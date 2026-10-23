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
