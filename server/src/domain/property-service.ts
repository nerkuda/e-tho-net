/**
 * Property service (0.6.5 — «Унификация работы со свойствами»; задачи C5+C6,
 * затем разделение на справочник и привязки).
 *
 * Three concerns live here, all keyed by `owner_type`:
 *   * **Property registry** (`properties`) — the network-wide nature of a
 *     property (name, value type, config, description). A property exists once
 *     and is attached to any number of thought/link types. Name is unique per
 *     network (case-insensitive, `name_key`), checked against the layer view
 *     `properties_v` (02-data-model.md §3.4a).
 *   * **Type bindings** (`type_properties`) — the property's role in one type:
 *     `required`, `position`. Inheritance goes along the type chain (L21); a
 *     binding on an ancestor makes the property visible to every descendant,
 *     and attaching it to an ancestor drops the descendants' redundant
 *     bindings in the same transaction (значения при этом не меняются — они
 *     адресуются свойством, а не привязкой).
 *   * **Property values** (`property_values`) — the actual values stored on
 *     individual thoughts/links. `property_id` references the registry, so a
 *     value survives type changes and detaches: a value whose property is not
 *     attached to the owner's type chain is read back flagged `outside_type`
 *     and can only be deleted, never written (02-data-model.md §3.5a).
 *
 * Reads go through the `*_v` layer views only (lint layers-s3); writes go
 * through `materializeShadow`/`deleteRowLayered` like every other branchable
 * table (13-layers.md §5).
 */

import { randomUUID } from 'node:crypto';

import {
  EtnError,
  LINK_PROPERTY_DIRECTIONS,
  LINK_PROPERTY_SIDES,
  PROPERTY_VALUE_TYPES,
  TYPE_OWNER_TYPES,
  typeNameKey,
  type EffectiveTypeProperty,
  type LinkPropertyDirection,
  type LinkPropertySide,
  type LinkPropertyValueItem,
  type LinkPropertyValues,
  type LinkStyle,
  type NetworkProperty,
  type NetworkPropertyInput,
  type NetworkPropertyUpdateInput,
  type PropertyConfig,
  type PropertyDefinition,
  type PropertyDefinitionInput,
  type PropertyDefinitionUpdateInput,
  type PropertyOwnerType,
  type PropertyUsageBinding,
  type PropertyUsageReport,
  type PropertyValueType,
  type PropertyValue,
  type PropertyValueValue,
  type RegistryPropertyCounters,
  type ResolvedLinkProperty,
  type ResolvedPropertyValue,
  type MutationWarning,
  type ThoughtCardWarning,
  type ThoughtUsage,
  type ThoughtUsageGroup,
  type TypeOwnerType,
} from '@etn/shared';

// Формы usage-отчёта и счётчиков справочника переехали в общий модуль
// `@etn/shared` (задача 120385ba): одна форма ответа на обе стороны.
// Реэкспорт сохранён для существующих импортов из домена.
export type { PropertyUsageBinding, PropertyUsageReport, RegistryPropertyCounters };

import type { NetworkDb } from '../db/network-db.js';
import { deleteRowLayered, isBaseContext, materializeShadow } from '../db/layer-write.js';
import { propertyValueId } from '../db/property-value-id.js';
import { getLinkType, createLinkType, updateLinkType, deleteLinkType } from './link-type-service.js';
import { findLinkTripleRow, restoreLinkRow } from './link-live-triple.js';
import { createComment, listComments, updateComment } from './comment-service.js';
import {
  type CrossNetworkRefValue,
  parseCrossNetworkAddress,
} from '@etn/shared';
import {
  type CrossNetworkAccessContext,
  deleteSnapshotPayload,
  readCrossNetworkRefValue,
  readSnapshotPayload,
  resolveAndBuildSnapshotsForWrite,
  resolveCrossNetworkRef,
  type CrossRefSnapshotItem,
  upsertSnapshotPayload,
} from './cross-network-ref-service.js';
import { rowToThoughtRef } from './thought-service.js';
import {
  expandTypeIdsToSubtree,
  getRootTypeId,
  subtreeIds,
  typeAncestors,
  type TypeTable,
} from './type-hierarchy.js';

// ===========================================================================
// Shared helpers
// ===========================================================================

/** The minimal nature of a property needed to validate/write a value. */
export interface PropertyLike {
  id: string;
  name: string;
  value_type: PropertyValueType;
  config: PropertyConfig | null;
}

/**
 * Normalize an incoming property description: `null`/blank → `null` (no
 * description), otherwise the trimmed string.
 */
function normalizeDescription(description: unknown): string | null {
  if (description === undefined || description === null) return null;
  if (typeof description !== 'string') {
    throw new EtnError('VALIDATION_ERROR', 'description must be a string or null', {
      field: 'description',
    });
  }
  const trimmed = description.trim();
  return trimmed === '' ? null : trimmed;
}

/** Validate a property name: non-empty string. */
function validateKey(key: unknown): string {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new EtnError('VALIDATION_ERROR', 'property key must be a non-empty string', {
      field: 'key',
    });
  }
  return key.trim();
}

/**
 * Validate a value type for a NEW or CHANGED registry property definition.
 * `thought_ref` упразднён (ADR «вид значения thought_ref упраздняется»,
 * миграция 040 перевела унаследованные свойства в свойства-связи) — вида
 * нет ни в коде, ни в реестре. `cross_network_ref` (0.8.3, задача 7849008a)
 * — допустимый вид: кросс-сетевая ссылка.
 */
function validateValueType(valueType: unknown): PropertyValueType {
  if (
    typeof valueType !== 'string' ||
    !(PROPERTY_VALUE_TYPES as readonly string[]).includes(valueType)
  ) {
    throw new EtnError('VALIDATION_ERROR', `invalid value_type: ${String(valueType)}`, {
      field: 'value_type',
      allowed: PROPERTY_VALUE_TYPES,
    });
  }
  // Legacy (миграция 040): `thought_ref` оставлен в PROPERTY_VALUE_TYPES
  // для компиляции тестов и импорта архивов, но создание/правка свойств этого
  // вида отвергается рантайм-guard'ом — унаследованные ссылки уже стали
  // свойствами-связями, новых быть не должно.
  if (valueType === 'thought_ref') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'value_type "thought_ref" упразднён (миграция 040); используйте свойство-связь',
      { field: 'value_type' },
    );
  }
  return valueType as PropertyValueType;
}

/** Validate an owner type for type_properties ('thought_type' | 'link_type'). */
function validateTypeOwnerType(ownerType: unknown): TypeOwnerType {
  if (
    typeof ownerType !== 'string' ||
    !(TYPE_OWNER_TYPES as readonly string[]).includes(ownerType)
  ) {
    throw new EtnError('VALIDATION_ERROR', `invalid owner_type: ${String(ownerType)}`, {
      field: 'owner_type',
    });
  }
  return ownerType as TypeOwnerType;
}

/** The type table that stores owners of the given binding owner type. */
function ownerTypeTable(ownerType: TypeOwnerType): TypeTable {
  return ownerType === 'thought_type' ? 'thought_types' : 'link_types';
}

/**
 * Обновить `updated_at`/`updated_by`/`updated_at_ms` типа (требование e6d4165e,
 * приравнивание «правка настроек типа → правка самого типа»). Все настройки —
 * подключение свойств, дефолты, описание, реордеринг — касаются типа как
 * сущности и должны быть видны в его DTO.
 *
 * Вызывается внутри уже открытой транзакции (все остальные правки
 * type_properties / type_property_overrides) и сам открывает теневую копию
 * по правилам S4 (13-layers.md §5.1).
 */
function touchType(ndb: NetworkDb, ownerType: TypeOwnerType, ownerId: string, actorUserId: string): void {
  const table = ownerTypeTable(ownerType);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  materializeShadow(ndb, table, ownerId);
  ndb
    .prepare(
      `UPDATE ${table} SET updated_at = ?, updated_by = ?, updated_at_ms = ?, version = version + 1
       WHERE id = ? AND layer_id = ?`,
    )
    .run(now, actorUserId, nowMs, ownerId, ndb.layerId);
}

/**
 * Обновить `updated_at`/`updated_by`/`updated_at_ms` владельца значения
 * свойства (мысли или связи) — требование e6d4165e, приравнивание
 * «правка значения свойства → правка владельца». Без этого `updated_by`
 * карточки мысли застывал бы на времени создания, и вкладка «Метаданные»
 * врала бы.
 *
 * Открывает теневую копию владельца в текущем слое; записи `value_*` и
 * `property_values.updated_at` остаются независимыми (миллисекундные даты
 * значения и владельца могут различаться на пару мс).
 *
 * `version` владельца НЕ инкрементируется (ошибка af104f16). Версия мысли/
 * связи — оптимистическая блокировка её СОБСТВЕННЫХ полей (PATCH `If-Match`,
 * 03-server-api.md §6.4); запись значения свойства идёт отдельным маршрутом
 * без `If-Match` (§9) и версию владельца как контракт не несёт. Инкремент
 * делал бы любой открытый редактор протухшим: после правки свойства (в том
 * числе чужим клиентом — событие `property-value.set` версию не доносит)
 * следующее сохранение реквизита мысли падало бы `409 VERSION_CONFLICT`,
 * хотя поля разные и мысль не захвачена. Авторство владельца при этом
 * обновляется — приравнивание требование e6d4165e задаёт по `updated_*`,
 * не по `version`.
 */
function touchOwner(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  actorUserId: string,
): void {
  const table = ownerType === 'thought' ? 'thoughts' : 'links';
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  materializeShadow(ndb, table, ownerId);
  ndb
    .prepare(
      `UPDATE ${table} SET updated_at = ?, updated_by = ?, updated_at_ms = ?
       WHERE id = ? AND layer_id = ?`,
    )
    .run(now, actorUserId, nowMs, ownerId, ndb.layerId);
}

/** Display name of a type from its owner table (link types: «fwd / rev»). */
function ownerTypeName(ndb: NetworkDb, ownerType: TypeOwnerType, ownerId: string): string {
  if (ownerType === 'thought_type') {
    const row = ndb.prepare('SELECT name FROM thought_types_v WHERE id = ?').get(ownerId) as
      | { name: string }
      | undefined;
    return row?.name ?? ownerId;
  }
  const row = ndb
    .prepare('SELECT name_forward, name_reverse FROM link_types_v WHERE id = ?')
    .get(ownerId) as { name_forward: string; name_reverse: string } | undefined;
  return row ? `${row.name_forward} / ${row.name_reverse}` : ownerId;
}

// ===========================================================================
// Link properties (0.8.1) — проекция типизированных рёбер в свойства
// ===========================================================================

/**
 * Направление свойства-связи (0.8.1, задача e1fbf304; требование b9562306):
 * если передан `side` (из привязки), он имеет приоритет — направление
 * переехало в привязку. Иначе — fallback на `config.direction` (для
 * совместимости с привязками, созданными до миграции 041, и для свойств,
 * у которых `side` не вычислен — скаляры, структурные).
 *
 * Экспортирована для `query-service.ts` (задача 20effcbd, отбор по свойствам-связям) —
 * единая точка интерпретации, без дублирования логики в движке отбора.
 */
export function linkPropertyDirection(
  config: PropertyConfig | null,
  side: LinkPropertySide | null = null,
): LinkPropertyDirection {
  if (side === 'source') return 'out';
  if (side === 'target') return 'in';
  return config?.direction === 'in' ? 'in' : 'out';
}

/**
 * Валидировать сторону привязки (`type_properties.side`); для скалярных и
 * структурных свойств сторона обязана быть `null`. Возвращает нормализованное
 * значение (`null` для не-link).
 */
function validateLinkSide(
  side: unknown,
  valueType: PropertyValueType,
  config: PropertyConfig | null,
): LinkPropertySide | null {
  if (valueType !== 'link') {
    if (side !== null && side !== undefined) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'сторона привязки задаётся только для свойств-связей',
        { field: 'side', side },
      );
    }
    return null;
  }
  // Структурное свойство-связь: направление хранится в `config.direction`,
  // колонка `side` остаётся пустой (см. миграцию 041).
  if (config?.structural === true) {
    if (side !== null && side !== undefined) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'структурное свойство-связь не имеет стороны — направление в config.direction',
        { field: 'side', side },
      );
    }
    return null;
  }
  if (side === null || side === undefined) {
    return null; // выводится из config.direction вызывающим кодом
  }
  if (!(LINK_PROPERTY_SIDES as readonly string[]).includes(side as string)) {
    throw new EtnError('VALIDATION_ERROR', `invalid side: ${String(side)}`, {
      field: 'side',
      allowed: LINK_PROPERTY_SIDES,
    });
  }
  return side as LinkPropertySide;
}

/**
 * Вывести сторону привязки из `config.direction` (для обратной совместимости
 * с привязками, созданными до миграции 041). `out` → `source`, `in` →
 * `target`. Возвращает `null` для скалярных/структурных свойств.
 */
export function linkPropertySideFromConfig(
  valueType: PropertyValueType,
  config: PropertyConfig | null,
): LinkPropertySide | null {
  if (valueType !== 'link') return null;
  if (config?.structural === true) return null;
  return config?.direction === 'in' ? 'target' : 'source';
}

/**
 * Прочитать сторону привязки из строки `type_properties` (после JOIN с
 * реестром). Колонка `side` после миграции 041 заполняется автоматически;
 * fallback на `config.direction` нужен для строк, существовавших до
 * миграции, и для теневых копий, не успевших синхронизироваться.
 */
export function linkPropertySideFromBinding(row: {
  side: string | null;
  value_type: PropertyValueType;
  config: PropertyConfig | null;
}): LinkPropertySide | null {
  if (row.side !== null && row.side !== undefined) {
    if (row.side === 'source' || row.side === 'target') return row.side;
  }
  return linkPropertySideFromConfig(row.value_type, row.config);
}

/**
 * Сторона привязки свойства-связи у конкретного владельца-мысли (0.8.2, ошибка
 * c67676f3). Направление ЗАПИСИ рёбер обязано совпадать с направлением ЧТЕНИЯ
 * (`emitExplicit`): обе стороны определяет привязка (`type_properties.side`) в
 * цепочке типов владельца, а не `config.direction`. Ищем первое определение
 * свойства в эффективном наборе типа владельца (собственная привязка или
 * унаследованная; зеркала попадают туда же). `side` привязки имеет приоритет,
 * при NULL — fallback на `config.direction` (привязки до миграции 041).
 *
 * `null` — свойства нет в цепочке типов владельца (внетиповое заполнение):
 * вызывающий откатывается на `config.direction`, сохраняя прежнее поведение.
 * Для структурных свойств («Родители»/«Потомки») сторона не определена — тоже
 * `null`, направление берётся из `config.direction`.
 */
export function resolveOwnerBindingSide(
  ndb: NetworkDb,
  ownerId: string,
  propertyId: string,
): LinkPropertySide | null {
  const row = ndb.prepare('SELECT type_id FROM thoughts_v WHERE id = ?').get(ownerId) as
    | { type_id: string | null }
    | undefined;
  const typeId = row?.type_id ?? getRootTypeId(ndb, 'thought_types');
  if (typeId === null) return null;
  for (const def of listEffectiveTypeProperties(ndb, 'thought_type', typeId)) {
    if (def.property_id !== propertyId || def.value_type !== 'link') continue;
    if (isStructuralLinkProperty(def.config)) return null;
    return def.side ?? linkPropertySideFromConfig(def.value_type, def.config);
  }
  return null;
}

/** `source` ↔ `target`. Для вычисления зеркала из исходной стороны. */
export function oppositeSide(side: LinkPropertySide): LinkPropertyDirection {
  return side === 'source' ? 'in' : 'out';
}

/** `true` для структурного свойства-связи (нетипизированные рёбра, `type_id IS NULL`). */
export function isStructuralLinkProperty(config: PropertyConfig | null): boolean {
  return config?.structural === true;
}

/** Id типа связи свойства-связи; `null` — структурное (нетипизированное). */
export function linkPropertyLinkTypeId(config: PropertyConfig | null): string | null {
  const id = config?.link_type_id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Имя свойства-связи, вычисленное из типа связи по направлению (требование
 * 38eaa15c): у источника (`out`) — `name_forward`, у цели (`in`) — `name_reverse`.
 * Имя НЕ хранится в определении свойства и не переопределяется на уровне типа.
 * Если тип связи пропал (удалён/не виден в слое) — fallback на id, чтобы
 * карточка не падала и агент видел, что ссылка повисла.
 */
function linkPropertyDisplayName(
  ndb: NetworkDb,
  linkTypeId: string,
  direction: LinkPropertyDirection,
): string {
  const lt = getLinkType(ndb, linkTypeId);
  if (lt === null) return linkTypeId;
  return direction === 'in' ? lt.name_reverse : lt.name_forward;
}

/**
 * Имя ПРОТИВОПОЛОЖНОЙ стороны свойства-связи (задача df992826): привязка
 * любой стороной делает в условии отбора доступными обе стороны — прямое имя
 * (`name_forward`, сторона источника) и обратное (`name_reverse`, сторона
 * цели). Единая точка интерпретации направления — {@link linkPropertyDirection},
 * чтобы имя совпадало с тем, что показывает чтение карточки мысли.
 *
 * `null` — у скалярных, структурных («Родители»/«Потомки» уже двусторонние,
 * см. миграцию 039) и свойств без типа связи противоположной стороны нет.
 */
export function oppositeLinkPropertyDisplayName(
  ndb: NetworkDb,
  config: PropertyConfig | null,
  side: LinkPropertySide | null,
): string | null {
  const cfg = config ?? {};
  if (isStructuralLinkProperty(cfg)) return null;
  const linkTypeId = linkPropertyLinkTypeId(cfg);
  if (linkTypeId === null) return null;
  const current = linkPropertyDirection(cfg, side);
  const opposite: LinkPropertyDirection = current === 'out' ? 'in' : 'out';
  return linkPropertyDisplayName(ndb, linkTypeId, opposite);
}

/**
 * Проверить конфигурацию свойства-связи (требование 2b9b5287): `link_type_id`
 * обязателен и существует (не корневой), `direction` из enum,
 * `allowed_target_type_ids` — существующие типы мыслей. Возвращает config
 * (как есть — нормализация `direction` происходит при чтении).
 */
function validateLinkConfig(
  ndb: NetworkDb,
  config: PropertyConfig | null,
  field: string,
): PropertyConfig {
  const cfg = config ?? {};
  const linkTypeId = cfg.link_type_id;
  if (cfg.structural === true) {
    // Структурное свойство-связь: типа связи нет (нетипизированные рёбра).
    if (typeof linkTypeId === 'string' && linkTypeId !== '') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'структурное свойство-связь не может иметь тип связи',
        { field: `${field}.link_type_id`, link_type_id: linkTypeId },
      );
    }
  } else {
    if (typeof linkTypeId !== 'string' || linkTypeId === '') {
      throw new EtnError('VALIDATION_ERROR', 'свойство-связь требует config.link_type_id', {
        field: `${field}.link_type_id`,
      });
    }
    const lt = getLinkType(ndb, linkTypeId);
    if (lt === null) {
      throw new EtnError('VALIDATION_ERROR', `тип связи ${linkTypeId} не найден`, {
        field: `${field}.link_type_id`,
        link_type_id: linkTypeId,
      });
    }
    if (lt.is_root) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'корневой тип связи не может быть свойством-связью',
        { field: `${field}.link_type_id`, link_type_id: linkTypeId },
      );
    }
  }
  if (
    cfg.direction !== undefined &&
    cfg.direction !== 'out' &&
    cfg.direction !== 'in'
  ) {
    throw new EtnError('VALIDATION_ERROR', `invalid direction: ${String(cfg.direction)}`, {
      field: `${field}.direction`,
      allowed: LINK_PROPERTY_DIRECTIONS,
    });
  }
  const allowed = cfg.allowed_target_type_ids;
  if (allowed !== undefined) {
    if (!Array.isArray(allowed) || allowed.some((id) => typeof id !== 'string' || id === '')) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'allowed_target_type_ids должен быть массивом id типов мыслей',
        { field: `${field}.allowed_target_type_ids` },
      );
    }
    for (const id of allowed) {
      const row = ndb.prepare('SELECT id FROM thought_types_v WHERE id = ?').get(id);
      if (!row) {
        throw new EtnError('VALIDATION_ERROR', `тип мысли ${id} не найден`, {
          field: `${field}.allowed_target_type_ids`,
          id,
        });
      }
    }
  }
  // Зеркальное ограничение источника (0.8.1, задача d7177d1d) — для привязок
  // со стороны target. Семантика и валидация совпадают с
  // `allowed_target_type_ids`.
  const allowedSources = cfg.allowed_source_type_ids;
  if (allowedSources !== undefined) {
    if (
      !Array.isArray(allowedSources) ||
      allowedSources.some((id) => typeof id !== 'string' || id === '')
    ) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'allowed_source_type_ids должен быть массивом id типов мыслей',
        { field: `${field}.allowed_source_type_ids` },
      );
    }
    for (const id of allowedSources) {
      const row = ndb.prepare('SELECT id FROM thought_types_v WHERE id = ?').get(id);
      if (!row) {
        throw new EtnError('VALIDATION_ERROR', `тип мысли ${id} не найден`, {
          field: `${field}.allowed_source_type_ids`,
          id,
        });
      }
    }
  }
  // Дефолт свойства-связи — набор целей (bb67e546): валидируется целиком,
  // чтобы неработающий дефолт не сохранился в реестр.
  if (cfg.default_value !== undefined && cfg.default_value !== null) {
    normalizeLinkDefaultValue(ndb, { id: '', name: field, value_type: 'link', config: cfg }, cfg.default_value);
  }
  // Дефолт стороны назначений (0.8.2): набор источников. Валидируется
  // существование id; отбор по типам назначений не применяется — значения
  // относятся к стороне источников.
  if (cfg.default_value_target !== undefined && cfg.default_value_target !== null) {
    normalizeLinkDefaultValueTarget(ndb, field, cfg.default_value_target);
  }
  return cfg;
}

/**
 * Проверить, что в наборе собственных свойств типа нет другого свойства-связи
 * с той же парой (тип связи + сторона) (0.8.1, требование b9562306). Проверка —
 * при правке онтологии, а не при записи мысли. `exceptPropertyId` исключает
 * само правимое свойство. Внетиповые свойства-связи проверяются отдельно
 * (совпадение типового и внетипового — не ошибка).
 */
function assertLinkPropertyPairUnique(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  linkTypeId: string | null,
  side: LinkPropertySide | null,
  exceptPropertyId: string | null,
): void {
  const rows = ndb
    .prepare(
      `SELECT tp.property_id AS property_id, tp.side AS side,
              p.config AS config, p.value_type AS value_type
         FROM type_properties_v tp
         JOIN properties_v p ON p.id = tp.property_id
        WHERE tp.owner_type = ? AND tp.owner_id = ? AND p.value_type = 'link'`,
    )
    .all(ownerType, ownerId) as Array<{
    property_id: string;
    side: string | null;
    config: string | null;
    value_type: PropertyValueType;
  }>;
  for (const row of rows) {
    if (row.property_id === exceptPropertyId) continue;
    let cfg: PropertyConfig | null = null;
    try {
      cfg = row.config ? (JSON.parse(row.config) as PropertyConfig) : null;
    } catch {
      cfg = null;
    }
    if (linkPropertyLinkTypeId(cfg) !== linkTypeId) continue;
    const rowSide = linkPropertySideFromBinding({
      side: row.side,
      value_type: row.value_type,
      config: cfg,
    });
    if (rowSide !== side) continue;
    throw new EtnError(
      'DUPLICATE',
      'свойство-связь с этим типом связи и стороной уже есть в типе',
      {
        owner_type: ownerType,
        owner_id: ownerId,
        link_type_id: linkTypeId,
        side,
        conflict_property_id: row.property_id,
      },
    );
  }
}

/** Счётчики активных типизированных рёбер мысли по (type_id, direction). */
function linkEdgeCounts(ndb: NetworkDb, thoughtId: string): Map<string, number> {
  const rows = ndb
    .prepare(
      `SELECT type_id AS link_type_id, 'out' AS direction, COUNT(*) AS count
         FROM links_v WHERE source_id = ? AND active = 1 AND marked_for_deletion = 0 AND type_id IS NOT NULL
         GROUP BY type_id
       UNION ALL
       SELECT type_id AS link_type_id, 'in' AS direction, COUNT(*) AS count
         FROM links_v WHERE target_id = ? AND active = 1 AND marked_for_deletion = 0 AND type_id IS NOT NULL
         GROUP BY type_id`,
    )
    .all(thoughtId, thoughtId) as Array<{
    link_type_id: string;
    direction: 'out' | 'in';
    count: number;
  }>;
  const out = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.link_type_id}|${row.direction}`;
    out.set(key, (out.get(key) ?? 0) + row.count);
  }
  return out;
}

/** Счётчики живых нетипизированных (структурных) рёбер мысли по направлениям. */
function structuralEdgeCounts(ndb: NetworkDb, thoughtId: string): { out: number; in: number } {
  const row = ndb
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM links_v WHERE source_id = ? AND active = 1 AND marked_for_deletion = 0 AND type_id IS NULL) AS out_count,
         (SELECT COUNT(*) FROM links_v WHERE target_id = ? AND active = 1 AND marked_for_deletion = 0 AND type_id IS NULL) AS in_count`,
    )
    .get(thoughtId, thoughtId) as { out_count: number; in_count: number } | undefined;
  return { out: row?.out_count ?? 0, in: row?.in_count ?? 0 };
}

/**
 * Эффективные свойства-связи мысли: явные (из цепочки типа) + зеркальные
 * (требование dde92461: `allowed_target_type_ids` порождает обратное свойство
 * у допустимых типов) + внетиповые (обратная сторона свойства-связи без
 * ограничения, либо свойство-связь не из типа мысли — `outside_type: true`).
 *
 * Каждая запись несёт счётчик {@link ResolvedLinkProperty.count}; рёбра в
 * `property_values` не пишутся (ADR «свойство-связь — проекция ребра»).
 */
export function listThoughtLinkProperties(ndb: NetworkDb, thoughtId: string): ResolvedLinkProperty[] {
  const typeRow = ndb.prepare('SELECT type_id FROM thoughts_v WHERE id = ?').get(thoughtId) as
    | { type_id: string | null }
    | undefined;
  const typeId = typeRow?.type_id ?? null;

  interface Entry {
    property_id: string;
    link_type_id: string | null;
    direction: LinkPropertyDirection;
    structural: boolean;
    property_name: string;
    outside_type: boolean;
    description: string | null;
    required: boolean;
    count: number;
    side: LinkPropertySide | null;
  }
  const byPair = new Map<string, Entry>();

  const putEntry = (e: Entry): void => {
    const key = `${e.link_type_id ?? ''}|${e.direction}`;
    if (!byPair.has(key)) byPair.set(key, e);
  };

  const emitExplicit = (def: EffectiveTypeProperty): void => {
    if (def.value_type !== 'link') return;
    const cfg = def.config ?? {};
    const structural = isStructuralLinkProperty(cfg);
    const linkTypeId = linkPropertyLinkTypeId(cfg);
    if (!structural && linkTypeId === null) return;
    putEntry({
      property_id: def.property_id,
      link_type_id: structural ? null : linkTypeId,
      // Направление задаётся привязкой (0.8.1); fallback на config.direction —
      // для совместимости с привязками, созданными до миграции 041.
      direction: linkPropertyDirection(def.config, def.side ?? null),
      structural,
      property_name: def.key,
      outside_type: false,
      description: def.description,
      required: def.required,
      count: 0,
      side: def.side ?? null,
    });
  };

  // 1. Явные свойства-связи из цепочки типа. Структурные «Родители»/«Потомки»
  //    объявлены на корневом типе и наследуются всеми — присутствуют у каждой
  //    мысли, включая бестиповую (корневой тип применяется и к ней).
  if (typeId !== null) {
    for (const def of listEffectiveTypeProperties(ndb, 'thought_type', typeId)) {
      emitExplicit(def);
    }
  } else {
    const rootId = getRootTypeId(ndb, 'thought_types');
    if (rootId !== null) {
      for (const def of listEffectiveTypeProperties(ndb, 'thought_type', rootId)) {
        emitExplicit(def);
      }
    }
  }

  // 2. Зеркала: свойство-связь с allowed_target_type_ids, покрывающим тип мысли.
  for (const prop of listNetworkProperties(ndb)) {
    if (prop.value_type !== 'link') continue;
    const cfg = prop.config ?? {};
    if (isStructuralLinkProperty(cfg)) continue;
    const linkTypeId = linkPropertyLinkTypeId(cfg);
    if (linkTypeId === null) continue;
    const allowed = cfg.allowed_target_type_ids ?? [];
    if (allowed.length === 0) continue;
    if (typeId === null) continue;
    const expanded = expandTypeIdsToSubtree(ndb, 'thought_types', allowed);
    if (!expanded.includes(typeId)) continue;
    const direction = linkPropertyDirection(cfg) === 'out' ? 'in' : 'out';
    putEntry({
      property_id: prop.id,
      link_type_id: linkTypeId,
      direction,
      structural: false,
      property_name: linkPropertyDisplayName(ndb, linkTypeId, direction),
      outside_type: false,
      description: prop.description,
      required: false,
      count: 0,
      side: direction === 'out' ? 'source' : 'target',
    });
  }

  const counts = linkEdgeCounts(ndb, thoughtId);

  // 3. Внетиповые: рёбра, чья пара (тип связи + направление) не покрыта
  //    явным/зеркальным свойством. Принадлежность типа связи реестру не
  //    проверяется: проекция «ребро → свойство» полная, и живое ребро обязано
  //    быть видно в свойствах даже когда его тип связи не имеет свойства в
  //    реестре (легаси-рёбра; ошибка e5cfacb9). Три источника внетиповых
  //    записей: обратная сторона свойства-связи без ограничения (dde92461),
  //    свойство-связь не из типа мысли (dfaacb05) и рёбра типов связей без
  //    реестрового свойства — у всех property_id пуст, запись через ключ
  //    реестра недоступна, только чтение и удаление самих рёбер.
  for (const [pair, count] of counts) {
    if (count === 0) continue;
    const [linkTypeId, direction] = pair.split('|') as [string, LinkPropertyDirection];
    if (byPair.has(pair)) {
      const e = byPair.get(pair)!;
      e.count = count;
      continue;
    }
    putEntry({
      property_id: '',
      link_type_id: linkTypeId,
      direction,
      structural: false,
      property_name: linkPropertyDisplayName(ndb, linkTypeId, direction),
      outside_type: true,
      description: null,
      required: false,
      count,
      side: direction === 'out' ? 'source' : 'target',
    });
  }

  // Счётчики структурных свойств — по нетипизированным рёбрам.
  const structuralCounts = structuralEdgeCounts(ndb, thoughtId);

  // Дозаписать счётчики для явных/зеркальных свойств (в т.ч. нулевые).
  const result: ResolvedLinkProperty[] = [];
  for (const entry of byPair.values()) {
    if (entry.structural) {
      entry.count = entry.direction === 'out' ? structuralCounts.out : structuralCounts.in;
    }
    result.push({
      id: entry.property_id,
      owner_type: 'thought',
      owner_id: thoughtId,
      property_id: entry.property_id,
      outside_type: entry.outside_type,
      property_name: entry.property_name,
      value_type: 'link',
      direction: entry.direction,
      side: entry.side,
      link_type_id: entry.link_type_id,
      structural: entry.structural,
      count: entry.count,
      ...(entry.description !== null ? { description: entry.description } : {}),
    });
  }
  return result;
}

/** Рёбра свойства-связи мысли (запрос значений): id ребра + цель + комментарий. */
export function getLinkPropertyValues(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  linkTypeId: string | null,
  direction: LinkPropertyDirection,
): LinkPropertyValueItem[] {
  if (ownerType !== 'thought') return [];
  const targetJoin =
    direction === 'out'
      ? 'JOIN thoughts_v t ON t.id = l.target_id'
      : 'JOIN thoughts_v t ON t.id = l.source_id';
  const ownerCol = direction === 'out' ? 'l.source_id' : 'l.target_id';
  // Структурное свойство (linkTypeId = null) — нетипизированные рёбра, порядок
  // по `position` (порядок детей в наборе «Потомки»); типизированное — по
  // убыванию новизны.
  const typeClause = linkTypeId === null ? 'l.type_id IS NULL' : 'l.type_id = ?';
  const orderBy =
    linkTypeId === null ? 'l.position ASC, l.id ASC' : 'l.created_at DESC, l.id DESC';
  const params = linkTypeId === null ? [ownerId] : [ownerId, linkTypeId];
  const rows = ndb
    .prepare(
      `SELECT l.id AS link_id, t.id AS target_id, t.title AS target_title, t.type_id AS target_type_id
         FROM links_v l
         ${targetJoin}
        WHERE ${ownerCol} = ? AND ${typeClause} AND l.active = 1 AND l.marked_for_deletion = 0
        ORDER BY ${orderBy}`,
    )
    .all(...params) as Array<{
    link_id: string;
    target_id: string;
    target_title: string | null;
    target_type_id: string | null;
  }>;
  const linkIds = rows.map((r) => r.link_id);
  const commentByLink = new Map<string, string | null>();
  if (linkIds.length > 0) {
    const commentRows = ndb
      .prepare(
        `SELECT owner_id, body_md FROM comments_v
          WHERE owner_type = 'link' AND kind = 'permanent' AND owner_id IN (${linkIds
            .map(() => '?')
            .join(',')})`,
      )
      .all(...linkIds) as Array<{ owner_id: string; body_md: string }>;
    for (const c of commentRows) commentByLink.set(c.owner_id, c.body_md);
  }
  return rows.map((r) => ({
    link_id: r.link_id,
    target_id: r.target_id,
    target_title: r.target_title,
    target_type_id: r.target_type_id,
    comment: commentByLink.get(r.link_id) ?? null,
  }));
}

// ===========================================================================
// Link property write (0.8.1) — запись рёбер через заполнение свойств-связей
// ===========================================================================

/** Нормализовать входящее значение свойства-связи в список id целей. */
function normalizeLinkTargets(value: PropertyValueValue, key: string): string[] {
  if (value === null || value === undefined) return [];
  // Свойство-связь — строковые id (или массив id). Расширение типа
  // `PropertyValueValue` вариантом `CrossNetworkRefValue[]` (задача 7849008a)
  // сделало сигнатуру шире, но эта функция вызывается только для `link`
  // значений (см. `setPropertyValue` ниже), так что нестроковый массив
  // здесь — `VALIDATION_ERROR`.
  if (Array.isArray(value)) {
    if (value.some((v) => typeof v !== 'string' || v === '')) {
      throw new EtnError('VALIDATION_ERROR', `свойство «${key}» ожидает id мыслей`, { key });
    }
    return [...new Set(value as string[])];
  }
  if (typeof value === 'string' && value !== '') return [value];
  throw new EtnError('VALIDATION_ERROR', `свойство «${key}» ожидает id мысли или массив id`, {
    key,
  });
}

/** Концы ребра по направлению свойства: `out` — владелец источник, `in` — цель. */
function linkEndpoints(
  ownerId: string,
  direction: LinkPropertyDirection,
  targetId: string,
): [string, string] {
  return direction === 'out' ? [ownerId, targetId] : [targetId, ownerId];
}

/**
 * Типы-кандидаты значения свойства-связи с ПРОТИВОПОЛОЖНОЙ стороны привязки
 * владельца (0.8.2, ошибка c67676f3): реестр привязок — единственный источник
 * истины ограничения (та же единая точка `loadBindingTypesBySide`, что и
 * `allowed_opposite_type_ids` при чтении карточки, см.
 * {@link attachAllowedOppositeTypeIds}). Привязка со стороны источника
 * ограничивает цели (типы стороны назначения), со стороны назначения —
 * источники. Поддеревья раскрываются (L21). Пусто — ограничения по реестру нет.
 */
function allowedOppositeTypeIdsForValidation(
  ndb: NetworkDb,
  propertyId: string,
  side: LinkPropertySide,
): string[] {
  const entry = loadBindingTypesBySide(ndb, [propertyId]).get(propertyId);
  if (entry === undefined) return [];
  const types = side === 'source' ? entry.target : entry.source;
  if (types.length === 0) return [];
  return expandTypeIdsToSubtree(ndb, 'thought_types', types);
}

/**
 * Проверить, что цель существует и подходит по типу. Тип-отбор берётся с
 * противоположной стороны привязки владельца (`side`, 0.8.2, ошибка c67676f3) —
 * единая точка {@link allowedOppositeTypeIdsForValidation}; при отсутствии
 * привязки (`side === null`) или пустом реестровом ограничении — legacy
 * `config.allowed_target_type_ids` (совместимость с привязками до миграции 041
 * и валидацией дефолтов реестра).
 */
function validateLinkTargetType(
  ndb: NetworkDb,
  prop: PropertyLike,
  targetId: string,
  side: LinkPropertySide | null = null,
): void {
  const target = ndb.prepare('SELECT type_id FROM thoughts_v WHERE id = ?').get(targetId) as
    | { type_id: string | null }
    | undefined;
  if (!target) {
    throw new EtnError('VALIDATION_ERROR', `referenced thought ${targetId} does not exist`, {
      key: prop.name,
      ref: targetId,
    });
  }
  const registryAllowed =
    side === null ? [] : allowedOppositeTypeIdsForValidation(ndb, prop.id, side);
  const allowedIds =
    registryAllowed.length > 0
      ? registryAllowed
      : expandTypeIdsToSubtree(
          ndb,
          'thought_types',
          (prop.config?.allowed_target_type_ids ?? []).filter((id) => id !== ''),
        );
  if (allowedIds.length > 0 && (target.type_id === null || !allowedIds.includes(target.type_id))) {
    throw new EtnError('VALIDATION_ERROR', `thought ${targetId} is not of a required type`, {
      key: prop.name,
      ref: targetId,
      allowed_type_ids: allowedIds,
      actual_type_id: target.type_id,
    });
  }
}

/**
 * Дефолт свойства-связи — набор целей (ошибка bb67e546): дедупликация с
 * сохранением порядка + полная валидация каждой цели (существование, отбор
 * по типам цели). Пустой набор — `null` (дефолта нет).
 */
function normalizeLinkDefaultValue(
  ndb: NetworkDb,
  prop: PropertyLike,
  value: PropertyValueValue,
): string[] | null {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id === '')) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `дефолт свойства-связи «${prop.name}» — массив id мыслей`,
      { key: prop.name, expected: 'link' },
    );
  }
  const ids = [...new Set(value as string[])];
  for (const id of ids) validateLinkTargetType(ndb, prop, id);
  return ids.length > 0 ? ids : null;
}

/**
 * Дефолт стороны назначений свойства-связи (0.8.2, ADR «дефолт свойства живёт
 * на привязке»): массив id мыслей-источников. В отличие от `default_value`
 * отбор `allowed_target_type_ids` НЕ применяется — значения принадлежат
 * стороне источников. Проверяется существование, дедупликация, пустой набор
 * приводится к `null`.
 */
function normalizeLinkDefaultValueTarget(
  ndb: NetworkDb,
  field: string,
  value: unknown,
): string[] | null {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id === '')) {
    throw new EtnError('VALIDATION_ERROR', 'default_value_target — массив id мыслей', {
      field: `${field}.default_value_target`,
    });
  }
  const ids = [...new Set(value)];
  for (const id of ids) {
    const row = ndb.prepare('SELECT id FROM thoughts_v WHERE id = ?').get(id);
    if (!row) {
      throw new EtnError('VALIDATION_ERROR', `мысль ${id} не найдена`, {
        field: `${field}.default_value_target`,
        id,
      });
    }
  }
  return ids.length > 0 ? ids : null;
}

/**
 * Отфильтровать источники target-дефолта, применимые СЕЙЧАС (0.8.2): живые
 * (не помеченные на удаление) и существующие. Отбор по типам не применяется —
 * протухший источник молча пропускается, создание мысли не падает.
 */
export function filterApplicableLinkDefaultSources(ndb: NetworkDb, ids: string[]): string[] {
  return ids.filter((id) => {
    const row = ndb
      .prepare('SELECT marked_for_deletion FROM thoughts_v WHERE id = ?')
      .get(id) as { marked_for_deletion: number } | undefined;
    return row !== undefined && row.marked_for_deletion === 0;
  });
}

/**
 * Отфильтровать цели link-дефолта, применимые СЕЙЧАС: живые (не удалённые и не
 * в корзине) и проходящие отбор по типам цели. Применение дефолта при создании
 * мысли не должно падать из-за цели, исчезнувшей или сменившей тип после
 * установки дефолта (bb67e546) — такие молча пропускаются.
 */
export function filterApplicableLinkDefaultTargets(
  ndb: NetworkDb,
  config: PropertyConfig | null,
  ids: string[],
): string[] {
  const prop: PropertyLike = { id: '', name: 'default', value_type: 'link', config };
  return ids.filter((id) => {
    try {
      validateLinkTargetType(ndb, prop, id);
      const row = ndb
        .prepare('SELECT marked_for_deletion FROM thoughts_v WHERE id = ?')
        .get(id) as { marked_for_deletion: number } | undefined;
      return row !== undefined && row.marked_for_deletion === 0;
    } catch {
      return false;
    }
  });
}

/** Живые (не в корзине) рёбра свойства-связи владельца: target_id → строка. */
function listLiveLinkTargets(
  ndb: NetworkDb,
  ownerId: string,
  linkTypeId: string | null,
  direction: LinkPropertyDirection,
): Map<string, { id: string; position: number }> {
  const ownerCol = direction === 'out' ? 'source_id' : 'target_id';
  const targetCol = direction === 'out' ? 'target_id' : 'source_id';
  const typeClause = linkTypeId === null ? 'type_id IS NULL' : 'type_id = ?';
  const params = linkTypeId === null ? [ownerId] : [ownerId, linkTypeId];
  const rows = ndb
    .prepare(
      `SELECT id, ${targetCol} AS target_id, position FROM links_v
        WHERE ${ownerCol} = ? AND ${typeClause} AND active = 1 AND marked_for_deletion = 0`,
    )
    .all(...params) as Array<{ id: string; target_id: string; position: number }>;
  const out = new Map<string, { id: string; position: number }>();
  for (const r of rows) out.set(r.target_id, { id: r.id, position: r.position });
  return out;
}

/**
 * Обеспечить ЖИВОЕ ребро тройки (низкоуровневая запись значения свойства-связи,
 * без связи с link-service — цикл; примитив тройки — в `link-live-triple`).
 *
 * Тройка уникальна среди живых рёбер (требование 4591f837): живой дубль не
 * плодим, а корзинное ребро той же тройки не блокирует постановку значения —
 * снимаем пометку (комментарий сохраняется, как у `etn.links.restore`) и
 * выставляем позицию. Иначе повторная установка значения поверх корзинного
 * ребра падала сырой ошибкой `UNIQUE constraint failed` (миграция 029 держит
 * тройку и за помеченными строками).
 */
function insertLinkRow(
  ndb: NetworkDb,
  sourceId: string,
  targetId: string,
  linkTypeId: string | null,
  position: number,
  actorUserId: string,
): string {
  const twin = findLinkTripleRow(ndb, sourceId, targetId, linkTypeId);
  if (twin !== null) {
    if (twin.marked_for_deletion) {
      restoreLinkRow(ndb, twin.id, actorUserId);
      setLinkPosition(ndb, twin.id, position, actorUserId);
    }
    return twin.id;
  }
  const id = randomUUID();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  ndb
    .prepare(
      `INSERT INTO links (id, layer_id, source_id, target_id, type_id, position, active, version,
                          created_at, updated_at, created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ndb.layerId, sourceId, targetId, linkTypeId, position, now, now, actorUserId, actorUserId, nowMs, nowMs);
  return id;
}

/** Пометить ребро в корзину (не физическое удаление — комментарий сохраняется). */
function markLinkForDeletion(ndb: NetworkDb, linkId: string, actorUserId: string): void {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  materializeShadow(ndb, 'links', linkId);
  ndb
    .prepare(
      `UPDATE links SET marked_for_deletion = 1, marked_for_deletion_at = ?, marked_for_deletion_by = ?,
                        updated_at = ?, updated_by = ?, updated_at_ms = ?, version = version + 1
        WHERE id = ? AND layer_id = ?`,
    )
    .run(now, actorUserId, now, actorUserId, nowMs, linkId, ndb.layerId);
}

/** Позиция нового ребра в списке детей источника (структурное: в конец). */
function nextStructuralPosition(ndb: NetworkDb, sourceId: string): number {
  const row = ndb
    .prepare(
      `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM links_v
        WHERE source_id = ? AND active = 1 AND marked_for_deletion = 0 AND type_id IS NULL`,
    )
    .get(sourceId) as { p: number };
  return row.p;
}

/**
 * Полная замена набора свойства-связи (операция `set`): создаёт недостающие
 * рёбра, помечает в корзину лишние. Направление из определения, симметрия —
 * заполнение прямого и обратного свойства создаёт одно и то же ребро.
 * Идемпотентно: уже живое ребро к цели не трогается.
 */
function setLinkPropertyTargets(
  ndb: NetworkDb,
  ownerId: string,
  prop: PropertyLike,
  targetIds: string[],
  actorUserId: string,
  nameDirection: LinkPropertyDirection | null = null,
): { targets: string[]; createdLinkIds: string[] } {
  const cfg = prop.config ?? {};
  const structural = isStructuralLinkProperty(cfg);
  const linkTypeId = linkPropertyLinkTypeId(cfg);
  // Направление — из display-имени стороны внетиповой записи (0.8.2, ошибка
  // 748b80fd), иначе — по стороне привязки владельца (0.8.2, ошибка c67676f3),
  // fallback на config.direction вне типа владельца.
  const bindingSide = resolveOwnerBindingSide(ndb, ownerId, prop.id);
  const direction = nameDirection ?? linkPropertyDirection(cfg, bindingSide);
  // Валидация цели: у внетипового display-ключа (`nameDirection` задан)
  // привязки у владельца нет — ограничение сторон не применяем, остаётся
  // legacy `config.allowed_target_type_ids`; иначе — сторона привязки.
  const side = nameDirection !== null ? null : bindingSide;

  for (const targetId of targetIds) validateLinkTargetType(ndb, prop, targetId, side);
  for (const targetId of targetIds) {
    const [src, dst] = linkEndpoints(ownerId, direction, targetId);
    if (src === dst) {
      throw new EtnError('VALIDATION_ERROR', 'a link cannot connect a thought to itself', {
        key: prop.name,
        ref: targetId,
      });
    }
  }

  const existing = listLiveLinkTargets(ndb, ownerId, linkTypeId, direction);
  const wanted = new Set(targetIds);
  for (const [targetId, link] of existing) {
    if (!wanted.has(targetId)) markLinkForDeletion(ndb, link.id, actorUserId);
  }

  const result: string[] = [];
  const createdLinkIds: string[] = [];
  targetIds.forEach((targetId, index) => {
    const [src, dst] = linkEndpoints(ownerId, direction, targetId);
    const current = existing.get(targetId);
    if (current !== undefined) {
      // Структурный «Потомки»: `set` задаёт и порядок детей (позиция = индекс).
      if (structural && direction === 'out' && current.position !== index) {
        setLinkPosition(ndb, current.id, index, actorUserId);
      }
      result.push(targetId);
      return;
    }
    const position = structural
      ? direction === 'out'
        ? index
        : nextStructuralPosition(ndb, src)
      : 0;
    // `insertLinkRow` может восстановить корзинное ребро той же тройки — для
    // наблюдателя оно так же становится живым, поэтому идёт в `created`
    // (та же семантика, что у `etn.properties.add`: `created = no live edge`).
    createdLinkIds.push(insertLinkRow(ndb, src, dst, linkTypeId, position, actorUserId));
    result.push(targetId);
  });
  return { targets: result, createdLinkIds };
}

/**
 * Заполнить свойство-связь со стороны НАЗНАЧЕНИЙ (0.8.2, ADR «дефолт свойства
 * живёт на привязке»): `ownerId` — цель, `sourceIds` — источники; рёбра
 * создаются канонически (источник → владелец). Применяется при создании мысли
 * типа с привязкой `side = 'target'`. Валидация целей — существование и
 * живость (отбор `allowed_type_ids` не применяется: значения — сторона
 * источников). Самосвязь молча пропускается. Полная замена набора:
 * недостающие рёбра создаются, лишние помечаются на удаление.
 *
 * Возвращает и итоговый набор источников (`targets`), и id рёбер, созданных
 * (в том числе восстановленных из корзины) этой записью, — по ним фасады
 * публикуют `link.created` (ошибка 8655842b, тот же контракт, что у
 * {@link setLinkPropertyTargets}).
 */
export function setLinkPropertySourcesForTarget(
  ndb: NetworkDb,
  ownerId: string,
  prop: PropertyLike,
  sourceIds: string[],
  actorUserId: string,
): { targets: string[]; createdLinkIds: string[] } {
  return ndb.transaction(() => {
    const cfg = prop.config ?? {};
    const linkTypeId = linkPropertyLinkTypeId(cfg);
    // owner — цель: рёбра ищем направлением `in`, противоположный конец — источник.
    const existing = listLiveLinkTargets(ndb, ownerId, linkTypeId, 'in');
    const wanted = new Set(sourceIds);
    for (const [sourceId, link] of existing) {
      if (!wanted.has(sourceId)) markLinkForDeletion(ndb, link.id, actorUserId);
    }
    const result: string[] = [];
    const createdLinkIds: string[] = [];
    for (const sourceId of sourceIds) {
      if (sourceId === ownerId) continue;
      if (existing.has(sourceId)) {
        result.push(sourceId);
        continue;
      }
      createdLinkIds.push(insertLinkRow(ndb, sourceId, ownerId, linkTypeId, 0, actorUserId));
      result.push(sourceId);
    }
    return { targets: result, createdLinkIds };
  });
}

/** Переставить ребро на позицию `position` (структурный порядок детей). */
function setLinkPosition(
  ndb: NetworkDb,
  linkId: string,
  position: number,
  actorUserId: string,
): void {
  materializeShadow(ndb, 'links', linkId);
  ndb
    .prepare(
      `UPDATE links SET position = ?, updated_at = ?, updated_by = ?, updated_at_ms = ?, version = version + 1
        WHERE id = ? AND layer_id = ?`,
    )
    .run(position, new Date().toISOString(), actorUserId, Date.now(), linkId, ndb.layerId);
}

/** Написать/обновить постоянный комментарий ребра («зачем именно эта ссылка»).
 *  `warnings` — коллектор предупреждений записи (требование 822a9149):
 *  перезапись комментария ребра может потерять живые трансклюзии. */
function upsertLinkComment(
  ndb: NetworkDb,
  linkId: string,
  comment: string,
  actorUserId: string,
  warnings: MutationWarning[],
): void {
  const existing = listComments(ndb, 'link', linkId).find((c) => c.kind === 'permanent');
  if (existing !== undefined) {
    updateComment(ndb, existing.id, { body_md: comment }, undefined, actorUserId, { warnings });
  } else {
    createComment(ndb, 'link', linkId, { kind: 'permanent', title: null, body_md: comment }, actorUserId);
  }
}

/**
 * Добавить одну цель в набор свойства-связи (операция `add`): идемпотентно
 * (живое ребро уже есть — no-op), принимает необязательный комментарий.
 * Один вызов, без чтения текущего набора.
 */
function addLinkPropertyTarget(
  ndb: NetworkDb,
  ownerId: string,
  prop: PropertyLike,
  targetId: string,
  comment: string | null,
  actorUserId: string,
  warnings: MutationWarning[],
  nameDirection: LinkPropertyDirection | null = null,
): string {
  const cfg = prop.config ?? {};
  const structural = isStructuralLinkProperty(cfg);
  const linkTypeId = linkPropertyLinkTypeId(cfg);
  // Направление — из display-имени (748b80fd), иначе сторона привязки
  // владельца (c67676f3).
  const bindingSide = resolveOwnerBindingSide(ndb, ownerId, prop.id);
  const direction = nameDirection ?? linkPropertyDirection(cfg, bindingSide);
  // Внетиповой display-ключ: привязки у владельца нет — без ограничения сторон.
  const side = nameDirection !== null ? null : bindingSide;

  validateLinkTargetType(ndb, prop, targetId, side);
  const [src, dst] = linkEndpoints(ownerId, direction, targetId);
  if (src === dst) {
    throw new EtnError('VALIDATION_ERROR', 'a link cannot connect a thought to itself', {
      key: prop.name,
      ref: targetId,
    });
  }
  const existing = listLiveLinkTargets(ndb, ownerId, linkTypeId, direction).get(targetId);
  if (existing !== undefined) {
    if (comment !== null) upsertLinkComment(ndb, existing.id, comment, actorUserId, warnings);
    return existing.id;
  }
  const position = structural ? (direction === 'out' ? nextStructuralPosition(ndb, src) : nextStructuralPosition(ndb, src)) : 0;
  const id = insertLinkRow(ndb, src, dst, linkTypeId, position, actorUserId);
  if (comment !== null) upsertLinkComment(ndb, id, comment, actorUserId, warnings);
  return id;
}

/**
 * Убрать одну цель из набора свойства-связи (операция `remove`): помечает ребро
 * в корзину (комментарий не теряется). Отсутствующее ребро — no-op.
 */
function removeLinkPropertyTarget(
  ndb: NetworkDb,
  ownerId: string,
  prop: PropertyLike,
  targetId: string,
  actorUserId: string,
  nameDirection: LinkPropertyDirection | null = null,
): string | null {
  const cfg = prop.config ?? {};
  const linkTypeId = linkPropertyLinkTypeId(cfg);
  // Направление — из display-имени (748b80fd), иначе сторона привязки
  // владельца (c67676f3).
  const direction =
    nameDirection ??
    linkPropertyDirection(cfg, resolveOwnerBindingSide(ndb, ownerId, prop.id));
  const existing = listLiveLinkTargets(ndb, ownerId, linkTypeId, direction).get(targetId);
  if (existing === undefined) return null;
  markLinkForDeletion(ndb, existing.id, actorUserId);
  return existing.id;
}

// ===========================================================================
// Property registry (`properties`) — 0.6.5
// ===========================================================================

/** Raw `properties` row. */
interface PropertyRow {
  id: string;
  name: string;
  name_key: string;
  value_type: string;
  config: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  created_at_ms: number;
  updated_at_ms: number;
}

/** Convert a raw registry row into a {@link NetworkProperty}. */
function rowToNetworkProperty(row: PropertyRow): NetworkProperty {
  return {
    id: row.id,
    name: row.name,
    value_type: row.value_type as PropertyValueType,
    config: row.config ? (JSON.parse(row.config) as PropertyConfig) : null,
    description: row.description,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
  };
}

/** Every property of the registry visible in the connection's layer context. */
export function listNetworkProperties(ndb: NetworkDb): NetworkProperty[] {
  const rows = ndb
    .prepare('SELECT * FROM properties_v ORDER BY name COLLATE NOCASE')
    .all() as PropertyRow[];
  return rows.map(rowToNetworkProperty);
}

/** A registry property by id, or `null` when absent. */
export function getNetworkProperty(ndb: NetworkDb, id: string): NetworkProperty | null {
  const row = ndb.prepare('SELECT * FROM properties_v WHERE id = ?').get(id) as
    | PropertyRow
    | undefined;
  return row ? rowToNetworkProperty(row) : null;
}

/** A registry property by name (case-insensitive), or `null` when absent. */
export function getNetworkPropertyByName(ndb: NetworkDb, name: string): NetworkProperty | null {
  const row = ndb
    .prepare('SELECT * FROM properties_v WHERE name_key = type_name_key(?)')
    .get(name) as PropertyRow | undefined;
  return row ? rowToNetworkProperty(row) : null;
}

/**
 * Resolve a registry property id by its display name, case-insensitively
 * (задача d5ab1630 «Типы и свойства адресуются именами во всех фильтрах
 * MCP»). Throws `NOT_FOUND` when no property matches. The `VALIDATION_ERROR`
 * `candidates` arm is reserved for theoretical name ambiguity; uniqueness of
 * `name_key` per the `idx_properties_name_key` index keeps it unreachable in
 * practice — but the helper still walks the result so a future migration
 * that loosens uniqueness won't silently fall back to the first row.
 */
export function resolvePropertyIdByName(ndb: NetworkDb, name: string): string {
  const key = typeNameKey(name);
  const rows = ndb
    .prepare('SELECT id, name FROM properties_v WHERE name_key = ?')
    .all(key) as Array<{ id: string; name: string }>;
  if (rows.length === 0) {
    throw new EtnError('NOT_FOUND', `property "${name}" not found`, {
      field: 'property',
      name,
    });
  }
  if (rows.length > 1) {
    throw new EtnError('VALIDATION_ERROR', `property name "${name}" is ambiguous`, {
      field: 'property',
      name,
      candidates: rows.map((r) => ({ id: r.id, name: r.name })),
    });
  }
  return rows[0]!.id;
}

/**
 * Резолвинг ссылки условия на свойство (задача df992826): условие отбора или
 * прямого structure-запроса адресует свойство либо registry id, либо ИМЕНЕМ.
 * Имя может быть:
 *
 *   * каноническим именем строки реестра (скаляры; у свойства-связи это одна
 *     из сторон — та, что соответствует `config.direction`/привязке);
 *   * ПРЯМЫМ (`name_forward`, сторона источника) или ОБРАТНЫМ
 *     (`name_reverse`, сторона цели) именем свойства-связи — тогда условие
 *     матчит рёбра с противоположным направлением (резолвинг обеих сторон).
 *
 * Направление берётся из имени: `name_forward` ⇒ `out`, `name_reverse` ⇒ `in`
 * (единая точка интерпретации — {@link linkPropertyDirection}, без дублирования
 * логики зеркал из чтения свойств мысли).
 *
 * Коллизия (обратное имя одного свойства-связи совпало с прямым именем другого
 * свойства или с именем скаляра) НЕ проглатывается: бросается
 * `VALIDATION_ERROR` со списком кандидатов — молчаливый выбор «первого»
 * превратил бы условие в непредсказуемое.
 *
 * `null` — ссылка не распознана как свойство (условие отбрасывается движком,
 * как и раньше для неизвестного `property_id`).
 */
export interface ResolvedConditionPropertyRef {
  propertyId: string;
  /**
   * Направление рёбер, заданное именем стороны свойства-связи. `null` —
   * ссылка адресована id или каноническим именем: направление, как и раньше,
   * вычисляется из `config`/стороны привязки в движке отбора.
   */
  direction: LinkPropertyDirection | null;
}

export function resolveConditionPropertyRef(
  ndb: NetworkDb,
  ref: string,
  requestId?: string,
): ResolvedConditionPropertyRef | null {
  // 1. Id реестра — прежний путь; направление остаётся за config/привязкой
  //    (обратная совместимость сохранённых отборов и фильтров).
  if (getNetworkProperty(ndb, ref) !== null) {
    return { propertyId: ref, direction: null };
  }
  const key = typeNameKey(ref);
  if (key === '') return null;

  const candidates = new Map<string, ResolvedConditionPropertyRef>();
  const add = (propertyId: string, direction: LinkPropertyDirection | null): void => {
    candidates.set(`${propertyId}|${direction ?? ''}`, { propertyId, direction });
  };

  // 2. Каноническое имя строки реестра (скаляры, каноническое имя связи).
  const byStored = getNetworkPropertyByName(ndb, ref);
  if (byStored !== null) {
    const cfg = byStored.config ?? {};
    add(
      byStored.id,
      byStored.value_type === 'link' && !isStructuralLinkProperty(cfg)
        ? linkPropertyDirection(cfg)
        : null,
    );
  }

  // 3. Обе стороны каждого свойства-связи: прямое имя — 'out', обратное — 'in'.
  //    Структурные пропускаем — «Родители»/«Потомки» уже двусторонние.
  for (const prop of listNetworkProperties(ndb)) {
    if (prop.value_type !== 'link') continue;
    const cfg = prop.config ?? {};
    if (isStructuralLinkProperty(cfg)) continue;
    const linkTypeId = linkPropertyLinkTypeId(cfg);
    if (linkTypeId === null) continue;
    if (typeNameKey(linkPropertyDisplayName(ndb, linkTypeId, 'out')) === key) {
      add(prop.id, 'out');
    }
    if (typeNameKey(linkPropertyDisplayName(ndb, linkTypeId, 'in')) === key) {
      add(prop.id, 'in');
    }
  }

  if (candidates.size === 0) return null;
  if (candidates.size > 1) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Имя свойства «${ref}» неоднозначно: совпадает с несколькими сторонами свойств-связей.`,
      {
        field: 'property_id',
        name: ref,
        candidates: [...candidates.values()],
      },
      requestId,
    );
  }
  return [...candidates.values()][0]!;
}

/**
 * Throw `DUPLICATE` (409) when another visible property already holds the
 * name. Uniqueness is checked against `properties_v` — the layer's view, not
 * the physical table: the same name may coexist in different layers and only
 * clash at merge time (02-data-model.md §3.4a, «Слои»).
 */
function assertNameAvailable(ndb: NetworkDb, name: string, exceptId: string | null): void {
  const row = ndb
    .prepare('SELECT id FROM properties_v WHERE name_key = type_name_key(?)')
    .get(name) as { id: string } | undefined;
  if (row && row.id !== exceptId) {
    throw new EtnError('DUPLICATE', `свойство «${name}» уже есть в этой мыслесети`, {
      name,
      conflict_property_id: row.id,
    });
  }
}

/**
 * Create a registry property (name must be free, case-insensitively). The row
 * lands in the connection's layer; a same-`name_key` tombstone of this layer
 * is woken by the upsert below.
 *
 * 0.8.1 (задача e1fbf304, требование 09f692ff): для свойств-связей без
 * существующего `config.link_type_id` принимает `input.name_forward` и
 * `input.name_reverse` и создаёт связанный тип связи в этой же
 * транзакции. Старое поведение (явный `config.link_type_id`) сохранено.
 */
export function createNetworkProperty(
  ndb: NetworkDb,
  input: NetworkPropertyInput,
  actorUserId: string,
): NetworkProperty {
  const valueType = validateValueType(input.value_type);
  let config = input.config === undefined || input.config === null ? null : input.config;
  // Свойство-связь: имя не хранится/не правится — вычисляется из типа связи
  // по направлению (требование 38eaa15c). Входной name игнорируется.
  let name: string;
  if (valueType === 'link') {
    // Единый жизненный цикл свойства-связи ↔ link_type (0.8.1, требование
    // 09f692ff): при отсутствии config.link_type_id сервер создаёт link_type
    // по паре имён. Сначала пробуем авто-создание, чтобы не падать в
    // validateLinkConfig с требованием link_type_id; валидация config
    // выполняется ниже уже с заполненным link_type_id.
    const hasLinkTypeId = typeof config?.link_type_id === 'string' && config.link_type_id !== '';
    if (!isStructuralLinkProperty(config) && !hasLinkTypeId) {
      const forward = (input.name_forward ?? '').trim();
      const reverse = (input.name_reverse ?? '').trim();
      if (forward === '' || reverse === '') {
        throw new EtnError(
          'VALIDATION_ERROR',
          'для свойства-связи без существующего типа связи нужно передать name_forward и name_reverse',
          { field: 'config.link_type_id' },
        );
      }
      const linkType = createLinkType(
        ndb,
        {
          name_forward: forward,
          name_reverse: reverse,
          parent_id: input.parent_link_type_id ?? null,
          color: input.link_color ?? null,
          style: input.link_style ?? null,
          width: input.link_width ?? null,
        },
        actorUserId,
      );
      config = { ...(config ?? {}), link_type_id: linkType.id };
    }
    config = validateLinkConfig(ndb, config, 'config');
    name = isStructuralLinkProperty(config)
      ? validateKey(input.name)
      : linkPropertyDisplayName(
          ndb,
          config.link_type_id as string,
          linkPropertyDirection(config),
        );
  } else {
    assertNoTargetDefaultForScalar(config);
    name = validateKey(input.name);
  }
  const configJson = config === null ? null : JSON.stringify(config);
  const description = normalizeDescription(input.description);
  const id = randomUUID();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  assertNameAvailable(ndb, name, null);
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description,
                               created_at, updated_at, created_by, updated_by,
                               created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, type_name_key(?), ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name_key, layer_id) DO UPDATE SET
         deleted = 0,
         name = excluded.name,
         value_type = excluded.value_type,
         config = excluded.config,
         description = excluded.description,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by,
         updated_at_ms = excluded.updated_at_ms`,
    )
    .run(
      id,
      ndb.layerId,
      name,
      name,
      valueType,
      configJson,
      description,
      now,
      now,
      actorUserId,
      actorUserId,
      nowMs,
      nowMs,
    );
  // The conflict arm wakes a same-name tombstone of this layer keeping its
  // ORIGINAL id — re-read by name, never by the fresh uuid.
  return getNetworkPropertyByName(ndb, name)!;
}

/**
 * Запрет смены вида значения между скалярной категорией и категорией «связь»
 * (0.8.1, требование 5a82c709): конверсия бессмысленна — значения связи
 * живут рёбрами, а не в таблице значений. Внутри скалярной категории конверсия
 * работает (L6), внутри «связи» — нет необходимости. Тест «был ли link»
 * опирается на исходный `value_type` (до смены).
 */
function assertNoLinkScalarCategorySwitch(
  currentValueType: PropertyValueType,
  nextValueType: PropertyValueType,
): void {
  if (currentValueType === nextValueType) return;
  const currentIsLink = currentValueType === 'link';
  const nextIsLink = nextValueType === 'link';
  if (currentIsLink !== nextIsLink) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'категория вида значения неизменна: переход скаляр ↔ связь запрещён',
      {
        field: 'value_type',
        from: currentValueType,
        to: nextValueType,
        reason:
          'значения свойства-связи живут рёбрами, а не в property_values — конвертация бессмысленна',
      },
    );
  }
}

/**
 * Patch a registry property (last-write-wins per field). Changing `value_type`
 * rewrites every stored value of the property in the same transaction:
 * convertible values move to the new column, the rest are cleared (L6, and
 * 02-data-model.md §3.4a). Renaming is safe — values address the property by
 * id, not by name.
 *
 * Переход скаляр ↔ «связь» запрещён (0.8.1, требование 5a82c709): свойство
 * рождается в одной категории вида значения и не меняет её; значения связи
 * живут рёбрами, конвертировать их бессмысленно.
 */
export function updateNetworkProperty(
  ndb: NetworkDb,
  id: string,
  changes: NetworkPropertyUpdateInput,
  actorUserId: string,
): NetworkProperty {
  const current = getNetworkProperty(ndb, id);
  if (!current) {
    throw new EtnError('NOT_FOUND', `property ${id} not found`, { entity: 'property', id });
  }
  const nextType =
    changes.value_type !== undefined ? validateValueType(changes.value_type) : undefined;
  if (nextType !== undefined) {
    assertNoLinkScalarCategorySwitch(current.value_type, nextType);
  }
  const finalType = nextType ?? current.value_type;
  const finalConfig = changes.config !== undefined ? changes.config : current.config;

  // Свойство-связь: имя выводится из типа связи, а не из запроса. Правка
  // config/value_type на 'link' валидируется здесь же.
  let validatedConfig: PropertyConfig | null | undefined = undefined;
  let nextName = changes.name !== undefined ? validateKey(changes.name) : undefined;
  let linkTypeIdForUpdate: string | null = null;
  if (finalType === 'link') {
    validatedConfig = validateLinkConfig(ndb, finalConfig, 'config');
    if (!isStructuralLinkProperty(validatedConfig)) {
      nextName = linkPropertyDisplayName(
        ndb,
        (validatedConfig.link_type_id as string),
        linkPropertyDirection(validatedConfig),
      );
      linkTypeIdForUpdate = validatedConfig.link_type_id as string;
    }
  } else if (changes.config !== undefined) {
    assertNoTargetDefaultForScalar(finalConfig);
  }

  // Единый жизненный цикл свойства-связи (0.8.1, требование 09f692ff):
  // правка имён сторон, оформления и т.п. пишет в связанный link_type.
  // Сбор linkChanges выполняется до основной транзакции — `updateLinkType`
  // внутри сам откроет свою, но в одной сессии SQLite это нормально
  // (вложенные SAVEPOINT), если же она конфликтует — вызывающий код
  // должен ожидать отказ с понятным сообщением.
  let linkUpdate: { name_forward?: string; name_reverse?: string; color?: string | null; style?: LinkStyle | null; width?: number | null; parent_id?: string | null } | null = null;
  if (
    linkTypeIdForUpdate !== null &&
    (changes.name_forward !== undefined ||
      changes.name_reverse !== undefined ||
      changes.link_color !== undefined ||
      changes.link_style !== undefined ||
      changes.link_width !== undefined ||
      changes.parent_link_type_id !== undefined)
  ) {
    linkUpdate = {};
    if (changes.name_forward !== undefined) linkUpdate.name_forward = validateKey(changes.name_forward);
    if (changes.name_reverse !== undefined) linkUpdate.name_reverse = validateKey(changes.name_reverse);
    if (changes.link_color !== undefined) linkUpdate.color = changes.link_color ?? null;
    if (changes.link_style !== undefined) linkUpdate.style = changes.link_style ?? null;
    if (changes.link_width !== undefined) linkUpdate.width = changes.link_width ?? null;
    // Ошибка 16766f82: явный `parent_link_type_id` правит `parent_id`
    // связанного link_type (защита `reparent_blocked_by_layer` и валидация
    // цикла — внутри `updateLinkType`). Сравниваем с текущим родителем,
    // чтобы `null` (под корневой тип) и повтор не поднимали version впустую.
    if (changes.parent_link_type_id !== undefined) {
      const currentLinkForParent = getLinkType(ndb, linkTypeIdForUpdate);
      const desiredParentId =
        changes.parent_link_type_id === null
          ? getRootTypeId(ndb, 'link_types')
          : changes.parent_link_type_id;
      if (
        currentLinkForParent !== null &&
        desiredParentId !== null &&
        desiredParentId !== currentLinkForParent.parent_id
      ) {
        linkUpdate.parent_id = changes.parent_link_type_id;
      }
    }
    if (Object.keys(linkUpdate).length === 0) linkUpdate = null;
  }

  return ndb.transaction(() => {
    if (nextName !== undefined && nextName !== current.name) {
      assertNameAvailable(ndb, nextName, id);
    }
    if (nextType !== undefined && nextType !== current.value_type) {
      migratePropertyValues(ndb, id, current.value_type, nextType);
    }
    // Правка link_type (0.8.1) — до UPDATE свойства, чтобы новое имя
    // свойства (вычисляемое из link_type.name_forward/reverse) уже было
    // доступно при возможном re-read после UPDATE.
    if (linkUpdate && linkTypeIdForUpdate !== null) {
      const currentLink = getLinkType(ndb, linkTypeIdForUpdate);
      if (currentLink === null) {
        throw new EtnError('NOT_FOUND', `link type ${linkTypeIdForUpdate} not found`, {
          entity: 'link_type',
          id: linkTypeIdForUpdate,
        });
      }
      updateLinkType(ndb, linkTypeIdForUpdate, linkUpdate, currentLink.version, actorUserId);
      // После правки link_type перечитываем имя свойства через него.
      if (validatedConfig !== undefined) {
        nextName = linkPropertyDisplayName(
          ndb,
          linkTypeIdForUpdate,
          linkPropertyDirection(validatedConfig),
        );
      }
    }
    const sets: string[] = [];
    const args: unknown[] = [];
    if (nextName !== undefined) {
      sets.push('name = ?', 'name_key = type_name_key(?)');
      args.push(nextName, nextName);
    }
    if (nextType !== undefined) {
      sets.push('value_type = ?');
      args.push(nextType);
    }
    if (validatedConfig !== undefined) {
      sets.push('config = ?');
      args.push(JSON.stringify(validatedConfig));
    } else if (changes.config !== undefined) {
      sets.push('config = ?');
      args.push(changes.config === null ? null : JSON.stringify(changes.config));
    }
    if (changes.description !== undefined) {
      sets.push('description = ?');
      args.push(normalizeDescription(changes.description));
    }
    if (sets.length === 0) {
      return current;
    }
    const nowMs = Date.now();
    sets.push('updated_at = ?', 'updated_by = ?', 'updated_at_ms = ?');
    args.push(new Date(nowMs).toISOString(), actorUserId, nowMs);
    materializeShadow(ndb, 'properties', id);
    args.push(id, ndb.layerId);
    ndb.prepare(`UPDATE properties SET ${sets.join(', ')} WHERE id = ? AND layer_id = ?`).run(
      ...args,
    );
    return getNetworkProperty(ndb, id)!;
  });
}

/**
 * Delete a registry property. Allowed only when the property is attached to
 * nothing and filled nowhere (even a value outside type blocks): the refusal
 * returns two counters — how many types attach it and how many values are
 * stored — so the client can explain what is holding it
 * (02-data-model.md §3.4a «Удаление свойства блокируется»).
 *
 * 0.8.1 (задача e1fbf304, требование 09f692ff): для свойств-связей —
 * удаление типа связи (принудительно, рёбра обнуляют `type_id` и
 * становятся структурными «Родители/Потомки»); возвращает число таких
 * рёбер в `links_becoming_structural`. Для скалярных и структурных
 * свойств — `null`.
 */
export interface DeletePropertyResult {
  /** Число рёбер, ставших структурными после удаления типа связи
   *  (0.8.1, требование 09f692ff). `null` для скалярных и структурных. */
  links_becoming_structural: number | null;
}

export function deleteNetworkProperty(
  ndb: NetworkDb,
  id: string,
): DeletePropertyResult {
  const current = getNetworkProperty(ndb, id);
  if (!current) {
    throw new EtnError('NOT_FOUND', `property ${id} not found`, { entity: 'property', id });
  }
  const typesCount = (
    ndb
      .prepare('SELECT COUNT(*) AS c FROM type_properties_v WHERE property_id = ?')
      .get(id) as { c: number }
  ).c;
  const valuesCount = (
    ndb
      .prepare('SELECT COUNT(*) AS c FROM property_values_v WHERE property_id = ?')
      .get(id) as { c: number }
  ).c;
  if (typesCount > 0 || valuesCount > 0) {
    throw new EtnError(
      'DUPLICATE',
      'свойство подключено к типам или заполнено — сначала отключите его от всех типов и разберите значения',
      { property_id: id, types_count: typesCount, values_count: valuesCount },
    );
  }
  // Для свойств-связей сначала считаем живые рёбра и удаляем link_type
  // (0.8.1): рёбра обнулят `type_id` и станут структурными.
  let linksBecomingStructural: number | null = null;
  if (current.value_type === 'link') {
    const cfg = current.config ?? {};
    const linkTypeId = cfg.link_type_id;
    if (typeof linkTypeId === 'string' && linkTypeId !== '' && cfg.structural !== true) {
      const linkType = getLinkType(ndb, linkTypeId);
      if (linkType !== null) {
        const linkCount = (
          ndb
            .prepare(
              'SELECT COUNT(*) AS c FROM links_v WHERE type_id = ? AND active = 1 AND marked_for_deletion = 0',
            )
            .get(linkTypeId) as { c: number }
        ).c;
        // Используем force=1 — принудительное удаление с обнулением
        // `type_id` у рёбер. Постоянные комментарии рёбер сохраняются
        // (требование 09f692ff).
        deleteLinkType(ndb, linkTypeId, undefined, { force: true });
        linksBecomingStructural = linkCount;
      }
    }
  }
  deleteRowLayered(ndb, 'properties', id);
  return { links_becoming_structural: linksBecomingStructural };
}

// ===========================================================================
// Type bindings (`type_properties`) — what a type exposes
// ===========================================================================

/** Raw binding row joined with its registry property. */
interface BindingRow {
  id: string;
  owner_type: string;
  owner_id: string;
  property_id: string;
  required: number;
  position: number;
  side: string | null;
  name: string;
  value_type: string;
  config: string | null;
  description: string | null;
}

/** Convert a joined binding row into a {@link PropertyDefinition}. */
function rowToPropertyDefinition(row: BindingRow): PropertyDefinition {
  const valueType = row.value_type as PropertyValueType;
  const config = row.config ? (JSON.parse(row.config) as PropertyConfig) : null;
  const side = linkPropertySideFromBinding({
    side: row.side,
    value_type: valueType,
    config,
  });
  return {
    id: row.id,
    property_id: row.property_id,
    owner_type: row.owner_type as TypeOwnerType,
    owner_id: row.owner_id,
    key: row.name,
    value_type: valueType,
    config,
    required: row.required === 1,
    position: row.position,
    side,
    description: row.description,
  };
}

const BINDING_SELECT = `SELECT tp.id AS id, tp.owner_type AS owner_type, tp.owner_id AS owner_id,
       tp.property_id AS property_id, tp.required AS required, tp.position AS position,
       tp.side AS side,
       p.name AS name, p.value_type AS value_type, p.config AS config, p.description AS description
  FROM type_properties_v tp
  JOIN properties_v p ON p.id = tp.property_id`;

/**
 * List the own bindings of a type, ordered by `position` then name
 * (docs/03-server-api.md §8). The registry nature is merged into each entry.
 */
export function listTypeProperties(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
): PropertyDefinition[] {
  const rows = ndb
    .prepare(`${BINDING_SELECT} WHERE tp.owner_type = ? AND tp.owner_id = ? ORDER BY tp.position, p.name`)
    .all(ownerType, ownerId) as BindingRow[];
  return rows.map(rowToPropertyDefinition);
}

/** Return a binding (with its merged property nature) by binding id, or `null`. */
export function getTypeProperty(ndb: NetworkDb, id: string): PropertyDefinition | null {
  const row = ndb.prepare(`${BINDING_SELECT} WHERE tp.id = ?`).get(id) as
    | BindingRow
    | undefined;
  return row ? rowToPropertyDefinition(row) : null;
}

/**
 * Look up the binding of a property by (owner_type, owner_id, key) — the key
 * resolves against the registry (names are unique per network). Returns `null`
 * when the type does not attach a property with this name.
 */
export function getTypePropertyByKey(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  key: string,
): PropertyDefinition | null {
  const row = ndb
    .prepare(`${BINDING_SELECT} WHERE tp.owner_type = ? AND tp.owner_id = ? AND p.name_key = type_name_key(?)`)
    .get(ownerType, ownerId, key) as BindingRow | undefined;
  return row ? rowToPropertyDefinition(row) : null;
}

// ---------------------------------------------------------------------------
// Hierarchy (L21): chain-resolved bindings + default-value/description overrides
// ---------------------------------------------------------------------------

/**
 * The chain of type ids whose bindings are visible to a thought/link of type
 * `typeId`: the type itself, its ancestors up to the root — and, when `typeId`
 * is `null` (an untyped owner), just the root type, whose settings apply to
 * every element without a type (docs/08-ui-spec.md §8.1). Ordered from the
 * type itself up to the root.
 */
function visibleTypeChain(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  typeId: string | null,
): string[] {
  const table = ownerTypeTable(ownerType);
  if (typeId === null) {
    const rootId = getRootTypeId(ndb, table);
    return rootId === null ? [] : [rootId];
  }
  return typeAncestors(ndb, table, typeId);
}

/** The override rows a type holds for a property: both payloads at once. */
function getOverrideRow(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  typeId: string,
  propertyId: string,
): { default_value: PropertyValueValue; description: string | null } | null {
  const row = ndb
    .prepare(
      'SELECT default_value, description FROM type_property_overrides_v WHERE owner_type = ? AND type_id = ? AND property_id = ?',
    )
    .get(ownerType, typeId, propertyId) as
    | { default_value: string; description: string | null }
    | undefined;
  return row
    ? { default_value: JSON.parse(row.default_value) as PropertyValueValue, description: row.description }
    : null;
}

/**
 * `config.default_value_target` осмыслен только для свойства-связи (0.8.2):
 * у скаляра единственная сторона — `default_value`.
 */
function assertNoTargetDefaultForScalar(config: PropertyConfig | null): void {
  if (
    config !== null &&
    config.default_value_target !== undefined &&
    config.default_value_target !== null
  ) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'config.default_value_target допустим только для свойства-связи',
      { field: 'config.default_value_target' },
    );
  }
}

/**
 * Общее значение по умолчанию стороны привязки свойства (0.8.2, ADR «дефолт
 * свойства живёт на привязке»): у свойства-связи со стороной `target` — ключ
 * `config.default_value_target` (набор источников), в остальных случаях —
 * `config.default_value` (единственная сторона скаляра либо сторона
 * источников). Отсутствие ключа — `null`.
 */
function commonSideDefaultValue(def: PropertyDefinition): PropertyValueValue {
  if (def.value_type !== 'link') return def.config?.default_value ?? null;
  const side = def.side ?? linkPropertySideFromConfig(def.value_type, def.config);
  if (side === 'target') return def.config?.default_value_target ?? null;
  return def.config?.default_value ?? null;
}

/**
 * Effective properties of a type (L21 + 0.6.5, docs/02-data-model.md §3.4.1):
 * the type's own bindings plus everything inherited from its ancestors,
 * ordered from the root down to the type. One property appears once in the
 * chain — ancestors win by position, and the «attach to ancestor drops
 * descendants' bindings» rule keeps the invariant on write.
 *
 * `description` is override-aware and transitive: the deepest type between the
 * defining type and this one that stored an override wins, until a deeper type
 * overrides it again.
 *
 * `default_value` (0.8.2, ADR «дефолт свойства живёт на привязке»): только
 * override-строка САМОГО типа, без транзитивности, иначе — общее значение
 * стороны привязки (`config.default_value` для стороны источников,
 * `config.default_value_target` для стороны назначений). `overridden_here` —
 * у самого типа есть строка override с дефолтом.
 *
 * `allowed_opposite_type_ids` (0.8.2, ошибка a6513df0): у свойств-связей —
 * типы привязок этого свойства с ПРОТИВОПОЛОЖНОЙ стороны (`type_properties.side`),
 * вычисляются по реестру привязок (см. {@link attachAllowedOppositeTypeIds}).
 */
export function listEffectiveTypeProperties(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
): EffectiveTypeProperty[] {
  const chainSelfFirst = visibleTypeChain(ndb, ownerType, ownerId);
  const chainRootFirst = [...chainSelfFirst].reverse();
  const out: EffectiveTypeProperty[] = [];
  for (const typeId of chainRootFirst) {
    for (const def of listTypeProperties(ndb, ownerType, typeId)) {
      const inherited = typeId !== ownerId;
      // Дефолт привязки (0.8.2, ADR «дефолт свойства живёт на привязке»):
      // override-строка САМОГО типа, БЕЗ транзитивности — пусто означает общее
      // значение стороны привязки, а не дефолт предка.
      const ownOverrideRow = getOverrideRow(ndb, ownerType, ownerId, def.property_id);
      const ownOverrideDefault = ownOverrideRow === null ? null : ownOverrideRow.default_value;
      // Описания остаются транзитивными: идём от типа вверх до (не включая)
      // определяющий тип; первая строка с описанием побеждает
      // (02-data-model.md §3.4.1 «Транзитивность»).
      let descOverride: string | null = null;
      let descriptionOverridden = false;
      if (inherited) {
        for (const t of chainSelfFirst) {
          if (t === typeId) break;
          const row = getOverrideRow(ndb, ownerType, t, def.property_id);
          if (row === null) continue;
          if (descOverride === null && row.description !== null) {
            descOverride = row.description;
            descriptionOverridden = t === ownerId;
          }
          if (descOverride !== null) break;
        }
      }
      // Общее значение стороны привязки: у стороны назначений — свой ключ
      // `config.default_value_target`, иначе `config.default_value`.
      const ownDefault = commonSideDefaultValue(def);
      const overriddenHere = ownOverrideDefault !== null;
      // Направление для отображения имени (0.8.1): привязка source/target
      // через `type_properties.side` имеет приоритет над `config.direction`.
      // Для встречных свойств, созданных до миграции 041, `side` может быть
      // не выставлен (NULL) — fallback на config.direction.
      const effectiveDirection: LinkPropertyDirection = linkPropertyDirection(
        def.config,
        def.side ?? null,
      );
      out.push({
        ...def,
        // Имя свойства-связи вычисляется из типа связи по направлению
        // (требование 38eaa15c), а не берётся из справочника. Структурное
        // свойство-связь хранит имя в реестре (типа связи у него нет).
        key:
          def.value_type === 'link' && !isStructuralLinkProperty(def.config)
            ? linkPropertyDisplayName(
                ndb,
                (def.config?.link_type_id ?? '') as string,
                effectiveDirection,
              )
            : def.key,
        inherited,
        defined_on: typeId,
        defined_on_name: ownerTypeName(ndb, ownerType, typeId),
        default_value: ownOverrideDefault !== null ? ownOverrideDefault : ownDefault,
        overridden_here: overriddenHere,
        description: inherited ? (descOverride ?? def.description) : def.description,
        description_overridden: descriptionOverridden,
      });
    }
  }
  if (ownerType === 'thought_type') {
    appendMirroredLinkProperties(ndb, ownerId, out);
  }
  attachAllowedOppositeTypeIds(ndb, out);
  return out;
}

/**
 * Проставить эффективным определениям свойства-связи допустимые типы значения
 * (0.8.2, ошибка a6513df0): это типы ПРОТИВОПОЛОЖНОЙ стороны реестра привязок
 * этого свойства (`type_properties.side`), а не `config` владельца. У привязки
 * со стороны источника ограничены цели (типы привязок со стороны назначения),
 * у привязки со стороны назначения — источники. Пусто — ограничения нет.
 *
 * Реестр привязок — единственный источник истины ограничения: `config`-ключи
 * `allowed_*_type_ids` моделью 0.8.1 не предусмотрены и UI не пишутся.
 * Поддеревья типов раскрывает клиент (L21).
 */
function attachAllowedOppositeTypeIds(ndb: NetworkDb, out: EffectiveTypeProperty[]): void {
  const linkPropIds = [
    ...new Set(
      out
        .filter((d) => d.value_type === 'link' && !isStructuralLinkProperty(d.config))
        .map((d) => d.property_id),
    ),
  ];
  if (linkPropIds.length === 0) return;
  const bySide = loadBindingTypesBySide(ndb, linkPropIds);
  for (const def of out) {
    if (def.value_type !== 'link' || isStructuralLinkProperty(def.config)) continue;
    const side = def.side ?? linkPropertySideFromConfig(def.value_type, def.config);
    const entry = bySide.get(def.property_id);
    def.allowed_opposite_type_ids =
      side === 'source'
        ? [...(entry?.target ?? [])]
        : side === 'target'
          ? [...(entry?.source ?? [])]
          : [];
  }
}

/**
 * Типы мыслей, к которым свойство привязано по сторонам (`type_properties.side`)
 * — карта `property_id → { source, target }`. Одна подготовленная выборка на
 * набор свойств: зеркальные записи физических привязок не имеют и не влияют
 * (их `property_id` — это же свойство реестра, а сторона зеркала вычисляется
 * вызывающим).
 */
function loadBindingTypesBySide(
  ndb: NetworkDb,
  propertyIds: readonly string[],
): Map<string, { source: string[]; target: string[] }> {
  const map = new Map<string, { source: string[]; target: string[] }>();
  const rows = ndb
    .prepare(
      `SELECT DISTINCT property_id, side, owner_id
         FROM type_properties_v
        WHERE property_id IN (${propertyIds.map(() => '?').join(', ')})
          AND owner_type = 'thought_type'
          AND side IS NOT NULL`,
    )
    .all(...propertyIds) as Array<{ property_id: string; side: string; owner_id: string }>;
  for (const row of rows) {
    let entry = map.get(row.property_id);
    if (entry === undefined) {
      entry = { source: [], target: [] };
      map.set(row.property_id, entry);
    }
    if (row.side === 'source') entry.source.push(row.owner_id);
    else if (row.side === 'target') entry.target.push(row.owner_id);
  }
  return map;
}

/**
 * Дописать в эффективный набор типа мысли зеркальные свойства-связи
 * (требование dde92461): каждое свойство-связь реестра с непустым
 * `allowed_target_type_ids` порождает у накрываемых типов обратное свойство —
 * без явной привязки, направлением противоположным исходному. «Определяющий»
 * тип для `defined_on` — самый глубокий предок `ownerId`, входящий в
 * `allowed_target_type_ids` (обычно сам список и есть; поддерево расширяет
 * его вниз, и для потомка определяющий тип — его предок из списка).
 *
 * Пара (тип связи + направление) адресует свойство однозначно (требование
 * 597b1c1a) — если пара уже покрыта явной/унаследованной привязкой, зеркало
 * не добавляется (та же свёртка, что в `listThoughtLinkProperties`).
 * Структурные свойства («Родители»/«Потомки») зеркал не порождают: у
 * нетипизированных рёбер обратная сторона уже покрыта парой самих свойств.
 *
 * Дефолт зеркала (0.8.2): только общее значение для назначений
 * (`config.default_value_target`) — пер-типового override у зеркальной записи
 * нет, привязки как таковой не существует.
 */
function appendMirroredLinkProperties(
  ndb: NetworkDb,
  ownerId: string,
  out: EffectiveTypeProperty[],
): void {
  const covered = new Set<string>();
  for (const def of out) {
    if (def.value_type !== 'link') continue;
    // Направление берём из привязки (side) с fallback на config.direction —
    // одно и то же для обеих колонок (требование b9562306: пара
    // (link_type, direction/side) адресует свойство однозначно).
    covered.add(
      `${linkPropertyLinkTypeId(def.config) ?? ''}|${linkPropertyDirection(def.config, def.side ?? null)}`,
    );
  }
  const ancestorsSelfFirst = typeAncestors(ndb, 'thought_types', ownerId);
  const ancestorSet = new Set(ancestorsSelfFirst);
  for (const prop of listNetworkProperties(ndb)) {
    if (prop.value_type !== 'link') continue;
    const cfg = prop.config ?? {};
    if (isStructuralLinkProperty(cfg)) continue;
    const linkTypeId = linkPropertyLinkTypeId(cfg);
    if (linkTypeId === null) continue;
    const allowed = cfg.allowed_target_type_ids ?? [];
    if (allowed.length === 0) continue;
    const direction = linkPropertyDirection(cfg) === 'out' ? 'in' : 'out';
    const pair = `${linkTypeId}|${direction}`;
    if (covered.has(pair)) continue;
    // Тип накрыт, если сам или какой-то его предок входит в allowed-список
    // (эквивалент расширения списка на поддеревья, как в
    // `listThoughtLinkProperties`).
    if (!allowed.some((id) => ancestorSet.has(id))) continue;
    const defining = ancestorsSelfFirst.find((id) => allowed.includes(id));
    if (defining === undefined) continue;
    covered.add(pair);
    out.push({
      id: `mirror:${prop.id}`,
      property_id: prop.id,
      owner_type: 'thought_type',
      owner_id: ownerId,
      key: linkPropertyDisplayName(ndb, linkTypeId, direction),
      value_type: 'link',
      config: { ...cfg, direction },
      required: false,
      position: out.length,
      side: direction === 'out' ? 'source' : 'target',
      description: prop.description,
      mirrored: true,
      inherited: defining !== ownerId,
      defined_on: defining,
      defined_on_name: ownerTypeName(ndb, 'thought_type', defining),
      default_value: cfg.default_value_target ?? null,
      overridden_here: false,
      description_overridden: false,
    });
  }
}

/**
 * Shared guard of both override setters (default value, description): the type
 * must resolve in the connection's layer context, and the addressed property
 * (by binding id OR registry property id — legacy REST clients address the
 * ancestor's binding, new ones the registry property) must be attached in the
 * type's chain.
 *
 * `requireInherited` различает сеттеры: описание правится только у
 * **унаследованной** привязки (собственная — в справочнике, 422), а дефолт
 * (0.8.2, ADR «дефолт свойства живёт на привязке») допускается и на
 * собственной привязке.
 *
 * Returns the registry property plus the side of the nearest binding in the
 * chain (for a link property — `source`/`target`, иначе `null`).
 *
 * Throws `NOT_FOUND` (404) for a missing type/property and `VALIDATION_ERROR`
 * (422) for an own property when `requireInherited`, or an out-of-chain one.
 */
function assertOverridableProperty(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  propertyId: string,
  options: { requireInherited: boolean },
): { prop: PropertyLike; side: LinkPropertySide | null } {
  validateTypeOwnerType(ownerType);
  // S5 (13-layers.md §13): the owner must resolve in the connection's layer
  // context — the `_v` view hides types tombstoned in this chain and keeps
  // layer-only types invisible to the base.
  const typeRow = ndb
    .prepare(`SELECT id FROM ${ownerTypeTable(ownerType)}_v WHERE id = ?`)
    .get(ownerId);
  if (!typeRow) {
    throw new EtnError('NOT_FOUND', `type ${ownerId} not found`, { entity: 'type', id: ownerId });
  }
  // Accept a binding id (legacy form: the ancestor's definition id) or a
  // registry property id.
  const binding = ndb
    .prepare('SELECT property_id FROM type_properties_v WHERE id = ?')
    .get(propertyId) as { property_id: string } | undefined;
  const registryId = binding ? binding.property_id : propertyId;
  const prop = getNetworkProperty(ndb, registryId);
  if (!prop) {
    throw new EtnError('NOT_FOUND', `property ${propertyId} not found`, {
      entity: 'type_property',
      id: propertyId,
    });
  }
  const chain = visibleTypeChain(ndb, ownerType, ownerId);
  let bindingSide: string | null = null;
  let foundInChain = false;
  for (const typeId of chain) {
    const own = ndb
      .prepare(
        'SELECT id, side FROM type_properties_v WHERE owner_type = ? AND owner_id = ? AND property_id = ?',
      )
      .get(ownerType, typeId, registryId) as { id: string; side: string | null } | undefined;
    if (!own) continue;
    if (typeId === ownerId && options.requireInherited) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'собственные свойства правятся в справочнике — описание сразу для всех типов',
        { entity: 'type_property', id: registryId, owner_id: ownerId },
      );
    }
    bindingSide = own.side;
    foundInChain = true;
    break; // nearest chain member — the binding whose side applies
  }
  // Not attached anywhere in the chain at all → cannot be overridden here.
  if (!foundInChain) {
    const attached = ndb
      .prepare(
        `SELECT 1 FROM type_properties_v
       WHERE owner_type = ? AND property_id = ? AND owner_id IN (${chain.map(() => '?').join(', ')})
       LIMIT 1`,
      )
      .get(ownerType, registryId, ...chain);
    if (!attached) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'переопределять можно только свойства, подключённые предками этого типа',
        { entity: 'type_property', id: registryId, owner_id: ownerId },
      );
    }
  }
  return {
    prop: { id: prop.id, name: prop.name, value_type: prop.value_type, config: prop.config },
    side: linkPropertySideFromBinding({
      side: bindingSide,
      value_type: prop.value_type,
      config: prop.config,
    }),
  };
}

/** The visible override rows of (type, property) — ids plus both payloads. */
function listOverrideRows(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  propertyId: string,
): Array<{ id: string; default_value: string; description: string | null }> {
  return ndb
    .prepare(
      'SELECT id, default_value, description FROM type_property_overrides_v WHERE owner_type = ? AND type_id = ? AND property_id = ?',
    )
    .all(ownerType, ownerId, propertyId) as Array<{
    id: string;
    default_value: string;
    description: string | null;
  }>;
}

/**
 * Set or clear a type's default-value override (0.8.2, ADR «дефолт свойства
 * живёт на привязке»). Разрешено для **любой** привязки в цепочке типа — и
 * унаследованной, и собственной; `value = null` снимает дефолт (действует
 * общее значение стороны привязки).
 *
 * Для свойства-связи значение нормализуется по стороне привязки: сторона
 * `source` — набор целей (`normalizeLinkDefaultValue`), сторона `target` —
 * набор источников (`normalizeLinkDefaultValueTarget`, без отбора по типам).
 *
 * Throws `NOT_FOUND` (404) when the property or the type does not exist, and
 * `VALIDATION_ERROR` (422) when the property is not attached in the chain.
 *
 * Возвращает `true`, если эффективный дефолт привязки изменился (запись
 * батч-онтологии по этому признаку отличает `updated` от идемпотентного
 * `unchanged`), `false` — если значение уже было таким.
 */
export function setTypePropertyDefaultOverride(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  propertyId: string,
  value: PropertyValueValue,
  actorUserId: string,
): boolean {
  return ndb.transaction(() => {
    const { prop, side } = assertOverridableProperty(ndb, ownerType, ownerId, propertyId, {
      requireInherited: false,
    });
    // Дефолт свойства-связи — набор целей (bb67e546) либо источников
    // (0.8.2, сторона назначений): нормализация (дедуп + валидация каждого id)
    // вместо скалярной coerce; пустой набор = сброс.
    const normalized =
      value === null
        ? null
        : prop.value_type === 'link'
          ? side === 'target'
            ? normalizeLinkDefaultValueTarget(ndb, prop.name, value)
            : normalizeLinkDefaultValue(ndb, prop, value)
          : (validateAndCoerce(ndb, prop, value), value);
    const now = new Date().toISOString();
    // «Дефолт изменился» — сравнение эффективного собственного значения:
    // запись той же величины не должна выдаваться за `updated`.
    let changed = false;
    if (normalized === null) {
      // Reset the default only: a row that still carries a description
      // override survives with default_value = 'null' (JSON null reads back
      // as "no override"); a row overriding nothing is removed.
      for (const row of listOverrideRows(ndb, ownerType, ownerId, prop.id)) {
        if (JSON.parse(row.default_value) !== null) changed = true;
        if (row.description === null) {
          // S4: физически в основе, надгробием в слое (13-layers.md §5.2).
          deleteRowLayered(ndb, 'type_property_overrides', row.id);
          continue;
        }
        materializeShadow(ndb, 'type_property_overrides', row.id);
        ndb
          .prepare(
            'UPDATE type_property_overrides SET default_value = ?, updated_at = ? WHERE id = ? AND layer_id = ?',
          )
          .run('null', now, row.id, ndb.layerId);
      }
    } else {
      // S5 (13-layers.md §5.1): a visible ancestor row for this natural key is
      // shadowed FIRST — a fresh logical id would leave both rows live in this
      // layer's view. The conflict arm updates ONLY default_value, so a
      // description override held by the same row survives.
      const existingOverride = listOverrideRows(ndb, ownerType, ownerId, prop.id)[0];
      if (existingOverride) {
        changed =
          JSON.stringify(JSON.parse(existingOverride.default_value)) !==
          JSON.stringify(normalized);
        materializeShadow(ndb, 'type_property_overrides', existingOverride.id);
      } else {
        changed = true;
      }
      ndb
        .prepare(
          `INSERT INTO type_property_overrides (id, layer_id, owner_type, type_id, property_id, default_value, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (owner_type, type_id, property_id, layer_id) DO UPDATE SET
             default_value = excluded.default_value,
             updated_at = excluded.updated_at,
             deleted = 0`,
        )
        .run(randomUUID(), ndb.layerId, ownerType, ownerId, prop.id, JSON.stringify(normalized), now, now);
    }
    // Любая правка дефолта (включая сброс) — это правка настроек типа:
    // обновим авторство самого типа (требование e6d4165e, приравнивание).
    touchType(ndb, ownerType, ownerId, actorUserId);
    return changed;
  });
}

/**
 * Set or clear a type's description override of an inherited property
 * (docs/03-server-api.md §8.2). `description = null` (or a blank string)
 * resets the effective description back to the registry's own.
 *
 * Semantics mirror {@link setTypePropertyDefaultOverride}; both overrides are
 * transitive down the type subtree until a deeper type overrides them.
 */
export function setTypePropertyDescriptionOverride(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  propertyId: string,
  description: string | null,
  actorUserId: string,
): void {
  const normalized = normalizeDescription(description);
  ndb.transaction(() => {
    const { prop } = assertOverridableProperty(ndb, ownerType, ownerId, propertyId, {
      requireInherited: true,
    });
    const now = new Date().toISOString();
    if (normalized === null) {
      // Reset the description only: a row that still carries a default-value
      // override survives with description = NULL; a row overriding nothing
      // is removed.
      for (const row of listOverrideRows(ndb, ownerType, ownerId, prop.id)) {
        if (JSON.parse(row.default_value) === null) {
          deleteRowLayered(ndb, 'type_property_overrides', row.id);
          continue;
        }
        materializeShadow(ndb, 'type_property_overrides', row.id);
        ndb
          .prepare(
            'UPDATE type_property_overrides SET description = NULL, updated_at = ? WHERE id = ? AND layer_id = ?',
          )
          .run(now, row.id, ndb.layerId);
      }
    } else {
      const existingOverride = listOverrideRows(ndb, ownerType, ownerId, prop.id)[0];
      if (existingOverride) {
        materializeShadow(ndb, 'type_property_overrides', existingOverride.id);
      }
      ndb
        .prepare(
          `INSERT INTO type_property_overrides (id, layer_id, owner_type, type_id, property_id, default_value, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'null', ?, ?, ?)
           ON CONFLICT (owner_type, type_id, property_id, layer_id) DO UPDATE SET
             description = excluded.description,
             updated_at = excluded.updated_at,
             deleted = 0`,
        )
        .run(randomUUID(), ndb.layerId, ownerType, ownerId, prop.id, normalized, now, now);
    }
    // Любая правка описания (включая сброс) — это правка настроек типа:
    // обновим авторство самого типа (требование e6d4165e, приравнивание).
    touchType(ndb, ownerType, ownerId, actorUserId);
  });
}

/**
 * Материализовать зеркальные привязки со стороны назначения для свойства-связи
 * (0.8.1, требование 115e44fa): при непустом `allowed_target_type_ids` и
 * создании привязки со стороны источника — для каждого типа из списка
 * создаётся привязка со стороны назначения (`required = false`, без дефолта).
 * Уже существующие привязки (в т.ч. в рабочем слое) не дублируются.
 *
 * Возвращает число материализованных привязок — для диагностики в логах и
 * возможного использования вызывающим кодом. Снимается строго в контексте
 * уже открытой транзакции (вызывающий код управляет коммитом).
 */
function materializeMirroredTargetBindings(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  prop: PropertyLike,
  sourceSide: LinkPropertySide,
  actorUserId: string,
): number {
  if (ownerType !== 'thought_type') return 0;
  if (sourceSide !== 'source') return 0;
  if (isStructuralLinkProperty(prop.config)) return 0;
  const allowed = prop.config?.allowed_target_type_ids ?? [];
  const targets = allowed.filter((id): id is string => typeof id === 'string' && id !== '');
  if (targets.length === 0) return 0;

  // Целевой тип должен существовать и не быть удалён/корзинным.
  const existingRows = ndb
    .prepare(
      `SELECT id FROM ${ownerTypeTable(ownerType)}_v WHERE id IN (${targets
        .map(() => '?')
        .join(',')})`,
    )
    .all(...targets) as Array<{ id: string }>;
  const liveTargets = existingRows.map((r) => r.id);

  let created = 0;
  for (const targetTypeId of liveTargets) {
    // Не материализуем привязку к самому себе (цикл в иерархии типов).
    if (targetTypeId === ownerId) continue;
    // Проверяем, нет ли уже живой привязки этого свойства к этому типу
    // (с любой стороны или в любом слое — мы в одной транзакции, слой один).
    const existingBinding = ndb
      .prepare(
        `SELECT id FROM type_properties_v
          WHERE owner_type = ? AND owner_id = ? AND property_id = ?`,
      )
      .get(ownerType, targetTypeId, prop.id) as { id: string } | undefined;
    if (existingBinding) continue;

    // Привязка со стороны target: required=false, без дефолта.
    const position =
      (
        ndb
          .prepare(
            'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM type_properties_v WHERE owner_type = ? AND owner_id = ?',
          )
          .get(ownerType, targetTypeId) as { p: number }
      ).p + 100; // заведомо после явных привязок типа
    const bindingId = randomUUID();
    ndb
      .prepare(
        `INSERT INTO type_properties (id, layer_id, owner_type, owner_id, property_id, required, position, side)
         VALUES (?, ?, ?, ?, ?, 0, ?, 'target')
         ON CONFLICT (owner_type, owner_id, property_id, layer_id) DO UPDATE SET
           deleted = 0,
           side = 'target',
           required = 0`,
      )
      .run(bindingId, ndb.layerId, ownerType, targetTypeId, prop.id, position);
    created += 1;
  }
  if (created > 0) {
    // Зеркальные привязки — правка настроек целевого типа. Чтение физической
    // таблицы нужно, чтобы понять, материализовалась ли строка в текущем слое
    // (а не в любом из цепочки — `type_properties_v` агрегирует по слоям).
    for (const targetTypeId of liveTargets) {
      if (targetTypeId === ownerId) continue;
      const exists = ndb
        .prepare(
          `SELECT id FROM type_properties -- layers:physical-read
            WHERE owner_type = ? AND owner_id = ? AND property_id = ? AND layer_id = ?`,
        )
        .get(ownerType, targetTypeId, prop.id, ndb.layerId) as { id: string } | undefined;
      if (exists) touchType(ndb, ownerType, targetTypeId, actorUserId);
    }
  }
  return created;
}

/**
 * Create-or-attach: the legacy `POST …/types/{id}/properties` entry point.
 *
 * New model (0.6.5): the property lives in the registry.
 *   * a registry property with this name (case-insensitive) already exists →
 *     it is attached to the type as-is; the request's nature fields
 *     (`value_type`/`config`/`description`) are ignored — the registry is the
 *     single source of the property's nature;
 *   * otherwise a registry property is created with the given nature first.
 *
 * Then the binding is created with the given `required`/`position`/`side`.
 * Attaching to a type whose ANCESTOR already binds the property is rejected
 * with `DUPLICATE` — the property is already inherited. Re-attaching a
 * property the type ALREADY binds is **idempotent** (ошибка `0bfd7180`):
 * the existing binding is updated in place (same row, same logical id) —
 * never a second row and never `DUPLICATE`. Attaching to a type
 * drops the same property's redundant bindings across the type's whole
 * SUBTREE in the same transaction (02-data-model.md §3.4.1); values are never
 * touched — they address the property, not the binding.
 *
 * `position` defaults to one past the current maximum so new properties land
 * last. The binding row lands in the connection's layer; a binding tombstone
 * of this layer is woken by the upsert.
 *
 * `side` (0.8.1, задача e1fbf304): для свойств-связей — `source` / `target`,
 * выводится из `config.direction` если не задан; для скалярных и
 * структурных свойств всегда `null`. При создании привязки со стороны
 * источника и непустом `allowed_target_type_ids` материализуются
 * соответствующие зеркальные привязки со стороны назначения
 * (требование 115e44fa).
 */
export function createTypeProperty(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  input: PropertyDefinitionInput,
  actorUserId: string,
): PropertyDefinition {
  validateTypeOwnerType(ownerType);
  const key = validateKey(input.key);
  return ndb.transaction(() => {
    // S5 (13-layers.md §13): the owner must resolve in the connection's layer
    // context — a base write cannot attach a binding to a layer-only type,
    // and a layer write cannot attach one to a type tombstoned in its chain.
    const owner = ndb
      .prepare(`SELECT id FROM ${ownerTypeTable(ownerType)}_v WHERE id = ?`)
      .get(ownerId);
    if (!owner) {
      throw new EtnError('NOT_FOUND', `type ${ownerId} not found`, { entity: 'type', id: ownerId });
    }

    // Registry first: reuse by name, else create.
    let prop = getNetworkPropertyByName(ndb, key);
    if (!prop) {
      prop = createNetworkProperty(ndb, {
        name: key,
        value_type: validateValueType(input.value_type),
        config: input.config ?? null,
        description: input.description ?? null,
      }, actorUserId);
    }

    // A binding on an ancestor means the property is already inherited — the
    // effective list must keep exactly one entry per property per chain, so
    // that stays `DUPLICATE`.
    //
    // A visible binding on the type ITSELF is a repeat attach, and a repeat is
    // idempotent (ошибка `0bfd7180`; прецедент — MCP `etn.ontology.write`
    // `type_properties[].action` `unchanged`/`updated` и `on_duplicate: reuse`
    // у `etn.thoughts.write`): привязка не дублируется и не пересоздаётся,
    // а до-писывается тем же upsert ниже (`ON CONFLICT … DO UPDATE`), сохраняя
    // исходный логический id. Порядок при этом не переезжает: без явного
    // `position` берётся позиция существующей привязки, а не «в конец».
    const chain = visibleTypeChain(ndb, ownerType, ownerId);
    let existingOwnPosition: number | null = null;
    for (const typeId of chain) {
      const clash = ndb
        .prepare(
          'SELECT id, position FROM type_properties_v WHERE owner_type = ? AND owner_id = ? AND property_id = ?',
        )
        .get(ownerType, typeId, prop.id) as { id: string; position: number } | undefined;
      if (!clash) continue;
      if (typeId === ownerId) {
        existingOwnPosition = clash.position;
        continue;
      }
      throw new EtnError(
        'DUPLICATE',
        `свойство «${key}» уже подключено родительским типом — оно и так наследуется`,
        { owner_type: ownerType, owner_id: ownerId, key, clash_owner_id: typeId },
      );
    }

    // Сторона привязки (0.8.1): выводится из input.side или из config.direction.
    const side = validateLinkSide(input.side, prop.value_type, prop.config);
    const finalSide: LinkPropertySide | null =
      side ?? linkPropertySideFromConfig(prop.value_type, prop.config);

    // Уникальность пары (тип связи + сторона) в наборе собственных свойств
    // типа (требование b9562306). Совпадение с внетиповым свойством — не ошибка.
    // Собственная привязка этого же свойства исключается: при повторном
    // attach она и есть обновляемая строка, а не соперник (ошибка 0bfd7180).
    if (prop.value_type === 'link') {
      assertLinkPropertyPairUnique(
        ndb,
        ownerType,
        ownerId,
        linkPropertyLinkTypeId(prop.config),
        finalSide,
        prop.id,
      );
    }

    // Attaching here makes the same property's bindings across the subtree
    // redundant (02-data-model.md §3.4.1): drop them in this transaction.
    // Values survive — they reference the property, not the binding.
    const table = ownerTypeTable(ownerType);
    for (const typeId of subtreeIds(ndb, table, ownerId)) {
      if (typeId === ownerId) continue;
      const redundant = ndb
        .prepare(
          'SELECT id FROM type_properties_v WHERE owner_type = ? AND owner_id = ? AND property_id = ?',
        )
        .get(ownerType, typeId, prop.id) as { id: string } | undefined;
      if (redundant) {
        deleteRowLayered(ndb, 'type_properties', redundant.id);
      }
    }

    const position =
      input.position ??
      existingOwnPosition ??
      (
        ndb
          .prepare(
            'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM type_properties_v WHERE owner_type = ? AND owner_id = ?',
          )
          .get(ownerType, ownerId) as { p: number }
      ).p;
    const bindingId = randomUUID();
    ndb
      .prepare(
        `INSERT INTO type_properties (id, layer_id, owner_type, owner_id, property_id, required, position, side)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_type, owner_id, property_id, layer_id) DO UPDATE SET
           deleted = 0,
           required = excluded.required,
           position = excluded.position,
           side = excluded.side`,
      )
      .run(
        bindingId,
        ndb.layerId,
        ownerType,
        ownerId,
        prop.id,
        input.required ? 1 : 0,
        position,
        finalSide,
      );
    // The conflict arm wakes a same-(owner, property) tombstone of this layer
    // keeping its ORIGINAL id — re-read by (owner, key), never by the fresh uuid.
    // Подключение свойства — это правка настроек типа: обновим авторство
    // самого типа (требование e6d4165e, приравнивание).
    touchType(ndb, ownerType, ownerId, actorUserId);

    // Зеркальные привязки со стороны target (требование 115e44fa) — только
    // для свойств-связей с непустым allowed_target_type_ids и стороны source.
    // Без побочного эффекта, если ограничение пустое или тип скалярный.
    if (finalSide !== null) {
      materializeMirroredTargetBindings(ndb, ownerType, ownerId, prop, finalSide, actorUserId);
    }

    // Для link-свойства реестровое имя — display-имя из типа связи (входной
    // key игнорируется при создании), поэтому биндинг перечитывается по
    // ФАКТИЧЕСКОМУ имени строки реестра, а не по входному ключу.
    return getTypePropertyByKey(ndb, ownerType, ownerId, prop.name)!;
  });
}

/** A plain ISO date (YYYY-MM-DD, optionally with a time tail). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}($|T)/;

/**
 * Try to convert a stored value to a new value type (L6). Returns the column +
 * raw SQL value to rewrite, or `null` when the value cannot be represented —
 * the caller then clears it. Deliberately conservative: dates never become
 * numbers.
 */
function convertStoredValue(
  value: string | number | boolean | string[],
  to: PropertyValueType,
): { column: string; raw: string | number | null } | null {
  if (Array.isArray(value)) {
    if (to === 'text' || to === 'url') return { column: 'value_text', raw: value.join(', ') };
    return null;
  }
  switch (to) {
    case 'text':
    case 'url': {
      if (typeof value === 'string') return { column: 'value_text', raw: value };
      if (typeof value === 'number') return { column: 'value_text', raw: String(value) };
      return { column: 'value_text', raw: value ? 'true' : 'false' };
    }
    case 'number': {
      if (typeof value === 'number') return { column: 'value_number', raw: value };
      if (typeof value === 'boolean') return { column: 'value_number', raw: value ? 1 : 0 };
      const trimmed = value.trim();
      if (trimmed !== '') {
        const n = Number(trimmed);
        if (Number.isFinite(n)) return { column: 'value_number', raw: n };
      }
      return null;
    }
    case 'date': {
      if (typeof value === 'string' && ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value))) {
        return { column: 'value_date', raw: value.slice(0, 10) };
      }
      return null;
    }
    case 'bool': {
      if (typeof value === 'boolean') return { column: 'value_bool', raw: value ? 1 : 0 };
      if (typeof value === 'number' && (value === 0 || value === 1)) {
        return { column: 'value_bool', raw: value };
      }
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (s === 'true' || s === 'да' || s === '1') return { column: 'value_bool', raw: 1 };
        if (s === 'false' || s === 'нет' || s === '0') return { column: 'value_bool', raw: 0 };
      }
      return null;
    }
    case 'link':
      // Значение свойства-связи не хранится — конверсия в 'link' всегда
      // сбрасывает значение (ребро создаётся отдельно).
      return null;
    case 'thought_ref':
      // Legacy: в живой БД таких свойств не остаётся (миграция 040). Для
      // гипотетических строк-«призраков» — конвертация не имеет смысла.
      return null;
    case 'cross_network_ref':
      // Кросс-сетевая ссылка: снапшот привязан к адресу и при смене value_type
      // теряет смысл. Конвертация бессмысленна — значение сбрасывается
      // (как и для `link` / legacy `thought_ref`).
      return null;
    case 'publication':
      // Ссылка на публикацию: id адресует конкретную публикацию и при смене
      // value_type теряет смысл — конвертировать не во что.
      return null;
  }
}

/**
 * Rewrite every stored value of a property whose `value_type` changed (L6):
 * convertible values move to the new column, the rest are deleted. Runs in the
 * caller's transaction so a failed migration rolls the type change back.
 * Scope: the values visible in the connection's layer context (matches the
 * write path — a layer edits its own view of the row set).
 */
function migratePropertyValues(
  ndb: NetworkDb,
  propertyId: string,
  from: PropertyValueType,
  to: PropertyValueType,
): void {
  const rows = ndb
    .prepare('SELECT * FROM property_values_v WHERE property_id = ?')
    .all(propertyId) as PropertyValueRow[];
  const now = new Date().toISOString();
  for (const row of rows) {
    // No definition here (only the source value type) — the data-driven array
    // parse inside readValue covers stored multiple values without the flag.
    const value = readValue(row, from);
    // Конверсия при смене value_type между скалярными категориями; форма
    // `CrossNetworkRefValue[]` (задача 7849008a) здесь не появляется —
    // `readValue` для cross_network_ref возвращает сырой адрес-строку или
    // JSON-массив, без снапшота. `convertStoredValue` ждёт скаляр.
    const converted =
      value === null
        ? null
        : convertStoredValue(value as string | number | boolean | string[], to);
    if (converted === null) {
      // S4: физически в основе, надгробием в слое (13-layers.md §5.2).
      deleteRowLayered(ndb, 'property_values', row.id);
      continue;
    }
    materializeShadow(ndb, 'property_values', row.id);
    ndb
      .prepare(
        `UPDATE property_values SET
           value_text = NULL, value_date = NULL, value_number = NULL,
           value_bool = NULL, value_thought_ref = NULL,
           ${converted.column} = ?, updated_at = ?
         WHERE id = ? AND layer_id = ?`,
      )
      .run(converted.raw, now, row.id, ndb.layerId);
  }
}

/**
 * Patch a type property (docs/03-server-api.md §8, legacy surface). The id
 * addresses the BINDING; `required`/`position`/`side` edit the binding itself,
 * while `key`/`value_type`/`config`/`description` edit the registry property —
 * and so apply immediately to every type attaching it (0.6.5 semantics).
 *
 * Changing `value_type` rewrites every stored value of the property in the
 * same transaction (see {@link migratePropertyValues}); renaming keeps stored
 * values attached (they reference the property id, not the name).
 *
 * `side` (0.8.1, задача e1fbf304) — переезд направления из свойства в
 * привязку. Значение валидируется: для скалярных/структурных свойств
 * принимается только `null`; для типизированных свойств-связей — `source`
 * или `target`. Не задан — сторона остаётся прежней.
 */
export function updateTypeProperty(
  ndb: NetworkDb,
  id: string,
  changes: PropertyDefinitionUpdateInput,
  actorUserId: string,
): PropertyDefinition {
  const current = getTypeProperty(ndb, id);
  if (!current) {
    throw new EtnError('NOT_FOUND', `property ${id} not found`, { entity: 'type_property', id });
  }
  const nextKey = changes.key !== undefined ? validateKey(changes.key) : undefined;
  const nextType = changes.value_type !== undefined ? validateValueType(changes.value_type) : undefined;

  return ndb.transaction(() => {
    // Registry-level edits (nature): one property, every attaching type.
    const registryChanges: NetworkPropertyUpdateInput = {};
    if (nextKey !== undefined && nextKey !== current.key) registryChanges.name = nextKey;
    if (nextType !== undefined && nextType !== current.value_type) {
      registryChanges.value_type = nextType;
    }
    if (changes.config !== undefined) registryChanges.config = changes.config;
    if (changes.description !== undefined) registryChanges.description = changes.description;
    if (Object.keys(registryChanges).length > 0) {
      updateNetworkProperty(ndb, current.property_id, registryChanges, actorUserId);
    }
    // Binding-level edits (role in this type).
    const sets: string[] = [];
    const args: unknown[] = [];
    if (changes.required !== undefined) {
      sets.push('required = ?');
      args.push(changes.required ? 1 : 0);
    }
    if (changes.position !== undefined) {
      sets.push('position = ?');
      args.push(changes.position);
    }
    let nextSide: LinkPropertySide | null | undefined = undefined;
    if (changes.side !== undefined) {
      const refreshedProp = getNetworkProperty(ndb, current.property_id);
      if (refreshedProp === null) {
        throw new EtnError('NOT_FOUND', `property ${current.property_id} not found`, {
          entity: 'property',
          id: current.property_id,
        });
      }
      nextSide = validateLinkSide(changes.side, refreshedProp.value_type, refreshedProp.config);
      sets.push('side = ?');
      args.push(nextSide);
    }
    let typeTouched = Object.keys(registryChanges).length > 0;
    if (sets.length > 0) {
      // S4 (13-layers.md §5.1): shadow copy on first edit in a working layer;
      // the UPDATE targets the connection's layer row only.
      materializeShadow(ndb, 'type_properties', id);
      args.push(id, ndb.layerId);
      ndb.prepare(`UPDATE type_properties SET ${sets.join(', ')} WHERE id = ? AND layer_id = ?`).run(
        ...args,
      );
      // Правка роли свойства в типе (required/position) тоже меняет настройки
      // типа: обновим авторство типа (требование e6d4165e).
      typeTouched = true;
    }
    if (typeTouched) {
      touchType(ndb, current.owner_type, current.owner_id, actorUserId);
    }
    // Уникальность пары (тип связи + сторона) при правке свойства-связи
    // (требование b9562306): смена value_type/config/side могла изменить пару.
    const updated = getTypeProperty(ndb, id);
    if (updated !== null && updated.value_type === 'link') {
      assertLinkPropertyPairUnique(
        ndb,
        updated.owner_type,
        updated.owner_id,
        linkPropertyLinkTypeId(updated.config),
        updated.side ?? null,
        updated.property_id,
      );
    }
    return updated!;
  });
}

/**
 * Detach a property from a type (legacy `DELETE …/types/{id}/properties/{id}`
 * surface). Since 0.6.5 the binding carries no values: detaching leaves every
 * stored value in place — it becomes a value outside type, readable with
 * `outside_type: true` and deletable manually (02-data-model.md §3.5a). The
 * pre-0.6.5 cascade (values + overrides deleted with the definition) is gone.
 *
 * Снятие привязки со стороны назначения дополнительно синхронизирует legacy
 * `config.allowed_target_type_ids` — см.
 * {@link stripLegacyAllowedTargetType} (ошибка 3ac05cff, 0.9.1).
 */
export function deleteTypeProperty(ndb: NetworkDb, id: string, actorUserId: string): void {
  const current = getTypeProperty(ndb, id);
  if (!current) {
    throw new EtnError('NOT_FOUND', `property ${id} not found`, { entity: 'type_property', id });
  }
  ndb.transaction(() => {
    // S4 (13-layers.md §5.2): in a working layer the detach materialises a
    // tombstone over the binding; the base rows stay intact.
    deleteRowLayered(ndb, 'type_properties', id);
    // Привязка назначения, порождённая legacy-ограничением целей, снимается
    // НАВСЕГДА: из списка целей реестрового свойства её владелец убирается,
    // иначе эффективный набор снова синтезирует зеркало и «✕» — no-op.
    if (current.value_type === 'link' && !isStructuralLinkProperty(current.config)) {
      if (current.side === 'target') {
        stripLegacyAllowedTargetType(ndb, current.property_id, current.owner_id, actorUserId);
      }
    }
    // Отключение свойства — это правка настроек типа: обновим авторство
    // самого типа (требование e6d4165e, приравнивание).
    touchType(ndb, current.owner_type, current.owner_id, actorUserId);
  });
}

/**
 * Убрать тип из legacy-списка `config.allowed_target_type_ids` свойства-связи
 * (ошибка 3ac05cff, 0.9.1). Список — исторический механизм МАТЕРИАЛИЗАЦИИ
 * зеркал (миграция 042, требование e93001ac): из него `createTypeProperty`
 * создаёт настоящие target-привязки, а `appendMirroredLinkProperties` /
 * `listThoughtLinkProperties` по-прежнему достраивают обратное свойство у
 * типов, покрытых списком (нужно для .etnx-архивов, где target-привязок нет).
 *
 * Пока снятый владелец остаётся в списке, синтез возвращает свойство — снятие
 * target-привязки визуально не срабатывает. Поэтому при отвязке target-привязки
 * тип убирается из списка: в модели 0.8.1 ограничение целей — это сами
 * target-привязки (`loadBindingTypesBySide`), а список лишь их дублирует.
 *
 * Синхронизируется только ТОЧНОЕ совпадение `typeId` со списком. Тип, покрытый
 * списком через предка (поддерево), собственной привязки не имеет и снять её
 * нельзя — правится объявление предка.
 *
 * Конфиг правится ТОЧЕЧНО, минуя {@link updateNetworkProperty}: его
 * `validateLinkConfig` перепроверяет весь конфиг, включая посторонние
 * legacy-записи списка, которые могли протухнуть (тип удалён) — это отвергло бы
 * законное снятие. Здесь удаляется ровно один элемент, остальное не трогается.
 */
function stripLegacyAllowedTargetType(
  ndb: NetworkDb,
  propertyId: string,
  typeId: string,
  actorUserId: string,
): void {
  const prop = getNetworkProperty(ndb, propertyId);
  if (prop === null || prop.value_type !== 'link' || isStructuralLinkProperty(prop.config)) return;
  const cfg = prop.config ?? {};
  const allowed = cfg.allowed_target_type_ids;
  if (!Array.isArray(allowed) || !allowed.includes(typeId)) return;
  const nextConfig: PropertyConfig = { ...cfg };
  const remaining = allowed.filter((entry) => entry !== typeId);
  if (remaining.length > 0) nextConfig.allowed_target_type_ids = remaining;
  else delete nextConfig.allowed_target_type_ids;
  const nowMs = Date.now();
  // S4 (13-layers.md §5.1): shadow copy on first edit in a working layer.
  materializeShadow(ndb, 'properties', propertyId);
  ndb
    .prepare(
      `UPDATE properties SET config = ?, updated_at = ?, updated_by = ?, updated_at_ms = ?
        WHERE id = ? AND layer_id = ?`,
    )
    .run(
      JSON.stringify(nextConfig),
      new Date(nowMs).toISOString(),
      actorUserId,
      nowMs,
      propertyId,
      ndb.layerId,
    );
}

/**
 * Reorder the property bindings of a type by assigning `position = index` to
 * each id in `orderedPropertyIds` (docs/03-server-api.md §8). Ids not listed
 * keep their position. All listed ids must belong to the given owner.
 */
export function reorderTypeProperties(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  orderedPropertyIds: string[],
  actorUserId: string,
): PropertyDefinition[] {
  return ndb.transaction(() => {
    // S4: в слое порядок — правка теневых копий привязок (13-layers.md §5.1).
    const stmt = ndb.prepare(
      'UPDATE type_properties SET position = ? WHERE id = ? AND owner_type = ? AND owner_id = ? AND layer_id = ?',
    );
    orderedPropertyIds.forEach((propId, index) => {
      materializeShadow(ndb, 'type_properties', propId);
      stmt.run(index, propId, ownerType, ownerId, ndb.layerId);
    });
    // Реордеринг — правка настроек типа: обновим авторство самого типа
    // (требование e6d4165e, приравнивание).
    touchType(ndb, ownerType, ownerId, actorUserId);
    return listTypeProperties(ndb, ownerType, ownerId);
  });
}

// ===========================================================================
// Property values (C6) — polymorphic EAV on thoughts/links
// ===========================================================================

/** Raw `property_values` row. */
interface PropertyValueRow {
  id: string;
  owner_type: string;
  owner_id: string;
  property_id: string;
  value_text: string | null;
  value_date: string | null;
  value_number: number | null;
  value_bool: number | null;
  value_thought_ref: string | null;
  updated_at: string;
  created_by: string;
  updated_by: string;
  created_at_ms: number;
  updated_at_ms: number;
}

/**
 * Map a stored row back into the typed {@link PropertyValue.value} according to
 * the property's `value_type`, reading only the matching column.
 *
 * `url` (multiple form): `value_text` stores a JSON array; the stored shape
 * wins over the `multiple` flag (task 0.6.2).
 */
function readValue(
  row: PropertyValueRow,
  valueType: PropertyValueType,
  multiple = false,
): PropertyValueValue {
  switch (valueType) {
    case 'text':
      return row.value_text;
    case 'url': {
      const raw = row.value_text;
      if (raw === null) return null;
      if (raw.startsWith('[')) return parseRefIds(raw);
      return multiple ? [raw] : raw;
    }
    case 'date':
      return row.value_date;
    case 'number':
      return row.value_number;
    case 'bool':
      return row.value_bool === null ? null : row.value_bool === 1;
    case 'link':
      // Значения свойства-связи не хранятся в property_values (ADR «свойство-связь
      // — проекция ребра») — строка-призрак (неудалённый остаток миграции 040
      // с несуществующей целью) читается как null.
      return null;
    case 'thought_ref': {
      // Legacy (миграция 040): в живой БД таких свойств быть не должно;
      // но если строка-«призрак» всё же есть — читаем по старому (single id
      // или JSON-массив), чтобы тесты value-handling и импорт архивов не
      // разломались.
      const raw = row.value_thought_ref;
      if (raw === null) return null;
      if (raw.startsWith('[')) return parseRefIds(raw);
      return multiple ? [raw] : raw;
    }
    case 'cross_network_ref': {
      // Адрес лежит в value_text: single — строка, multiple — JSON-массив
      // адресов (та же форма, что у `url` / legacy `thought_ref`).
      const raw = row.value_text;
      if (raw === null) return null;
      if (raw.startsWith('[')) return parseRefIds(raw);
      return multiple ? [raw] : raw;
    }
    case 'publication': {
      // Ссылка на публикацию лежит в value_text: single — id строкой,
      // multiple — JSON-массив id (та же форма, что у cross_network_ref).
      const raw = row.value_text;
      if (raw === null) return null;
      if (raw.startsWith('[')) return parseRefIds(raw);
      return multiple ? [raw] : raw;
    }
  }
}

/**
 * `true` when the property allows several values of its `value_type`
 * (`url` only; `text` keeps its comma-join form).
 */
function isMultipleProperty(prop: PropertyLike): boolean {
  if (prop.config?.multiple !== true) return false;
  // Legacy (миграция 040): в живой БД thought_ref-свойств быть не должно,
  // но для value-handling (тесты, унаследованные архивы) — multiple
  // распознаётся и для thought_ref. cross_network_ref (0.8.3, задача
  // 7849008a) — массив кросс-сетевых адресов, publication (0.11.1, задача
  // f37b468d) — массив id публикаций.
  return (
    prop.value_type === 'url' ||
    prop.value_type === 'thought_ref' ||
    prop.value_type === 'cross_network_ref' ||
    prop.value_type === 'publication'
  );
}

/**
 * LIKE pattern matching an id inside a stored JSON array of ids
 * (`["a","b"]` → `%"a"%`). Quoting makes the match exact.
 */
function refLikePattern(id: string): string {
  return `%"${id.replace(/[\\%_]/g, (ch) => `\\${ch}`)}"%`;
}

/**
 * Parse a stored multiple `thought_ref`/`url` payload (`["id", …]` JSON) into
 * strings. Defensive against malformed/legacy content.
 */
function parseRefIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v !== '');
  } catch {
    return [];
  }
}

/**
 * The `value_*` column a value type is stored in. `url` shares `value_text`
 * with `text`. The literal is derived from the validated enum, never from user
 * input.
 */
function storageColumn(valueType: PropertyValueType): string {
  // `url` и `cross_network_ref` делят `value_text` с `text` — собственной
  // колонки у них нет (миграция 006 для url, 044 для cross_network_ref: адрес
  // `n:<net>#<id>` лежит скаляром/JSON-массивом в `value_text`). Без явного
  // маппинга `value_${valueType}` дал бы несуществующую колонку
  // `value_cross_network_ref` и падение INSERT (ошибка 052c84b2). Чтение
  // согласовано — `readValue` берёт `value_text` для обоих видов.
  // `publication` (0.11.1, задача f37b468d) — третья владелица `value_text`:
  // id публикации скаляром/JSON-массивом, отдельной колонки нет.
  return valueType === 'url' || valueType === 'cross_network_ref' || valueType === 'publication'
    ? 'value_text'
    : `value_${valueType}`;
}

/**
 * The layer-resolving view of an owner's table (13-layers.md §4.2): owner
 * validation must respect the connection's layer context — a tombstoned owner
 * is a 404 in that layer.
 */
function ownerTable(ownerType: PropertyOwnerType): 'thoughts_v' | 'links_v' {
  return ownerType === 'thought' ? 'thoughts_v' : 'links_v';
}

/**
 * Property ids attached to the owner's type chain (own binding or any
 * ancestor's, L21): the set of properties a value write may target. An
 * untyped owner sees the root type's bindings (docs/08-ui-spec.md §8.1).
 */
function attachedPropertyIds(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
): Set<string> {
  const row = ndb
    .prepare(`SELECT type_id AS tid FROM ${ownerTable(ownerType)} WHERE id = ?`)
    .get(ownerId) as { tid: string | null } | undefined;
  if (!row) {
    throw new EtnError('NOT_FOUND', `${ownerType} ${ownerId} not found`, {
      entity: ownerType,
      id: ownerId,
    });
  }
  const defOwnerType: TypeOwnerType = ownerType === 'thought' ? 'thought_type' : 'link_type';
  const chain = visibleTypeChain(ndb, defOwnerType, row.tid);
  const ids = new Set<string>();
  if (chain.length === 0) return ids;
  const stmt = ndb.prepare(
    `SELECT property_id FROM type_properties_v WHERE owner_type = ? AND owner_id IN (${chain
      .map(() => '?')
      .join(', ')})`,
  );
  for (const r of stmt.all(defOwnerType, ...chain) as Array<{ property_id: string }>) {
    ids.add(r.property_id);
  }
  return ids;
}

/**
 * Результат {@link resolveDefinition}: определение свойства плюс направление рёбер,
 * выведенное из display-имени стороны (0.8.2, ошибка 748b80fd). `direction`
 * заполнен, когда ключ совпал с display-именем стороны внетиповой записи
 * свойства-связи (`name_forward` → `out`, `name_reverse` → `in`): запись и
 * удаление рёбер обязаны идти из имени стороны, а не из стороны привязки
 * владельца. `null` — ключ адресован канонически (id, скаляр, ключ
 * эффективного набора типа): направление определяет привязка владельца
 * (0.8.2, ошибка c67676f3).
 */
export interface ResolvedDefinition extends PropertyLike {
  direction: LinkPropertyDirection | null;
}

/**
 * Направление рёбер, заданное display-именем стороны свойства-связи
 * (`name_forward` ⇒ `out`, `name_reverse` ⇒ `in`) — как в
 * {@link resolveConditionPropertyRef}. `null` — имя не совпало ни с одной
 * текущей стороной (например, устаревший снимок имени строки реестра, когда
 * тип связи переименовали) либо свойство скалярное/структурное.
 */
function linkPropertyDirectionFromDisplayName(
  ndb: NetworkDb,
  config: PropertyConfig | null,
  key: string,
): LinkPropertyDirection | null {
  const cfg = config ?? {};
  if (isStructuralLinkProperty(cfg)) return null;
  const linkTypeId = linkPropertyLinkTypeId(cfg);
  if (linkTypeId === null) return null;
  const k = typeNameKey(key);
  if (k === typeNameKey(linkPropertyDisplayName(ndb, linkTypeId, 'out'))) return 'out';
  if (k === typeNameKey(linkPropertyDisplayName(ndb, linkTypeId, 'in'))) return 'in';
  return null;
}

/**
 * Resolve a property by the key the READ side shows. Names are unique per
 * network since 0.6.5, so a scalar name alone addresses the property — but a
 * link property reads under its DISPLAY name computed from the link type and
 * direction (требование «имя свойства-связи вычисляется из типа связи»),
 * which can diverge from the registry row's stored name (миграция 040 named
 * the link type `upd: …` while keeping the old property name; renaming a link
 * type later shifts the display name the same way). Resolution order for
 * thought owners:
 *
 *  1. the owner type's effective set — its `key` is exactly what the card and
 *     the editor show (display names for links, registry names for scalars,
 *     mirrors included). A pair «link type + direction» is unique in a set, so
 *     a link hit is unambiguous; a display name clashing with a scalar's name
 *     surfaces as an explicit ambiguity error;
 *  2. the registry by stored name (unattached scalars, canonical link names);
 *  3. link properties of the registry by EITHER display side — the outside-type
 *     write arm (требование dfaacb05: запись значения свойства-связи, не
 *     подключённого к типу владельца).
 *
 * Шаги 2–3 возвращают `direction` из display-имени (имя стороны адресует
 * направление однозначно, 0.8.2, ошибка 748b80fd): у внетипового ключа
 * `name_forward` пишет/удаляет ИСХОДЯЩИЕ рёбра, `name_reverse` — входящие.
 * Шаг 1 (типовой ключ эффективного набора) направление не задаёт — его, как и
 * раньше, определяет сторона привязки владельца (ошибка c67676f3).
 *
 * Connectivity to the owner's type is NOT checked here — callers decide
 * (writes reject unattached properties with 422, deletes of outside-type
 * values must succeed). До 0.8.2 экспортировалась для фасада
 * `etn.properties.set` (удалён, задача 937480ca); остальные пользователи —
 * внутри домена.
 */
export function resolveDefinition(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  key: string,
): ResolvedDefinition | null {
  if (ownerType === 'thought') {
    // 1) Эффективный набор типа владельца — ключи, которые отдаёт чтение.
    const row = ndb
      .prepare('SELECT type_id FROM thoughts_v WHERE id = ?')
      .get(ownerId) as { type_id: string | null } | undefined;
    const typeId = row?.type_id ?? getRootTypeId(ndb, 'thought_types');
    if (typeId !== null) {
      const matches = listEffectiveTypeProperties(ndb, 'thought_type', typeId).filter(
        (d) => d.key === key,
      );
      if (matches.length === 1) {
        const def = matches[0]!;
        // Типовой ключ: направление — за привязкой владельца (c67676f3).
        return {
          id: def.property_id,
          name: def.key,
          value_type: def.value_type,
          config: def.config,
          direction: null,
        };
      }
      if (matches.length > 1) {
        throw new EtnError('VALIDATION_ERROR', `property name "${key}" is ambiguous`, {
          field: 'property',
          name: key,
          candidates: matches.map((m) => ({ id: m.property_id, name: m.key })),
        });
      }
    }
  }
  // 2) Канонический путь — имя строки реестра. Для свойства-связи имя строки —
  //    display-имя ОДНОЙ из сторон: если оно совпало с текущей стороной типа
  //    связи, направление берём из имени (748b80fd).
  const prop = getNetworkPropertyByName(ndb, key);
  if (prop) {
    return {
      id: prop.id,
      name: prop.name,
      value_type: prop.value_type,
      config: prop.config,
      direction:
        prop.value_type === 'link'
          ? linkPropertyDirectionFromDisplayName(ndb, prop.config, key)
          : null,
    };
  }
  // 3) Внетиповая запись свойства-связи (dfaacb05): ключ может быть
  //    display-именем любой стороны link-свойства реестра, не подключённого к
  //    типу владельца; направление — из имени стороны (748b80fd).
  if (ownerType === 'thought') {
    const byDisplay = new Map<string, { prop: NetworkProperty; direction: LinkPropertyDirection }>();
    for (const p of listNetworkProperties(ndb)) {
      if (p.value_type !== 'link') continue;
      const direction = linkPropertyDirectionFromDisplayName(ndb, p.config, key);
      if (direction === null) continue;
      byDisplay.set(p.id, { prop: p, direction });
    }
    if (byDisplay.size === 1) {
      const hit = [...byDisplay.values()][0]!;
      return {
        id: hit.prop.id,
        name: hit.prop.name,
        value_type: hit.prop.value_type,
        config: hit.prop.config,
        direction: hit.direction,
      };
    }
    if (byDisplay.size > 1) {
      throw new EtnError('VALIDATION_ERROR', `property name "${key}" is ambiguous`, {
        field: 'property',
        name: key,
        candidates: [...byDisplay.values()].map((h) => ({ id: h.prop.id, name: h.prop.name })),
      });
    }
  }
  return null;
}

/**
 * Прочитать значение `cross_network_ref` со снапшотом и применить фильтр прав
 * (задача 7849008a, требование 6d4ad9ac). Возвращает `null`, если после
 * фильтрации не осталось ни одного адреса — это сигнал вызывающему, что
 * значения нет вообще (нет прав на единственную сеть). Иначе возвращает
 * массив `CrossNetworkRefValue[]` либо пустой массив, если значение пустое.
 *
 * Деградация по правам:
 *   * сеть удалена — снапшот и пометка `unresolved: true` сохраняются
 *     (значение остаётся видимым);
 *   * нет прав на сеть — адрес молча отфильтровывается; если после этого
 *     не осталось ни одного адреса, возвращается `null` (значение исчезает
 *     из карточки);
 *   * повреждённый адрес (network_id === '') — пропускается фильтром
 *     (`accessibleNetworkIds` сети с пустым id не содержит) и отбрасывается
 *     заодно с фильтрацией.
 *
 * Если `accessibleNetworkIds === null`, фильтрация не выполняется (тесты и
 * устаревшие пути чтения).
 */
function readCrossNetworkRefValueResolved(
  ndb: NetworkDb,
  propertyValueId: string,
  rawValue: string | string[],
  accessibleNetworkIds: ReadonlySet<string> | null,
): CrossNetworkRefValue[] | null {
  const payload = readSnapshotPayload(ndb, propertyValueId);
  const values = readCrossNetworkRefValue(rawValue, payload);
  if (accessibleNetworkIds === null) return values;
  const filtered = values.filter((v) => v.network_id === '' || accessibleNetworkIds.has(v.network_id));
  // Если всё отфильтровано и исходное значение не пустое — скрываем значение целиком.
  const isEmpty = (Array.isArray(rawValue) ? rawValue.length === 0 : rawValue === '');
  if (filtered.length === 0 && !isEmpty) return null;
  return filtered;
}

/**
 * List all stored property values of an owner (docs/03-server-api.md §9),
 * including **values outside type** — values whose property is not attached to
 * the owner's type chain (a leftover from a type change or a detached
 * property). Such values carry `outside_type: true` plus the property's name
 * and value type, without which the client could not render them
 * (02-data-model.md §3.5a).
 *
 * `accessibleNetworkIds` (задача 7849008a, требование 6d4ad9ac) — набор сетей,
 * к которым у текущего пользователя есть доступ; используется для фильтрации
 * значений `cross_network_ref` (нет прав — значение молча отфильтровывается).
 * `null`/не задано — фильтрация не выполняется (для тестов и устаревших
 * путей чтения).
 */
export function getPropertyValues(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  accessibleNetworkIds: ReadonlySet<string> | null = null,
): PropertyValue[] {
  const rows = ndb
    .prepare(
      `SELECT pv.*, p.name AS property_name, p.value_type AS property_value_type, p.config AS property_config
       FROM property_values_v pv
       JOIN properties_v p ON p.id = pv.property_id
       WHERE pv.owner_type = ? AND pv.owner_id = ?`,
    )
    .all(ownerType, ownerId) as Array<PropertyValueRow & {
    property_name: string;
    property_value_type: string;
    property_config: string | null;
  }>;
  const attached = attachedPropertyIds(ndb, ownerType, ownerId);
  const out: PropertyValue[] = [];
  for (const row of rows) {
    const prop: PropertyLike = {
      id: row.property_id,
      name: row.property_name,
      value_type: row.property_value_type as PropertyValueType,
      config: row.property_config ? (JSON.parse(row.property_config) as PropertyConfig) : null,
    };
    if (prop.value_type === 'cross_network_ref') {
      // Чтение со снапшотом и фильтром прав. `null` — все адреса отфильтрованы
      // (нет прав на единственную сеть) — значение в карточке не показывается.
      const stored = row.value_text;
      const rawValue: string | string[] = stored === null
        ? ''
        : stored.startsWith('[')
          ? parseRefIds(stored)
          : isMultipleProperty(prop)
            ? [stored]
            : stored;
      const resolved = readCrossNetworkRefValueResolved(ndb, row.id, rawValue, accessibleNetworkIds);
      if (resolved === null) continue;
      out.push({
        id: row.id,
        owner_type: ownerType,
        owner_id: ownerId,
        property_id: row.property_id,
        outside_type: !attached.has(row.property_id),
        property_name: row.property_name,
        value_type: prop.value_type,
        value: resolved,
        updated_at: row.updated_at,
        created_by: row.created_by,
        updated_by: row.updated_by,
        created_at_ms: row.created_at_ms,
        updated_at_ms: row.updated_at_ms,
      });
      continue;
    }
    out.push({
      id: row.id,
      owner_type: ownerType,
      owner_id: ownerId,
      property_id: row.property_id,
      outside_type: !attached.has(row.property_id),
      property_name: row.property_name,
      value_type: prop.value_type,
      value: readValue(row, prop.value_type, isMultipleProperty(prop)),
      updated_at: row.updated_at,
      created_by: row.created_by,
      updated_by: row.updated_by,
      created_at_ms: row.created_at_ms,
      updated_at_ms: row.updated_at_ms,
    });
  }
  return out;
}

/**
 * Значения свойств для REST `GET …/properties` (0.8.1): скаляры как раньше
 * плюс свойства-связи — списком рёбер (id ребра + цель + комментарий,
 * требование d024dbd6). Карточка MCP отдаёт счётчики, этот запрос — рёбра.
 *
 * `accessibleNetworkIds` — см. {@link getPropertyValues}.
 */
export function getPropertyValuesWithLinks(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  accessibleNetworkIds: ReadonlySet<string> | null = null,
): (PropertyValue | LinkPropertyValues)[] {
  const out: (PropertyValue | LinkPropertyValues)[] = getPropertyValues(
    ndb,
    ownerType,
    ownerId,
    accessibleNetworkIds,
  );
  if (ownerType === 'thought') {
    for (const lp of listThoughtLinkProperties(ndb, ownerId)) {
      out.push({
        ...lp,
        values: getLinkPropertyValues(ndb, ownerType, ownerId, lp.link_type_id, lp.direction),
      });
    }
  }
  return out;
}

/**
 * MCP-чтение значений свойств (task N4, docs/05-mcp-server.md §4.1): то же,
 * что {@link getPropertyValues}, плюс счётчики свойств-связей и резолв
 * legacy `thought_ref` к `{id, title}` (одиночные — LEFT JOIN, множественные
 * — пакетный запрос). Агенту не нужны отдельные вызовы `etn.thoughts.get`
 * на каждую ссылку; `title: null` — висячая ссылка на удалённую мысль.
 * Legacy-ветка восстановлена для тестов value-handling и импорта архивов
 * (миграция 040): в живой БД таких свойств быть не должно.
 *
 * `accessibleNetworkIds` (задача 7849008a) — фильтр для `cross_network_ref`,
 * проброшенный в {@link getPropertyValues}.
 */
export function getPropertyValuesResolved(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  accessibleNetworkIds: ReadonlySet<string> | null = null,
): (ResolvedPropertyValue | ResolvedLinkProperty)[] {
  const rows = ndb
    .prepare(
      `SELECT pv.*, p.name AS property_name, p.value_type AS property_value_type, p.config AS property_config,
              t.title AS ref_title
       FROM property_values_v pv
       JOIN properties_v p ON p.id = pv.property_id
       LEFT JOIN thoughts_v t ON t.id = pv.value_thought_ref
       WHERE pv.owner_type = ? AND pv.owner_id = ?`,
    )
    .all(ownerType, ownerId) as Array<
    PropertyValueRow & {
      property_name: string;
      property_value_type: string;
      property_config: string | null;
      ref_title: string | null;
    }
  >;
  const attached = attachedPropertyIds(ndb, ownerType, ownerId);
  const prepared: Array<{
    row: (typeof rows)[number];
    prop: PropertyLike;
    value: PropertyValueValue;
  }> = [];
  for (const row of rows) {
    const prop: PropertyLike = {
      id: row.property_id,
      name: row.property_name,
      value_type: row.property_value_type as PropertyValueType,
      config: row.property_config ? (JSON.parse(row.property_config) as PropertyConfig) : null,
    };
    prepared.push({ row, prop, value: readValue(row, prop.value_type, isMultipleProperty(prop)) });
  }
  // Titles of every id stored inside multiple-ref arrays: one batched lookup.
  const arrayIds = new Set<string>();
  for (const { prop, value } of prepared) {
    if (prop.value_type === 'thought_ref' && Array.isArray(value)) {
      for (const id of value) arrayIds.add(id as string);
    }
  }
  const titlesById = new Map<string, string>();
  if (arrayIds.size > 0) {
    const ids = [...arrayIds];
    const titleRows = ndb
      .prepare(`SELECT id, title FROM thoughts_v WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ id: string; title: string }>;
    for (const t of titleRows) titlesById.set(t.id, t.title);
  }
  const out: (ResolvedPropertyValue | ResolvedLinkProperty)[] = [];
  for (const { row, prop, value } of prepared) {
    let resolved: ResolvedPropertyValue['value'] = value;
    if (prop.value_type === 'thought_ref') {
      if (Array.isArray(value)) {
        // Legacy thought_ref: одиночный id или JSON-массив id
        // (02-data-model.md §3.5). Каждый id резолвится через пакетный
        // lookup, отсутствующая цель — `title: null`.
        const ids = value as string[];
        resolved = ids.map(
          (id): { id: string; title: string | null } => ({
            id,
            title: titlesById.get(id) ?? null,
          }),
        );
      } else if (typeof value === 'string') {
        resolved = { id: value, title: row.ref_title };
      }
    } else if (prop.value_type === 'cross_network_ref') {
      // Задача 7849008a, требование 6d4ad9ac: значение читается со снапшотом
      // имени цели. Сервер НЕ открывает чужую data.db; фильтр прав
      // (`accessibleNetworkIds`) применяется здесь — нет прав на сеть →
      // значение молча отфильтровывается. Сеть удалена → снапшот виден с
      // пометкой `unresolved: true`.
      const rawValue: string | string[] =
        value === null
          ? ''
          : Array.isArray(value)
            ? (value as string[])
            : (value as string);
      const enriched = readCrossNetworkRefValueResolved(
        ndb,
        row.id,
        rawValue,
        accessibleNetworkIds,
      );
      // null — все адреса отфильтрованы: значение в карточке не показывается.
      if (enriched === null) continue;
      resolved = enriched;
    }
    out.push({
      id: row.id,
      owner_type: ownerType,
      owner_id: ownerId,
      property_id: row.property_id,
      outside_type: !attached.has(row.property_id),
      property_name: row.property_name,
      value_type: prop.value_type,
      value: resolved,
      updated_at: row.updated_at,
      created_by: row.created_by,
      updated_by: row.updated_by,
      created_at_ms: row.created_at_ms,
      updated_at_ms: row.updated_at_ms,
    });
  }
  // Свойства-связи: карточка отдаёт их счётчиками (требование d024dbd6).
  if (ownerType === 'thought') {
    for (const lp of listThoughtLinkProperties(ndb, ownerId)) {
      out.push(lp);
    }
  }
  return out;
}

/**
 * Reverse lookup использования мысли (docs/03-server-api.md §9.1): мысли,
 * ссылающиеся на `thoughtId` через ВСЕ формальные свойства-связи реестра
 * (c0a2a2e6; флаг `blocks_target_deletion` на «Использование» не влияет —
 * он остаётся про защиту от удаления), сгруппированные по свойству реестра.
 * Плечо `thought_ref`-значений исчезло вместе с видом значения (миграция 040):
 * все ссылки — рёбра. Groups are ordered by property name, items by the
 * owner's normalized title.
 */
export function findThoughtUsage(ndb: NetworkDb, thoughtId: string): ThoughtUsage {
  const groups: ThoughtUsageGroup[] = [];
  const byProperty = new Map<string, ThoughtUsageGroup>();

  // Legacy (миграция 040): в живой БД thought_ref-свойств быть не должно,
  // но если каким-то образом значение осталось (тестовая фикстура,
  // унаследованный архив до конверсии) — использование должно учитываться,
  // иначе удаление цели не блокируется. Резолв идёт по value_thought_ref
  // (одиночный id или JSON-массив).
  const legacyRows = ndb
    .prepare(
      `SELECT pv.property_id AS property_id, p.name AS property_key,
              t.id, t.title, t.type_id, t.icon, t.icon_kind, t.icon_attachment_id,
              t.icon_color, t.active,
              t.fg_color, t.bg_color, t.font_bold, t.font_italic,
              t.font_underline, t.font_strike, t.font_manual
       FROM property_values_v pv
       JOIN properties_v p ON p.id = pv.property_id
       JOIN thoughts_v t ON t.id = pv.owner_id
       WHERE pv.owner_type = 'thought'
         AND (pv.value_thought_ref = ? OR pv.value_thought_ref LIKE ? ESCAPE '\\')
       ORDER BY p.name COLLATE NOCASE, t.title_norm COLLATE NOCASE`,
    )
    .all(thoughtId, refLikePattern(thoughtId)) as Array<{
    property_id: string;
    property_key: string;
    id: string;
    title: string;
    type_id: string | null;
    icon: string | null;
    icon_kind: string;
    icon_attachment_id: string | null;
    icon_color: string | null;
    active: number;
    fg_color: string | null;
    bg_color: string | null;
    font_bold: number;
    font_italic: number;
    font_underline: number;
    font_strike: number;
    font_manual: number;
  }>;

  for (const row of legacyRows) {
    let group = byProperty.get(row.property_id);
    if (group === undefined) {
      group = { property_id: row.property_id, key: row.property_key, thoughts: [] };
      byProperty.set(row.property_id, group);
      groups.push(group);
    }
    group.thoughts.push(rowToThoughtRef(row));
  }

  // Использование через свойства-связи — ВСЕ формальные link-рёбра реестра,
  // у которых мысль является целью ссылки (c0a2a2e6: «кто ссылается на мысль»).
  // Блокировка удаления (`blocks_target_deletion`) здесь ни при чём — она
  // остаётся в countThoughtRefUsages/clearThoughtRefUsages.
  for (const bp of listLinkPropertyEdges(ndb, { onlyBlocking: false })) {
    const refCol = bp.direction === 'out' ? 'source_id' : 'target_id';
    const ownerCol = bp.direction === 'out' ? 'target_id' : 'source_id';
    const typeClause = bp.link_type_id === null ? 'l.type_id IS NULL' : 'l.type_id = ?';
    const params = bp.link_type_id === null ? [thoughtId] : [thoughtId, bp.link_type_id];
    const linkRows = ndb
      .prepare(
        `SELECT t.id, t.title, t.type_id, t.icon, t.icon_kind, t.icon_attachment_id,
                t.icon_color, t.active, t.fg_color, t.bg_color, t.font_bold, t.font_italic,
                t.font_underline, t.font_strike, t.font_manual
           FROM links_v l
           JOIN thoughts_v t ON t.id = l.${refCol}
          WHERE l.${ownerCol} = ? AND ${typeClause} AND l.active = 1 AND l.marked_for_deletion = 0
          ORDER BY t.title_norm COLLATE NOCASE`,
      )
      .all(...params) as Array<Parameters<typeof rowToThoughtRef>[0]>;
    if (linkRows.length === 0) continue;
    let group = byProperty.get(bp.property_id);
    if (group === undefined) {
      group = { property_id: bp.property_id, key: bp.name, thoughts: [] };
      byProperty.set(bp.property_id, group);
      groups.push(group);
    }
    for (const row of linkRows) group.thoughts.push(rowToThoughtRef(row));
  }

  const total = groups.reduce((acc, g) => acc + g.thoughts.length, 0);
  return { total, groups, holding_layers: [] };
}

/**
 * Записи учёта ссылок через свойства-связи: свойство + направление ребра у
 * владельца. Общий тип для двух потребителей — «Использования» мысли
 * (все свойства-связи, c0a2a2e6) и блокировки удаления (только
 * `blocks_target_deletion`, dbf1e4aa).
 */
interface LinkPropertyEdge {
  property_id: string;
  name: string;
  /** Направление ребра у ВЛАДЕЛЬЦА: `out` — владелец источник (ссылается на
   *  цель), `in` — владелец цель (на него ссылается источник). */
  direction: LinkPropertyDirection;
  link_type_id: string | null;
}

/**
 * Свойства-связи реестра с направлением, РАЗРЕШЁННЫМ ПО ПРИВЯЗКАМ
 * (ошибка 083dcde5; класс ошибки c67676f3).
 *
 * Направление свойства-связи живёт в привязке (`type_properties.side`,
 * миграция 042), а не в `config`: одна реестровая строка может быть привязана
 * и источником, и назначением на разные типы владельцев. Поэтому возвращаем по
 * записи на каждую ПАРУ `(property_id, direction)`, а не одну запись на
 * свойство: привязка-источник — `out`, привязка-назначение — `in`. У свойства
 * без привязок сохраняем прежний fallback на `config.direction` (внетиповое
 * заполнение, привязки до миграции 041).
 *
 * Симметрично чтению ({@link listThoughtLinkProperties}, `emitExplicit`):
 * направление каждой записи вычисляет {@link linkPropertyDirection} по стороне
 * привязки.
 *
 * `onlyBlocking` — `true` для проверки удаления (`blocks_target_deletion`),
 * `false` для «Использования» мысли (все формальные link-рёбра, c0a2a2e6).
 * Структурные «Родители»/«Потомки» исключаются всегда: они не формальные
 * ссылки-свойства.
 */
function listLinkPropertyEdges(
  ndb: NetworkDb,
  opts: { onlyBlocking: boolean },
): LinkPropertyEdge[] {
  // Стороны, которыми свойство привязано у типов владельцев. Без привязок
  // свойство остаётся с fallback-направлением из config.
  const bindingSides = new Map<string, Set<LinkPropertySide | null>>();
  const rows = ndb
    .prepare(
      `SELECT DISTINCT tp.property_id AS property_id, tp.side AS side
         FROM type_properties_v tp
         JOIN properties_v p ON p.id = tp.property_id
        WHERE p.value_type = 'link'${
          opts.onlyBlocking ? " AND json_extract(p.config, '$.blocks_target_deletion') = 1" : ''
        }`,
    )
    .all() as Array<{ property_id: string; side: string | null }>;
  for (const row of rows) {
    let sides = bindingSides.get(row.property_id);
    if (sides === undefined) {
      sides = new Set();
      bindingSides.set(row.property_id, sides);
    }
    sides.add(row.side === 'source' || row.side === 'target' ? row.side : null);
  }

  const out: LinkPropertyEdge[] = [];
  for (const prop of listNetworkProperties(ndb)) {
    if (prop.value_type !== 'link') continue;
    const cfg = prop.config ?? {};
    if (isStructuralLinkProperty(cfg)) continue;
    if (opts.onlyBlocking && cfg.blocks_target_deletion !== true) continue;
    const sides = bindingSides.get(prop.id);
    const directions: LinkPropertyDirection[] =
      sides === undefined || sides.size === 0
        ? [linkPropertyDirection(cfg, null)]
        : [...new Set([...sides].map((side) => linkPropertyDirection(cfg, side)))];
    for (const direction of directions) {
      out.push({
        property_id: prop.id,
        name: prop.name,
        direction,
        link_type_id: linkPropertyLinkTypeId(cfg),
      });
    }
  }
  return out;
}

/** Свойства-связи, блокирующие удаление цели (`blocks_target_deletion`). */
function listBlockingLinkProperties(ndb: NetworkDb): LinkPropertyEdge[] {
  return listLinkPropertyEdges(ndb, { onlyBlocking: true });
}

/**
 * Number of distinct thoughts referencing `thoughtId` through link-property
 * edges with `blocks_target_deletion = true` (0.8.1, dbf1e4aa; до — через
 * `thought_ref`-значения, упразднены миграцией 040). Backs the "использование
 * в свойствах" blocking arm of the S13 deletion check. The check must see
 * live edges of every layer; tombstones do not block.
 */
export function countThoughtRefUsages(ndb: NetworkDb, thoughtId: string): number {
  let total = 0;
  // Legacy (миграция 040): в живой БД thought_ref-свойств быть не должно,
  // но если каким-то образом значение осталось (тестовая фикстура,
  // унаследованный архив до конверсии) — использование должно учитываться,
  // иначе удаление цели не блокируется. Резолв идёт по value_thought_ref
  // (одиночный id или JSON-массив).
  const legacy = ndb
    .prepare(
      `SELECT COUNT(*) AS c
       FROM property_values_v pv
       WHERE pv.owner_type = 'thought'
         AND pv.value_thought_ref IS NOT NULL
         AND (pv.value_thought_ref = ? OR pv.value_thought_ref LIKE ? ESCAPE '\\')`,
    )
    .get(thoughtId, refLikePattern(thoughtId)) as { c: number };
  total += legacy.c;
  // Свойства-связи с blocks_target_deletion: блокирует цель (противоположный
  // конец от владельца). Считаем рёбра, где мысль — цель ссылки.
  for (const bp of listBlockingLinkProperties(ndb)) {
    const ownerCol = bp.direction === 'out' ? 'target_id' : 'source_id';
    const typeClause = bp.link_type_id === null ? 'type_id IS NULL' : 'type_id = ?';
    const params = bp.link_type_id === null ? [thoughtId] : [thoughtId, bp.link_type_id];
    const lrow = ndb
      .prepare(
        `SELECT COUNT(*) AS c FROM links_v l -- layers:physical-read
          WHERE l.${ownerCol} = ? AND ${typeClause} AND l.active = 1 AND l.marked_for_deletion = 0`,
      )
      .get(...params) as { c: number };
    total += lrow.c;
  }
  return total;
}

/**
 * Mark every blocking link-property edge to `thoughtId` for deletion
 * (0.8.1, dbf1e4aa) — «Очистить использование» (03-server-api.md §9.2).
 * Returns how many references were cleared. Плечо `thought_ref`-значений
 * исчезло вместе с видом значения (миграция 040) — все ссылки рёбра.
 */
export function clearThoughtRefUsages(ndb: NetworkDb, thoughtId: string): number {
  let cleared = 0;
  // Legacy (миграция 040): удаляем оставшиеся строки property_values с
  // thought_ref-ссылкой на цель (тестовые фикстуры, унаследованные архивы).
  // `property_values_v` — view только для чтения; UPDATE пишем в базовую
  // таблицу `property_values` (слой — текущий).
  const legacyRes = ndb
    .prepare(
      `UPDATE property_values
          SET value_text = NULL,
              value_date = NULL,
              value_number = NULL,
              value_bool = NULL,
              value_thought_ref = NULL,
              updated_at = ?
        WHERE owner_type = 'thought'
          AND value_thought_ref IS NOT NULL
          AND (value_thought_ref = ? OR value_thought_ref LIKE ? ESCAPE '\\')
          AND layer_id = ?`,
    )
    .run(new Date().toISOString(), thoughtId, refLikePattern(thoughtId), ndb.layerId);
  cleared += legacyRes.changes;
  // Рёбра блокирующих свойств-связей — помечаем в корзину (комментарий не теряется).
  for (const bp of listBlockingLinkProperties(ndb)) {
    const ownerCol = bp.direction === 'out' ? 'target_id' : 'source_id';
    const typeClause = bp.link_type_id === null ? 'type_id IS NULL' : 'type_id = ?';
    const params = bp.link_type_id === null ? [thoughtId] : [thoughtId, bp.link_type_id];
    const links = ndb
      .prepare(
        `SELECT id FROM links_v l WHERE l.${ownerCol} = ? AND ${typeClause} AND l.active = 1 AND l.marked_for_deletion = 0`,
      )
      .all(...params) as Array<{ id: string }>;
    for (const link of links) {
      markLinkForDeletion(ndb, link.id, 'system');
      cleared += 1;
    }
  }
  return cleared;
}

/**
 * Validate `value` against the property's `value_type` and return the column
 * name + raw SQL value to write.
 *
 * The returned `column` is always one of the fixed `value_*` literals derived
 * from `value_type` (never user input). For `thought_ref`, when the config
 * names allowed types, the referenced thought must be of one of them
 * (subtree-expanded, L21).
 */
function validateAndCoerce(
  ndb: NetworkDb,
  prop: PropertyLike,
  value: PropertyValueValue,
): { column: string; raw: string | number | null } {
  const column = storageColumn(prop.value_type);
  if (value === null) {
    return { column, raw: null };
  }
  switch (prop.value_type) {
    case 'text':
      if (typeof value !== 'string') {
        throw new EtnError('VALIDATION_ERROR', `property "${prop.name}" expects text`, {
          key: prop.name,
          expected: 'text',
        });
      }
      return { column, raw: value };
    case 'url': {
      if (Array.isArray(value)) {
        if (!isMultipleProperty(prop)) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `property "${prop.name}" does not allow multiple values`,
            { key: prop.name, expected: 'url', multiple: false },
          );
        }
        const urls = [...new Set(value as string[])];
        if (urls.length === 0) return { column, raw: null };
        if (urls.some((url) => typeof url !== 'string')) {
          throw new EtnError('VALIDATION_ERROR', `property "${prop.name}" expects URL strings`, {
            key: prop.name,
            expected: 'url',
          });
        }
        return { column, raw: JSON.stringify(urls) };
      }
      if (typeof value !== 'string') {
        throw new EtnError('VALIDATION_ERROR', `property "${prop.name}" expects a URL string`, {
          key: prop.name,
          expected: 'url',
        });
      }
      return { column, raw: isMultipleProperty(prop) ? JSON.stringify([value]) : value };
    }
    case 'date':
      if (typeof value !== 'string') {
        throw new EtnError(
          'VALIDATION_ERROR',
          `property "${prop.name}" expects an ISO-8601 date string`,
          { key: prop.name, expected: 'date' },
        );
      }
      return { column, raw: value };
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new EtnError('VALIDATION_ERROR', `property "${prop.name}" expects a number`, {
          key: prop.name,
          expected: 'number',
        });
      }
      return { column, raw: value };
    case 'bool':
      if (typeof value !== 'boolean') {
        throw new EtnError('VALIDATION_ERROR', `property "${prop.name}" expects a boolean`, {
          key: prop.name,
          expected: 'bool',
        });
      }
      return { column, raw: value ? 1 : 0 };
    case 'link':
      // Значение свойства-связи записывается созданием/правкой ребра, а не
      // значением в property_values (ADR «свойство-связь — проекция ребра»).
      // Запись через свойства — отдельная задача (3), здесь — явный отказ.
      throw new EtnError(
        'VALIDATION_ERROR',
        `свойство «${prop.name}» — связь: заполняется ребром, а не значением`,
        { key: prop.name, expected: 'link' },
      );
    case 'thought_ref': {
      // Legacy (миграция 040): создание свойств этого типа отвергается
      // validateValueType на create/update (API). Но если свойство каким-то
      // образом уже есть в БД (тестовая фикстура через seedThoughtRefProperty,
      // импорт унаследованного архива до конверсии) — запись значения
      // принимается с полной валидацией: dedupe, проверка каждого id
      // (существование + type filter), отбраковка массивов для non-multiple.
      if (Array.isArray(value)) {
        if (!isMultipleProperty(prop)) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `property "${prop.name}" does not allow multiple values`,
            { key: prop.name, expected: 'thought_ref', multiple: false },
          );
        }
        const ids = [...new Set(value as string[])];
        if (ids.length === 0) {
          // An empty selection clears the value (same as null).
          return { column, raw: null };
        }
        if (ids.some((id) => typeof id !== 'string')) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `property "${prop.name}" expects thought ids`,
            { key: prop.name, expected: 'thought_ref' },
          );
        }
        for (const id of ids) {
          validateThoughtRefTarget(ndb, prop, id);
        }
        return { column, raw: JSON.stringify(ids) };
      }
      if (typeof value !== 'string') {
        throw new EtnError(
          'VALIDATION_ERROR',
          `property "${prop.name}" expects a thought id`,
          { key: prop.name, expected: 'thought_ref' },
        );
      }
      validateThoughtRefTarget(ndb, prop, value);
      return { column, raw: isMultipleProperty(prop) ? JSON.stringify([value]) : value };
    }
    case 'cross_network_ref': {
      // Адрес n:<network_id>#<thought_id>; single — строка, multiple —
      // JSON-массив (как у `url`). Валидация формата адреса — на уровне
      // общего шага, живой резолв (запрет своей сети + проверка сети и цели) —
      // снаружи, в {@link setPropertyValueForProperty}, см. шаг «живой
      // резолв при записи» (требование aa89940c).
      if (Array.isArray(value)) {
        if (!isMultipleProperty(prop)) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `property "${prop.name}" does not allow multiple values`,
            { key: prop.name, expected: 'cross_network_ref', multiple: false },
          );
        }
        const addresses = [...new Set(value as string[])];
        if (addresses.length === 0) {
          // An empty selection clears the value (same as null).
          return { column, raw: null };
        }
        if (addresses.some((addr) => typeof addr !== 'string')) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `property "${prop.name}" expects cross-network addresses`,
            { key: prop.name, expected: 'cross_network_ref' },
          );
        }
        return { column, raw: JSON.stringify(addresses) };
      }
      if (typeof value !== 'string') {
        throw new EtnError(
          'VALIDATION_ERROR',
          `property "${prop.name}" expects a cross-network address`,
          { key: prop.name, expected: 'cross_network_ref' },
        );
      }
      return { column, raw: isMultipleProperty(prop) ? JSON.stringify([value]) : value };
    }
    case 'publication': {
      // Ссылка на публикацию ТЕКУЩЕЙ сети (0.11.1, задача f37b468d,
      // требование 9ce84a2b): значение — id публикации (single) или
      // JSON-массив id (multiple). Каждый id проверяется на существование в
      // текущем слое (`publications_v`); удаление цели блокирует живые
      // значения (см. `countPublicationRefUsages` в publication-service).
      if (Array.isArray(value)) {
        if (!isMultipleProperty(prop)) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `property "${prop.name}" does not allow multiple values`,
            { key: prop.name, expected: 'publication', multiple: false },
          );
        }
        const ids = [...new Set(value as string[])];
        if (ids.length === 0) {
          // An empty selection clears the value (same as null).
          return { column, raw: null };
        }
        if (ids.some((id) => typeof id !== 'string')) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `property "${prop.name}" expects publication ids`,
            { key: prop.name, expected: 'publication' },
          );
        }
        for (const id of ids) {
          validatePublicationRefTarget(ndb, prop, id);
        }
        return { column, raw: JSON.stringify(ids) };
      }
      if (typeof value !== 'string') {
        throw new EtnError(
          'VALIDATION_ERROR',
          `property "${prop.name}" expects a publication id`,
          { key: prop.name, expected: 'publication' },
        );
      }
      validatePublicationRefTarget(ndb, prop, value);
      return { column, raw: isMultipleProperty(prop) ? JSON.stringify([value]) : value };
    }
  }
}

/**
/**
 * Validate one `thought_ref` id against the property: the thought must exist,
 * and when the config names allowed types the target's type must be among
 * them (subtree-expanded, L21). Legacy-логика для value-handling thought_ref
 * (миграция 040): в живой БД таких свойств быть не должно, но если есть
 * (тестовая фикстура, унаследованный архив) — запись значения идёт по
 * старым правилам.
 */
function validateThoughtRefTarget(ndb: NetworkDb, prop: PropertyLike, id: string): void {
  const target = ndb.prepare('SELECT type_id FROM thoughts_v WHERE id = ?').get(id) as
    { type_id: string | null } | undefined;
  if (!target) {
    throw new EtnError('VALIDATION_ERROR', `referenced thought ${id} does not exist`, {
      key: prop.name,
      ref: id,
    });
  }
  const allowedIds = expandTypeIdsToSubtree(
    ndb,
    'thought_types',
    (
      (prop.config?.allowed_type_ids as unknown[] | undefined) ??
      (prop.config?.allowed_type_id !== undefined && prop.config?.allowed_type_id !== ''
        ? [prop.config.allowed_type_id as string]
        : [])
    ).filter((id): id is string => typeof id === 'string' && id !== ''),
  );
  if (allowedIds.length > 0 && (target.type_id === null || !allowedIds.includes(target.type_id))) {
    throw new EtnError('VALIDATION_ERROR', `thought ${id} is not of a required type`, {
      key: prop.name,
      ref: id,
      allowed_type_ids: allowedIds,
      actual_type_id: target.type_id,
    });
  }
}

/**
 * Validate one `publication` id against the property (0.11.1, задача f37b468d,
 * требование 9ce84a2b): the publication must exist in the connection's layer
 * context (`publications_v`), so a tombstoned/absent publication is rejected
 * the same way a missing thought is for a link property. Allowed-type filters
 * are not applicable — a publication has no thought type.
 */
function validatePublicationRefTarget(ndb: NetworkDb, prop: PropertyLike, id: string): void {
  const target = ndb.prepare('SELECT 1 FROM publications_v WHERE id = ?').get(id);
  if (!target) {
    throw new EtnError('VALIDATION_ERROR', `referenced publication ${id} does not exist`, {
      key: prop.name,
      ref: id,
    });
  }
}

/**
 * Upsert a property value addressed by property name (docs/03-server-api.md §9).
 *
 * The name resolves against the registry; the value is validated against the
 * property's nature and written only to the matching `value_*` column; the
 * other value columns are set to NULL. Passing `null` clears the value.
 *
 * A value may only be written for a property **attached to the owner's type
 * chain** (own binding or an ancestor's) — a registry property the type does
 * not attach is rejected with `VALIDATION_ERROR` (422), which also covers
 * re-writing an existing outside-type value: attach the property first
 * (02-data-model.md §3.5a).
 *
 * `crossNetworkAccess` — обязателен для записи значений вида
 * `cross_network_ref`: запись идёт с одним живым резолвом в чужую сеть
 * (требование aa89940c). Передаётся REST/MCP-роутами, в юнит-тестах
 * `property-service.test.ts` — фиктивный контекст (см.
 * `cross-network-ref-service.ts`).
 *
 * Throws:
 *   * `NOT_FOUND` (404) if the owner or the property (by name) is missing;
 *   * `VALIDATION_ERROR` (422) if the property is not attached to the owner's
 *     type, or the value does not match `value_type`.
 */
export function setPropertyValue(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  key: string,
  value: PropertyValueValue,
  actorUserId: string,
  crossNetworkAccess?: CrossNetworkAccessContext,
): PropertyValue {
  if (ownerType !== 'thought' && ownerType !== 'link') {
    throw new EtnError('VALIDATION_ERROR', `invalid owner_type: ${ownerType}`, {
      field: 'owner_type',
    });
  }
  return ndb.transaction(() => {
    // Ensure the owner exists (attachedPropertyIds re-reads it too, but the
    // 404 there must not precede property resolution errors in tests).
    const owner = ndb.prepare(`SELECT 1 FROM ${ownerTable(ownerType)} WHERE id = ?`).get(ownerId);
    if (!owner) {
      throw new EtnError('NOT_FOUND', `${ownerType} ${ownerId} not found`, {
        entity: ownerType,
        id: ownerId,
      });
    }
    const prop = resolveDefinition(ndb, ownerType, ownerId, key);
    if (!prop) {
      throw new EtnError('NOT_FOUND', `property "${key}" does not exist in this network`, {
        owner_type: ownerType,
        owner_id: ownerId,
        key,
      });
    }
    return setPropertyValueForProperty(
      ndb,
      ownerType,
      ownerId,
      prop,
      value,
      { key },
      actorUserId,
      prop.direction,
      crossNetworkAccess,
    );
  });
}

/**
 * Resolve the winning physical row of a `property_values` natural-key slot
 * `(owner_type, owner_id, property_id)` across the connection's layer chain
 * (13-layers.md §4.1), nearest layer first.
 *
 * Unlike `thoughts`/`links`, this table's logical identity is the natural
 * key, not the surrogate `id` — the generic `*_v` views (layer-chain.ts
 * `ensureLayerViews`) dedup PER `id`. Two independent first-writes for the
 * same natural key made from layer contexts that cannot see each other (e.g.
 * a child layer, then the base — the base never sees a descendant's rows)
 * legitimately mint two different ids for it. Once a later context's chain
 * includes BOTH origins (e.g. back in the child layer, whose chain is
 * `[child, base]`), `property_values_v` reports both ids as separate
 * "winners" for the same natural key, and a bare `LIMIT 1` over it picks one
 * arbitrarily — silently updating the wrong row, or crashing with a UNIQUE
 * violation when the write path shadow-copies the wrong id into a layer that
 * already holds the other one under a different id (bug 49d1f5e8). This
 * picks the row from the nearest layer in the chain — the only value that
 * should ever be "the" visible one from this context — generalising the same
 * precedence rule the `*_v` views apply per id to the natural key instead.
 */
function resolveVisiblePropertyValueId(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  propertyId: string,
): string | undefined {
  // layers:physical-read — deliberately bypasses `property_values_v`: that
  // view dedups per `id`, which is exactly the ambiguity this function
  // resolves instead (per natural key, nearest layer in the chain wins). The
  // `layer_chain` join still scopes the read to the connection's own chain —
  // this is not an all-layers audit, just a physical table access the S3
  // lint cannot otherwise tell apart from one (mirrors the identical
  // technique in realtime/layer-visibility.ts, outside the linted dirs).
  const row = ndb
    .prepare(
      `SELECT pv.id AS id
       FROM property_values pv -- layers:physical-read
       JOIN layer_chain lc ON lc.layer_id = pv.layer_id
       WHERE pv.owner_type = ? AND pv.owner_id = ? AND pv.property_id = ? AND pv.deleted = 0
       ORDER BY lc.depth ASC
       LIMIT 1`,
    )
    .get(ownerType, ownerId, propertyId) as { id: string } | undefined;
  return row?.id;
}

/**
 * The shared write path of {@link setPropertyValue} and
 * {@link setPropertyValueById}: connectivity check (422 when the owner's type
 * chain does not attach the property), validation, layered upsert.
 */
function setPropertyValueForProperty(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  prop: PropertyLike,
  value: PropertyValueValue,
  errKey: { key: string },
  actorUserId: string,
  nameDirection: LinkPropertyDirection | null = null,
  crossNetworkAccess?: CrossNetworkAccessContext,
): PropertyValue {
  // Свойство-связь: запись — создание/правка рёбер, а не значение в
  // property_values (ADR «свойство-связь — проекция ребра»). Запись вне типа
  // разрешена (обратная сторона/внетиповое свойство) — требование 2fe173c5.
  if (prop.value_type === 'link') {
    if (ownerType !== 'thought') {
      throw new EtnError('VALIDATION_ERROR', 'свойства-связи заполняются только у мыслей', {
        owner_type: ownerType,
        key: errKey.key,
      });
    }
    const { targets: targetIds, createdLinkIds } = setLinkPropertyTargets(
      ndb,
      ownerId,
      prop,
      normalizeLinkTargets(value, errKey.key),
      actorUserId,
      nameDirection,
    );
    touchOwner(ndb, ownerType, ownerId, actorUserId);
    const nowMs = Date.now();
    return {
      // Свойство-связь — проекция рёбер (ADR «свойство-связь — проекция ребра»):
      // строки `property_values` у неё нет, поэтому id честно `null`, а не
      // пустая строка-заглушка (ошибка 5a50f906 — `id: ""` в ответе читалось
      // как «id есть, но пустой»). Адрес ребра — `link_id` из
      // `LinkPropertyValueItem` (чтение значений) / `etn.properties.add`.
      // `link_ids` — рёбра, СОЗДАННЫЕ этой записью: фасады публикуют по ним
      // `link.created` (ошибка 1b719d76).
      id: null,
      owner_type: ownerType,
      owner_id: ownerId,
      property_id: prop.id,
      outside_type: false,
      property_name: prop.name,
      value_type: 'link',
      value: targetIds.length === 0 ? null : targetIds.length === 1 ? (targetIds[0] ?? null) : targetIds,
      link_ids: createdLinkIds,
      updated_at: new Date(nowMs).toISOString(),
      created_by: actorUserId,
      updated_by: actorUserId,
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
    };
  }

  const attached = attachedPropertyIds(ndb, ownerType, ownerId);
  if (!attached.has(prop.id)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `property "${errKey.key}" is not attached to this owner's type — attach it first`,
      { owner_type: ownerType, owner_id: ownerId, key: errKey.key, property_id: prop.id },
    );
  }

  const { column, raw } = validateAndCoerce(ndb, prop, value);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  // Детерминированный id от natural key (ошибка dc119240): независимые
  // «первые записи» одного свойства в не видящих друг друга слоях сходятся в
  // ОДИН id, поэтому представления `*_v`, дедуплицирующие по id, видят одну
  // строку на natural key, а не «призрака» с чужим значением.
  const id = propertyValueId(ownerType, ownerId, prop.id);
  // S5 (13-layers.md §5.1): the visible row for this natural key is shadowed
  // FIRST — writing into this layer while an ancestor row stays live would
  // break the «one value per (owner, property)» invariant of §3.5. Resolved
  // by natural key across the layer chain (bug 49d1f5e8) — see
  // {@link resolveVisiblePropertyValueId}. With deterministic ids the resolved
  // id equals the freshly computed one whenever any row for the natural key
  // exists anywhere in the chain (post-migration 036 data); the inequality
  // guard below only covers un-migrated legacy rows with random ids.
  const existingId = resolveVisiblePropertyValueId(ndb, ownerType, ownerId, prop.id);
  if (existingId !== undefined && existingId !== id) {
    materializeShadow(ndb, 'property_values', existingId);
  }
  // Upsert: write the raw value into the matching column on INSERT, and on
  // conflict reset every value_* column before copying the matching one back.
  // S4: the row lands in the connection's layer; `deleted = 0` wakes a
  // same-key tombstone of this layer instead of dropping the write silently.
  ndb
    .prepare(
      `INSERT INTO property_values (id, layer_id, owner_type, owner_id, property_id, ${column}, updated_at,
                                   created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_type, owner_id, property_id, layer_id) DO UPDATE SET
         deleted = 0,
         value_text = NULL,
         value_date = NULL,
         value_number = NULL,
         value_bool = NULL,
         value_thought_ref = NULL,
         ${column} = excluded.${column},
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by,
         updated_at_ms = excluded.updated_at_ms`,
    )
    .run(id, ndb.layerId, ownerType, ownerId, prop.id, raw, now, actorUserId, actorUserId, nowMs, nowMs);

  // Кросс-сетевая ссылка (задача 7849008a): запись значения идёт с одним
  // живым резолвом в чужую сеть (требование aa89940c). Снапшот имени
  // сохраняется рядом со значением в служебной неветбимой таблице
  // `property_value_cross_refs` (требование c104a0fc). Для `null` —
  // снапшоты удаляются.
  if (prop.value_type === 'cross_network_ref') {
    if (raw === null) {
      deleteSnapshotPayload(ndb, existingId ?? id);
    } else {
      if (crossNetworkAccess === undefined) {
        throw new EtnError(
          'INTERNAL',
          'cross_network_ref: запись требует CrossNetworkAccessContext',
          { key: errKey.key, owner_type: ownerType, owner_id: ownerId },
        );
      }
      const addresses = parseStoredCrossNetworkAddresses(String(raw));
      const items = resolveAndBuildSnapshotsForWrite(addresses, crossNetworkAccess);
      upsertSnapshotPayload(ndb, existingId ?? id, items);
    }
  }

  // Правка значения — это правка владельца (требование e6d4165e).
  // Без этого `updated_by` карточки мысли/связи застывал бы на создании,
  // и вкладка «Метаданные» показывала бы чужое имя.
  touchOwner(ndb, ownerType, ownerId, actorUserId);

  // Re-read by the id we just wrote/updated — the deterministic id of this
  // natural key (both branches of `existingId ?? id` carry it post-migration).
  // `property_values_v` dedups per id, and with deterministic ids there is
  // exactly one visible row per natural key (bug dc119240).
  const stored = ndb
    .prepare('SELECT * FROM property_values_v WHERE id = ?')
    .get(existingId ?? id) as PropertyValueRow;
  return {
    id: stored.id,
    owner_type: ownerType,
    owner_id: ownerId,
    property_id: prop.id,
    outside_type: false,
    property_name: prop.name,
    value_type: prop.value_type,
    value: readValue(stored, prop.value_type, isMultipleProperty(prop)),
    updated_at: stored.updated_at,
    created_by: stored.created_by,
    updated_by: stored.updated_by,
    created_at_ms: stored.created_at_ms,
    updated_at_ms: stored.updated_at_ms,
  };
}

/**
 * Same as {@link setPropertyValue} but addresses the property by registry id —
 * used by thought creation defaults, where the effective list entry is already
 * resolved (no second name lookup, no ambiguity).
 */
export function setPropertyValueById(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  propertyId: string,
  value: PropertyValueValue,
  actorUserId: string,
  crossNetworkAccess?: CrossNetworkAccessContext,
): PropertyValue {
  if (ownerType !== 'thought' && ownerType !== 'link') {
    throw new EtnError('VALIDATION_ERROR', `invalid owner_type: ${ownerType}`, {
      field: 'owner_type',
    });
  }
  return ndb.transaction(() => {
    const owner = ndb.prepare(`SELECT 1 FROM ${ownerTable(ownerType)} WHERE id = ?`).get(ownerId);
    if (!owner) {
      throw new EtnError('NOT_FOUND', `${ownerType} ${ownerId} not found`, {
        entity: ownerType,
        id: ownerId,
      });
    }
    const registryProp = getNetworkProperty(ndb, propertyId);
    if (!registryProp) {
      throw new EtnError('NOT_FOUND', `property ${propertyId} not found`, {
        entity: 'property',
        id: propertyId,
      });
    }
    const prop: PropertyLike = {
      id: registryProp.id,
      name: registryProp.name,
      value_type: registryProp.value_type,
      config: registryProp.config,
    };
    return setPropertyValueForProperty(
      ndb,
      ownerType,
      ownerId,
      prop,
      value,
      { key: registryProp.name },
      actorUserId,
      null,
      crossNetworkAccess,
    );
  });
}

/**
 * Write a map of property values in one transaction (task O2,
 * docs/05-mcp-server.md §4.2). Each entry is validated and upserted exactly as
 * {@link setPropertyValue} does; a failure on any key rolls back the whole set.
 */
export function setPropertyValues(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  values: Record<string, PropertyValueValue>,
  actorUserId: string,
  crossNetworkAccess?: CrossNetworkAccessContext,
): Record<string, PropertyValue> {
  return ndb.transaction(() => {
    const stored: Record<string, PropertyValue> = {};
    for (const [key, value] of Object.entries(values)) {
      stored[key] = setPropertyValue(
        ndb,
        ownerType,
        ownerId,
        key,
        value,
        actorUserId,
        crossNetworkAccess,
      );
    }
    return stored;
  });
}

/**
 * Достать массив адресов из `value_text` строки `cross_network_ref`-значения.
 * Хранится либо одиночный адрес (без `[`), либо JSON-массив (с `[`).
 * Парсится один раз — список адресов нужен и для резолва при записи, и для
 * конверсии при отборе/чтении.
 */
function parseStoredCrossNetworkAddresses(raw: string): string[] {
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === 'string' && v !== '');
      }
    } catch {
      // падаем в single-форму
    }
  }
  return [raw];
}

/**
 * Добавить одну цель в набор свойства-связи (операция `add`, 0.8.1): идемпотентно
 * (живое ребро уже есть — no-op), принимает необязательный комментарий «зачем
 * именно эта ссылка». Один вызов, без чтения текущего набора.
 *
 * `warnings` в результате (требование 822a9149) — предупреждения записи
 * комментария ребра: перезапись теряет живые трансклюзии (в т.ч. при `add` на
 * ЖИВОМ ребре с новым `comment`).
 */
export function addLinkPropertyValue(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  key: string,
  targetId: string,
  comment: string | null,
  actorUserId: string,
): { link_id: string; created: boolean; warnings: MutationWarning[] } {
  if (ownerType !== 'thought') {
    throw new EtnError('VALIDATION_ERROR', 'свойства-связи заполняются только у мыслей', {
      owner_type: ownerType,
      key,
    });
  }
  return ndb.transaction(() => {
    const prop = resolveDefinition(ndb, ownerType, ownerId, key);
    if (!prop || prop.value_type !== 'link') {
      throw new EtnError('NOT_FOUND', `property "${key}" does not exist or is not a link property`, {
        key,
      });
    }
    const existing = listLiveLinkTargets(
      ndb,
      ownerId,
      linkPropertyLinkTypeId(prop.config),
      // Направление — из display-имени (748b80fd), иначе сторона привязки
      // владельца (0.8.2, ошибка c67676f3).
      prop.direction ??
        linkPropertyDirection(prop.config, resolveOwnerBindingSide(ndb, ownerId, prop.id)),
    ).get(targetId);
    const warnings: MutationWarning[] = [];
    const id = addLinkPropertyTarget(
      ndb,
      ownerId,
      prop,
      targetId,
      comment,
      actorUserId,
      warnings,
      prop.direction,
    );
    touchOwner(ndb, ownerType, ownerId, actorUserId);
    return { link_id: id, created: existing === undefined, warnings };
  });
}

/**
 * Убрать одну цель из набора свойства-связи (операция `remove`, 0.8.1): помечает
 * ребро в корзину (комментарий не теряется). Отсутствующее ребро — no-op
 * (`link_id: null`).
 */
export function removeLinkPropertyValue(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  key: string,
  targetId: string,
  actorUserId: string,
): { link_id: string | null } {
  if (ownerType !== 'thought') {
    throw new EtnError('VALIDATION_ERROR', 'свойства-связи заполняются только у мыслей', {
      owner_type: ownerType,
      key,
    });
  }
  return ndb.transaction(() => {
    const prop = resolveDefinition(ndb, ownerType, ownerId, key);
    if (!prop || prop.value_type !== 'link') {
      throw new EtnError('NOT_FOUND', `property "${key}" does not exist or is not a link property`, {
        key,
      });
    }
    const id = removeLinkPropertyTarget(
      ndb,
      ownerId,
      prop,
      targetId,
      actorUserId,
      prop.direction,
    );
    if (id !== null) touchOwner(ndb, ownerType, ownerId, actorUserId);
    return { link_id: id };
  });
}

/**
 * Compute "card completeness" warnings for a thought (task O6,
 * docs/05-mcp-server.md §4.2). Returns one entry per `required` property in
 * the thought's effective type chain (L21) for which there is no stored value
 * on this card. Matching is by property id — a stored value outside the type
 * still counts as filled (it is the same property).
 *
 * Defaults are not stored rows and therefore do not mask the warning; thoughts
 * without a type never report warnings.
 */
export function computeThoughtCardWarnings(
  ndb: NetworkDb,
  thoughtId: string,
): ThoughtCardWarning[] {
  const row = ndb.prepare('SELECT type_id FROM thoughts_v WHERE id = ?').get(thoughtId) as
    | { type_id: string | null }
    | undefined;
  if (row === undefined || row.type_id === null) {
    return [];
  }
  const effective = listEffectiveTypeProperties(ndb, 'thought_type', row.type_id);
  if (effective.length === 0) {
    return [];
  }
  // Map (property_id → value) of everything currently stored on the thought
  // (только скаляры: свойства-связи значений в property_values не хранят).
  const stored = new Map<string, PropertyValueValue>();
  for (const v of getPropertyValues(ndb, 'thought', thoughtId)) {
    if (v.value_type === 'link') continue;
    stored.set(v.property_id, v.value);
  }
  // Счётчики рёбер — для проверки обязательных свойств-связей (требование
  // 7df6b966): заполнено, если есть хотя бы одно живое ребро.
  const edgeCounts = linkEdgeCounts(ndb, thoughtId);
  const warnings: ThoughtCardWarning[] = [];
  for (const def of effective) {
    if (!def.required) continue;
    if (def.value_type === 'link') {
      const cfg = def.config ?? {};
      const linkTypeId = cfg.link_type_id as string;
      // Направление свойства-связи задаётся привязкой (`type_properties.side`,
      // миграция 042), а не `config.direction` — та же единая точка
      // интерпретации, что и в чтении карточки (`emitExplicit`). Без учёта
      // стороны обязательное свойство «применяется к», заполненное ребром из
      // того же батча, ложно давало `REQUIRED_PROPERTY_MISSING`
      // (ошибка cb9fec6b-4606-4ddb-bd93-10716007b659).
      const direction = linkPropertyDirection(def.config, def.side ?? null);
      if ((edgeCounts.get(`${linkTypeId}|${direction}`) ?? 0) > 0) continue;
    } else if (hasValue(stored.get(def.property_id))) {
      continue;
    }
    warnings.push({
      code: 'REQUIRED_PROPERTY_MISSING',
      key: def.key,
      property_id: def.property_id,
      defined_on: def.defined_on,
      value_type: def.value_type,
      inherited: def.inherited,
    });
  }
  return warnings;
}

/**
 * A stored value counts as "filled" when it is not the absence marker
 * (`null`). Empty strings are legitimate values; an empty multiple `url` array
 * is an empty selection and counts as unset.
 */
function hasValue(value: PropertyValueValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  return !(Array.isArray(value) && value.length === 0);
}

/**
 * Delete a stored property value addressed by property name. Outside-type
 * values are deletable — manual removal is the only action available for them
 * (02-data-model.md §3.5a) — so the property only has to exist in the
 * registry, not to be attached to the owner's type. Idempotent
 * (error cefb4db0): when no value is stored for the property the call
 * succeeds as a no-op and reports `deleted: false` — DELETE semantics, the
 * editor's blur path may fire it against an already-empty field. Throws
 * `NOT_FOUND` (404) only when the property itself is unknown.
 */
export function deletePropertyValue(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  key: string,
  actorUserId: string,
): { property_id: string; deleted: boolean } {
  if (ownerType !== 'thought' && ownerType !== 'link') {
    throw new EtnError('VALIDATION_ERROR', `invalid owner_type: ${ownerType}`, {
      field: 'owner_type',
    });
  }
  return ndb.transaction(() => {
    const prop = resolveDefinition(ndb, ownerType, ownerId, key);
    if (!prop) {
      throw new EtnError('NOT_FOUND', `property "${key}" does not exist in this network`, {
        owner_type: ownerType,
        owner_id: ownerId,
        key,
      });
    }
    // S4: в слое значение скрывается надгробием (13-layers.md §5.2), в основе —
    // прежний физический DELETE.
    if (!isBaseContext(ndb)) {
      // Same natural-key ambiguity as the write path (bug 49d1f5e8): resolve
      // ONE row — the nearest layer's own value for this natural key —
      // instead of looping every `property_values_v` per-id "winner", which
      // can hand back two different ids for the same natural key and crash
      // `deleteRowLayered` with a UNIQUE violation when the farther one is
      // shadow-tombstoned into a layer that already holds the nearer one
      // under a different id. See {@link resolveVisiblePropertyValueId}.
      const existingId = resolveVisiblePropertyValueId(ndb, ownerType, ownerId, prop.id);
      if (existingId === undefined) {
        // Nothing stored — idempotent no-op (error cefb4db0).
        return { property_id: prop.id, deleted: false };
      }
      deleteRowLayered(ndb, 'property_values', existingId);
      // Удаление значения — правка владельца: обновим авторство
      // (требование e6d4165e, приравнивание).
      touchOwner(ndb, ownerType, ownerId, actorUserId);
      return { property_id: prop.id, deleted: true };
    }
    const result = ndb
      .prepare(
        'DELETE FROM property_values WHERE owner_type = ? AND owner_id = ? AND property_id = ?',
      )
      .run(ownerType, ownerId, prop.id);
    if (result.changes === 0) {
      // Nothing stored — idempotent no-op (error cefb4db0).
      return { property_id: prop.id, deleted: false };
    }
    // Удаление значения — правка владельца: обновим авторство
    // (требование e6d4165e, приравнивание).
    touchOwner(ndb, ownerType, ownerId, actorUserId);
    // Return the property_id so routes can emit `property-value.deleted`
    // without a second lookup.
    return { property_id: prop.id, deleted: true };
  });
}


/**
 * Явный резолв значений свойства вида `cross_network_ref` (задача 7849008a,
 * требование 95511443, спека операции 737ed900): для каждого видимого
 * вызывающему значения открывает целевую сеть и обновляет снапшот имени.
 * Цель или сеть удалены — значение помечается `unresolved: 1`, снапшот
 * сохраняется. Обрабатываются только значения, видимые вызывающему
 * (права уже отфильтрованы чтением).
 *
 * Снапшоты живут в служебной неветбимой таблице
 * `property_value_cross_refs` (см. миграцию 044) — обновление НЕ создаёт
 * слойных теневых строк, НЕ расходует write-бюджет и НЕ пишется в
 * `audit_log` как содержательная операция (требование c104a0fc).
 *
 * @returns Массив обновлённых снапшотов в DTO-форме `CrossNetworkRefValue`
 *   для каждого адреса значения (для single — массив длины 1).
 * @throws {EtnError} `VALIDATION_ERROR`, если свойство не существует или
 *   не имеет вида `cross_network_ref`.
 */
export function crossResolvePropertyValue(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  key: string,
  ctx: CrossNetworkAccessContext,
): CrossNetworkRefValue[] {
  return ndb.transaction(() => {
    const prop = resolveDefinition(ndb, ownerType, ownerId, key);
    if (!prop) {
      throw new EtnError('NOT_FOUND', `property "${key}" does not exist in this network`, {
        owner_type: ownerType,
        owner_id: ownerId,
        key,
      });
    }
    if (prop.value_type !== 'cross_network_ref') {
      throw new EtnError(
        'VALIDATION_ERROR',
        `cross-resolve применим только к свойствам вида cross_network_ref`,
        { key, value_type: prop.value_type },
      );
    }
    // Резолвим ФИЗИЧЕСКИЙ id значения (для слоя может быть отдельный row).
    const valueId = resolveVisiblePropertyValueId(ndb, ownerType, ownerId, prop.id);
    if (valueId === undefined) {
      return [];
    }
    const stored = ndb
      .prepare('SELECT value_text FROM property_values_v WHERE id = ?')
      .get(valueId) as { value_text: string | null };
    if (stored?.value_text === null || stored?.value_text === undefined) {
      return [];
    }
    const addresses = parseStoredCrossNetworkAddresses(stored.value_text);
    const now = new Date().toISOString();
    // Читаем текущий снапшот, чтобы для нерезолвленных адресов оставить
    // прежнее имя (требование 6d4ad9ac: «имя всегда из снапшота»).
    const existingPayload = readSnapshotPayload(ndb, valueId);
    const previousByKey = new Map<string, { title: string; resolved_at: string; unresolved: 0 | 1 }>();
    if (existingPayload !== null) {
      for (const item of existingPayload.items) {
        previousByKey.set(`${item.network_id}#${item.thought_id}`, {
          title: item.title,
          resolved_at: item.resolved_at,
          unresolved: item.unresolved,
        });
      }
    }
    const items: CrossRefSnapshotItem[] = [];
    const out: CrossNetworkRefValue[] = [];
    for (const address of addresses) {
      const parsed = parseCrossNetworkAddress(address);
      if (parsed === null) {
        // Повреждённое значение: оставляем как есть, помечаем нерезолвленным.
        items.push({
          network_id: '',
          thought_id: address,
          title: address,
          resolved_at: now,
          unresolved: 1,
        });
        out.push({
          network_id: '',
          thought_id: address,
          title_snapshot: address,
          unresolved: true,
          resolved_at: now,
        });
        continue;
      }
      const key2 = `${parsed.networkId}#${parsed.thoughtId}`;
      const status = resolveCrossNetworkRef(address, ctx);
      if (status.kind === 'resolved') {
        items.push({
          network_id: parsed.networkId,
          thought_id: parsed.thoughtId,
          title: status.title,
          resolved_at: now,
          unresolved: 0,
        });
        out.push({
          network_id: parsed.networkId,
          thought_id: parsed.thoughtId,
          title_snapshot: status.title,
          unresolved: false,
          resolved_at: now,
        });
      } else {
        // Нет прав / сеть или цель удалены — снапшот сохраняется, помечаем
        // нерезолвленным (требование 6d4ad9ac).
        const previous = previousByKey.get(key2);
        items.push({
          network_id: parsed.networkId,
          thought_id: parsed.thoughtId,
          title: previous?.title ?? address,
          resolved_at: now,
          unresolved: 1,
        });
        out.push({
          network_id: parsed.networkId,
          thought_id: parsed.thoughtId,
          title_snapshot: previous?.title ?? address,
          unresolved: true,
          resolved_at: now,
        });
      }
    }
    upsertSnapshotPayload(ndb, valueId, items);
    return out;
  });
}

// ---------------------------------------------------------------------------
// Счётчики и usage справочника свойств (ADR 8c93f03a, веха 7 версии 0.8.2).
// Раньше этот сырой SQL жил в фасаде `routes/properties-registry.ts` —
// вынесен сюда, чтобы роут остался тонким, а запросы покрывались доменными
// тестами. Поведение перенесено дословно.
// ---------------------------------------------------------------------------

/** Счётчики одного свойства справочника (перенос `readCounters` из роута). */
export function getPropertyRegistryCounters(
  ndb: NetworkDb,
  propertyId: string,
  valueType?: PropertyValueType,
): RegistryPropertyCounters {
  const typesCount = (
    ndb
      .prepare('SELECT COUNT(*) AS c FROM type_properties_v WHERE property_id = ?')
      .get(propertyId) as { c: number }
  ).c;
  const valuesCount = (
    ndb
      .prepare('SELECT COUNT(*) AS c FROM property_values_v WHERE property_id = ?')
      .get(propertyId) as { c: number }
  ).c;
  const result: RegistryPropertyCounters = {
    types_count: typesCount,
    values_count: valuesCount,
  };
  if (valueType === 'link') {
    // Split by side. `side IS NULL` rows are legacy bindings (миграция 041) —
    // they keep counting in the total but not in either side.
    const sourceCount = (
      ndb
        .prepare(
          "SELECT COUNT(*) AS c FROM type_properties_v WHERE property_id = ? AND side = 'source'",
        )
        .get(propertyId) as { c: number }
    ).c;
    const targetCount = (
      ndb
        .prepare(
          "SELECT COUNT(*) AS c FROM type_properties_v WHERE property_id = ? AND side = 'target'",
        )
        .get(propertyId) as { c: number }
    ).c;
    result.types_source_count = sourceCount;
    result.types_target_count = targetCount;
  }
  return result;
}

/** Групповые счётчики всего справочника — четыре агрегата за четыре запроса. */
export function getPropertyCounterMaps(ndb: NetworkDb): {
  typesByProp: Map<string, number>;
  valuesByProp: Map<string, number>;
  linkSourceByProp: Map<string, number>;
  linkTargetByProp: Map<string, number>;
} {
  const typeRows = ndb
    .prepare('SELECT property_id, COUNT(*) AS c FROM type_properties_v GROUP BY property_id')
    .all() as Array<{ property_id: string; c: number }>;
  const valueRows = ndb
    .prepare('SELECT property_id, COUNT(*) AS c FROM property_values_v GROUP BY property_id')
    .all() as Array<{ property_id: string; c: number }>;
  // Per-side counters for link properties (0.8.1, задача d7177d1d).
  const linkSourceRows = ndb
    .prepare(
      "SELECT property_id, COUNT(*) AS c FROM type_properties_v WHERE side = 'source' GROUP BY property_id",
    )
    .all() as Array<{ property_id: string; c: number }>;
  const linkTargetRows = ndb
    .prepare(
      "SELECT property_id, COUNT(*) AS c FROM type_properties_v WHERE side = 'target' GROUP BY property_id",
    )
    .all() as Array<{ property_id: string; c: number }>;
  return {
    typesByProp: new Map(typeRows.map((r) => [r.property_id, r.c])),
    valuesByProp: new Map(valueRows.map((r) => [r.property_id, r.c])),
    linkSourceByProp: new Map(linkSourceRows.map((r) => [r.property_id, r.c])),
    linkTargetByProp: new Map(linkTargetRows.map((r) => [r.property_id, r.c])),
  };
}

/**
 * Walk every stored value of a property and classify it as convertible or
 * droppable for the requested `value_type`. Used to surface `converted`/
 * `dropped` counters from the PATCH endpoint without changing the service's
 * signature. Rules mirror {@link convertStoredValue}; NULL always stays NULL.
 */
export function classifyStoredValues(
  ndb: NetworkDb,
  propertyId: string,
  from: PropertyValueType,
  to: PropertyValueType,
): { converted: number; dropped: number } {
  const rows = ndb
    .prepare(
      `SELECT value_text, value_date, value_number, value_bool
       FROM property_values_v WHERE property_id = ?`,
    )
    .all(propertyId) as Array<{
    value_text: string | null;
    value_date: string | null;
    value_number: number | null;
    value_bool: number | null;
  }>;

  let converted = 0;
  let dropped = 0;
  for (const row of rows) {
    // Read the stored value as its declared type, then try to convert.
    let value: string | number | boolean | string[] | null = null;
    switch (from) {
      case 'text':
      case 'url':
        value = row.value_text;
        break;
      case 'date':
        value = row.value_date;
        break;
      case 'number':
        value = row.value_number;
        break;
      case 'bool':
        value = row.value_bool === null ? null : row.value_bool === 1;
        break;
      case 'link':
        value = null;
        break;
    }
    // Same conversion rules as {@link convertStoredValue}.
    if (canStoredValueConvert(value, to)) converted += 1;
    else dropped += 1;
  }
  return { converted, dropped };
}

/** Классификатор одного значения для {@link classifyStoredValues}. */
function canStoredValueConvert(
  value: string | number | boolean | string[] | null,
  to: PropertyValueType,
): boolean {
  if (value === null) return true; // NULL always stays NULL
  if (Array.isArray(value)) {
    return to === 'text' || to === 'url';
  }
  switch (to) {
    case 'text':
    case 'url':
      return true;
    case 'number': {
      if (typeof value === 'number') return true;
      if (typeof value === 'boolean') return true;
      const trimmed = value.trim();
      if (trimmed === '') return false;
      const n = Number(trimmed);
      return Number.isFinite(n);
    }
    case 'date':
      return typeof value === 'string' && ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
    case 'bool':
      if (typeof value === 'boolean') return true;
      if (typeof value === 'number' && (value === 0 || value === 1)) return true;
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        return s === 'true' || s === 'да' || s === '1' || s === 'false' || s === 'нет' || s === '0';
      }
      return false;
    case 'link':
      return false;
    case 'thought_ref':
      // Legacy (миграция 040): таких свойств в живой БД не остаётся.
      return false;
    case 'cross_network_ref':
      // Кросс-сетевая ссылка: снапшот привязан к адресу и при смене value_type
      // теряет смысл. Конвертация бессмысленна.
      return false;
    case 'publication':
      // Ссылка на публикацию: id адресует конкретную публикацию и при смене
      // value_type теряет смысл — конвертация бессмысленна.
      return false;
  }
}

/**
 * Usage-отчёт свойства: привязки к типам с именами и счётчиками значений
 * «in-type» (по точному совпадению типа владельца с привязкой) и суммарный
 * счётчик «out-of-type» (значения на владельцах, чей тип не входит в набор
 * привязок). Перенос блока из `GET /networks/{id}/properties/{id}/usage`.
 */
export function getPropertyUsage(ndb: NetworkDb, propertyId: string): PropertyUsageReport {
  // Bindings: every type (thought or link) that attaches the property.
  const bindingRows = ndb
    .prepare(
      `SELECT tp.owner_type AS owner_type, tp.owner_id AS owner_id,
              tp.required AS required
       FROM type_properties_v tp
       WHERE tp.property_id = ?
       ORDER BY tp.owner_type, tp.owner_id`,
    )
    .all(propertyId) as Array<{
    owner_type: 'thought_type' | 'link_type';
    owner_id: string;
    required: number;
  }>;

  const thoughtTypeIds = bindingRows
    .filter((b) => b.owner_type === 'thought_type')
    .map((b) => b.owner_id);
  const linkTypeIds = bindingRows
    .filter((b) => b.owner_type === 'link_type')
    .map((b) => b.owner_id);

  const thoughtNameById = new Map<string, string>();
  if (thoughtTypeIds.length > 0) {
    const rows = ndb
      .prepare(
        `SELECT id, name FROM thought_types_v WHERE id IN (${thoughtTypeIds.map(() => '?').join(', ')})`,
      )
      .all(...thoughtTypeIds) as Array<{ id: string; name: string }>;
    for (const r of rows) thoughtNameById.set(r.id, r.name);
  }
  const linkNameById = new Map<string, string>();
  if (linkTypeIds.length > 0) {
    const rows = ndb
      .prepare(
        `SELECT id, name_forward, name_reverse FROM link_types_v WHERE id IN (${linkTypeIds.map(() => '?').join(', ')})`,
      )
      .all(...linkTypeIds) as Array<{
      id: string;
      name_forward: string;
      name_reverse: string;
    }>;
    for (const r of rows) linkNameById.set(r.id, `${r.name_forward} / ${r.name_reverse}`);
  }

  // For each binding, count stored values on owners whose type id matches
  // this binding exactly. The "in-type" notion is by the binding row's
  // owner type (a thought_type binding covers thoughts whose type_id
  // equals it).
  const bindings: PropertyUsageBinding[] = [];
  for (const b of bindingRows) {
    const ownerTable = b.owner_type === 'thought_type' ? 'thoughts_v' : 'links_v';
    const name =
      b.owner_type === 'thought_type'
        ? (thoughtNameById.get(b.owner_id) ?? b.owner_id)
        : (linkNameById.get(b.owner_id) ?? b.owner_id);
    const count = (
      ndb
        .prepare(
          `SELECT COUNT(*) AS c
           FROM property_values_v pv
           JOIN ${ownerTable} o ON o.id = pv.owner_id
           WHERE pv.property_id = ? AND pv.owner_type = ? AND o.type_id = ?`,
        )
        .get(
          propertyId,
          b.owner_type === 'thought_type' ? 'thought' : 'link',
          b.owner_id,
        ) as { c: number }
    ).c;
    bindings.push({
      owner_type: b.owner_type,
      owner_id: b.owner_id,
      owner_name: name,
      required: b.required === 1,
      values_in_type_count: count,
    });
  }

  // «Out-of-type»: stored values whose owner's type is not in the
  // attached set. Walk thought/link owners separately: a thought_type
  // binding covers thoughts, never links, so a thought's outside-type
  // status is computed against the thought_type bindings only.
  const thoughtTypeIdSet = new Set(thoughtTypeIds);
  const linkTypeIdSet = new Set(linkTypeIds);

  const thoughtOutsideCount = (
    ndb
      .prepare(
        `SELECT COUNT(*) AS c
         FROM property_values_v pv
         LEFT JOIN thoughts_v t ON t.id = pv.owner_id
         WHERE pv.property_id = ? AND pv.owner_type = 'thought'
           AND (t.type_id IS NULL OR t.type_id NOT IN (${thoughtTypeIds.length > 0 ? thoughtTypeIds.map(() => '?').join(', ') : 'NULL'}))`,
      )
      .get(propertyId, ...(thoughtTypeIds.length > 0 ? thoughtTypeIds : [])) as { c: number }
  ).c;

  const linkOutsideCount = (
    ndb
      .prepare(
        `SELECT COUNT(*) AS c
         FROM property_values_v pv
         LEFT JOIN links_v l ON l.id = pv.owner_id
         WHERE pv.property_id = ? AND pv.owner_type = 'link'
           AND (l.type_id IS NULL OR l.type_id NOT IN (${linkTypeIds.length > 0 ? linkTypeIds.map(() => '?').join(', ') : 'NULL'}))`,
      )
      .get(propertyId, ...(linkTypeIds.length > 0 ? linkTypeIds : [])) as { c: number }
  ).c;

  const valuesInTypeCount = bindings.reduce((acc, b) => acc + b.values_in_type_count, 0);
  const valuesOutsideTypeCount = thoughtOutsideCount + linkOutsideCount;

  return {
    bindings,
    values_in_type_count: valuesInTypeCount,
    values_outside_type_count: valuesOutsideTypeCount,
    thought_types: Array.from(thoughtTypeIdSet),
    link_types: Array.from(linkTypeIdSet),
  };
}
