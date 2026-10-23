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
  type EffectiveThoughtTypeView,
  type EffectiveThoughtView,
  type FilterDiagnostic,
  type FilterProfileId,
  type SortOrder,
  type StructureSort,
  type ThoughtCustomView,
  type ThoughtTypeView,
  type ThoughtTypeViewInput,
  type ThoughtTypeViewUpdateInput,
  type ThoughtViewScope,
  type ThoughtRef,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { parseStructureFilter } from './structure-service.js';
import { parseFilterAst } from './filter-ast.js';
import { diagnoseFilterAst, filterDiagnosticsError } from './filter-diagnostics.js';
import {
  validateViewDefinitionInput,
  validateViewDescription,
  validateViewName,
  validateViewPosition,
  viewNameKey,
} from './thought-view-validation.js';
import {
  structureRequestToQuery,
  type AstTokenContext,
  type QueryStats,
  type ThoughtQueryRequest,
  type ThoughtQueryResult,
} from './query-service.js';
import { queryThoughtsAsync } from './heavy-read.js';
import {
  buildViewResultCacheKey,
  lookupViewResult,
  storeViewResult,
  viewResultCacheGeneration,
} from './view-result-cache.js';
import {
  buildResolveContext,
  resolveThoughtTokensInAst,
  resolveTokensInDefinition as resolveTokensDefinition,
  validateDefinitionForTokens,
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
  findThoughtTypeViewNameOccupancy,
  getThoughtTypeView as repoGet,
  insertThoughtTypeView as repoInsert,
  listThoughtTypeViewsByType as repoListByType,
  ThoughtTypeViewNameCollisionError,
  updateThoughtTypeView as repoUpdate,
  type ThoughtTypeViewRow,
} from './thought-type-views-repo.js';
import { listThoughtCustomViewsByThought as repoListCustom } from './thought-custom-views-repo.js';
import { getThought } from './thought-service.js';
import {
  getNetworkPropertyByName,
  getPropertyValues,
  getLinkPropertyValues,
  listEffectiveTypeProperties,
  listThoughtLinkProperties,
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

/** `DUPLICATE` «имя занято» — единая форма `details` (в т.ч. надгробие слоя). */
function duplicateNameError(
  existingId: string,
  existingName: string,
  requestId?: string,
): EtnError {
  return new EtnError(
    'DUPLICATE',
    `Отбор с именем "${existingName}" уже есть в этом типе мысли.`,
    {
      entity: 'thought_type_view',
      field: 'name',
      existing_id: existingId,
      existing_name: existingName,
    },
    requestId,
  );
}

/**
 * Убедиться, что отбора с тем же `name_key` в этом типе нет (исключая
 * сам редактируемый отбор, если указан). Бросает `DUPLICATE` (409) с
 * `details.existing_id` / `details.existing_name` — нужно клиенту, чтобы
 * показать «такой отбор уже есть» рядом с полем имени.
 *
 * Проверяются два источника:
 *   1. видимые живые строки (`*_v`) — семантика имени в типе;
 *   2. физические строки ТЕКУЩЕГО слоя, включая надгробия — UNIQUE 037 не
 *      имеет `WHERE deleted = 0`, поэтому надгробие занимает имя до слияния
 *      (после move-to-thought в слое); иначе INSERT падал бы сырым
 *      `SQLITE_CONSTRAINT_UNIQUE` (ошибка 2dc32e85).
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
  if (clash) throw duplicateNameError(clash.id, clash.name, requestId);
  const occupied = findThoughtTypeViewNameOccupancy(ndb, thoughtTypeId, nameKey, exceptId);
  if (occupied) throw duplicateNameError(occupied.id, occupied.name, requestId);
}

/** Нарушение натурального ключа имени (UNIQUE `(type, name_key, layer_id)`). */
function isNameKeyConstraint(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string' || !code.startsWith('SQLITE_CONSTRAINT')) return false;
  return (err as Error).message.includes('thought_type_views');
}

/**
 * Перехватить коллизию натурального ключа при материализации тени/вставке и
 * отдать `409 DUPLICATE` с осмысленными `details`; прочие ошибки — пробросить.
 * Коллизию, найденную репозиторием ДО материализации (тень предкового дефолта
 * против живой одноимённой строки слоя), приходит
 * {@link ThoughtTypeViewNameCollisionError} — её карточка уже содержит id.
 */
function rethrowNameConstraint(
  ndb: NetworkDb,
  thoughtTypeId: string,
  nameKey: string,
  requestId: string | undefined,
  err: unknown,
  exceptId?: string,
): never {
  if (err instanceof ThoughtTypeViewNameCollisionError) {
    throw duplicateNameError(err.existingId, err.existingName, requestId);
  }
  if (!isNameKeyConstraint(err)) throw err;
  const clash =
    findThoughtTypeViewByTypeAndNameKey(ndb, thoughtTypeId, nameKey, exceptId) ??
    findThoughtTypeViewNameOccupancy(ndb, thoughtTypeId, nameKey, exceptId);
  if (clash) throw duplicateNameError(clash.id, clash.name, requestId);
  throw err;
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
  const name = validateViewName(input.name, requestId);
  const description = validateViewDescription(input.description, requestId);
  // Определение: синтаксис JSON + токены по реестру сети + красная диагностика
  // AST + профиль точки применения (общая точка с внетиповыми отборами).
  const validatedDefinition = validateViewDefinitionInput(
    ndb,
    input.definition,
    thoughtTypeId,
    requestId,
  );
  const definition = validatedDefinition.definition;
  const position = validateViewPosition(input.position, requestId);

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

  try {
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
  } catch (err) {
    // Остаточная гонка/материализация тени предкового дефолта: сырой
    // constraint → доменный 409 (ошибка 2dc32e85).
    rethrowNameConstraint(ndb, thoughtTypeId, nameKey, requestId, err);
  }
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
  if (changes.name !== undefined) validated.name = validateViewName(changes.name, requestId);
  if (changes.description !== undefined) {
    validated.description = validateViewDescription(changes.description, requestId);
  }
  if (changes.definition !== undefined) {
    validated.definition = validateViewDefinitionInput(
      ndb,
      changes.definition,
      // Якорь диагностики — тип отбора; он неизвестен до чтения строки, поэтому
      // полная проверка AST повторяется в транзакции ниже. Здесь — синтаксис,
      // токены и профиль (от типа не зависят).
      undefined,
      requestId,
    ).definition;
  }
  const position = validateViewPosition(changes.position, requestId);
  if (position !== undefined) validated.position = position;
  if (changes.is_default !== undefined) validated.is_default = changes.is_default;

  let ownerTypeId: string | undefined;
  let nameKeyForDiag: string | undefined;

  try {
    return ndb.transaction(() => {
      const current = getViewOrThrow(ndb, viewId, requestId);
      ownerTypeId = current.thought_type_id;
      // Имя не менялось — для диагностики constraint всё равно нужно текущее:
      // materializeShadow/clearDefault могут столкнуться с занятым именем слоя.
      nameKeyForDiag = current.name_key;
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
        // Полная валидация с ЯКОРЕМ типа отбора (требование 44d61c8a): вне
        // транзакции якорь неизвестен, поэтому красная диагностика AST
        // повторяется здесь. До UPDATE — иначе можно сохранить невалидное
        // определение.
        validated.definition = validateViewDefinitionInput(
          ndb,
          validated.definition,
          current.thought_type_id,
          requestId,
        ).definition;
      }

      if (validated.name !== undefined) {
        const newKey = viewNameKey(validated.name);
        nameKeyForDiag = newKey;
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
  } catch (err) {
    if (ownerTypeId !== undefined && nameKeyForDiag !== undefined) {
      rethrowNameConstraint(ndb, ownerTypeId, nameKeyForDiag, requestId, err, viewId);
    }
    throw err;
  }
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
 * Форма мысли для СМЕШАННОГО эффективного набора (0.14.1, требование
 * 045f539a): нужен `id`, чтобы добавить внетиповые отборы самой мысли.
 */
export interface ThoughtWithIdForEffectiveViews extends ThoughtForEffectiveViews {
  id: string;
}

/**
 * Эффективный набор ТИПОВЫХ отборов для мысли (требование eaca1253).
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
 * `position`. Форма намеренно БЕЗ `scope`: type-only путь (редактор типа и
 * `GET /thought-types/{id}/views*`) не меняется (0.14.1).
 */
function computeEffectiveTypeViews(
  ndb: NetworkDb,
  thoughtTypeId: string | null,
): EffectiveThoughtTypeView[] {
  const root = getRootThoughtType(ndb);
  if (!root) return [];

  // Цепочка ОТ ТИПА МЫСЛИ К КОРНЮ (ближайший уровень — первый).
  const fromTypeToRoot: string[] =
    thoughtTypeId === null
      ? [root.id]
      : thoughtTypeChain(ndb, thoughtTypeId);

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
  const ownTypeId = thoughtTypeId ?? root.id;
  const out: EffectiveThoughtTypeView[] = [];
  for (const typeId of fromRootToType) {
    for (const row of repoListByType(ndb, typeId)) {
      const winner = winnerByKey.get(row.name_key);
      if (!winner || winner.defined_on !== typeId) continue;
      const base = rowToView(winner.row);
      out.push({
        ...base,
        defined_on: winner.defined_on,
        inherited: winner.defined_on !== ownTypeId,
        is_default: winner.row.name_key === effectiveDefaultKey,
      });
    }
  }

  return out;
}

/**
 * Смешанный эффективный набор мысли (требование 045f539a): типовые отборы
 * (по цепочке) + внетиповые отборы самой мысли.
 *
 * Правила:
 *   * одноимённый (по `name_key`) внетиповой перекрывает типовой ЦЕЛИКОМ —
 *     типовой не попадает в набор (ни определение, ни дефолт);
 *   * межслойные одноимённые живые внетиповые схлопываются по `name_key`
 *     детерминированно: действует первый по `position, name` (одна кнопка,
 *     run по имени однозначен);
 *   * порядок: сначала типовые (от корня к типу, внутри уровня по `position`),
 *     затем внетиповые по `position, name`;
 *   * «по умолчанию»: у мысли не более одного дефолта. Дефолит внетиповой
 *     с пометкой (любой — он перекрывает типовой дефолт); иначе типовой
 *     дефолт, ЕСЛИ он не перекрыт одноимённым не-дефолтным внетиповым.
 *     Не-одноимённый не-дефолтный внетиповой типовой дефолт не трогает.
 *     Если дефолтов несколько после слияния слоёв — первый по
 *     `position, name`;
 *   * каждый элемент несёт `scope`/`defined_on`; у внетипового
 *     `inherited: false` и нет `thought_type_id`.
 */
function mergeEffectiveCustomViews(
  ndb: NetworkDb,
  thoughtId: string,
  typeViews: EffectiveThoughtTypeView[],
): EffectiveThoughtView[] {
  // `_v` уже свёрнут по слоям и упорядочен `position, name`. Одноимённые из
  // РАЗНЫХ слоёв (разные id) схлопываются: первый по порядку побеждает.
  const customByKey = new Map<string, ReturnType<typeof repoListCustom>[number]>();
  for (const row of repoListCustom(ndb, thoughtId)) {
    if (!customByKey.has(row.name_key)) customByKey.set(row.name_key, row);
  }
  const customs = [...customByKey.values()];

  // Эффективный внетиповой дефолт — первый по `position, name` (порядок
  // `customs` сохраняет сортировку репозитория).
  let customDefaultId: string | null = null;
  for (const row of customs) {
    if (row.is_default === 1) {
      customDefaultId = row.id;
      break;
    }
  }

  const out: EffectiveThoughtView[] = [];
  for (const view of typeViews) {
    // Перекрытие внетиповым — типовой исчезает целиком, вместе с дефолтом.
    if (customByKey.has(view.name_key)) continue;
    out.push({
      ...view,
      scope: 'type',
      // Дефолт мысли — внетиповой с пометкой (045f539a); он перекрывает
      // типовой дефолт, поэтому типовой сохраняет пометку, только пока
      // внетипового дефолта нет. Не-дефолтные внетиповые типовой дефолт не
      // трогают: снять его может лишь ОДНОИМЁННЫЙ внетиповой — тогда типовой
      // уходит из набора целиком (continue выше), и в наборе дефолта нет —
      // при фокусе открывается «Потомки».
      is_default: customDefaultId === null ? view.is_default : false,
    });
  }
  for (const row of customs) {
    out.push({
      id: row.id,
      name: row.name,
      name_key: row.name_key,
      description: row.description,
      definition: row.definition,
      position: row.position,
      is_default: row.id === customDefaultId,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
      created_by: row.created_by,
      scope: 'thought',
      defined_on: thoughtId,
      inherited: false,
    });
  }
  return out;
}

/**
 * Эффективный набор отборов для мысли.
 *
 * Две формы входа (требование 045f539a):
 *   * `{ type_id }` — прежний TYPE-ONLY путь: набор типовых отборов по цепочке
 *     без `scope` (редактор типа, `GET /thought-types/{id}/views*`);
 *   * `{ id, type_id }` — СМЕШАННЫЙ набор: типовые + внетиповые мысли, каждый
 *     со `scope`/`defined_on` (карточки MCP, исполнение, полоса отборов).
 */
export function getEffectiveViewsForThought(
  ndb: NetworkDb,
  thought: ThoughtWithIdForEffectiveViews,
): EffectiveThoughtView[];
export function getEffectiveViewsForThought(
  ndb: NetworkDb,
  thought: ThoughtForEffectiveViews,
): EffectiveThoughtTypeView[];
export function getEffectiveViewsForThought(
  ndb: NetworkDb,
  thought: ThoughtForEffectiveViews | ThoughtWithIdForEffectiveViews,
): EffectiveThoughtTypeView[] | EffectiveThoughtView[] {
  const typeViews = computeEffectiveTypeViews(ndb, thought.type_id);
  if (!('id' in thought) || typeof thought.id !== 'string') {
    // Type-only путь: форма ответа не меняется (инвариант редактора типа).
    return typeViews;
  }
  return mergeEffectiveCustomViews(ndb, thought.id, typeViews);
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
  const out: ThoughtPropertyValue[] = [];
  const raw = getPropertyValues(ndb, 'thought', thoughtId);
  if (raw.length > 0) {
    const meta = typeId === null
      ? new Map<string, { multiple: boolean; value_type: typeof raw[number]['value_type'] }>()
      : new Map(
        listEffectiveTypeProperties(ndb, 'thought_type', typeId).map((p) => [
          p.key,
          { multiple: p.config?.multiple === true, value_type: p.value_type },
        ] as const),
      );
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
  }
  // Свойства-СВЯЗИ: их значений в `property_values` нет вовсе (проекция «ребро →
  // свойство», ADR «проекция ребра»), поэтому `$thought.[<Имя>]` для свойства-
  // связи обязано читать цель рёбер (требование 3697eb65: `$thought.[…]` —
  // значение свойства СЕТИ, обе стороны свойства адресуемы).
  out.push(...collectThoughtLinkPropertyValues(ndb, thoughtId));
  return out;
}

/**
 * Значения свойств-СВЯЗЕЙ мысли для резолвера токенов `$thought.[<Имя>]`:
 * имя и направление — из {@link listThoughtLinkProperties} (прямая и обратная
 * сторона свойства, зеркала, внетиповые рёбра), цели — из рёбер
 * ({@link getLinkPropertyValues}). Одно живое ребро — СКАЛЯР (id цели, чтобы
 * работал `eq`), несколько — СПИСОК (наборы/`in`); пустой набор в карту не
 * попадает — это ПУСТОЕ значение по семантике A6 (условие сравнивается с
 * пустотой, а не даёт неразрешимый токен).
 */
function collectThoughtLinkPropertyValues(
  ndb: NetworkDb,
  thoughtId: string,
): ThoughtPropertyValue[] {
  const out: ThoughtPropertyValue[] = [];
  const seen = new Set<string>();
  for (const lp of listThoughtLinkProperties(ndb, thoughtId)) {
    const key = lp.property_name.trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    const targets = getLinkPropertyValues(ndb, 'thought', thoughtId, lp.link_type_id, lp.direction)
      .map((item) => item.target_id);
    if (targets.length === 0) continue;
    out.push({
      key,
      value_type: 'link',
      multiple: targets.length > 1,
      value: targets.length === 1 ? targets[0]! : targets,
    });
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

/**
 * Определение, которое можно исполнить относительно мысли: отбор типа,
 * внетиповой отбор мысли или запись смешанного эффективного набора
 * (0.14.1). Сохранённый отбор типа по-прежнему узнаётся по наличию
 * `thought_type_id` (нет `scope`).
 */
export type RunnableView = ThoughtTypeView | ThoughtCustomView | EffectiveThoughtView;

/** Владелец отбора: у записи набора — `scope`, у собственной строки — по виду. */
function viewScopeOf(view: RunnableView): ThoughtViewScope {
  if ('scope' in view) return view.scope;
  return 'thought_id' in view ? 'thought' : 'type';
}

export async function runViewForThought(
  ndb: NetworkDb,
  view: RunnableView,
  thoughtId: string,
  userId: string,
  requestId?: string,
  options?: RunViewQueryOptions,
): Promise<RunViewResult> {
  // Тонкая обёртка над единой доменной точкой (задача 0e7e89f5): от сохранённого
  // отбора зависят лишь `view.definition` и якорь диагностики. У внетипового
  // отбора владелец — мысль, поэтому якорь жёлтой диагностики — тип
  // КОНТЕКСТНОЙ мысли (не подменять владельца, операция 5e55b7bb).
  const scope = viewScopeOf(view);
  const thoughtTypeId: string | null =
    scope === 'thought'
      ? (getThought(ndb, thoughtId)?.type_id ?? null)
      : ('thought_type_id' in view ? view.thought_type_id : null);
  return executeViewDefinitionForThought(ndb, {
    definition: JSON.parse(view.definition) as Record<string, unknown>,
    thoughtTypeId,
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

  // Кэш результата (задача 3f2b0958, ошибка 49e05ea0). Точка одна для REST и
  // MCP: ключ нормализован (сеть, слой, соединение, пользователь, фокус, тип,
  // определение и параметры запуска), поэтому обе формы входа делят записи
  // только при одинаковом ключе. Проверки выше (доступ — в фасадах, мысль и
  // токены — здесь) уже выполнены; попадание не обходит их.
  //
  // `collectStats` — диагностический режим журналирования: длительности в
  // ответе не должны браться из чужого прогона, поэтому кэш обходим.
  //
  // Пользователь для ключа — из ТОГО ЖЕ источника, что у движка AST: `$user`
  // резолвится из `tokenContext.userId`, а не из `input.userId`. Транспорты
  // держат их равными, но это не инвариант: при расхождении ключ и результат
  // описывали бы разных пользователей, поэтому кэш fail-closed — не кэшируем.
  const tokenUserId = options?.tokenContext?.userId;
  const userMismatch = tokenUserId !== undefined && tokenUserId !== userId;
  const cacheKey =
    options?.collectStats === true || userMismatch
      ? null
      : buildViewResultCacheKey({
          networkId: ndb.networkId,
          layerId: ndb.layerId,
          instanceId: ndb.instanceId,
          userId: tokenUserId ?? userId,
          // Полный id после резолва короткого префикса (`getThought`) — чтобы
          // `abc12345` и полный UUID одного фокуса не раздваивали ключ.
          thoughtId: thought.id,
          thoughtTypeId: input.thoughtTypeId ?? null,
          definition: parsed,
          ...(options !== undefined ? { options } : {}),
        });
  const cacheGeneration = cacheKey === null ? null : viewResultCacheGeneration(ndb);
  if (cacheKey !== null && cacheGeneration !== null) {
    const cached = lookupViewResult(cacheKey, cacheGeneration);
    if (cached !== null) return cached;
  }
  /** Положить успешный результат в кэш (ошибки сюда не доходят). */
  const finish = (value: RunViewResult): RunViewResult => {
    if (cacheKey !== null && cacheGeneration !== null) {
      storeViewResult(cacheKey, cacheGeneration, value);
    }
    return value;
  };

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
      return finish({
        items: [],
        total: 0,
        directions: {},
        unresolved: resolvedAst.unresolved,
        sort,
        order,
        has_more: false,
        next_cursor: null,
      });
    }
    resolvedDefinition = resolvedAst.definition as Record<string, unknown>;
  } else {
    const resolved = resolveTokensInDefinitionProxy(parsed, resolveContext);

    if (resolved.unresolved.length > 0) {
      return finish({
        items: [],
        total: 0,
        directions: {},
        unresolved: resolved.unresolved,
        sort,
        order,
        has_more: false,
        next_cursor: null,
      });
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
  return finish({
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
  });
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
