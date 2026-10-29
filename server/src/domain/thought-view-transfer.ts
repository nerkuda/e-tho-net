/**
 * Перенос владельца отбора между мыслью и типом (0.14.1, задача e5ed05af;
 * операция 85414fbd «move-to-type и move-to-thought», требование 6a7d2292,
 * ADR 6021918b).
 *
 * Два направления одного жизненного цикла «вне типа ↔ тип»:
 *
 *   * {@link moveThoughtCustomViewToType} — внетиповой отбор мысли становится
 *     отбором типа этой мысли (появляется у всех мыслей типа);
 *   * {@link moveThoughtTypeViewToThought} — отбор типа становится внетиповым
 *     у указанной мысли (исчезает у всех прочих; для унаследованного —
 *     у всех типов-потомков предка-владельца).
 *
 * Перенос — одна транзакция: приём строки в таблицу-получатель через
 * `transfer*Row` (upsert по `(id, layer_id)` с оживлением надгробия и
 * сохранением `base_version`) + `deleteRowLayered` источника. `id`,
 * определение, описание, автор и дата создания сохраняются; `version`
 * начинается заново (1); `position` — в конец получателя; `is_default`
 * переносится, только если у получателя нет **видимого собственного** дефолта
 * (`*_v`, включая Основу; унаследованный от типа-предка не в счёт).
 *
 * Владелец `viewId` сверяется с адресом из пути: чужой отбор — 404 с
 * фактическим владельцем в `details.defined_on`. Для унаследованного отбора
 * типа адрес — `defined_on` (тип-владелец), а не тип фокуса.
 *
 * События пары публикует REST-фасад после коммита (`reason: 'moved'` с
 * `moved_to` у `.deleted`): домен транспорта не знает.
 *
 * Граница: переносы — только REST/GUI (MCP-инструмент не вводится,
 * операция 85414fbd).
 */

import { EtnError, type ThoughtCustomView, type ThoughtTypeView } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { deleteRowLayered } from '../db/layer-write.js';

import { getThought } from './thought-service.js';
import {
  findThoughtCustomViewByThoughtAndNameKey,
  transferThoughtCustomViewRow,
} from './thought-custom-views-repo.js';
import { getThoughtCustomView } from './thought-custom-views-service.js';
import { transferThoughtTypeViewRow } from './thought-type-views-repo.js';
import { assertNameAvailable, getThoughtTypeView } from './thought-type-views-service.js';

/** Результат переноса «вне типа → тип»: источник (для `.deleted`) + новая карточка. */
export interface CustomViewMovedToType {
  /** Карточка отбора у нового владельца (собственная строка типа). */
  view: ThoughtTypeView;
  /** Карточка источника ДО переноса — payload `thought-custom-view.deleted`. */
  source: ThoughtCustomView;
  /** Id типа-получателя (он же `moved_to` события). */
  type_id: string;
}

/** Результат переноса «тип → вне»: источник (для `.deleted`) + новая карточка. */
export interface TypeViewMovedToThought {
  /** Карточка отбора у нового владельца (внетиповая строка мысли). */
  view: ThoughtCustomView;
  /** Карточка источника ДО переноса — payload `thought-type-view.deleted`. */
  source: ThoughtTypeView;
  /** Id мысли-получателя (он же `moved_to` события). */
  thought_id: string;
}

/** `404`: отбор не принадлежит адресату пути (фактический владелец — в details). */
function ownerMismatch(
  entity: 'thought_custom_view' | 'thought_type_view',
  ownerField: 'thought_id' | 'type_id',
  ownerValue: string,
  viewId: string,
  actualOwner: string | null,
  requestId?: string,
): EtnError {
  return new EtnError(
    'NOT_FOUND',
    `У владельца ${ownerValue} нет отбора ${viewId}.`,
    {
      entity,
      id: viewId,
      [ownerField]: ownerValue,
      // Фактический владелец — чтобы клиент мог переадресовать команду
      // (унаследованный отбор адресуется по `defined_on`).
      defined_on: actualOwner,
    },
    requestId,
  );
}

/** `404`: мысль-владелец/цель отсутствует или лежит в корзине. */
function thoughtUnavailable(thoughtId: string, requestId?: string): EtnError {
  return new EtnError(
    'NOT_FOUND',
    `Мысль ${thoughtId} не найдена или находится в корзине.`,
    { entity: 'thought', id: thoughtId },
    requestId,
  );
}

/** `409 DUPLICATE` имени у получателя-мысли — единая форма `details`. */
function duplicateCustomViewName(
  existingId: string,
  existingName: string,
  requestId?: string,
): EtnError {
  return new EtnError(
    'DUPLICATE',
    `У мысли уже есть отбор с именем "${existingName}".`,
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
 * Внетиповой отбор мысли → отбор её типа (операция 85414fbd).
 *
 * Проверки (в этом порядке):
 *   404 — мысль не найдена/в корзине;
 *   404 — `viewId` не принадлежит мысли (`details.defined_on` — фактический
 *         владелец);
 *   422 — у мысли нет типа (`details.code: 'THOUGHT_HAS_NO_TYPE'`);
 *   409 — имя занято **видимым собственным** отбором целевого типа (`*_v`,
 *         включая строку из Основы) либо надгробием `thought_type_views`
 *         этого слоя до слияния; унаследованное от предка имя — законное
 *         переопределение и конфликтом не является.
 *
 * @returns карточка нового владельца, исходная карточка и id типа.
 */
export function moveThoughtCustomViewToType(
  ndb: NetworkDb,
  thoughtId: string,
  viewId: string,
  requestId?: string,
): CustomViewMovedToType {
  const thought = getThought(ndb, thoughtId);
  if (thought === null || thought.marked_for_deletion) {
    throw thoughtUnavailable(thoughtId, requestId);
  }
  const source = getThoughtCustomView(ndb, viewId);
  if (source === null || source.thought_id !== thought.id) {
    throw ownerMismatch(
      'thought_custom_view',
      'thought_id',
      thought.id,
      viewId,
      source?.thought_id ?? null,
      requestId,
    );
  }
  if (thought.type_id === null) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'У мысли нет типа — переносить отбор в отборы типа некуда.',
      {
        code: 'THOUGHT_HAS_NO_TYPE',
        entity: 'thought',
        id: thought.id,
      },
      requestId,
    );
  }
  const typeId = thought.type_id;

  ndb.transaction(() => {
    // Конфликт — с ВИДИМЫМИ живыми строками (`*_v`, включая собственные
    // отборы типа из Основы) и с физическими строками этого слоя (надгробие
    // занимает имя до слияния: UNIQUE 037 без `WHERE deleted = 0`).
    // Одноимённый отбор предка типа — законное переопределение.
    // Единая точка с CREATE/UPDATE — `assertNameAvailable` (проверка раунда 2,
    // S18: раньше проверялся только физический слой и перенос давал 200).
    assertNameAvailable(ndb, typeId, source.name_key, viewId, requestId);

    const outcome = transferThoughtTypeViewRow(ndb, {
      id: source.id,
      thought_type_id: typeId,
      name: source.name,
      name_key: source.name_key,
      description: source.description,
      definition: source.definition,
      is_default: source.is_default,
      created_at: source.created_at,
      created_by: source.created_by,
    });
    if (outcome === 'occupied') {
      // Живая строка получателя с этим id: пара переноса не замкнута —
      // практически недостижимо (ADR 6021918b), но отвечаем штатным 409.
      throw new EtnError(
        'DUPLICATE',
        'Отбор с этим id уже есть у типа-получателя.',
        { entity: 'thought_type_view', id: viewId },
        requestId,
      );
    }
    deleteRowLayered(ndb, 'thought_custom_views', viewId);
  });

  const view = getThoughtTypeView(ndb, viewId);
  if (view === null) {
    throw new Error(`thought_type_view ${viewId} not visible after move`);
  }
  return { view, source, type_id: typeId };
}

/**
 * Отбор типа → внетиповой отбор указанной мысли (операция 85414fbd).
 *
 * Проверки (в этом порядке):
 *   404 — `viewId` не принадлежит типу из пути (`:typeId` для унаследованного
 *         отбора обязан быть `defined_on`); `details.defined_on` — фактический
 *         владелец;
 *   404 — цель не найдена/в корзине (её тип значения не имеет: работает и без
 *         типа);
 *   409 — у цели уже есть живой одноимённый внетиповой отбор.
 *
 * @returns карточка нового владельца, исходная карточка и id мысли.
 */
export function moveThoughtTypeViewToThought(
  ndb: NetworkDb,
  typeId: string,
  viewId: string,
  targetThoughtId: string,
  requestId?: string,
): TypeViewMovedToThought {
  const source = getThoughtTypeView(ndb, viewId);
  if (source === null || source.thought_type_id !== typeId) {
    throw ownerMismatch(
      'thought_type_view',
      'type_id',
      typeId,
      viewId,
      source?.thought_type_id ?? null,
      requestId,
    );
  }
  // `getThought` резолвит короткий префикс id (контракт 85414fbd: как всюду
  // в REST) и возвращает `null` для неизвестного/скрытого слоем.
  const target = getThought(ndb, targetThoughtId);
  if (target === null || target.marked_for_deletion) {
    throw thoughtUnavailable(targetThoughtId, requestId);
  }
  const targetId = target.id;

  ndb.transaction(() => {
    // Собственный одноимённый внетиповой у цели — 409 (в т.ч. занятое живой
    // строкой имя). Надгробие внетиповых имя не занимает (partial unique 052).
    const clash = findThoughtCustomViewByThoughtAndNameKey(
      ndb,
      targetId,
      source.name_key,
      viewId,
    );
    if (clash !== null) throw duplicateCustomViewName(clash.id, clash.name, requestId);

    const outcome = transferThoughtCustomViewRow(ndb, {
      id: source.id,
      thought_id: targetId,
      name: source.name,
      name_key: source.name_key,
      description: source.description,
      definition: source.definition,
      is_default: source.is_default,
      created_at: source.created_at,
      created_by: source.created_by,
    });
    if (outcome === 'occupied') {
      throw new EtnError(
        'DUPLICATE',
        'Отбор с этим id уже есть у мысли-получателя.',
        { entity: 'thought_custom_view', id: viewId },
        requestId,
      );
    }
    deleteRowLayered(ndb, 'thought_type_views', viewId);
  });

  const view = getThoughtCustomView(ndb, viewId);
  if (view === null) {
    throw new Error(`thought_custom_view ${viewId} not visible after move`);
  }
  return { view, source, thought_id: targetId };
}
