/**
 * Доменный сервис внетиповых отборов мысли (`thought_custom_views`, миграция
 * 052; 0.14.1, задача a28d444b; операция 5e55b7bb «CRUD /thoughts/{id}/views»,
 * требование 045f539a «Эффективный набор»).
 *
 * Правила те же, что у отборов типа (037), с владельцем-мыслью:
 *   * имя уникально в пределах мысли-владельца (`name_key`, регистронезависимо)
 *     среди ЖИВЫХ строк → повторное имя `409 DUPLICATE` с `details.existing_id`;
 *   * у мысли не более одного внетипового отбора «по умолчанию»: пометка
 *     снимается с прежнего в той же транзакции;
 *   * `definition` валидируется общей точкой (`thought-view-validation.ts`):
 *     токены `$thought.*` — относительно мысли-владельца, якорь красной/жёлтой
 *     диагностики AST — тип мысли-владельца (у мысли без типа — без якоря);
 *   * позиция нового отбора — MAX+1 среди видимых отборов мысли.
 *
 * Коллизия натурального ключа при материализации тени в слое (правится строка
 * предка, а в слое уже есть живое имя) перехватывается и отдаётся как
 * `409 DUPLICATE`, а не сырой `SQLITE_CONSTRAINT` (контракт 5e55b7bb). То же —
 * для тени предкового ДЕФОЛТА, которую материализует `clearDefaultForThought`
 * перед установкой новой пометки (проверка раунда 1, Б1).
 */

import {
  EtnError,
  type EffectiveThoughtCustomView,
  type ThoughtCustomView,
  type ThoughtCustomViewInput,
  type ThoughtCustomViewUpdateInput,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { getThought } from './thought-service.js';
import {
  validateViewDefinition,
  validateViewDefinitionInput,
  validateViewDescription,
  validateViewName,
  validateViewPosition,
  viewNameKey,
} from './thought-view-validation.js';
import {
  clearDefaultForThought,
  deleteThoughtCustomView as repoDelete,
  findThoughtCustomViewByThoughtAndNameKey,
  getThoughtCustomView as repoGet,
  insertThoughtCustomView as repoInsert,
  listThoughtCustomViewsByThought as repoList,
  ThoughtCustomViewNameCollisionError,
  updateThoughtCustomView as repoUpdate,
  type ThoughtCustomViewRow,
} from './thought-custom-views-repo.js';

/** Доменное представление: `is_default` — boolean (в строке INTEGER). */
function rowToView(row: ThoughtCustomViewRow): ThoughtCustomView {
  return {
    id: row.id,
    thought_id: row.thought_id,
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
 * Карточка внетипового отбора в форме события/эффективного набора: владелец —
 * мысль, `scope: 'thought'`, `defined_on` = id мысли, `inherited: false`,
 * `thought_type_id` отсутствует (не подменять владельца). Единая точка для
 * REST-маршрутов CRUD и переноса (операция 85414fbd) — вторая копия маппинга
 * разошлась бы с первой.
 */
export function toEffectiveCustomView(
  view: ThoughtCustomView,
): EffectiveThoughtCustomView {
  return {
    id: view.id,
    name: view.name,
    name_key: view.name_key,
    description: view.description,
    definition: view.definition,
    position: view.position,
    is_default: view.is_default,
    version: view.version,
    created_at: view.created_at,
    updated_at: view.updated_at,
    created_by: view.created_by,
    scope: 'thought',
    defined_on: view.thought_id,
    inherited: false,
  };
}

/** Отбор по id (без `NOT_FOUND`) — удобно там, где «нет» — нормальный исход. */
export function getThoughtCustomView(
  ndb: NetworkDb,
  viewId: string,
): ThoughtCustomView | null {
  const row = repoGet(ndb, viewId);
  return row ? rowToView(row) : null;
}

/** Список отборов мысли в порядке `position, name`. */
export function listThoughtCustomViews(
  ndb: NetworkDb,
  thoughtId: string,
  options?: { currentLayerOnly?: boolean },
): ThoughtCustomView[] {
  return repoList(ndb, thoughtId, options).map(rowToView);
}

/** `NOT_FOUND` для отсутствующего отбора — единая форма `details`. */
function getViewOrThrow(ndb: NetworkDb, viewId: string, requestId?: string): ThoughtCustomView {
  const view = getThoughtCustomView(ndb, viewId);
  if (view === null) {
    throw new EtnError(
      'NOT_FOUND',
      'Отбор не найден.',
      { entity: 'thought_custom_view', id: viewId },
      requestId,
    );
  }
  return view;
}

/** Мысль-владелец обязана существовать и быть видимой в слое сессии. */
function getOwnerThoughtOrThrow(
  ndb: NetworkDb,
  thoughtId: string,
  requestId?: string,
): { id: string; type_id: string | null } {
  const thought = getThought(ndb, thoughtId);
  if (thought === null) {
    throw new EtnError(
      'NOT_FOUND',
      `Мысль ${thoughtId} не найдена.`,
      { entity: 'thought', id: thoughtId },
      requestId,
    );
  }
  return { id: thought.id, type_id: thought.type_id };
}

/** `DUPLICATE` «имя занято живой строкой» — единая форма `details`. */
function duplicateNameError(
  existingId: string,
  existingName: string,
  requestId?: string,
): EtnError {
  return new EtnError(
    'DUPLICATE',
    `Отбор с именем "${existingName}" уже есть у этой мысли.`,
    {
      entity: 'thought_custom_view',
      field: 'name',
      existing_id: existingId,
      existing_name: existingName,
    },
    requestId,
  );
}

/**
 * Убедиться, что живого отбора с тем же `name_key` в мысли нет (исключая
 * редактируемый). `DUPLICATE` несёт `existing_id`/`existing_name` — клиенту
 * нужно показать «такой отбор уже есть» рядом с полем имени.
 */
function assertNameAvailable(
  ndb: NetworkDb,
  thoughtId: string,
  nameKey: string,
  exceptId: string | undefined,
  requestId?: string,
): void {
  const clash = findThoughtCustomViewByThoughtAndNameKey(ndb, thoughtId, nameKey, exceptId);
  if (clash) throw duplicateNameError(clash.id, clash.name, requestId);
}

/** Нарушение натурального ключа имени (UNIQUE-индекс `..._name_live`). */
function isNameKeyConstraint(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string' || !code.startsWith('SQLITE_CONSTRAINT')) return false;
  return (err as Error).message.includes('thought_custom_views');
}

/**
 * Перехватить коллизию натурального ключа при материализации тени/вставке и
 * отдать `409 DUPLICATE` с осмысленными `details`; прочие ошибки — пробросить.
 * Коллизию, найденную репозиторием ДО материализации (тень предкового дефолта
 * против живой одноимённой строки слоя), приходит {@link
 * ThoughtCustomViewNameCollisionError} — её карточка уже содержит нужный id.
 */
function rethrowNameConstraint(
  ndb: NetworkDb,
  thoughtId: string,
  nameKey: string,
  requestId: string | undefined,
  err: unknown,
  exceptId?: string,
): never {
  if (err instanceof ThoughtCustomViewNameCollisionError) {
    throw duplicateNameError(err.existingId, err.existingName, requestId);
  }
  if (!isNameKeyConstraint(err)) throw err;
  const clash = findThoughtCustomViewByThoughtAndNameKey(ndb, thoughtId, nameKey, exceptId);
  if (clash) throw duplicateNameError(clash.id, clash.name, requestId);
  throw err;
}

/**
 * Создать внетиповой отбор мысли.
 *
 * Бросает `VALIDATION_ERROR` (422), `DUPLICATE` (409), `NOT_FOUND` (404 —
 * мысль-владелец не видна).
 */
export function createThoughtCustomView(
  ndb: NetworkDb,
  thoughtId: string,
  input: ThoughtCustomViewInput,
  actorUserId: string,
  requestId?: string,
): ThoughtCustomView {
  // Валидация payload — до транзакции: провал не держит write-lock.
  const name = validateViewName(input.name, requestId);
  const description = validateViewDescription(input.description, requestId);
  const position = validateViewPosition(input.position, requestId);
  const owner = getOwnerThoughtOrThrow(ndb, thoughtId, requestId);
  const definition = validateViewDefinitionInput(
    ndb,
    input.definition,
    owner.type_id,
    requestId,
  ).definition;

  const nameKey = viewNameKey(name);
  assertNameAvailable(ndb, owner.id, nameKey, undefined, requestId);

  try {
    return ndb.transaction(() => {
      if (input.is_default === true) clearDefaultForThought(ndb, owner.id);
      const created = repoInsert(
        ndb,
        {
          thought_id: owner.id,
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
    rethrowNameConstraint(ndb, owner.id, nameKey, requestId, err);
  }
}

/**
 * Правка внетипового отбора (частичная, last-write-wins по полям).
 *
 * Бросает `NOT_FOUND` (404), `VERSION_CONFLICT` (409), `VALIDATION_ERROR` (422),
 * `DUPLICATE` (409).
 */
export function updateThoughtCustomView(
  ndb: NetworkDb,
  viewId: string,
  changes: ThoughtCustomViewUpdateInput,
  expectedVersion: number | undefined,
  requestId?: string,
): ThoughtCustomView {
  const validated: ThoughtCustomViewUpdateInput = {};
  if (changes.name !== undefined) validated.name = validateViewName(changes.name, requestId);
  if (changes.description !== undefined) {
    validated.description = validateViewDescription(changes.description, requestId);
  }
  // Синтаксис — сразу; токены/AST-диагностика с якорем типа владельца — в
  // транзакции (тип и версия читаются там же).
  if (changes.definition !== undefined) {
    validated.definition = validateViewDefinition(changes.definition, requestId);
  }
  const position = validateViewPosition(changes.position, requestId);
  if (position !== undefined) validated.position = position;
  if (changes.is_default !== undefined) validated.is_default = changes.is_default;

  let ownerThoughtId: string | undefined;
  let newNameKey: string | undefined;

  try {
    return ndb.transaction(() => {
      const current = getViewOrThrow(ndb, viewId, requestId);
      ownerThoughtId = current.thought_id;
      // Имя не менялось — для диагностики constraint всё равно нужно текущее:
      // materializeShadow может столкнуться с живой одноимённой строкой слоя.
      newNameKey = current.name_key;
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new EtnError(
          'VERSION_CONFLICT',
          'Версия отбора изменилась с момента чтения.',
          {
            entity: 'thought_custom_view',
            id: viewId,
            expected: expectedVersion,
            current: current.version,
          },
          requestId,
        );
      }

      if (validated.definition !== undefined) {
        const thought = getThought(ndb, current.thought_id);
        validated.definition = validateViewDefinitionInput(
          ndb,
          validated.definition,
          thought?.type_id ?? null,
          requestId,
        ).definition;
      }

      if (validated.name !== undefined) {
        const key = viewNameKey(validated.name);
        newNameKey = key;
        if (key !== current.name_key) {
          assertNameAvailable(ndb, current.thought_id, key, viewId, requestId);
        }
      }

      if (validated.is_default === true) {
        clearDefaultForThought(ndb, current.thought_id, viewId);
      }

      const updated = repoUpdate(ndb, viewId, validated);
      return rowToView(updated);
    });
  } catch (err) {
    if (ownerThoughtId !== undefined && newNameKey !== undefined) {
      rethrowNameConstraint(ndb, ownerThoughtId, newNameKey, requestId, err, viewId);
    }
    throw err;
  }
}

/** Удалить внетиповой отбор. Неизвестный id → `NOT_FOUND` (404). */
export function deleteThoughtCustomView(
  ndb: NetworkDb,
  viewId: string,
  requestId?: string,
): void {
  getViewOrThrow(ndb, viewId, requestId);
  repoDelete(ndb, viewId);
}

// ===========================================================================
// Батч-запись отборов одной мысли (0.14.1, задача 769fde88; операция
// 97d1a0d3, ADR 2a758041) — доменная половина `etn.custom_views.write`.
//
// Семантика — REST CRUD тех же отборов, собранная в один батч:
//   * дискриминатор `action: create|update|delete`;
//   * `create.ref` — локальный псевдоним батча, резолвится вторым проходом
//     (допустим ref вперёд и create+delete в одном батче) по образцу
//     `type_views` онтологии;
//   * `update`/`delete` адресуют отбор `id` (полный id живого отбора ЭТОЙ
//     мысли; чужой — `NOT_FOUND`) XOR локальным `ref`;
//   * `on_duplicate` действует на `create` при совпадении `name_key` в
//     пределах мысли: `fail` (по умолчанию) — `DUPLICATE` с `existing_id`,
//     `reuse` — существующая карточка без события, `update` — правка
//     существующего (`updated`);
//   * пустой патч update и два create одного имени в батче —
//     `VALIDATION_ERROR`.
//
// Транзакцию, события и аудит оркестрирует фасад (`runWrite` MCP): сервис
// возвращает только результат и список фактических изменений — payload
// событий собирается из карточки, вернувшейся из домена (требование 7f526da1).
// ===========================================================================

/** Один элемент батча `etn.custom_views.write` (после валидации схемой). */
export interface ThoughtCustomViewWriteItem {
  action: 'create' | 'update' | 'delete';
  ref?: string;
  id?: string;
  name?: string;
  description?: string | null;
  definition?: string;
  position?: number;
  is_default?: boolean;
  expected_version?: number;
  on_duplicate?: 'fail' | 'reuse' | 'update';
}

/** Карточка create/update/reuse — полная строка отбора (как у REST CRUD). */
export type ThoughtCustomViewWriteResultItem =
  | ThoughtCustomView
  | { action: 'deleted'; id: string };

/** Фактическое изменение — фасад превращает его в real-time-событие. */
export type ThoughtCustomViewChange =
  | { action: 'created'; view: ThoughtCustomView }
  | { action: 'updated'; view: ThoughtCustomView; changes: ThoughtCustomViewUpdateInput }
  | { action: 'deleted'; view: ThoughtCustomView };

/** Итог батча: `items` по порядку входа + изменения для событий. */
export interface ThoughtCustomViewsWriteOutcome {
  items: ThoughtCustomViewWriteResultItem[];
  changed: ThoughtCustomViewChange[];
}

/** `VALIDATION_ERROR` с адресом элемента батча (`views[i].<field>`). */
function invalidViewItem(
  index: number,
  message: string,
  details: Record<string, unknown>,
  requestId?: string,
): never {
  throw new EtnError(
    'VALIDATION_ERROR',
    message,
    { entity: 'thought_custom_view', field: `views[${index}]`, ...details },
    requestId,
  );
}

/** Адрес отбора: полный `id` живого отбора этой мысли. */
function requireOwnedView(
  ndb: NetworkDb,
  thoughtId: string,
  viewId: string,
  index: number,
  requestId?: string,
): ThoughtCustomView {
  const view = getThoughtCustomView(ndb, viewId);
  if (view === null || view.thought_id !== thoughtId) {
    throw new EtnError(
      'NOT_FOUND',
      `У мысли ${thoughtId} нет отбора ${viewId}.`,
      {
        entity: 'thought_custom_view',
        id: viewId,
        thought_id: thoughtId,
        field: `views[${index}].id`,
      },
      requestId,
    );
  }
  return view;
}

/**
 * Применить батч отборов одной мысли. Вызывается внутри транзакции фасада:
 * любое исключение откатывает весь батч («всё или ничего»).
 */
export function writeThoughtCustomViews(
  ndb: NetworkDb,
  thoughtId: string,
  items: readonly ThoughtCustomViewWriteItem[],
  actorUserId: string,
  requestId?: string,
): ThoughtCustomViewsWriteOutcome {
  const owner = getOwnerThoughtOrThrow(ndb, thoughtId, requestId);

  // ---- Предпроверка батча (до записи) ---------------------------------
  const declaredRefs = new Set<string>();
  const createByKey = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    if (item.action === 'create' && item.ref !== undefined) {
      if (declaredRefs.has(item.ref)) {
        invalidViewItem(index, `ref "${item.ref}" объявлен в батче дважды.`, {
          field: `views[${index}].ref`,
          ref: item.ref,
        }, requestId);
      }
      declaredRefs.add(item.ref);
    }
    if (item.action === 'create') {
      if (item.name === undefined) {
        invalidViewItem(index, 'create требует name.', { field: `views[${index}].name` }, requestId);
      }
      if (item.definition === undefined) {
        invalidViewItem(
          index,
          'create требует definition (JSON-строку).',
          { field: `views[${index}].definition` },
          requestId,
        );
      }
      // Два create одного имени в батче — неоднозначный порядок и скрытый
      // DUPLICATE; отвергаем явно (спека операции).
      const nameKey = viewNameKey(validateViewName(item.name, requestId));
      const first = createByKey.get(nameKey);
      if (first !== undefined) {
        invalidViewItem(
          index,
          `Два create одного имени «${item.name}» в батче (первый — views[${first}]).`,
          { field: `views[${index}].name`, first_index: first },
          requestId,
        );
      }
      createByKey.set(nameKey, index);
      continue;
    }
    // update/delete адресуются ровно одним способом.
    const hasId = item.id !== undefined && item.id !== '';
    const hasRef = item.ref !== undefined && item.ref !== '';
    if (hasId === hasRef) {
      invalidViewItem(
        index,
        `${item.action} требует ровно одно из id или ref.`,
        { field: `views[${index}]`, id: item.id ?? null, ref: item.ref ?? null },
        requestId,
      );
    }
    if (item.action === 'update') {
      const hasPatch =
        item.name !== undefined ||
        item.description !== undefined ||
        item.definition !== undefined ||
        item.position !== undefined ||
        item.is_default !== undefined;
      if (!hasPatch) {
        invalidViewItem(
          index,
          'update требует хотя бы одно поле патча (name/description/definition/position/is_default).',
          { field: `views[${index}]` },
          requestId,
        );
      }
    }
  }

  // ---- Применение ------------------------------------------------------
  const results: Array<ThoughtCustomViewWriteResultItem | undefined> = new Array(
    items.length,
  ).fill(undefined);
  const changed: ThoughtCustomViewChange[] = [];
  const idByRef = new Map<string, string>();

  const applyUpdate = (
    index: number,
    item: ThoughtCustomViewWriteItem,
    viewId: string,
  ): void => {
    const patch: ThoughtCustomViewUpdateInput = {};
    if (item.name !== undefined) patch.name = item.name;
    if (item.description !== undefined) patch.description = item.description;
    if (item.definition !== undefined) patch.definition = item.definition;
    if (item.position !== undefined) patch.position = item.position;
    if (item.is_default !== undefined) patch.is_default = item.is_default;
    const updated = updateThoughtCustomView(
      ndb,
      viewId,
      patch,
      item.expected_version,
      requestId,
    );
    results[index] = updated;
    changed.push({ action: 'updated', view: updated, changes: patch });
  };

  const applyDelete = (index: number, viewId: string): void => {
    const before = requireOwnedView(ndb, owner.id, viewId, index, requestId);
    deleteThoughtCustomView(ndb, viewId, requestId);
    results[index] = { action: 'deleted', id: viewId };
    changed.push({ action: 'deleted', view: before });
  };

  for (const [index, item] of items.entries()) {
    if (item.action === 'create') {
      const name = item.name as string;
      const definition = item.definition as string;
      const nameKey = viewNameKey(validateViewName(name, requestId));
      const existing = findThoughtCustomViewByThoughtAndNameKey(ndb, owner.id, nameKey);
      if (existing !== null) {
        const mode = item.on_duplicate ?? 'fail';
        if (mode === 'fail') {
          throw duplicateNameError(existing.id, existing.name, requestId);
        }
        if (mode === 'reuse') {
          // Существующий отбор не меняется и событие не порождает.
          results[index] = rowToView(existing);
          if (item.ref !== undefined) idByRef.set(item.ref, existing.id);
          continue;
        }
        // `update`: create-тело применяется как патч существующего отбора.
        // Патч симметричен (решение проверки V3, 2026-10-23): опущенное поле
        // сохраняет прежнее значение — в том числе `description`; явно
        // переданный `null` по-прежнему очищает описание.
        const patch: ThoughtCustomViewUpdateInput = {
          name,
          definition,
          ...(item.description !== undefined ? { description: item.description } : {}),
          ...(item.position !== undefined ? { position: item.position } : {}),
          ...(item.is_default !== undefined ? { is_default: item.is_default } : {}),
        };
        const updated = updateThoughtCustomView(ndb, existing.id, patch, undefined, requestId);
        results[index] = updated;
        changed.push({ action: 'updated', view: updated, changes: patch });
        if (item.ref !== undefined) idByRef.set(item.ref, updated.id);
        continue;
      }
      const created = createThoughtCustomView(
        ndb,
        owner.id,
        {
          name,
          definition,
          ...(item.description !== undefined ? { description: item.description } : {}),
          ...(item.position !== undefined ? { position: item.position } : {}),
          ...(item.is_default !== undefined ? { is_default: item.is_default } : {}),
        },
        actorUserId,
        requestId,
      );
      results[index] = created;
      changed.push({ action: 'created', view: created });
      if (item.ref !== undefined) idByRef.set(item.ref, created.id);
      continue;
    }
    if (item.action === 'update') {
      if (item.id !== undefined) {
        requireOwnedView(ndb, owner.id, item.id, index, requestId);
        applyUpdate(index, item, item.id);
      }
      // Адрес по ref резолвится вторым проходом.
      continue;
    }
    // delete
    if (item.id !== undefined) applyDelete(index, item.id);
  }

  // ---- Второй проход: update/delete по локальному ref -----------------
  for (const [index, item] of items.entries()) {
    if (item.action === 'create' || item.id !== undefined) continue;
    const ref = item.ref as string;
    const viewId = idByRef.get(ref);
    if (viewId === undefined) {
      invalidViewItem(
        index,
        `ref "${ref}" не удалось разрешить в этом батче.`,
        { field: `views[${index}].ref`, ref, known_refs: [...idByRef.keys()] },
        requestId,
      );
    }
    if (item.action === 'update') applyUpdate(index, item, viewId);
    else applyDelete(index, viewId);
  }

  return {
    items: results.map((item) => {
      /* c8 ignore next */
      if (item === undefined) throw new Error('custom views batch left an unresolved item');
      return item;
    }),
    changed,
  };
}
