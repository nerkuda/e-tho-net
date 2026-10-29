/**
 * Клиентская проверка совместимости версий с сервером (задача 12fd5b0e,
 * требование 4d3be6ca, сущность 89aad200, ТП 52b33158).
 *
 * ## Зачем проверка двойная
 *
 * Уже выпущенный сервер 0.14.1 отдаёт `client_compatibility = ">=0.1.0"` и сам
 * новый клиент не отсечёт: по диапазону сервера любой клиент «совместим».
 * Поэтому клиент проверяет ДВА условия:
 *
 *  1. версия сервера входит во встроенный диапазон клиента
 *     `compatibilityRangeFor(clientVersion)` — предохранитель от старого сервера;
 *  2. версия клиента входит в `client_compatibility` сервера (если поля нет или
 *     оно в устаревшей однобокой форме — в `min_client`).
 *
 * Оба условия выполнены — работать можно. Иначе ни один запрос данных не
 * уходит: подключение не устанавливается, а глобальное состояние становится
 * блокирующим (`client-outdated` / `server-outdated`) либо неопределённым
 * (`check-failed`, диалог не показывается).
 *
 * ## Границы модуля
 *
 * `checkCompatibility` — чистая функция: ни сети, ни DOM, ни state. Тело
 * `/version` ей передаёт вызывающий. Stateful-часть ({@link CompatibilityGate})
 * только запоминает вердикт и раздаёт его рендереру; сама она в сеть не ходит —
 * функцию получения `/version` ей передают снаружи.
 *
 * ## Диапазон — только из `@etn/shared`
 *
 * Parsing semver и minor-окно живут в `shared/src/semver.ts`; модуль не
 * дублирует их и не хардкодит границы (требование 1f593647: совместимость по
 * паре major.minor, prerelease следующего minor — вне окна).
 */

import {
  CLIENT_VERSION_ERROR_REASON,
  compareSemver,
  compatibilityRangeFor,
  EtnError,
  parseRangeBounds,
  parseSemver,
  satisfiesRange,
  type ClientVersionErrorDetails,
  type ClientVersionErrorReason,
  type VersionResponse,
} from '@etn/shared';

import type { RealtimeStatus } from './net/ws-client.js';

/**
 * Пять статусов результата проверки (сущность 89aad200):
 *
 *  - `compatible` — версии совместимы, рекомендаций нет;
 *  - `recommended-update` — работать можно, доступна рекомендованная версия;
 *  - `client-outdated` — 426 или клиент вне диапазона сервера → блокировка;
 *  - `server-outdated` — сервер старше встроенного диапазона клиента → блокировка;
 *  - `check-failed` — `/version` недоступен/битый → НЕ блокирует, состояние
 *    `unknown` (диалог не показывается; подключение при этом не устанавливается,
 *    см. сценарий d2c80aa4).
 */
export type CompatibilityStatus =
  | 'compatible'
  | 'recommended-update'
  | 'client-outdated'
  | 'server-outdated'
  | 'check-failed';

/**
 * Состояние баннера рекомендованной версии (элемент интерфейса ed068706):
 * `hidden` — всё совместимо или идёт блокировка (показывается диалог),
 * `recommended-update` — доступна рекомендованная версия, `unknown` — проверка
 * не удалась (нейтральный текст, работа продолжается).
 */
export type CompatibilityBannerState = 'hidden' | 'recommended-update' | 'unknown';

/** Машиночитаемая причина, по которой работать нельзя/неизвестно. */
export type CompatibilityReason = 'client-outdated' | 'server-outdated' | 'check-failed';

/**
 * Итог проверки совместимости — IPC-сущность «Результат проверки совместимости
 * клиента с сервером» (89aad200). Передаётся рендереру и управляет блокировкой.
 *
 * Роль администратора берётся из `GET /api/v1/me` (обычного при подключении или
 * диагностического после блокирующего вердикта — требование 4d3be6ca) и
 * попадает в `is_admin` (0afec967): диалог блокировки показывает «Обновить
 * сервер» только администратору. `roleConfirmed` различает «роль не
 * запрашивали» от «запросили и получили не администратора».
 */
export interface CompatibilityResult {
  status: CompatibilityStatus;
  /** Проекция статуса на баннер: диалог/баннер выбираются по ней. */
  banner: CompatibilityBannerState;
  /** `true` — работать запрещено (только `client-outdated`/`server-outdated`). */
  blocking: boolean;
  /** Причина ограничения; `null` — работать можно. */
  reason: CompatibilityReason | null;
  /** Версия этого клиента (как её видит main). */
  clientVersion: string;
  /** Встроенный диапазон клиента, вычисленный из `clientVersion`. */
  clientCompatibility: string | null;
  /** Версия сервера из `/version`; `null` — не получена. */
  serverVersion: string | null;
  /** Диапазон совместимых клиентов с сервера (`client_compatibility`/`min_client`). */
  serverCompatibility: string | null;
  /** Рекомендованная сервером версия клиента, если новее текущей. */
  recommendedClientVersion: string | null;
  /** Страница релиза клиента (`client_download_url`) — открывается в браузере. */
  downloadUrl: string | null;
  /** `GET /api/v1/me` уже подтвердил роль в этой сессии (K3). */
  roleConfirmed: boolean;
  /**
   * `true` — пользователь администратор сервера (`is_admin` из `/api/v1/me`).
   * `/me` не выполнен или роль не подтверждена — `false`: диалог показывает
   * нейтральный текст «Обратитесь к администратору сервера», кнопки
   * «Обновить сервер» нет (требование 8623b9ff, 0afec967).
   */
  is_admin: boolean;
  /**
   * Машиночитаемая причина отказа сервера `426 CLIENT_VERSION_UNSUPPORTED`
   * (словарь `CLIENT_VERSION_ERROR_REASON` в `@etn/shared`); `null` — отказ
   * пришёл не от сервера (проверка `/version` при подключении). По ней диалог
   * и текст отказа подключения выбирают формулировку (0afec967).
   */
  serverReason: ClientVersionErrorReason | null;
}

/** Вход чистой проверки: версия клиента + тело `/version` как пришло. */
export interface CompatibilityInput {
  clientVersion: string;
  /** Тело ответа `GET /api/v1/version` (может быть битым/чужим). */
  response: unknown;
  /** Подтверждена ли роль после `GET /me` (попадает в результат). */
  roleConfirmed?: boolean;
  /** Администратор ли пользователь по `GET /me` (попадает в `is_admin`). */
  isAdmin?: boolean;
}

/**
 * Читает тело `GET /version` в типизированный вид.
 *
 * Обязательны `version` и хотя бы один источник диапазона клиента
 * (`client_compatibility` или `min_client`): без него проверить второе условие
 * нельзя. Устаревшая однобокая форма `client_compatibility` сохранена как есть —
 * её разбор (и откат к `min_client`) делает {@link clientInServerRange}.
 * Нестроковые/пустые необязательные поля становятся `null`; функция никогда не
 * бросает.
 */
export function parseVersionResponse(raw: unknown): VersionResponse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const version = stringOrNull(obj['version']);
  if (version === null) return null;
  const compatibility = stringOrNull(obj['client_compatibility']);
  const minClient = stringOrNull(obj['min_client']);
  if (compatibility === null && minClient === null) return null;
  return {
    version,
    api: stringOrNull(obj['api']) ?? '',
    min_client: minClient ?? '',
    client_compatibility: compatibility ?? '',
    recommended_client_version: stringOrNull(obj['recommended_client_version']),
    client_download_url: stringOrNull(obj['client_download_url']),
    client_sha256: stringOrNull(obj['client_sha256']),
  };
}

/**
 * Чистая проверка совместимости — единственное место правил.
 *
 * Порядок:
 *  1. разобрать версию клиента (не разобралась — `check-failed`);
 *  2. проверить сервер по ВСТРОЕННОМУ диапазону клиента; вне окна — блокировка:
 *     сервер старее клиента → `server-outdated`, иначе (новее окна) —
 *     `client-outdated` (сущность 89aad200);
 *  3. проверить клиента по диапазону сервера (`client_compatibility`, при
 *     отсутствии/однобокой форме — `min_client`); не входит — `client-outdated`;
 *  4. совместимо, но сервер рекомендует более новую версию (и она входит в его
 *     же диапазон) — `recommended-update`.
 */
export function checkCompatibility(input: CompatibilityInput): CompatibilityResult {
  const roleConfirmed = input.roleConfirmed === true;
  const clientVersion = input.clientVersion;
  const clientCompatibility = compatibilityRangeFor(clientVersion);

  const base = {
    clientVersion,
    clientCompatibility,
    serverVersion: null,
    serverCompatibility: null,
    recommendedClientVersion: null,
    downloadUrl: null,
    roleConfirmed,
    is_admin: input.isAdmin === true,
    serverReason: null,
  } as const;

  if (clientCompatibility === null || parseSemver(clientVersion) === null) {
    return failure('check-failed', base);
  }

  const server = parseVersionResponse(input.response);
  if (server === null) {
    return failure('check-failed', base);
  }
  const withServer = {
    ...base,
    serverVersion: server.version,
    serverCompatibility: serverRangeOf(server),
    downloadUrl: server.client_download_url ?? null,
  };
  if (parseSemver(server.version) === null) {
    return failure('check-failed', withServer);
  }
  // Диапазон сервера не разбирается ни как `client_compatibility`, ни как
  // `min_client` — контракт `/version` битый, проверить клиента нельзя.
  if (parseRangeBounds(server.client_compatibility) === null && parseSemver(server.min_client) === null) {
    return failure('check-failed', withServer);
  }

  // Условие 1: сервер внутри встроенного диапазона клиента.
  if (!satisfiesRange(server.version, clientCompatibility)) {
    const order = compareSemver(server.version, clientVersion);
    if (order === null) return failure('check-failed', withServer);
    return failure(order < 0 ? 'server-outdated' : 'client-outdated', withServer);
  }

  // Условие 2: клиент внутри диапазона сервера.
  if (!clientInServerRange(clientVersion, server)) {
    return failure('client-outdated', withServer);
  }

  const recommended = server.recommended_client_version ?? null;
  if (recommended !== null && isNewerRecommended(recommended, clientVersion, server)) {
    return {
      ...withServer,
      status: 'recommended-update',
      banner: 'recommended-update',
      blocking: false,
      reason: null,
      recommendedClientVersion: recommended,
    };
  }

  return {
    ...withServer,
    status: 'compatible',
    banner: 'hidden',
    blocking: false,
    reason: null,
  };
}

/**
 * `true`, когда переход статуса realtime-соединения означает ПЕРЕПОДКЛЮЧЕНИЕ
 * (связь была потеряна и восстановилась), а не первый коннект или результат
 * пробы живости. Только на таком переходе повторяется проверка совместимости
 * (требование 4d3be6ca: «при каждом подключении и переподключении»).
 */
export function isReconnectTransition(
  previous: RealtimeStatus | null,
  next: RealtimeStatus,
): boolean {
  if (next !== 'connected') return false;
  return previous === 'reconnecting' || previous === 'offline' || previous === 'suspect';
}

/**
 * Отказ подключения из-за несовместимости (connect-time). Рендерер различает
 * его по `details.kind`; сообщение техническое — пользовательскую формулировку
 * выбирает диалог/экран подключения (0afec967), а не этот текст.
 */
export interface CompatibilityRefusalDetails {
  kind: 'client-compatibility';
  result: CompatibilityResult;
}

/** `EtnError` отказа подключения: код каталога + машиночитаемый результат. */
export function compatibilityRefusal(result: CompatibilityResult): EtnError {
  return new EtnError('CLIENT_VERSION_UNSUPPORTED', refusalMessage(result), {
    kind: 'client-compatibility',
    result,
  } satisfies CompatibilityRefusalDetails);
}

/** Диапазон сервера в человекочитаемом виде: `client_compatibility` или `min_client`. */
function serverRangeOf(server: VersionResponse): string | null {
  if (server.client_compatibility.trim() !== '') return server.client_compatibility;
  if (server.min_client.trim() !== '') {
    // Устаревшая однобокая форма — показываем как диапазон «не ниже».
    return `>=${server.min_client}`;
  }
  return null;
}

/**
 * Второе условие: клиент входит в диапазон сервера.
 *
 * `client_compatibility` разбирается строгой грамматикой `>=X.Y.Z <X.Y.Z`
 * (`satisfiesRange`). Уже выпущенный сервер отдаёт однобокое `>=0.1.0` — тогда
 * действует `min_client` (требование 4d3be6ca: «если поля нет — в min_client»).
 * Ни один источник не разобрался — проверить нельзя (`false` → клиент
 * посчитается несовместимым; битый ответ отсекает `parseVersionResponse`).
 */
function clientInServerRange(clientVersion: string, server: VersionResponse): boolean {
  const serverRange = server.client_compatibility.trim();
  if (serverRange !== '' && parseRangeBounds(serverRange) !== null) {
    return satisfiesRange(clientVersion, serverRange);
  }
  // Однобокое `>=0.1.0` (сервер 0.14.1) или пустое поле — только `min_client`.
  const minClient = server.min_client.trim();
  if (minClient === '') return false;
  const order = compareSemver(clientVersion, minClient);
  return order !== null && order >= 0;
}

/**
 * Рекомендация показывается, только если она новее клиента И входит в диапазон
 * самого сервера: рекомендовать версию, которую сервер не примет, нельзя.
 */
function isNewerRecommended(
  recommended: string,
  clientVersion: string,
  server: VersionResponse,
): boolean {
  const order = compareSemver(recommended, clientVersion);
  if (order === null || order <= 0) return false;
  const serverRange = server.client_compatibility.trim();
  if (serverRange === '' || parseRangeBounds(serverRange) === null) return true;
  return satisfiesRange(recommended, serverRange);
}

/** Результат-отказ с заполненными общими полями. */
function failure(
  status: 'client-outdated' | 'server-outdated' | 'check-failed',
  common: Omit<CompatibilityResult, 'status' | 'banner' | 'blocking' | 'reason'>,
): CompatibilityResult {
  return {
    ...common,
    status,
    // Блокировка — диалог (8623b9ff), баннер при ней не показывается; у
    // `check-failed` баннер нейтральный `unknown` (ed068706).
    banner: status === 'check-failed' ? 'unknown' : 'hidden',
    blocking: status !== 'check-failed',
    reason: status,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Причина отказа `426` из `details.reason`; чужое/битое значение — `null`. */
function versionReasonOf(value: unknown): ClientVersionErrorReason | null {
  const known = Object.values(CLIENT_VERSION_ERROR_REASON) as string[];
  return typeof value === 'string' && known.includes(value)
    ? (value as ClientVersionErrorReason)
    : null;
}

/** Администратор ли пользователь по телу `GET /api/v1/me`; иначе `false`. */
function isAdminOf(me: unknown): boolean {
  if (typeof me !== 'object' || me === null) return false;
  return (me as { is_admin?: unknown }).is_admin === true;
}

function refusalMessage(result: CompatibilityResult): string {
  const client = `Клиент ${result.clientVersion}`;
  const server = result.serverVersion === null ? 'сервер неизвестной версии' : `сервер ${result.serverVersion}`;
  if (result.status === 'server-outdated') {
    const range = result.clientCompatibility ?? 'встроенный диапазон клиента';
    return `${server} старше клиента: ${client} поддерживает серверы ${range}. Обновите сервер.`;
  }
  if (result.status === 'client-outdated') {
    const range = result.serverCompatibility ?? 'диапазон сервера';
    const link = result.downloadUrl === null ? '' : ` Страница релиза: ${result.downloadUrl}`;
    return `${client} несовместим с сервером: сервер допускает клиенты ${range}.${link}`;
  }
  return `${client}: проверка совместимости не пройдена (${result.status}).`;
}

// ---------------------------------------------------------------------------
// Stateful-часть: вердикт и его раздача
// ---------------------------------------------------------------------------

/** Зависимости {@link CompatibilityGate}. */
export interface CompatibilityGateOptions {
  /** Версия этого клиента (`app.getVersion()`). */
  clientVersion: string;
  /** Публикация вердикта рендереру (`compatibility:status`); `null` — очистка. */
  publish(result: CompatibilityResult | null): void;
  /**
   * Немедленный разрыв текущего соединения при блокировке в середине сессии
   * (426) или на переподключении. Не очищает вердикт — это делает {@link CompatibilityGate.reset}.
   */
  teardown(): void;
  /** Журнал (необязателен; тесты не передают). */
  log?(
    level: 'info' | 'warn',
    message: string,
    data?: Record<string, string | number | boolean | null>,
  ): void;
}

/** Итог одной проверки: `ok: false` — работать нельзя. */
export type CompatibilityCheckOutcome =
  | { ok: true; result: CompatibilityResult }
  | { ok: false; result: CompatibilityResult; error?: unknown };

/**
 * Владелец текущего вердикта совместимости в main-процессе.
 *
 * Жизненный цикл:
 *  - {@link check} — перед первой авторизованной операцией (`GET /me`):
 *    запрашивает `/version`, считает вердикт, публикует его; при `check-failed`
 *    возвращает исходную ошибку запроса, чтобы подключение отказало с ЧЕСТНОЙ
 *    причиной (d2c80aa4), а не с «несовместимой версией»;
 *  - {@link recheck} — при переподключении: повторяет проверку; блокирующий
 *    вердикт немедленно разрывает соединение;
 *  - {@link onVersionRejected} — `426 CLIENT_VERSION_UNSUPPORTED` в середине
 *    сессии: teardown + блокирующий `client-outdated` без ожидания перезапуска;
 *  - {@link reset} — пользователь отключился: вердикта нет.
 *
 * Устаревшие ответы не публикуются: каждый запуск получает номер, а 426/reset
 * двигают номер вперёд — ответ, начатый до них, «не текущий».
 */
export class CompatibilityGate {
  private readonly clientVersion: string;
  private readonly publish: (result: CompatibilityResult | null) => void;
  private readonly teardown: () => void;
  private readonly log: CompatibilityGateOptions['log'];
  /** Текущий вердикт; `null` — проверка ещё не выполнялась/сброшена. */
  private current: CompatibilityResult | null = null;
  /** `GET /me` уже подтвердил роль в этой сессии (K3). */
  private roleConfirmed = false;
  /** Пользователь — администратор по последнему успешному `/me` (0afec967). */
  private isAdmin = false;
  /** Номер поколения проверок — отбрасывает устаревшие ответы. */
  private seq = 0;
  /** Идёт повторная проверка (single-flight: шторм реконнектов не плодит запросы). */
  private rechecking = false;

  public constructor(opts: CompatibilityGateOptions) {
    this.clientVersion = opts.clientVersion;
    this.publish = opts.publish;
    this.teardown = opts.teardown;
    this.log = opts.log;
  }

  /** Текущий вердикт (или `null` до первой проверки). */
  public getResult(): CompatibilityResult | null {
    return this.current;
  }

  /** `true` — вердикт блокирует работу (`client-outdated`/`server-outdated`). */
  public isBlocking(): boolean {
    return this.current?.blocking === true;
  }

  /**
   * Успешный `GET /me`: роль в этой сессии известна (K3). `me` — тело ответа
   * `/me`: из него берётся `is_admin` для кнопки «Обновить сервер»
   * (0afec967). Без аргумента роль подтверждается, администратор остаётся
   * прежним (совместимость с вызовами, где тело не нужно).
   */
  public markRoleConfirmed(me?: unknown): void {
    this.roleConfirmed = true;
    if (me !== undefined) this.isAdmin = isAdminOf(me);
    // Вердикт уже опубликован с неподтверждённой ролью — обновляем его, иначе
    // renderer не узнает роль и кнопка «Обновить сервер» не появится
    // (K3, требование 8623b9ff).
    if (
      this.current !== null &&
      (!this.current.roleConfirmed || this.current.is_admin !== this.isAdmin)
    ) {
      this.current = {
        ...this.current,
        roleConfirmed: true,
        is_admin: this.isAdmin,
      };
      this.publish(this.current);
    }
  }

  /**
   * Блокирующий вердикт НА ПОДКЛЮЧЕНИИ: ровно один диагностический `GET /me`,
   * чтобы подтвердить роль (K3, требование 8623b9ff). На старом сервере обычный
   * `GET /me` недоступен (подключение уже запрещено), и без этого вызова роль
   * не подтвердилась бы никогда → кнопка «Обновить сервер» не появилась бы.
   *
   * Из результата `/me` берётся ТОЛЬКО `is_admin` (0afec967) — иначе кнопка
   * «Обновить сервер» не появилась бы: профиль не активируется, других
   * авторизованных запросов нет. Ошибка `/me` оставляет роль неподтверждённой и
   * `is_admin: false` (нейтральный текст «Обратитесь к администратору
   * сервера»). Вне блокировки — no-op.
   */
  public async confirmRoleAfterBlocking(getMe: () => Promise<unknown>): Promise<void> {
    if (!this.isBlocking()) return;
    let me: unknown;
    try {
      me = await getMe();
    } catch {
      return;
    }
    this.markRoleConfirmed(me);
  }

  /** Сброс (пользователь отключился): вердикта нет, роль не подтверждена. */
  public reset(): void {
    this.seq += 1;
    this.current = null;
    this.roleConfirmed = false;
    this.isAdmin = false;
    this.publish(null);
  }

  /**
   * Проверка перед первой авторизованной операцией. Никогда не бросает:
   * недоступный/битый `/version` — это `check-failed` с исходной ошибкой в
   * `error` (вызывающий подключения пробрасывает её дальше).
   */
  public async check(
    fetchVersion: () => Promise<VersionResponse>,
  ): Promise<CompatibilityCheckOutcome> {
    // Новое подключение — роль ещё не подтверждена ЭТИМ сервером (K3): до
    // `GET /me` администратор неизвестен, диалог покажет нейтральный текст.
    this.roleConfirmed = false;
    this.isAdmin = false;
    return this.run(fetchVersion, false);
  }

  /**
   * Повторная проверка при переподключении (4d3be6ca). Блокирующий вердикт
   * разрывает соединение. Пропускается, если проверка уже идёт.
   */
  public async recheck(
    fetchVersion: () => Promise<VersionResponse>,
  ): Promise<CompatibilityCheckOutcome | null> {
    if (this.rechecking) return null;
    this.rechecking = true;
    try {
      return await this.run(fetchVersion, true);
    } finally {
      this.rechecking = false;
    }
  }

  /**
   * `426 CLIENT_VERSION_UNSUPPORTED` в середине сессии (DoD задачи): собрать
   * блокирующий вердикт из `details` сервера, немедленно разорвать соединение
   * и опубликовать состояние — без ожидания следующего запуска.
   */
  public onVersionRejected(details: ClientVersionErrorDetails | null): void {
    const previous = this.current;
    // Более поздний вердикт не должен быть перезаписан проверкой в полёте.
    this.seq += 1;
    const result: CompatibilityResult = {
      status: 'client-outdated',
      banner: 'hidden',
      blocking: true,
      reason: 'client-outdated',
      clientVersion: this.clientVersion,
      clientCompatibility: compatibilityRangeFor(this.clientVersion),
      serverVersion: details?.server_version ?? previous?.serverVersion ?? null,
      serverCompatibility: details?.compatibility ?? previous?.serverCompatibility ?? null,
      recommendedClientVersion: previous?.recommendedClientVersion ?? null,
      downloadUrl: details?.download_url ?? previous?.downloadUrl ?? null,
      roleConfirmed: this.roleConfirmed,
      is_admin: this.isAdmin,
      // Причина отказа от сервера (`details.reason`): диалог и текст отказа
      // подключения выбирают по ней формулировку (0afec967).
      serverReason: versionReasonOf(details?.reason),
    };
    this.current = result;
    this.log?.('warn', 'client version rejected mid-session', {
      client: result.clientVersion,
      server: result.serverVersion ?? '',
      compatibility: result.serverCompatibility ?? '',
    });
    try {
      this.teardown();
    } catch {
      // Разрыв — best effort: вердикт уже блокирующий, запросы данных уйдут
      // в никуда только если teardown не сработал; повторно не пытаемся.
    }
    this.publish(result);
  }

  /** Один прогон проверки. `staleness` отсекает ответы, обогнанные 426/reset. */
  private async run(
    fetchVersion: () => Promise<VersionResponse>,
    fromReconnect: boolean,
  ): Promise<CompatibilityCheckOutcome> {
    const seq = ++this.seq;
    let result: CompatibilityResult;
    let error: unknown;
    try {
      const response = await fetchVersion();
      result = checkCompatibility({
        clientVersion: this.clientVersion,
        response,
        roleConfirmed: this.roleConfirmed,
        isAdmin: this.isAdmin,
      });
    } catch (err) {
      error = err;
      result = checkCompatibility({
        clientVersion: this.clientVersion,
        // Битый/недоступный ответ: `check-failed`, а не «совместимо» (DoD).
        response: null,
        roleConfirmed: this.roleConfirmed,
        isAdmin: this.isAdmin,
      });
    }

    if (seq !== this.seq) {
      // Ответ устарел: его обогнал 426/reset/следующая проверка. Ничего не
      // публикуем и не разрываем — решение уже принято более поздним событием.
      return { ok: false, result: this.current ?? result, error };
    }

    this.current = result;
    this.log?.(
      'info',
      'compatibility checked',
      {
        status: result.status,
        client: result.clientVersion,
        server: result.serverVersion ?? '',
      },
    );
    this.publish(result);

    const ok = result.status === 'compatible' || result.status === 'recommended-update';
    if (!ok && fromReconnect && result.blocking) {
      try {
        this.teardown();
      } catch {
        // best effort — см. onVersionRejected
      }
    }
    return ok ? { ok: true, result } : { ok: false, result, ...(error === undefined ? {} : { error }) };
  }
}

/**
 * Проверка совместимости на подключении (12fd5b0e) — единственный вход для
 * `connectProfile`:
 *
 *  1. `GET /version` через gate; совместимо — возвращаемся, а обычный `GET /me`
 *     делает вызывающий (`connectAndActivate`), и только он активирует профиль;
 *  2. `check-failed` — пробрасывается ИСХОДНАЯ ошибка `/version` (сценарий
 *     d2c80aa4): подключение отказывает с честной причиной, а не «несовместимая
 *     версия»;
 *  3. блокирующий вердикт — ровно один диагностический `GET /me` только для
 *     подтверждения роли (K3, требование 8623b9ff) и отказ
 *     `CLIENT_VERSION_UNSUPPORTED` с уже обновлённым вердиктом.
 *
 * Ни при каком исходе эта функция не активирует профиль и не запрашивает
 * данные: авторизованных запросов не больше одного (диагностический `/me`).
 */
export async function verifyCompatibilityOnConnect(
  gate: CompatibilityGate,
  deps: {
    /** Публичный `GET /api/v1/version`. */
    getVersion(): Promise<VersionResponse>;
    /** `GET /api/v1/me` — только подтверждение роли; результат отбрасывается. */
    getMe(): Promise<unknown>;
  },
): Promise<void> {
  const outcome = await gate.check(() => deps.getVersion());
  if (outcome.ok) return;
  if (outcome.error !== undefined) throw outcome.error;
  await gate.confirmRoleAfterBlocking(() => deps.getMe());
  throw compatibilityRefusal(gate.getResult() ?? outcome.result);
}
