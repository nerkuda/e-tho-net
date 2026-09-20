/**
 * Определения свойств типа ↔ набор свойств открытого редактора
 * (ошибка 74b94c26 «Открытый редактор не перечитывает свойства при изменении
 * определений свойств типа»).
 *
 * Вкладка «Свойства» открытого редактора показывает таблицу по ЭФФЕКТИВНОМУ
 * набору определений типа показанной сущности — привязки её типа и всех
 * предков (L21), плюс зеркальные свойства-связи (требование dde92461).
 * Набор меняется двумя путями:
 *
 *  - **realtime** — события `property-definition.created/updated/deleted` от
 *    другого клиента или от MCP `etn.ontology.write`; сеть/слой фильтрует
 *    транспорт, а «касается ли это показанной сущности» решает
 *    {@link definitionChangeAffectsShown};
 *  - **локально** — правка определений в редакторе типа
 *    (`screens/type-manager.ts`) или привязок свойства из менеджера свойств
 *    (`screens/property-manager.ts`). Своё realtime-эхо до рендерера не
 *    доходит — главный процесс его отбрасывает (G8 applier), поэтому
 *    производители уведомляют подписчиков сами через
 *    {@link notifyTypeDefinitionsChanged}.
 *
 * Гейт отсекает изменения ЧУЖИХ типов: перечитывается только набор,
 * зависящий от изменённого определения. Формула «тип накрыт» повторяет
 * серверную (`appendMirroredLinkProperties`): сам тип или его предок входит в
 * список допустимых типов свойства-связи — тогда у показанного типа есть
 * зеркальное (встречное) свойство, и его правка тоже обязана перечитать
 * таблицу.
 *
 * Индекс показанных определений ({@link rememberShownDefinitions} /
 * {@link shownDefinitionOwner}) нужен потому, что события `updated`/`deleted`
 * несут ТОЛЬКО id (привязки или реестрового свойства) — владельца приходится
 * брать из того, что реально отрисовано в таблице. Неизвестный id означает,
 * что определения в таблице нет: устаревать нечему, вкладка прочитает набор
 * заново при следующем построении.
 */

import type { TypeOwnerType } from '@etn/shared';

/** Изменения определений свойств, на которые реагирует открытый редактор. */
export type DefinitionEventType =
  | 'property-definition.created'
  | 'property-definition.updated'
  | 'property-definition.deleted';

const DEFINITION_EVENT_TYPES: readonly string[] = [
  'property-definition.created',
  'property-definition.updated',
  'property-definition.deleted',
];

/** Сужает имя realtime-события до {@link DefinitionEventType}. */
export function isDefinitionEventType(type: string): type is DefinitionEventType {
  return DEFINITION_EVENT_TYPES.includes(type);
}

/** Владелец определения свойства — тип мыслей или тип связи. */
export interface DefinitionOwner {
  ownerType: TypeOwnerType;
  ownerId: string;
}

/** Цепочка типов показанной в редакторе сущности (сам тип + предки). */
export interface ShownTypeChain {
  /** `thought_type` для мысли, `link_type` для связи. */
  ownerType: TypeOwnerType;
  /** Id показанного типа и всех его предков; пусто — типа нет в каталоге. */
  ids: ReadonlySet<string>;
}

/**
 * Что удалось вычитать об изменении определения. `owner` — `null`, когда
 * событие владельца не несёт, а показанный набор его не отрисовал.
 */
export interface DefinitionChangeFacts {
  owner: DefinitionOwner | null;
  /** Свойства-связи: списки допустимых типов, дающие зеркала (см. модульный
   *  комментарий); `null` — не выводимы из изменения. */
  allowedTypeIds: readonly string[] | null;
  /**
   * Изменены сами списки допустимых типов: прежняя граница покрытия
   * неизвестна (снятие покрытия тоже могло случиться) — перечитываем набор
   * независимо от цепочки. Правка этих списков редка, а пересборка вкладки
   * «Свойства» дешева (без CodeMirror).
   */
  coverageBoundaryUnknown: boolean;
}

/** Изменение, о котором не известно ничего, — не влияет ни на что. */
const NEUTRAL_FACTS: DefinitionChangeFacts = {
  owner: null,
  allowedTypeIds: null,
  coverageBoundaryUnknown: false,
};

// ---------------------------------------------------------------------------
// Локальный путь: уведомление об изменении определений (свой клиент)
// ---------------------------------------------------------------------------

const localListeners = new Set<(owner: DefinitionOwner) => void>();

/** Подписка на локальные изменения определений свойств типа. */
export function onTypeDefinitionsChanged(
  listener: (owner: DefinitionOwner) => void,
): () => void {
  localListeners.add(listener);
  return () => {
    localListeners.delete(listener);
  };
}

/**
 * Уведомляет подписчиков: определения свойств типа изменены ЭТИМ клиентом
 * (правка в редакторе типа или в менеджере свойств). `ownerId` — тип, у
 * которого правили привязки; потомки получают изменение по цепочке типов.
 */
export function notifyTypeDefinitionsChanged(owner: DefinitionOwner): void {
  for (const listener of localListeners) listener(owner);
}

// ---------------------------------------------------------------------------
// Индекс определений, показанных таблицей «Свойства» открытого редактора
// ---------------------------------------------------------------------------

/** Минимум определения, нужный индексу показанных свойств. */
export interface ShownDefinition {
  /** Id привязки (`type_properties.id`; у зеркала — синтетический). */
  id: string;
  /** Id реестрового свойства — событие может адресовать и его. */
  property_id?: string;
  owner_type: TypeOwnerType;
  owner_id: string;
}

/** Индекс: id привязки / реестрового свойства → владелец определения. */
let shownDefinitions = new Map<string, DefinitionOwner>();

/**
 * Запоминает набор определений, отрисованный таблицей «Свойства» текущей
 * показанной сущности (вызывается её загрузкой). Индекс заменяется целиком:
 * события обязаны сверяться с тем, что видно на экране сейчас.
 */
export function rememberShownDefinitions(defs: readonly ShownDefinition[]): void {
  const next = new Map<string, DefinitionOwner>();
  for (const def of defs) {
    const owner: DefinitionOwner = { ownerType: def.owner_type, ownerId: def.owner_id };
    next.set(def.id, owner);
    if (def.property_id !== undefined && def.property_id !== '') next.set(def.property_id, owner);
  }
  shownDefinitions = next;
}

/** Владелец определения по id привязки или реестрового свойства; `null` —
 *  такого определения в показанной таблице нет. */
export function shownDefinitionOwner(definitionId: string): DefinitionOwner | null {
  return shownDefinitions.get(definitionId) ?? null;
}

// ---------------------------------------------------------------------------
// Гейт: касается ли изменение показанной сущности
// ---------------------------------------------------------------------------

/**
 * Касается ли изменение определения набора свойств показанного типа:
 * изменение привязки в цепочке типов показанной сущности (сам тип или
 * предок) либо свойства-связи, покрывающей эту цепочку зеркалом.
 */
export function definitionChangeAffectsShown(
  facts: DefinitionChangeFacts,
  shown: ShownTypeChain,
): boolean {
  if (facts.coverageBoundaryUnknown) return true;
  const owner = facts.owner;
  if (owner === null) return false;
  // Разные ветви каталогов (мысль ↔ связь) свойств друг другу не отдают.
  if (owner.ownerType !== shown.ownerType) return false;
  if (shown.ids.has(owner.ownerId)) return true;
  return facts.allowedTypeIds !== null && facts.allowedTypeIds.some((id) => shown.ids.has(id));
}

/** Факты об изменении определения из `data` realtime-события. */
export function definitionChangeFacts(
  type: DefinitionEventType,
  data: unknown,
): DefinitionChangeFacts {
  const payload = asRecord(data);
  if (payload === null) return NEUTRAL_FACTS;

  if (type === 'property-definition.created') {
    // `created` (в т.ч. upsert MCP `etn.ontology.write`) несёт полный снимок
    // определения — владелец и списки покрытия известны точно.
    const definition = asRecord(payload['definition']);
    if (definition === null) return NEUTRAL_FACTS;
    const ownerType = asString(definition['owner_type']);
    const ownerId = asString(definition['owner_id']);
    return {
      owner:
        ownerType !== null && ownerId !== null
          ? { ownerType: ownerType as TypeOwnerType, ownerId }
          : null,
      allowedTypeIds: mirrorCoveredTypeIds(definition),
      coverageBoundaryUnknown: false,
    };
  }

  const id = asString(payload['id']);
  if (type === 'property-definition.updated') {
    const changes = asRecord(payload['changes']);
    return {
      owner: id === null ? null : shownDefinitionOwner(id),
      allowedTypeIds: null,
      coverageBoundaryUnknown: changes !== null && hasCoverageKeys(changes),
    };
  }
  return {
    owner: id === null ? null : shownDefinitionOwner(id),
    allowedTypeIds: null,
    coverageBoundaryUnknown: false,
  };
}

/** Изменены ли сами списки допустимых типов (граница покрытия сдвинулась). */
function hasCoverageKeys(changes: Record<string, unknown>): boolean {
  return (
    'allowed_target_type_ids' in changes ||
    'allowed_source_type_ids' in changes ||
    'allowedTargetTypeIds' in changes ||
    'allowedSourceTypeIds' in changes
  );
}

/**
 * Списки допустимых типов, по которым у накрытых типов появляется зеркальное
 * (или встречное, d7177d1d) свойство. Какой список смотреть — решает сторона
 * привязки (`source` → назначения, `target` → источники); сторона неизвестна —
 * берём объединение обоих (возможен лишний пересбор, но не пропуск).
 */
function mirrorCoveredTypeIds(definition: Record<string, unknown>): readonly string[] | null {
  const config = asRecord(definition['config']);
  if (config === null) return null;
  const allowedTargets = asStringArray(config['allowed_target_type_ids']);
  const allowedSources = asStringArray(config['allowed_source_type_ids']);
  const direction = asString(config['direction']);
  const side =
    asString(definition['side']) ??
    (direction === 'out' ? 'source' : direction === 'in' ? 'target' : null);
  const picked =
    side === 'source' ? allowedTargets : side === 'target' ? allowedSources : null;
  const ids = picked ?? [...(allowedTargets ?? []), ...(allowedSources ?? [])];
  return ids.length > 0 ? ids : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((item): item is string => typeof item === 'string' && item !== '');
  return strings.length > 0 ? strings : null;
}
