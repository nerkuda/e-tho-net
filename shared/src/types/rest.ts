/**
 * Общие формы ответов REST-операций (задача 120385ba, версия 0.8.2).
 *
 * Единственный источник для форм ответов, которые НЕ являются простым DTO:
 * композиция сущности со счётчиками, «плоское» дополнение сущности
 * вычислительными полями, отчёты. Раньше такие формы объявлялись дважды —
 * сервер собирал объект инлайном и отправлял через `sendSuccess`, клиент
 * независимо писал такой же inline-тип в `rest-client.ts`. Обе стороны
 * компилировались, но расходились: клиент ждал `{ property, … }`, сервер
 * отдавал плоский `{ ...property }` (ошибка c83f0215, коммит d548888).
 *
 * Правило: если форма ответа не сводится к одному DTO — объявляй её здесь и
 * используй на обеих сторонах (`server`/`client`). Тогда рассинхрон ловит
 * `tsc`, а сторож `client/tests/guard-rest-response-contracts.test.ts`
 * не даёт вернуться inline-типам в `rest-client.ts`.
 */

import type { DuplicateMatchKind, IconKind, PropertyValueType } from '../enums.js';

import type { CrossNetworkTruncationReason } from './search.js';

import type { ActivityRow } from './activity.js';
import type { AuditLogEntry } from './api.js';
import type { ApiKeyWithSecret, User } from './user.js';
import type { EffectiveThoughtTypeView, ThoughtTypeView } from './thought-type-view.js';
import type { NetworkProperty } from './thought-type.js';
import type { ThoughtRef } from './thought.js';
import type { FocusNeighbor } from './thought.js';
import type { NetworksCatalog } from './network.js';
import type { StructureQueryResponse } from './structure.js';

/**
 * `POST /admin/users` — двойной ответ при создании пользователя с ключом:
 * сам пользователь + его одноразовый ключ (полный текст ключа виден один раз).
 */
export interface AdminUserWithKey {
  user: User;
  key: ApiKeyWithSecret;
}

/**
 * `GET /admin/audit` — страница журнала аудита. `total` — размер окна до
 * пагинации (в success-конверте едет в `meta`).
 */
export interface AuditListResult {
  entries: AuditLogEntry[];
  total: number;
}

/** `POST /networks/{nid}/thoughts/{id}/focus-order` — порядок обхода фокуса. */
export interface FocusOrderResult {
  focus_thought_id: string;
  dir: string;
  ordered_ids: string[];
}

/**
 * `GET /networks/{nid}/thoughts/{id}/neighbors` — страница соседей с
 * метаданными пагинации (задача c8fa74ba). `items` — сами строки (форма
 * {@link FocusNeighbor}), `total`/`limit`/`offset` сервер отдаёт в `meta`
 * списка; клиент сводит их в одну форму источником порционной подгрузки
 * секторов карты мыслей и выпадающих списков целей.
 */
export interface NeighborPage {
  items: FocusNeighbor[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * `GET /networks/{nid}/thought-types/{id}/views` — собственные отборы типа
 * (`data`) плюс эффективный набор с учётом предков (`meta.effective`).
 */
export interface ThoughtTypeViewsResult {
  data: ThoughtTypeView[];
  meta: { effective: EffectiveThoughtTypeView[] };
}

/** Направления рёбер вершины отбора (мета прогона, `focus-filter-strip`). */
export interface ViewDirectionFlags {
  has_incoming: boolean;
  has_outgoing: boolean;
}

/** Нераспознанный токен определения отбора (мета прогона). */
export interface ViewUnresolvedToken {
  token: string;
  reason: string;
  message: string;
}

/** `meta` прогона отбора типа мысли (`POST /thoughts/{id}/views/{view}/run`). */
export interface RunThoughtTypeViewMeta {
  total: number;
  limit: number;
  offset: number;
  directions: Record<string, ViewDirectionFlags>;
  view: { id: string; name: string; type_id: string };
  sort?: string;
  order?: string;
  unresolved?: ViewUnresolvedToken[];
}

/** Результат прогона отбора: страница мыслей + мета (в success-конверте `meta`). */
export interface RunThoughtTypeViewResult {
  data: ThoughtRef[];
  meta: RunThoughtTypeViewMeta;
}

/** Счётчики справочника свойств (`GET /properties`, `GET /properties/{id}`). */
export interface RegistryPropertyCounters {
  types_count: number;
  values_count: number;
  /** Только для `value_type = 'link'`: привязки на стороне источника. */
  types_source_count?: number;
  /** Только для `value_type = 'link'`: привязки на стороне цели. */
  types_target_count?: number;
}

/** Свойство справочника + счётчики привязок и значений. */
export type NetworkPropertyWithCounters = NetworkProperty & RegistryPropertyCounters;

/**
 * `PATCH /networks/{nid}/properties/{id}` — НОВОЕ свойство, «расплющенное»
 * вместе со следом конверсии `value_type` (не конверт `{ property, … }`).
 */
export type NetworkPropertyUpdateResult = NetworkProperty & {
  converted: number;
  dropped: number;
};

/**
 * `DELETE /networks/{nid}/properties/{id}` — id удалённого свойства и число
 * рёбер, потерявших `type_id` и ставших структурными (`null` — не связи).
 */
export interface NetworkPropertyDeleteResult {
  id: string;
  links_becoming_structural: number | null;
}

/** Одна привязка свойства к типу-владельцу в usage-отчёте. */
export interface PropertyUsageBinding {
  owner_type: 'thought_type' | 'link_type';
  owner_id: string;
  owner_name: string;
  required: boolean;
  values_in_type_count: number;
}

/** Полный отчёт usage свойства справочника. */
export interface PropertyUsageReport {
  bindings: PropertyUsageBinding[];
  values_in_type_count: number;
  values_outside_type_count: number;
  /** Множества id типов-владельцев (диагностика dichotomy «in/out of type»). */
  thought_types: string[];
  link_types: string[];
}

/**
 * `GET /networks/{nid}/properties/{id}/usage` — свойство + его usage-отчёт
 * (домен считает отчёт, роут добавляет идентичность свойства).
 */
export interface NetworkPropertyUsage extends PropertyUsageReport {
  property_id: string;
  name: string;
  value_type: PropertyValueType;
}

/** Кандидат дубля из `GET /thoughts/duplicates` (08-ui-spec.md §4.4). */
export interface DuplicateHit {
  id: string;
  /** Id сети-владельца кандидата. Присутствует только в кросс-сетевом ответе
   *  (задача eb1a3f43); для одиночной сети сеть известна из контекста. */
  network_id?: string;
  title: string;
  /** Display forms of the candidate's synonyms. */
  synonyms: string[];
  /** Strongest match found. */
  matched_on: DuplicateMatchKind;
  /** Synonym text that matched, when `matched_on === 'synonym'`. */
  matched_synonym?: string;
  /** The candidate's own thought type (for icon/style resolution). */
  type_id: string | null;
  /** Own icon, when set; the caller falls back to the type's icon. */
  icon: string | null;
  icon_kind: IconKind;
  /** HEX-цвет символа иконки или `null` (задача 4105bd6a). */
  icon_color?: string | null;
  /** Own style overrides (nullable: inherit the type defaults). */
  fg_color: string | null;
  bg_color: string | null;
  font_bold: boolean | null;
  font_italic: boolean | null;
  font_underline: boolean | null;
  font_strike: boolean | null;
  /** Title of one parent (lexicographically first), for disambiguation. */
  parent_title: string | null;
}

/**
 * Кросс-сетевой ответ `etn.thoughts.find_duplicates` (задача eb1a3f43): массив
 * хитов с проставленным `network_id` плюс справочник сетей (`id` +
 * `display_name`). Для одиночной сети инструмент возвращает голый массив
 * `DuplicateHit[]` — поведение не изменилось (см. задачу 120385ba).
 */
export interface CrossNetworkDuplicateResponse {
  hits: DuplicateHit[];
  networks: NetworksCatalog;
  /** True, когда суммарная выдача обрезана потолком веера (задача 29bc5673). */
  truncated?: boolean;
  /** Причина обрезки веерной выдачи; `null` — не обрезано. */
  reason?: CrossNetworkTruncationReason | null;
}

/**
 * Кросс-сетевой ответ `POST /thoughts/query` с `network_ids` в теле
 * (задача eb1a3f43, требование c98d5d19): обычный `StructureQueryResponse`
 * плюс справочник сетей (`id` + `display_name`). Каждый `items[i]` несёт
 * `network_id`. Для одиночной сети инструмент возвращает голый
 * `StructureQueryResponse` без `networks` — поведение не изменилось.
 */
export type CrossNetworkStructureQueryResponse = StructureQueryResponse & {
  networks: NetworksCatalog;
};

/** `POST /networks/{nid}/thoughts/export` — поставленная задача экспорта. */
export interface ExportJobStartResult {
  job_id: string;
}

/**
 * `GET /networks/{nid}/activity` — страница журнала. `total` едет в
 * success-конверте (`meta`), клиент склеивает оба поля в один ответ.
 */
export interface ActivityListResult {
  rows: ActivityRow[];
  total: number;
}

/** `POST /activity/rollup` — итог свёртки журнала. */
export interface ActivityRollupResult {
  removed: number;
  kept: number;
}

/** `POST /activity/truncate` — итог жёсткой обрезки журнала. */
export interface ActivityTruncateResult {
  removed: number;
}

/** `POST /locks/clear` — сколько блокировок снято. */
export interface LocksClearResult {
  cleared: number;
}
