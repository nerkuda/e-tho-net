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
 * Валидация `definition`. Синтаксис JSON проверяется здесь же (строка
 * парсится в объект), поверх — полная валидация токенов из закрытого
 * пространства имён (задача 20b2fca0, ADR 7c1c5bf5): имена свойств в
 * `$thought.[…]` сверяются с цепочкой типов, `config.multiple=true` —
 * с операцией условия. Невалидный отбор не сохранится.
 *
 * Исполнение отбора относительно мысли-контекста — через
 * {@link runViewForThought}: токены резолвятся сервером перед движком
 * отбора мыслей (требование 3697eb65); неразрешимые дают пустой
 * результат с пояснением (требование b7fdab20).
 */

import {
  EtnError,
  SORT_ORDERS,
  STRUCTURE_SORTS,
  THOUGHT_TYPE_VIEW_DESCRIPTION_MAX,
  THOUGHT_TYPE_VIEW_NAME_MAX,
  type EffectiveThoughtTypeView,
  type FilterDiagnostic,
  type FilterProfileId,
  type SortOrder,
  type StructureSort,
  type ThoughtTypeView,
  type ThoughtTypeViewInput,
  type ThoughtTypeViewUpdateInput,
  type ThoughtRef,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { getPropertyValues } from './property-service.js';
import { parseStructureFilter } from './structure-service.js';
import { parseFilterAst } from './filter-ast.js';
import { diagnoseFilterAst, filterDiagnosticsError } from './filter-diagnostics.js';
import { assertFilterDefinitionInProfile } from './filter-profile-validation.js';
import {
  structureRequestToQuery,
  type AstTokenContext,
  type QueryStats,
  type ThoughtQueryRequest,
  type ThoughtQueryResult,
} from './query-service.js';
import { queryThoughtsAsync } from './heavy-read.js';
import {
  buildResolveContext,
  resolveThoughtTokensInAst,
  resolveTokensInDefinition as resolveTokensDefinition,
  validateDefinitionForTokens,
  type PropertyMeta,
  type ResolveContext,
  type ThoughtPropertyValue,
  type TokenIssue,
} from './thought-type-view-tokens.js';
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
import { getThought } from './thought-service.js';
import {
  getNetworkPropertyByName,
  linkPropertySideFromConfig,
  listEffectiveTypeProperties,
  listNetworkProperties,
  oppositeLinkPropertyDisplayName,
} from './property-service.js';

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
 * Метаданные свойств РЕЕСТРА СЕТИ для валидатора токенов
 * (`thought-type-view-tokens`): имена, `multiple`, `value_type`.
 *
 * **Свойство резолвится по реестру сети независимо от привязки к типу отбора**
 * (ошибка 50d9bf4e, пункт A6): токен `$thought.[Имя]` принимается, если такое
 * свойство определено в сети, — даже если оно не подключено к типу этого отбора
 * (при исполнении отсутствие значения у мысли даёт пустое значение по семантике
 * отбора). Поэтому валидатору отдаётся ПОЛНЫЙ список свойств сети, а не
 * свойства цепочки типа.
 *
 * Свойство-связь адресуется обеими сторонами: к метаданным добавляется имя
 * противоположной стороны, чтобы токен `$thought.[<обратное имя>]` был принят
 * (единая точка интерпретации направления — `oppositeLinkPropertyDisplayName`).
 */
function getNetworkPropertyMeta(ndb: NetworkDb): PropertyMeta[] {
  const out: PropertyMeta[] = [];
  for (const p of listNetworkProperties(ndb)) {
    out.push({
      key: p.name,
      multiple: p.config?.multiple === true,
      value_type: p.value_type,
    });
    if (p.value_type !== 'link') continue;
    const side = linkPropertySideFromConfig(p.value_type, p.config ?? null);
    const opposite = oppositeLinkPropertyDisplayName(ndb, p.config ?? null, side);
    if (opposite === null || opposite === p.name) continue;
    out.push({ key: opposite, multiple: p.config?.multiple === true, value_type: p.value_type });
  }
  return out;
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

/**
 * Красная диагностика на сохранении (требование 44d61c8a): AST-форма
 * определения, ссылающаяся на удалённую сущность (свойство реестра, тип/тип
 * связи, значение-мысль), не сохраняется — `VALIDATION_ERROR` со
 * структурированными `details.diagnostics`. Определения старой плоской формы
 * (`definition v1`, без поля `version`) пропускаются: их миграция в AST —
 * отдельная задача 4be62d42.
 */
function assertAstDefinitionEntitiesResolvable(
  ndb: NetworkDb,
  parsedDefinition: Record<string, unknown>,
  thoughtTypeId: string,
  requestId?: string,
): void {
  if (parsedDefinition['version'] === undefined) return;
  const ast = parseFilterAst(parsedDefinition, requestId);
  const diag = diagnoseFilterAst(ndb, ast, { thoughtTypeId, requestId });
  if (diag.errors.length > 0) throw filterDiagnosticsError(diag.errors, requestId);
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
  // Полная валидация токенов (задача 20b2fca0): запускается после синтаксиса
  // JSON. Свойства сверяются с РЕЕСТРОМ СЕТИ (A6), а не с цепочкой типа:
  // `$thought.[Имя]` принимается для любого свойства сети, а `multiple`
  // распознаётся по его конфигурации.
  // Повторный JSON.parse дёшев — definition это пара KB; альтернатива
  // (возвращать из `validateDefinition` ещё и parsed-объект) рвёт границу
  // ответственности функции (валидация → парсинг).
  const parsedDefinition = JSON.parse(definition) as Record<string, unknown>;
  validateDefinitionForTokens(
    parsedDefinition,
    { properties: getNetworkPropertyMeta(ndb) },
    requestId,
  );
  // Красная диагностика: AST, ссылающийся на удалённую сущность, не сохраняется.
  assertAstDefinitionEntitiesResolvable(ndb, parsedDefinition, thoughtTypeId, requestId);
  // Профиль точки применения: операнд, невидимый в отборе мыслей, не сохраняется
  // (требование 0095daad, ADR 0c02ab4f).
  assertFilterDefinitionInProfile(parsedDefinition, 'thoughts', requestId);

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

    if (validated.definition !== undefined) {
      // Полная валидация токенов (задача 20b2fca0): свойства сверяются с
      // реестром СЕТИ (A6). До UPDATE — иначе можно было бы сохранить
      // невалидное определение.
      const parsedDefinition = JSON.parse(validated.definition) as Record<string, unknown>;
      validateDefinitionForTokens(
        parsedDefinition,
        { properties: getNetworkPropertyMeta(ndb) },
        requestId,
      );
      // Красная диагностика: AST, ссылающийся на удалённую сущность, не сохраняется.
      assertAstDefinitionEntitiesResolvable(
        ndb,
        parsedDefinition,
        current.thought_type_id,
        requestId,
      );
      // Профиль точки применения (требование 0095daad, ADR 0c02ab4f).
      assertFilterDefinitionInProfile(parsedDefinition, 'thoughts', requestId);
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

/**
 * Список отборов одного типа в текущем слое, по `position`.
 *
 * Параметр `currentLayerOnly` (по умолчанию `false`) переключает чтение с
 * представления `thought_type_views_v` (свёртка по цепочке слоёв, нужно
 * `getEffectiveViewsForThought`) на физическую таблицу с фильтром
 * `layer_id = ndb.layerId` — для REST `GET /thought-types/{id}/views`,
 * контракт b90bb6e6: «GET отдаёт собственные отборы типа».
 */
export function listThoughtTypeViewsByType(
  ndb: NetworkDb,
  thoughtTypeId: string,
  options?: { currentLayerOnly?: boolean },
): ThoughtTypeView[] {
  return repoListByType(ndb, thoughtTypeId, options).map(rowToView);
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

// ---------------------------------------------------------------------------
// Исполнение отбора относительно мысли-контекста (задача 20b2fca0, интерфейс
// для этапа 5 — REST `POST /thoughts/{id}/views/{view}/run`).
// ---------------------------------------------------------------------------

/**
 * Результат исполнения отбора относительно конкретной мысли. Помимо
 * страницы мыслей, как у {@link StructureQueryResult}, несёт `unresolved`
 * — список токенов, которые не удалось разрешить на момент исполнения
 * (требование b7fdab20). При непустом списке страница пустая.
 */
export interface RunViewResult {
  items: ThoughtRef[];
  total: number;
  /** Направления связей для найденных мыслей (тот же формат, что в
   *  `ThoughtQueryResult.directions` — фронт подсвечивает эллипсы). */
  directions: ThoughtQueryResult['directions'];
  /** `[]` — все токены разрешены, иначе условие с токеном не применилось,
   *  и движок отбора возвращает пустую страницу с пояснением. */
  unresolved: TokenIssue[];
  /** Эффективная сортировка страницы: из тела запроса или из определения
   *  отбора (ошибка 4dd14aa3 — исполняется SQL-движком, а не JS). */
  sort: StructureSort;
  /** Эффективное направление сортировки (см. {@link RunViewResult.sort}). */
  order: SortOrder;
  /**
   * Жёлтая диагностика (требование 325efc13): свойство условия отвязано от типа
   * отбора — отбор исполнен по фактическим значениям вне типа. Пусто — жёлтых
   * предупреждений нет. Красная диагностика не доходит сюда: она бросает ошибку.
   */
  warnings?: FilterDiagnostic[];
  /** Статистика исполнения (только при `collectStats`, требование 0f34a5ff). */
  stats?: QueryStats;
  /**
   * Есть ли ещё страницы за текущей (задача 0e7e89f5). Доносится из движка
   * (`queryThoughts`) — прежде терялось: MCP `etn.views.run { ast }` молча не
   * отдавал хвост, а сохранённый путь его не возвращал вовсе.
   */
  has_more: boolean;
  /** Keyset-курсор следующей страницы (`null` — страниц больше нет). */
  next_cursor: string | null;
}

/**
 * Параметры страницы исполнения отбора (ошибка 4dd14aa3, 0.8.2). Все поля
 * необязательны: не переданное значение берётся из определения отбора
 * (`sort`/`order`, сохраняемые клиентом в `definition`), иначе — дефолт
 * `alpha asc` с лимитом 100. Сортировка и пагинация исполняются SQL-движком
 * (`queryThoughts`), а не JS-пересортировкой страницы.
 */
export interface RunViewQueryOptions {
  /** Сортировка страницы — переопределяет сохранённую в определении. */
  sort?: StructureSort;
  /** Направление сортировки — переопределяет сохранённое в определении. */
  order?: SortOrder;
  /** Лимит страницы (дефолт 100, потолок — `queryThoughts`). */
  limit?: number;
  /** Смещение пагинации (дефолт 0). */
  offset?: number;
  /** Контекст разрешения токенов AST (обязательный пункт задачи c13762b1):
   *  часы, пользователь, первый день недели сети, профиль времени. Прокидывается
   *  в движок отбора (`queryThoughts`) — без него календарные токены AST не
   *  разрешатся. */
  tokenContext?: AstTokenContext;
  /** Собирать статистику исполнения (требование 0f34a5ff) — только при
   *  включённом серверном журналировании. */
  collectStats?: boolean;
  /** Профиль точки применения (требование 0095daad, ADR 0c02ab4f). Отбор типа —
   *  точка «мысли»; по умолчанию `thoughts`. Определяет видимость операндов и
   *  гранулярность времени. */
  profile?: FilterProfileId;
  /**
   * Потолок лимита страницы. Не задан — `STRUCTURES_QUERY_MAX_LIMIT`
   * (REST `POST /thoughts/query`). MCP-ветки `etn.views.run` (сохранённый отбор
   * и ad-hoc AST) и ad-hoc REST-маршрут используют 200 (задача 0e7e89f5) —
   * прежде потолки расходились (100 vs 200).
   */
  maxLimit?: number;
  /**
   * `ast.sort` и поля `sort`/`order` взаимоисключающие (конвенция cb78315b
   * «оставьте один источник», задача 0e7e89f5). По умолчанию `false`:
   * сохранённый отбор допускает переопределение — тело перекрывает сохранённую
   * сортировку (контракт 95273103). Ad-hoc путь передаёт `true`.
   */
  exclusiveSort?: boolean;
}

/**
 * Превратить «сырые» значения свойств мысли из `getPropertyValues` в
 * плоскую форму, которую ест резолвер токенов: ключ + тип + флаг
 * `multiple` + скаляр или массив строк (для `multiple`).
 *
 * **Свойство резолвится по реестру сети независимо от привязки к типу**
 * (ошибка 50d9bf4e, пункт A6): значение свойства вне цепочки типа отбора
 * (`outside_type`) тоже подставляется — метаданные (`multiple`/`value_type`)
 * для него берутся из реестра. Свойство, которого у мысли нет, в карту не
 * попадает — резолвер отдаёт для него пустое значение (семантика отбора), а не
 * «неразрешимый токен».
 */
function collectThoughtPropertyValues(
  ndb: NetworkDb,
  thoughtId: string,
  typeId: string | null,
): ThoughtPropertyValue[] {
  const raw = getPropertyValues(ndb, 'thought', thoughtId);
  if (raw.length === 0) return [];
  const meta = typeId === null
    ? new Map<string, { multiple: boolean; value_type: typeof raw[number]['value_type'] }>()
    : new Map(
      listEffectiveTypeProperties(ndb, 'thought_type', typeId).map((p) => [
        p.key,
        { multiple: p.config?.multiple === true, value_type: p.value_type },
      ] as const),
    );
  const out: ThoughtPropertyValue[] = [];
  for (const v of raw) {
    // `null` (и экзотика вроде пустого массива для одиночного свойства) —
    // резолверу нечего подставлять: подставляется пустое значение (A6).
    if (v.value === null) continue;
    if (Array.isArray(v.value) && v.value.length === 0) continue;
    // `cross_network_ref` (задача 7849008a) — снапшот `CrossNetworkRefValue[]`,
    // токены `$thought.<key>` не применимы к кросс-сетевому адресу.
    if (v.value_type === 'cross_network_ref') continue;
    // Метаданные: цепочка типа, при отсутствии (свойство вне типа) — реестр сети.
    const fromType = meta.get(v.property_name);
    const fromRegistry = fromType === undefined ? getNetworkPropertyByName(ndb, v.property_name) : null;
    const multiple = fromType?.multiple ?? fromRegistry?.config?.multiple === true;
    const valueType = fromType?.value_type ?? fromRegistry?.value_type ?? v.value_type;
    // Множественное `text` хранится comma-joined строкой (02-data-model
    // §3.4–3.5); токен `$thought.[…]` обязан подставляться СПИСКОМ элементов
    // (требование 12fccde9) — иначе он уходит одной склеенной строкой и
    // условие-список по ней не матчит (ошибка 7489e4d9, тот же класс).
    let value = v.value as string | number | boolean | string[];
    if (multiple && valueType === 'text' && typeof value === 'string') {
      value = splitMultipleText(value);
      if (value.length === 0) continue; // пустой список — пустое значение (12fccde9)
    }
    out.push({ key: v.property_name, value_type: valueType, multiple, value });
  }
  return out;
}

/**
 * Собрать {@link ResolveContext} для конкретной мысли — общая точка разрешения
 * токенов контекста мысли (`$thought`/`$thought.*`/`$thought.[…]`): поля мысли +
 * значения свойств + пользователь + часы/настройки сети. Используется отбором
 * типа мысли (`runViewForThought`) и точкой поиска карты (задача 4b1cc3d4):
 * семантика `$thought` одна, второй сборки контекста нет.
 */
export function buildThoughtResolveContext(
  ndb: NetworkDb,
  thought: ResolveContext['thought'],
  thoughtId: string,
  userId: string,
  extra: { now?: () => Date; firstDayOfWeek?: number; withTime?: boolean } = {},
): ResolveContext {
  return buildResolveContext(
    thought,
    collectThoughtPropertyValues(ndb, thoughtId, thought.type_id),
    userId,
    extra.now,
    {
      ...(extra.firstDayOfWeek !== undefined ? { firstDayOfWeek: extra.firstDayOfWeek } : {}),
      ...(extra.withTime !== undefined ? { withTime: extra.withTime } : {}),
    },
  );
}

/**
 * Разделить хранимую comma-joined строку множественного `text`-свойства на
 * элементы (разделитель записи — `", "`). Пустые элементы отбрасываются, так
 * что пустое значение даёт пустой список — случай неразрешимого токена
 * (требование 12fccde9).
 */
function splitMultipleText(raw: string): string[] {
  return raw
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Коды плоской сортировки `StructureSort` → фиксированные ключи `ast.sort`.
 * Нужны, когда тело запроса переопределяет сортировку AST-определения
 * (контракт 95273103): `viewed`/`manual` ключа AST не имеют — там отбор
 * уходит на плоскую сортировку движка.
 */
const STRUCTURE_SORT_TO_AST_KEY: Partial<Record<StructureSort, string>> = {
  alpha: 'title',
  created: 'created_at',
  updated: 'updated_at',
};

export async function runViewForThought(
  ndb: NetworkDb,
  view: ThoughtTypeView,
  thoughtId: string,
  userId: string,
  requestId?: string,
  options?: RunViewQueryOptions,
): Promise<RunViewResult> {
  // Тонкая обёртка над единой доменной точкой (задача 0e7e89f5): от сохранённого
  // отбора зависят лишь `view.definition` и `view.thought_type_id`.
  return executeViewDefinitionForThought(ndb, {
    definition: JSON.parse(view.definition) as Record<string, unknown>,
    thoughtTypeId: view.thought_type_id,
    thoughtId,
    userId,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(options !== undefined ? { options } : {}),
  });
}

/**
 * Исполнить ПРОИЗВОЛЬНОЕ определение отбора относительно конкретной мысли —
 * единая доменная точка (задача 0e7e89f5). От сохранённого отбора отличается
 * только источником определения: {@link runViewForThought} передаёт
 * `view.definition` и `view.thought_type_id`, ad-hoc AST-прогон (`etn.views.run
 * { ast }` и REST `POST /thoughts/{id}/views/run`) — само тело и тип контекстной
 * мысли. Всё прочее — резолв токенов контекста мысли, диагностика, единый
 * исполнитель, исключение контекстной мысли, `total` (всегда COUNT),
 * `has_more`/`next_cursor` — ОДНО для обеих форм; второй сборки контекста мысли
 * нет (общая точка {@link buildThoughtResolveContext}).
 *
 * Шаги:
 *   1. Прочитать мысль (404 для несуществующей — `getThought` возвращает
 *      `null`, бросаем `NOT_FOUND`).
 *   2. Распарсить определение: wire-AST (`version`) либо старая плоская форма
 *      `definition v1` (распознаётся по отсутствию `version`).
 *   3. Собрать контекст резолвера: поля мысли + значения свойств +
 *      id пользователя + часы (`now()` по умолчанию).
 *   4. Подставить токены. Если хоть один не разрешён — пустой результат
 *      с пояснениями (требование b7fdab20), `queryThoughts` не вызывается.
 *   5. Иначе — `queryThoughts` от имени `userId` с подставленным фильтром.
 *
 * @param input.thoughtTypeId Тип мысли — якорь жёлтой диагностики «свойство
 *   отвязано от типа» (`diagnoseFilterAst`). У сохранённого отбора —
 *   `view.thought_type_id`, у ad-hoc — тип контекстной мысли (`thought.type_id`;
 *   у мысли без типа диагностик нет).
 */
export async function executeViewDefinitionForThought(
  ndb: NetworkDb,
  input: {
    definition: Record<string, unknown>;
    thoughtTypeId?: string | null;
    thoughtId: string;
    userId: string;
    requestId?: string;
    options?: RunViewQueryOptions;
  },
): Promise<RunViewResult> {
  const { thoughtId, userId, requestId } = input;
  const options = input.options;
  const parsed = input.definition;
  const thought = getThought(ndb, thoughtId);
  if (thought === null) {
    throw new EtnError(
      'NOT_FOUND',
      `Мысль ${thoughtId} не найдена.`,
      { entity: 'thought', id: thoughtId },
      requestId,
    );
  }
  // Повторная защита: даже если по дороге кто-то подменил definition в БД,
  // здесь отбор не выполнится с невалидными токенами — выбросим 422.
  validateDefinitionForTokens(parsed, undefined, requestId);

  // Сортировка/направление: тело запроса переопределяет сохранённые в
  // определении отбора (контракт 95273103 «sort/order в теле переопределяют
  // сортировку, сохранённую в отборе»). Значение из определения проходит
  // ту же валидацию по единому набору, что и тело: недопустимое (легаси или
  // опечатка) молча не игнорируется в пользу тишины — деградируем к дефолту
  // `alpha asc`, как и `parseStructureFilter` для прочих неизвестных полей.
  // Ошибка 4dd14aa3: прежде сортировка зашивалась в `alpha` здесь и
  // «исполнялась» JS-сравнением полей, которых нет в ThoughtRef, — теперь
  // её исполняет SQL-движок.
  const sort = options?.sort ?? readSavedSort(parsed);
  const order = options?.order ?? readSavedOrder(parsed);
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  // Определение отбора хранится либо в форме AST (0.13.1, сущность 489c394f —
  // распознаётся по полю `version`), либо в старой плоской `definition v1`.
  const isAstDefinition = parsed['version'] !== undefined;

  let resolvedDefinition: Record<string, unknown>;
  // Контекст резолва токенов (мысль-контекст + свойства + пользователь + часы +
  // настройки сети) — ОБЩИЙ для обеих форм определения: плоский резолвер
  // раскрывает им строки, AST-форма — токены контекста мысли (ошибка 23c7d3e9
  // п. C3). Часы/первый день недели/гранулярность времени берутся из
  // `tokenContext` (обязательный пункт задачи 7a798b17, замечание верификатора
  // задачи 0f1b9892; требование 0095daad) — иначе календарные токены
  // (`$today`/`$weekStart`) раскрывались бы по реальным часам и от
  // понедельника, а `$now` — по историческому умолчанию.
  const extra = options?.tokenContext;
  const now = extra?.nowMs !== undefined ? (): Date => new Date(extra.nowMs!) : undefined;
  // Сборка контекста — общая точка ({@link buildThoughtResolveContext}), одна и
  // та же с точкой поиска карты (задача 4b1cc3d4).
  const resolveContext: ResolveContext = buildThoughtResolveContext(
    ndb,
    {
      id: thought.id,
      title: thought.title,
      synonyms: thought.synonyms,
      type_id: thought.type_id,
      active: thought.active,
      // `created_by`/`updated_by` опциональны в DTO Thought; в контекст
      // токенов пустую строку не отдаём — `$thought.author` уйдёт в
      // «не разрешён», отбор вернёт пустой результат с пояснением.
      created_by: thought.created_by ?? '',
      updated_by: thought.updated_by ?? '',
      created_at: thought.created_at,
      updated_at: thought.updated_at,
    },
    thoughtId,
    userId,
    {
      ...(now !== undefined ? { now } : {}),
      ...(extra?.firstDayOfWeek !== undefined ? { firstDayOfWeek: extra.firstDayOfWeek } : {}),
      ...(extra?.withTime !== undefined ? { withTime: extra.withTime } : {}),
    },
  );

  if (isAstDefinition) {
    // AST-форма. ГЛОБАЛЬНЫЕ токены (`$today`/`$user`/`$weekStart` и арифметика
    // по ним) раскрывает САМ движок по `tokenContext` (единый исполнитель,
    // задача 0f1b9892) — плоский резолвер к AST неприменим: он подставляет
    // значение ВНУТРЬ строки `{token:"$user"}` и превращает валидный токен в
    // мусорный. Токены КОНТЕКСТА МЫСЛИ (`$thought`/`$thought.*`/
    // `$thought.[…]`) движку не по силам — контекста мысли в сетевом запросе
    // нет, — поэтому их раскрывает сервис, у которого мысль есть. Иначе условие
    // «Мысль в иерархии $thought» давало необъяснимый пустой результат (ошибка
    // 23c7d3e9 п. C3).
    const resolvedAst = resolveThoughtTokensInAst(parsed, resolveContext);
    if (resolvedAst.unresolved.length > 0) {
      return {
        items: [],
        total: 0,
        directions: {},
        unresolved: resolvedAst.unresolved,
        sort,
        order,
        has_more: false,
        next_cursor: null,
      };
    }
    resolvedDefinition = resolvedAst.definition as Record<string, unknown>;
  } else {
    const resolved = resolveTokensInDefinitionProxy(parsed, resolveContext);

    if (resolved.unresolved.length > 0) {
      return {
        items: [],
        total: 0,
        directions: {},
        unresolved: resolved.unresolved,
        sort,
        order,
        has_more: false,
        next_cursor: null,
      };
    }
    resolvedDefinition = resolved.definition as Record<string, unknown>;
  }

  // Старая плоская форма компилируется в AST тем же движком отбора (единый
  // вход, требование 91983c20); одноразовая миграция БД v1 → AST — отдельная
  // задача 4be62d42.
  let warnings: FilterDiagnostic[] = [];
  const query: ThoughtQueryRequest = isAstDefinition
    ? (() => {
        // Форму дерева валидирует доменный parseFilterAst (строгая проверка).
        const ast = parseFilterAst(resolvedDefinition, requestId);
        // Ad-hoc путь (задача 0e7e89f5): `ast.sort` и `sort`/`order` — два
        // источника одного порядка, одновременно недопустимы (конвенция
        // cb78315b «оставьте один источник»). Сохранённый отбор эту пару
        // допускает — тело перекрывает сохранённую сортировку (95273103).
        if (
          options?.exclusiveSort === true &&
          ast.sort !== undefined &&
          ast.sort.length > 0 &&
          (options.sort !== undefined || options.order !== undefined)
        ) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'Сортировка задана дважды: в теле ast (sort) и в полях sort/order — оставьте один источник.',
            { field: 'sort' },
            requestId,
          );
        }
        // Диагностика AST отбора типа (требования 44d61c8a/325efc13): красное
        // (удалённая сущность) — запрет применения; жёлтое (свойство отвязано
        // от типа) — исполняем и отдаём предупреждение в ответе. Якорь жёлтой
        // диагностики — тип мысли (у сохранённого отбора — тип отбора, у
        // ad-hoc — тип контекстной мысли).
        const diag = diagnoseFilterAst(ndb, ast, {
          thoughtTypeId: input.thoughtTypeId ?? undefined,
          requestId,
        });
        if (diag.errors.length > 0) throw filterDiagnosticsError(diag.errors, requestId);
        warnings = diag.warnings;
        // Контракт 95273103: явные `sort`/`order` ТЕЛА переопределяют
        // сохранённую в определении сортировку. Для AST-определения это значит
        // переопределить и `ast.sort` (иначе движок предпочёл бы определение):
        //   * задан `sort` → одна карта «код → ключ AST» с телом-направлением
        //     (некодируемые коды вроде `viewed` — плоская сортировка движка);
        //   * задан только `order` → направление КАЖДОГО сохранённого ключа
        //     берётся из тела.
        const bodySort = options?.sort;
        const bodyOrder = options?.order;
        let astForQuery = ast;
        if (bodySort !== undefined || bodyOrder !== undefined) {
          const mapped = bodySort === undefined ? undefined : STRUCTURE_SORT_TO_AST_KEY[bodySort];
          if (bodySort !== undefined && mapped !== undefined) {
            astForQuery = { version: ast.version, filter: ast.filter, sort: [{ key: mapped, order }] };
          } else if (bodySort === undefined && ast.sort !== undefined) {
            astForQuery = { version: ast.version, filter: ast.filter, sort: ast.sort.map((k) => ({ ...k, order })) };
          } else {
            // `viewed`/`manual` или определение без `sort`: отдаём плоской
            // сортировке движка (`req.sort`/`req.order` уже несут тело).
            astForQuery = { version: ast.version, filter: ast.filter };
          }
        }
        return { ast: astForQuery, sort, order, limit, offset, count: true } satisfies ThoughtQueryRequest;
      })()
    : structureRequestToQuery({
        ...parseStructureFilter(resolvedDefinition, requestId),
        sort,
        order,
        limit,
        offset,
        count: true,
      });
  const result = await queryThoughtsAsync(ndb, userId, query, {
    emptyFilterMode: 'home_orphans',
    includeDirections: true,
    profile: options?.profile ?? 'thoughts',
    ...(options?.maxLimit !== undefined ? { maxLimit: options.maxLimit } : {}),
    ...(options?.tokenContext !== undefined ? { tokenContext: options.tokenContext } : {}),
    ...(options?.collectStats === true ? { collectStats: true } : {}),
  });
  // Исключаем саму контекстную мысль из результата: «отбор относительно
  // мысли» показывает СОСЕДЕЙ, удовлетворяющих критериям, а не саму мысль.
  // `StructureQueryRequest` пока не несёт `exclude_ids` — фильтруем после
  // запроса. Это редкая операция (лимит 100), цена невелика.
  const items = result.items.filter((i) => i.id !== thoughtId);
  const total = Math.max(0, (result.total ?? 0) - (result.items.length > items.length ? 1 : 0));
  return {
    items,
    total,
    directions: result.directions,
    // Неразрешимые токены AST (задача 0f1b9892, требование b7fdab20) —
    // приходят из исполнения; пустой массив — всё разрешилось. Прежде здесь
    // жёстко стоял `[]`, и неразрешимый токен молча давал пустую выдачу.
    unresolved: result.unresolved ?? [],
    sort,
    order,
    // Хвост страницы несёт движок (задача 0e7e89f5): `total` — всегда COUNT
    // (`count: true` выше), `has_more`/`next_cursor` — есть ли ещё страницы.
    has_more: result.has_more,
    next_cursor: result.next_cursor,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(result.stats !== undefined ? { stats: result.stats } : {}),
  };
}

/**
 * Сохранённая в определении отбора сортировка (клиент кладёт `sort`/`order`
 * в `definition` всегда — `buildWireFilter`). Валидация по единому набору
 * {@link STRUCTURE_SORTS}; значение вне набора (легаси/опечатка) → дефолт
 * `alpha` — как движок отбора трактует прочие неизвестные поля.
 */
function readSavedSort(definition: Record<string, unknown>): StructureSort {
  const raw = definition['sort'];
  return typeof raw === 'string' && (STRUCTURE_SORTS as readonly string[]).includes(raw)
    ? (raw as StructureSort)
    : 'alpha';
}

/** Сохранённое в определении направление сортировки (см. {@link readSavedSort}). */
function readSavedOrder(definition: Record<string, unknown>): SortOrder {
  const raw = definition['order'];
  return typeof raw === 'string' && (SORT_ORDERS as readonly string[]).includes(raw)
    ? (raw as SortOrder)
    : 'asc';
}

/**
 * Тонкая обёртка над резолвером токенов: клонирует definition, подставляет,
 * возвращает `{ definition, unresolved }`. Вынесено, чтобы
 * `runViewForThought` не зависел от формы импорта резолвера напрямую.
 */
function resolveTokensInDefinitionProxy(
  parsedDefinition: Record<string, unknown>,
  ctx: ResolveContext,
): { definition: unknown; unresolved: TokenIssue[] } {
  // Резолвер делает обход по строкам, поэтому копия входного объекта —
  // входной параметр остаётся неизменным для повторных вызовов и тестов.
  const cloned = JSON.parse(JSON.stringify(parsedDefinition)) as Record<string, unknown>;
  return resolveTokensDefinition(cloned, ctx);
}
