/**
 * Сервис отборов типов мыслей (`thought_type_views`, миграция 037; тех.проект
 * 918833e3 «Отборы для типов мыслей», задача 17eb741e «Домен отборов типа»).
 *
 * Покрывает доменные правила, на которые не способен репозиторий
 * (`thought-type-views-repo.ts`):
 *
 *   * требование 141c2576 — имя отбора уникально в пределах своего типа,
 *     сравнение регистронезависимо по `name_key`. Повторное имя →
 *     `DUPLICATE` (HTTP 409) с `details.existing_id` и `details.existing_name`,
 *     чтобы клиент мог показать «такой отбор уже есть»;
 *   * требование 7263e565 — у типа мысли не более одного отбора «по
 *     умолчанию». Пометка снимается с прежнего отбора того же типа в той же
 *     транзакции, что и установка новой. Параллельные запросы не
 *     отвергаются, а переносят пометку (write-lock SQLite выстраивает их
 *     последовательно, и второй видит результат первого);
 *   * требование eaca1253 — эффективный набор отборов мыши: свои +
 *     унаследованные от типов-предков, перекрытие одноимённых целиком,
 *     порядок от корня к типу мысли, наследование признака «по умолчанию»;
 *   * требование 23e0f78e — у мысли без типа действуют отборы корневого
 *     типа; заводить новый отбор с холста для неё нельзя (UI-правило;
 *     проверяется при `create` для `thoughtTypeId === <root>` через особый
 *     код ошибки `THOUGHT_TYPE_NOT_ASSIGNABLE`, который клиент превращает в
 *     скрытие кнопки «+»).
 *
 * Валидация `definition`. На этом этапе проверяется только синтаксис JSON
 * (строка парсится в объект). Полная валидация токенов (`$today`,
 * `$thought.*`) — отдельный этап 20b2fca0, и эта проверка намеренно не
 * повторяется здесь: зря падающие `422` на этапе хранения сломали бы
 * сохранение отбора, который сейчас валиден как JSON, но не как фильтр.
 */

import {
  EtnError,
  THOUGHT_TYPE_VIEW_DESCRIPTION_MAX,
  THOUGHT_TYPE_VIEW_NAME_MAX,
  type EffectiveThoughtTypeView,
  type ThoughtTypeView,
  type ThoughtTypeViewInput,
  type ThoughtTypeViewUpdateInput,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import {
  getRootThoughtType,
  thoughtTypeChain,
} from './thought-type-service.js';
import {
  clearDefaultForThoughtType,
  deleteThoughtTypeView as repoDelete,
  findThoughtTypeViewByTypeAndNameKey,
  getThoughtTypeView as repoGet,
  insertThoughtTypeView as repoInsert,
  listThoughtTypeViewsByType as repoListByType,
  updateThoughtTypeView as repoUpdate,
  type ThoughtTypeViewRow,
} from './thought-type-views-repo.js';

/**
 * Доменное представление отбора (`ThoughtTypeView`). Различается с репозиторным
 * `ThoughtTypeViewRow` только типом `is_default` (boolean против INTEGER) и
 * конвертируется через {@link rowToView}.
 */
function rowToView(row: ThoughtTypeViewRow): ThoughtTypeView {
  return {
    id: row.id,
    thought_type_id: row.thought_type_id,
    name: row.name,
    name_key: row.name_key,
    description: row.description,
    definition: row.definition,
    position: row.position,
    is_default: row.is_default === 1,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
  };
}

/**
 * Вычислить `name_key` — нормализованную форму имени (trim + lowercase),
 * использующуюся для сравнения дублей и перекрытий (требования 141c2576
 * и eaca1253). Локальная копия логики репозитория: иначе правило
 * нормализации пришлось бы экспортировать только ради сервиса, что
 * размывает границу ответственности (репозиторий — хранение, сервис —
 * правила).
 */
function viewNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Валидация имени отбора: непустая строка, до {@link THOUGHT_TYPE_VIEW_NAME_MAX}
 * символов (после `trim`). Требование 141c2576.
 *
 * `requestId` пробрасывается в `EtnError` (REST/MCP его подставляют).
 */
function validateName(name: unknown, requestId?: string): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Имя отбора должно быть непустой строкой.',
      { field: 'name' },
      requestId,
    );
  }
  const trimmed = name.trim();
  if ([...trimmed].length > THOUGHT_TYPE_VIEW_NAME_MAX) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Имя отбора должно быть не длиннее ${THOUGHT_TYPE_VIEW_NAME_MAX} символов.`,
      { field: 'name', limit: THOUGHT_TYPE_VIEW_NAME_MAX },
      requestId,
    );
  }
  return trimmed;
}

/**
 * Валидация описания: необязательная строка, до
 * {@link THOUGHT_TYPE_VIEW_DESCRIPTION_MAX} символов. Пустая строка и `null`
 * нормализуются в `null` — описание либо есть осмысленное, либо отсутствует.
 */
function validateDescription(
  description: unknown,
  requestId?: string,
): string | null {
  if (description === undefined || description === null) return null;
  if (typeof description !== 'string') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Описание отбора должно быть строкой или null.',
      { field: 'description' },
      requestId,
    );
  }
  if (description.length > THOUGHT_TYPE_VIEW_DESCRIPTION_MAX) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Описание отбора должно быть не длиннее ${THOUGHT_TYPE_VIEW_DESCRIPTION_MAX} символов.`,
      { field: 'description', limit: THOUGHT_TYPE_VIEW_DESCRIPTION_MAX },
      requestId,
    );
  }
  return description === '' ? null : description;
}

/**
 * Валидация `definition`: непустая строка, синтаксически валидный
 * JSON-объект. Токены и полная семантика отбора — отдельный этап 20b2fca0;
 * здесь только защита от мусора и подтверждение, что хранить будем
 * валидный JSON.
 */
function validateDefinition(definition: unknown, requestId?: string): string {
  if (typeof definition !== 'string' || definition.trim() === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'definition должен быть непустой JSON-строкой.',
      { field: 'definition' },
      requestId,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition);
  } catch (err) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `definition не является валидным JSON: ${(err as Error).message}`,
      { field: 'definition' },
      requestId,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'definition должен быть JSON-объектом (не массивом и не null).',
      { field: 'definition' },
      requestId,
    );
  }
  return definition;
}

/** Валидация `position`: целое число ≥ 0, опционально. */
function validatePosition(position: unknown, requestId?: string): number | undefined {
  if (position === undefined) return undefined;
  if (typeof position !== 'number' || !Number.isInteger(position) || position < 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'position должен быть неотрицательным целым числом.',
      { field: 'position' },
      requestId,
    );
  }
  return position;
}

/**
 * Обернуть `getOrThrow`-логику над репозиторным `get`: если строки нет —
 * `EtnError('NOT_FOUND', ...)` с понятным `details` для клиента.
 */
function getViewOrThrow(ndb: NetworkDb, viewId: string, requestId?: string): ThoughtTypeView {
  const row = repoGet(ndb, viewId);
  if (!row) {
    throw new EtnError(
      'NOT_FOUND',
      'Отбор не найден.',
      { entity: 'thought_type_view', id: viewId },
      requestId,
    );
  }
  return rowToView(row);
}

/**
 * Убедиться, что отбора с тем же `name_key` в этом типе нет (исключая
 * сам редактируемый отбор, если указан). Бросает `DUPLICATE` (409) с
 * `details.existing_id` / `details.existing_name` — нужно клиенту, чтобы
 * показать «такой отбор уже есть» рядом с полем имени.
 */
function assertNameAvailable(
  ndb: NetworkDb,
  thoughtTypeId: string,
  nameKey: string,
  exceptId: string | undefined,
  requestId?: string,
): void {
  const clash = findThoughtTypeViewByTypeAndNameKey(
    ndb,
    thoughtTypeId,
    nameKey,
    exceptId,
  );
  if (clash) {
    throw new EtnError(
      'DUPLICATE',
      `Отбор с именем "${clash.name}" уже есть в этом типе мысли.`,
      {
        entity: 'thought_type_view',
        field: 'name',
        existing_id: clash.id,
        existing_name: clash.name,
      },
      requestId,
    );
  }
}

/**
 * Создать отбор типа мысли.
 *
 * Бросает:
 *   * `VALIDATION_ERROR` (422) — неверное имя / описание / `definition`;
 *   * `DUPLICATE` (409) — в этом типе уже есть отбор с тем же `name_key`;
 *   * `NOT_FOUND` (404) — `thoughtTypeId` не существует;
 *   * `VALIDATION_ERROR` (422) с `code: 'THOUGHT_TYPE_NOT_ASSIGNABLE'` —
 *     `thoughtTypeId` указывает на корневой тип (требование 23e0f78e:
 *     добавлять отборы корневому типу через эту функцию нельзя; доменный
 *     путь заводит их редактором типов, минуя `createThoughtTypeView`).
 *
 * `is_default: true` — пометка ставится транзакционно вместе со снятием
 * прежней (требование 7263e565): первый запрос поставит `A`, параллельный
 * `B` после первого без ошибки перенесёт пометку на `B`.
 */
export function createThoughtTypeView(
  ndb: NetworkDb,
  thoughtTypeId: string,
  input: ThoughtTypeViewInput,
  actorUserId: string,
  requestId?: string,
): ThoughtTypeView {
  // Валидация payload — до открытия транзакции, чтобы провалы валидации
  // не задерживали write-lock.
  const name = validateName(input.name, requestId);
  const description = validateDescription(input.description, requestId);
  const definition = validateDefinition(input.definition, requestId);
  const position = validatePosition(input.position, requestId);

  // Проверка типа — корневой тип нельзя «заселять отборами с холста».
  const root = getRootThoughtType(ndb);
  if (!root) {
    throw new EtnError(
      'NOT_FOUND',
      'Корневой тип мысли не найден — сеть не инициализирована.',
      { entity: 'thought_type', id: 'root' },
      requestId,
    );
  }
  if (thoughtTypeId === root.id) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Корневому типу нельзя добавлять отборы через этот путь: создайте их в редакторе типов.',
      { entity: 'thought_type', id: thoughtTypeId, root_id: root.id },
      requestId,
    );
  }
  const typeRow = ndb
    .prepare('SELECT id FROM thought_types_v WHERE id = ?')
    .get(thoughtTypeId) as { id: string } | undefined;
  if (!typeRow) {
    throw new EtnError(
      'NOT_FOUND',
      `Тип мысли ${thoughtTypeId} не найден.`,
      { entity: 'thought_type', id: thoughtTypeId },
      requestId,
    );
  }

  const nameKey = viewNameKey(name);
  assertNameAvailable(ndb, thoughtTypeId, nameKey, undefined, requestId);

  return ndb.transaction(() => {
    if (input.is_default === true) {
      // Снимаем прежнюю пометку тем же id (исключаем — пусто, потому что
      // нового отбора ещё нет, и дублей тут быть не может: `exceptId = undefined`).
      clearDefaultForThoughtType(ndb, thoughtTypeId);
    }
    const created = repoInsert(
      ndb,
      {
        thought_type_id: thoughtTypeId,
        name,
        description,
        definition,
        ...(position !== undefined ? { position } : {}),
        ...(input.is_default !== undefined ? { is_default: input.is_default } : {}),
      },
      actorUserId,
    );
    return rowToView(created);
  });
}

/**
 * Правка отбора. Частичная — меняются только переданные поля.
 *
 * Бросает:
 *   * `NOT_FOUND` (404) — отбора нет;
 *   * `VERSION_CONFLICT` (409) — `expectedVersion` задан и не совпал;
 *   * `VALIDATION_ERROR` (422) — неверный `name` / `description` /
 *     `definition` / `position`;
 *   * `DUPLICATE` (409) — новое имя занято соседним отбором того же типа.
 *
 * Установка `is_default: true` идёт в одной транзакции вместе со снятием
 * прежней пометки у других отборов того же типа (требование 7263e565).
 * Параллельный запрос не отвергается — write-lock SQLite выстраивает их,
 * и второй видит результат первого.
 */
export function updateThoughtTypeView(
  ndb: NetworkDb,
  viewId: string,
  changes: ThoughtTypeViewUpdateInput,
  expectedVersion: number | undefined,
  actorUserId: string,
  requestId?: string,
): ThoughtTypeView {
  // Валидация payload — вне транзакции, чтобы провалы валидации не
  // задерживали write-lock.
  const validated: ThoughtTypeViewUpdateInput = {};
  if (changes.name !== undefined) validated.name = validateName(changes.name, requestId);
  if (changes.description !== undefined) {
    validated.description = validateDescription(changes.description, requestId);
  }
  if (changes.definition !== undefined) {
    validated.definition = validateDefinition(changes.definition, requestId);
  }
  const position = validatePosition(changes.position, requestId);
  if (position !== undefined) validated.position = position;
  if (changes.is_default !== undefined) validated.is_default = changes.is_default;

  return ndb.transaction(() => {
    const current = getViewOrThrow(ndb, viewId, requestId);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError(
        'VERSION_CONFLICT',
        'Версия отбора изменилась с момента чтения.',
        {
          entity: 'thought_type_view',
          id: viewId,
          expected: expectedVersion,
          current: current.version,
        },
        requestId,
      );
    }

    if (validated.name !== undefined) {
      const newKey = viewNameKey(validated.name);
      if (newKey !== current.name_key) {
        assertNameAvailable(ndb, current.thought_type_id, newKey, viewId, requestId);
      }
    }

    if (validated.is_default === true) {
      // Снимаем пометку с других отборов того же типа, исключая текущий —
      // иначе UPDATE ниже мог бы снять её сам с себя.
      clearDefaultForThoughtType(ndb, current.thought_type_id, viewId);
    }

    const updated = repoUpdate(ndb, viewId, validated, actorUserId);
    return rowToView(updated);
  });
}

/**
 * Удалить отбор. Неизвестный id → `NOT_FOUND` (404).
 */
export function deleteThoughtTypeView(
  ndb: NetworkDb,
  viewId: string,
  requestId?: string,
): void {
  getViewOrThrow(ndb, viewId, requestId);
  repoDelete(ndb, viewId);
}

/**
 * Прочитать отбор или вернуть `null`, если такого нет (без `NOT_FOUND` —
 * удобно для мест, где «нет» — нормальный исход).
 */
export function getThoughtTypeView(
  ndb: NetworkDb,
  viewId: string,
): ThoughtTypeView | null {
  const row = repoGet(ndb, viewId);
  return row ? rowToView(row) : null;
}

/** Список отборов одного типа в текущем слое, по `position`. */
export function listThoughtTypeViewsByType(
  ndb: NetworkDb,
  thoughtTypeId: string,
): ThoughtTypeView[] {
  return repoListByType(ndb, thoughtTypeId).map(rowToView);
}

/**
 * Описание входа «мысль» для эффективного набора: хватает `type_id` (или
 * `null`). Сделано узким интерфейсом, чтобы сервис не зависел от всего
 * DTO `Thought` — вызывающий код передаёт то, что есть.
 */
export interface ThoughtForEffectiveViews {
  type_id: string | null;
}

/**
 * Эффективный набор отборов для мысли (требование eaca1253).
 *
 * Алгоритм — двухпроходный:
 *
 *   1. **От типа мысли к корню** — для каждого `name_key` запоминаем
 *      ближайшего к мысли (`winner`). Это даёт «потомок перекрывает
 *      предка»: первый встретившийся — ближайший, остальные пропускаются.
 *
 *   2. **От корня к типу мысли** — идём по уровням цепочки. На каждом
 *      уровне перебираем отборы этого уровня в порядке `position`. Если
 *      отбор — `winner` для своего `name_key` И `defined_on` совпадает с
 *      уровнем (то есть winner определён именно на этом типе), добавляем
 *      его в выходной список. Так гарантируется:
 *
 *        * перекрытие: потомок с тем же `name_key` остаётся в выходе, а не
 *          предок (winner именно потомок);
 *        * `defined_on` указывает на тип, на котором winner реально
 *          определён;
 *        * `position` берётся из winner'а (т.е. позиция потомка в его
 *          типе), внутри уровня сортировка по ней;
 *        * `is_default` (наследуется) — у winner'а; если у самого типа
 *          мысли нет `is_default`, побеждает ближайший к мысли winner с
 *          пометкой.
 *
 *      Если `thought.type_id === null` (требование 23e0f78e) — цепочка
 *      состоит из одного корневого типа.
 *
 * Возвращает отборы в порядке «от корня к типу мысли», внутри уровня — по
 * `position`.
 */
export function getEffectiveViewsForThought(
  ndb: NetworkDb,
  thought: ThoughtForEffectiveViews,
): EffectiveThoughtTypeView[] {
  const root = getRootThoughtType(ndb);
  if (!root) return [];

  // Цепочка ОТ ТИПА МЫСЛИ К КОРНЮ (ближайший уровень — первый).
  const fromTypeToRoot: string[] =
    thought.type_id === null
      ? [root.id]
      : thoughtTypeChain(ndb, thought.type_id);

  // Проход 1: ближайший к мысли `winner` для каждого `name_key`.
  const winnerByKey = new Map<
    string,
    { row: ThoughtTypeViewRow; defined_on: string }
  >();
  for (const typeId of fromTypeToRoot) {
    for (const row of repoListByType(ndb, typeId)) {
      if (!winnerByKey.has(row.name_key)) {
        winnerByKey.set(row.name_key, { row, defined_on: typeId });
      }
    }
  }

  // Эффективный «по умолчанию» — ближайший к мысли winner с пометкой
  // (требование 7263e565 «Собственный отбор по умолчанию у потомка
  // отменяет наследуемый» + eaca1253 «Признак „по умолчанию“ тоже
  // наследуется»). Идём по цепочке ОТ ТИПА МЫСЛИ К КОРНЮ — первый
  // встреченный winner с `is_default = 1` и есть эффективный.
  let effectiveDefaultKey: string | null = null;
  for (const typeId of fromTypeToRoot) {
    if (effectiveDefaultKey !== null) break;
    for (const row of repoListByType(ndb, typeId)) {
      const winner = winnerByKey.get(row.name_key);
      if (winner && winner.defined_on === typeId && row.is_default === 1) {
        effectiveDefaultKey = row.name_key;
        break;
      }
    }
  }

  // Проход 2: от корня к типу мысли — собираем выход в порядке UI.
  const fromRootToType = fromTypeToRoot.slice().reverse();
  const thoughtTypeId = thought.type_id ?? root.id;
  const out: EffectiveThoughtTypeView[] = [];
  for (const typeId of fromRootToType) {
    for (const row of repoListByType(ndb, typeId)) {
      const winner = winnerByKey.get(row.name_key);
      if (!winner || winner.defined_on !== typeId) continue;
      const base = rowToView(winner.row);
      out.push({
        ...base,
        defined_on: winner.defined_on,
        inherited: winner.defined_on !== thoughtTypeId,
        is_default: winner.row.name_key === effectiveDefaultKey,
      });
    }
  }

  return out;
}
