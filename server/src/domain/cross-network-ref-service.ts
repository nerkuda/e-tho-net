/**
 * Кросс-сетевая ссылка значениями свойств — резолв, снапшоты, деградация
 * (задача 7849008a, ADR ae8346d0, требования aa89940c/6d4ad9ac/95511443/c104a0fc).
 *
 * Вид значения `cross_network_ref` (общий реестр `properties`, миграция 044).
 * Адрес хранится в `property_values.value_text` как скаляр или JSON-массив
 * (multiple); снапшоты имён целей — в служебной неветбимой таблице
 * `property_value_cross_refs`.
 *
 * Серверная ответственность:
 *
 *   * **Живой резолв при записи** (`resolveForWrite`) — открывает целевую
 *     сеть, читает `title` мысли, валидирует адрес; несуществующий адрес
 *     отвергается с `VALIDATION_ERROR` (опечатка ловится сразу, требование
 *     aa89940c).
 *
 *   * **Снапшот** — кэш имени цели; обновляется по ДЕЙСТВИЮ (REST
 *     cross-resolve, MCP `etn.properties.resolve`, переход по ссылке в
 *     клиенте, контекстное меню). Снапшот НЕ создаёт слойных теневых строк
 *     и НЕ пишется в `audit_log` (требование c104a0fc). Запись снапшота идёт
 *     через `upsertSnapshotRow` без открытия слоя.
 *
 *   * **Деградация по правам** — если у пользователя нет доступа к целевой
 *     сети, значение молча фильтруется из выдачи (требование 6d4ad9ac).
 *     Проверка делается вызывающим по `systemDb.getMemberRole`.
 *
 *   * **Деградация по адресу** — сеть или цель удалены: резолв помечает
 *     значение `unresolved: 1`, снапшот имени сохраняется.
 */

import {
  type CrossNetworkRefResolveStatus,
  type CrossNetworkRefValue,
  formatCrossNetworkAddress,
  isCrossNetworkAddress,
  parseCrossNetworkAddress,
} from '@etn/shared';

import { EtnError } from '@etn/shared';
import type { Logger } from 'pino';
import type { NetworkDb } from '../db/network-db.js';
import { openNetworkDb } from '../db/network-db.js';
import { resolveSessionLayer } from './layer-service.js';

// ---------------------------------------------------------------------------
// Snapshot row helpers
// ---------------------------------------------------------------------------

/** Одна запись снапшота в JSON-массиве `payload.items`. */
export interface CrossRefSnapshotItem {
  network_id: string;
  thought_id: string;
  title: string;
  /** ISO-8601 UTC. */
  resolved_at: string;
  unresolved: 0 | 1;
}

interface SnapshotPayload {
  items: CrossRefSnapshotItem[];
}

/** Прочитать снапшоты для значения. Возвращает `null`, если снапшотов нет. */
export function readSnapshotPayload(
  ndb: NetworkDb,
  propertyValueId: string,
): SnapshotPayload | null {
  const row = ndb
    .prepare(
      `SELECT payload FROM property_value_cross_refs WHERE property_value_id = ?`,
    )
    .get(propertyValueId) as { payload: string } | undefined;
  if (row === undefined) return null;
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'items' in parsed &&
      Array.isArray((parsed as SnapshotPayload).items)
    ) {
      return parsed as SnapshotPayload;
    }
  } catch {
    // fall through — повреждённый снапшот трактуем как отсутствующий.
  }
  return null;
}

/**
 * Upsert снапшота для значения. Используется как при записи значения
 * (`setPropertyValue` и его аналоги), так и при явном живом резолве
 * (`resolveCrossNetworkRefsByIds`).
 *
 * Снапшоты живут в НЕВЕТБИМОЙ таблице — обновление не открывает слой и не
 * пишет `audit_log` (требование c104a0fc). Вызывающий обязан обеспечить
 * корректность `propertyValueId` (id физической строки `property_values`
 * после `materializeShadow`).
 */
export function upsertSnapshotPayload(
  ndb: NetworkDb,
  propertyValueId: string,
  items: CrossRefSnapshotItem[],
): void {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const payload: SnapshotPayload = { items };
  ndb
    .prepare(
      `INSERT INTO property_value_cross_refs (property_value_id, payload, updated_at, updated_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (property_value_id) DO UPDATE SET
         payload = excluded.payload,
         updated_at = excluded.updated_at,
         updated_at_ms = excluded.updated_at_ms`,
    )
    .run(propertyValueId, JSON.stringify(payload), now, nowMs);
}

/**
 * Удалить снапшоты значения. Вызывается при удалении самого значения
 * (`deleteRowLayered` каскадирует запись `property_values`, снапшот —
 * служебная таблица, отдельный путь).
 */
export function deleteSnapshotPayload(
  ndb: NetworkDb,
  propertyValueId: string,
): void {
  ndb.prepare(`DELETE FROM property_value_cross_refs WHERE property_value_id = ?`).run(propertyValueId);
}

// ---------------------------------------------------------------------------
// Живой резолв в чужую сеть
// ---------------------------------------------------------------------------

/** Контекст для {@link resolveCrossNetworkRef} — нужно открыть data.db целевой
 *  сети и проверить права пользователя. */
export interface CrossNetworkAccessContext {
  dataDir: string;
  userId: string;
  clientId: string;
  logger: Logger;
  /** Сети, к которым у пользователя есть доступ (member/admin). Резолв
   *  адресов из чужих сетей молча возвращает `unresolved: permission_denied`,
   *  адресов из доступных сетей идёт штатно. */
  accessibleNetworkIds: ReadonlySet<string>;
  /** Id сети, в которой идёт запись/чтение значения. Адреса с этим
   *  `network_id` отвергаются при записи (требование 884d14e1: «Адрес
   *  кросс-сетевой ссылки: запрет собственной сети»). */
  currentNetworkId: string;
}

/**
 * Резолв одной строки адреса `n:<network_id>#<thought_id>` через системную
 * базу + целевую сеть. Не открывает чужую базу для адресов из недоступных
 * сетей — возвращает `permission_denied`. Открывает слой вызывающего в
 * целевой сети (как и {@link openNetworkDbForCrossNetwork} в
 * `cross-network-search-service`).
 *
 * @returns `resolved` с заголовком цели; `unresolved` с причиной отказа.
 */
export function resolveCrossNetworkRef(
  address: string,
  ctx: CrossNetworkAccessContext,
): CrossNetworkRefResolveStatus {
  const parsed = parseCrossNetworkAddress(address);
  if (parsed === null) {
    return { kind: 'unresolved', reason: 'thought_not_found' };
  }
  if (!ctx.accessibleNetworkIds.has(parsed.networkId)) {
    return { kind: 'unresolved', reason: 'permission_denied' };
  }
  let ndb: NetworkDb;
  try {
    const base = openNetworkDb(ctx.dataDir, parsed.networkId, ctx.logger);
    const layer = resolveSessionLayer(base, ctx.userId, ctx.clientId);
    ndb = openNetworkDb(ctx.dataDir, parsed.networkId, ctx.logger, layer.id);
  } catch {
    return { kind: 'unresolved', reason: 'network_not_found' };
  }
  // Соединение целевой сети НЕ закрываем: `openNetworkDb` — общий реестр
  // соединений, тот же экземпляр (network, layer) переиспользуют и другие
  // вызовы. Закрытие здесь оставляло в реестре закрытый дескриптор: следующий
  // резолв/запись в ту же сеть получал мёртвое соединение и отвечал
  // `unresolved` (вскрыто честной записью `cross_network_ref`, ошибка
  // 052c84b2). Так же поступает соседний `openNetworkDbForCrossNetwork`.
  const row = ndb
    .prepare(`SELECT title FROM thoughts_v WHERE id = ?`)
    .get(parsed.thoughtId) as { title: string } | undefined;
  if (row === undefined) {
    return { kind: 'unresolved', reason: 'thought_not_found' };
  }
  return { kind: 'resolved', title: row.title };
}

/**
 * Зарезервировать снапшоты для набора адресов одной записи значения. Вызывается
 * при ЗАПИСИ значения (`setPropertyValue` и аналоги): один живой резолв на
 * адрес, успех — снапшот с `unresolved: 0`; любой отказ —
 * `VALIDATION_ERROR` (опечатка адреса ловится сразу, требование aa89940c).
 *
 * @throws {EtnError} `VALIDATION_ERROR`, если хотя бы один адрес не резолвится
 *   (нет прав / сеть или цель удалены). Это и есть «живой резолв при записи»,
 *   отличающий запись от чтения: чтение никогда не открывает чужие базы
 *   (требование 6d4ad9ac), запись — открывает.
 */
export function resolveAndBuildSnapshotsForWrite(
  addresses: string[],
  ctx: CrossNetworkAccessContext,
): CrossRefSnapshotItem[] {
  const now = new Date().toISOString();
  const items: CrossRefSnapshotItem[] = [];
  for (const address of addresses) {
    if (!isCrossNetworkAddress(address)) {
      throw new EtnError('VALIDATION_ERROR', 'некорректный адрес кросс-сетевой ссылки', {
        address,
        expected_format: 'n:<network_uuid>#<thought_uuid>',
      });
    }
    const parsed = parseCrossNetworkAddress(address)!;
    // Запрет адреса собственной сети (требование 884d14e1) — для внутрисетевых
    // ссылок есть свойство-связь.
    if (parsed.networkId === ctx.currentNetworkId) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'кросс-сетевая ссылка не может адресовать собственную сеть — заведите свойство-связь',
        { address, current_network_id: ctx.currentNetworkId },
      );
    }
    const status = resolveCrossNetworkRef(address, ctx);
    if (status.kind !== 'resolved') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'цель кросс-сетевой ссылки нерезолвится при записи',
        { address, reason: status.reason },
      );
    }
    items.push({
      network_id: parsed.networkId,
      thought_id: parsed.thoughtId,
      title: status.title,
      resolved_at: now,
      unresolved: 0,
    });
  }
  return items;
}

/**
 * Прочитать значение `cross_network_ref` со снапшотом. Возвращает `null`, если
 * `value_text` пустой или не парсится — это ловится выше в `readValue`,
 * здесь только компоновка ответа.
 *
 * Если снапшоты отсутствуют (значение записано до миграции 044 или до того,
 * как был реализован апдейт снапшотов), возвращаем имя-заглушку `<id>` —
 * пользователь увидит явный плейсхолдер, а живой резолв по действию
 * (`POST /properties/{key}/cross-resolve`) его заполнит.
 */
export function readCrossNetworkRefValue(
  stored: string | string[],
  payload: SnapshotPayload | null,
): CrossNetworkRefValue[] {
  const addresses = Array.isArray(stored) ? stored : [stored];
  const byKey = new Map<string, CrossRefSnapshotItem>();
  if (payload !== null) {
    for (const item of payload.items) byKey.set(`${item.network_id}#${item.thought_id}`, item);
  }
  return addresses.map((address) => {
    const parsed = parseCrossNetworkAddress(address);
    if (parsed === null) {
      // Защита от повреждённого значения: отдаём фиктивный адрес, чтобы
      // пользователь увидел проблему и вызвал `cross-resolve`.
      return {
        network_id: '',
        thought_id: address,
        title_snapshot: address,
        unresolved: true,
        resolved_at: null,
      };
    }
    const snap = byKey.get(`${parsed.networkId}#${parsed.thoughtId}`);
    if (snap === undefined) {
      return {
        network_id: parsed.networkId,
        thought_id: parsed.thoughtId,
        title_snapshot: formatCrossNetworkAddress(parsed.networkId, parsed.thoughtId),
        unresolved: true,
        resolved_at: null,
      };
    }
    return {
      network_id: snap.network_id,
      thought_id: snap.thought_id,
      title_snapshot: snap.title,
      unresolved: snap.unresolved === 1,
      resolved_at: snap.resolved_at,
    };
  });
}
