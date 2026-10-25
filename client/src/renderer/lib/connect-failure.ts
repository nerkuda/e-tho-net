/**
 * Человеческий текст отказа подключения к серверу (ошибка 390e9746).
 *
 * Замечание заказчика: сообщения о неудачном подключении должны называть
 * ФАКТИЧЕСКУЮ причину, а не показывать «затычку» на все случаи. Диалог
 * подключения (список сохранённых серверов и форма нового подключения) и
 * автоподключение при запуске зовут {@link describeConnectFailure}: текст
 * всегда содержит адрес сервера, а причина берётся из того, что реально видно
 * в отказе:
 *
 *  - транспортный сбой — структурированная причина `details.reason` ошибки
 *    (`ConnectFailureDetails`: main различает отказ в соединении, таймаут, DNS
 *    и недоступность сети и кладёт причину в `details`, не заставляя UI
 *    разбирать технический текст);
 *  - ответ сервера — его собственный код (`UNAUTHORIZED` → «отклонил API-key»,
 *    `RATE_LIMITED` и т.п.);
 *  - иначе — серверный текст через `errText`; локальные технические огрызки
 *    (`HTTP 404: …`) не показываются как причина.
 *
 * Валидационная подсказка «Введите адрес сервера…» остаётся только у формы и
 * только для действительно пустого/некорректного ввода — к этому модулю она
 * не относится.
 */

import type { ConnectFailureDetails, ConnectFailureReason } from '../../main/ipc/contract.js';
import { errText } from './dom.js';
import { t, type MessageKey } from './i18n.js';

/** Куда пытались подключиться: метка профиля (если есть) и адрес. */
export interface ConnectTarget {
  /** Метка сохранённого профиля; пустая/совпадающая с адресом не дублируется. */
  label?: string | null;
  /** Адрес сервера — всегда попадает в сообщение. */
  baseUrl: string;
}

/** Причина отказа → ключ словаря. */
const REASON_KEYS: Readonly<Record<ConnectFailureReason, MessageKey>> = {
  refused: 'connect.reason.refused',
  timeout: 'connect.reason.timeout',
  dns: 'connect.reason.dns',
  unreachable: 'connect.reason.unreachable',
  other: 'connect.reason.other',
};

/** Разбор `details` транспортного отказа; чужие/битые `details` — `null`. */
function connectFailureDetails(err: unknown): ConnectFailureDetails | null {
  if (typeof err !== 'object' || err === null) return null;
  const details = (err as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return null;
  const d = details as { kind?: unknown; reason?: unknown };
  if (d.kind !== 'connect-failed') return null;
  const known = typeof d.reason === 'string' && d.reason in REASON_KEYS;
  return { kind: 'connect-failed', reason: known ? (d.reason as ConnectFailureReason) : 'other' };
}

/** Код ошибки сервера (`EtnError.code`), если он есть в восстановленной ошибке. */
function errorCodeOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : null;
}

/** Текст причины: структурированная причина, код сервера, серверный текст. */
function reasonText(err: unknown): string {
  const details = connectFailureDetails(err);
  if (details !== null) return t(REASON_KEYS[details.reason]);
  switch (errorCodeOf(err)) {
    case 'UNAUTHORIZED':
      return t('connect.reason.unauthorized');
    case 'FORBIDDEN':
      return t('connect.reason.forbidden');
    case 'RATE_LIMITED':
      return t('connect.reason.rateLimited');
    default:
      break;
  }
  const text = errText(err);
  // Локально собранные транспортные огрызки («HTTP 404: <html>…») — не причина
  // для пользователя: показываем нейтральную формулировку.
  if (text === '' || /^HTTP \d/i.test(text)) return t('connect.reason.other');
  return text;
}

/**
 * Сообщение об отказе подключения: адрес сервера + фактическая причина.
 * Метка профиля показывается, только если она не совпадает с адресом.
 */
export function describeConnectFailure(err: unknown, target: ConnectTarget): string {
  const baseUrl = target.baseUrl.trim();
  const label = (target.label ?? '').trim();
  const reason = reasonText(err);
  return label !== '' && label !== baseUrl
    ? t('connect.failed.withLabel', [label, baseUrl, reason])
    : t('connect.failed.address', [baseUrl, reason]);
}
