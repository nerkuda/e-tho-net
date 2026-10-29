/**
 * Серверная проверка версии desktop-клиента на изменяющих запросах (задача
 * c3f33e6a, требование 271e3327, ADR 6ded6a87).
 *
 * Клиентская проверка диапазона защищает от старого сервера, но не защищает
 * данные от уже выпущенного старого клиента, который до сервера всё-таки дошёл.
 * Поэтому после успешной аутентификации и ДО обработчика изменяющего запроса
 * (`POST`/`PUT`/`PATCH`/`DELETE`) сервер проверяет заголовок `Client-Version`:
 *
 *  - `Client-Id` отсутствует → запрос считается API-интеграцией/скриптом и
 *    пропускается (осознанное исключение ADR — автоматизацию не ломаем);
 *  - `Client-Version` нет (или он пуст) → `version-missing`;
 *  - заголовок не парсится как версия → `version-invalid`;
 *  - версия вне `client_compatibility` → `version-out-of-range` с версиями,
 *    диапазоном и ссылкой на скачивание.
 *
 * Границы (ADR, «Запрещено»): чтение (`GET`/`HEAD`/`OPTIONS`) не блокируется;
 * читающие `POST`-эндпоинты (allowlist {@link READ_ONLY_POST_ROUTES}) тоже —
 * старый desktop-клиент обязан продолжать читать данные, иначе обещание ADR
 * «старые клиенты читают, но не изменяют» не выполняется: клиент читает мысли
 * и хронику именно через `POST …/thoughts/query` и `POST …/chronicle/query`.
 * MCP (`/mcp`) идёт своим транспортом и эту проверку не проходит; молча
 * пропускать запрос с `Client-Id` без версии нельзя; второго диапазона здесь
 * нет — только `client_compatibility` из `/version`. Во время обслуживания
 * сервера `503 SERVER_UPDATING` приоритетнее: maintenance-проверка ставится
 * `onRequest`-хуком и выполняется раньше этого guard'а (preHandler).
 *
 * Модуль чистый: не пишет в БД, не логирует ключи и не формирует HTTP-ответ —
 * возвращает решение, а канонический конверт отправляет `authPreHandler`.
 */

import type { FastifyRequest } from 'fastify';

import {
  CLIENT_VERSION_ERROR_REASON,
  parseSemver,
  satisfiesRange,
  type ClientVersionErrorDetails,
  type ClientVersionErrorReason,
} from '@etn/shared';

import { CLIENT_ID_HEADER, CLIENT_VERSION_HEADER } from '../http/context.js';
import type { ClientChannel } from '../version.js';

/** HTTP-методы, на которых проверяется версия desktop-клиента. */
const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Читающие `POST`-эндпоинты (allowlist): версия клиента на них НЕ проверяется.
 *
 * `POST` — не признак изменения: клиент читает мысли, хронику, рёбра, отборы и
 * упоминания именно `POST`-запросами (`POST /thoughts/query`,
 * `POST /chronicle/query` и т.д.). Блокировать их значит нарушить обещание ADR
 * 6ded6a87 «старые desktop-клиенты читают данные, но не могут изменять» —
 * несовместимый клиент не увидел бы даже список мыслей.
 *
 * Список закрытый и явный: новый `POST`-маршрут по умолчанию проверяется,
 * пока его не внесут сюда осознанно — вместе с тестом, доказывающим, что он
 * ничего не меняет. Каждая запись — зарегистрированный шаблон Fastify
 * (`request.routeOptions.url`) с префиксом `/api/v1` и именами параметров
 * (`:networkId`); сравнение — по нормализованному пути без query string,
 * фрагмента и завершающего слеша (см. {@link requestPath}), причём параметр
 * маршрута (`:key`) совпадает с любым непустым сегментом пути: сырой `url`
 * содержит конкретные id, а шаблон — их имена.
 *
 * В список НЕ входят `POST`-маршруты с побочными эффектами, даже если они не
 * меняют знания: `…/export` и `…/publications/…/export` создают задачу
 * экспорта, `…/import/preview` — чистый разбор, но `…/import/commit` меняет
 * данные, `…/activity/rollup` удаляет детальные строки журнала.
 */
export const READ_ONLY_POST_ROUTES: readonly string[] = [
  // «Структуры»: страница мыслей, рёбра между ними, резолв id.
  '/api/v1/networks/:networkId/thoughts/query',
  '/api/v1/networks/:networkId/thoughts/edges',
  '/api/v1/networks/:networkId/thoughts/resolve',
  // Проверка блокировок удаления (ничего не удаляет и не помечает).
  '/api/v1/networks/:networkId/thoughts/deletion-check-batch',
  '/api/v1/networks/:networkId/links/deletion-check-batch',
  // Хроника.
  '/api/v1/networks/:networkId/chronicle/query',
  // Исполнение сохранённого/adhoc-отбора относительно мысли-контекста.
  '/api/v1/networks/:networkId/thoughts/:thoughtId/views/:view/run',
  '/api/v1/networks/:networkId/thoughts/:thoughtId/views/run',
  // Разбор архива без записи в сеть.
  '/api/v1/networks/:networkId/import/preview',
  // Явный резолв кросс-сетевых значений (требование c104a0fc: без write-бюджета
  // и audit-записи как содержательной правки) — для обоих видов владельца.
  '/api/v1/networks/:networkId/thoughts/:id/properties/:key/cross-resolve',
  '/api/v1/networks/:networkId/links/:id/properties/:key/cross-resolve',
  // Поиск упоминаний в присланных текстах (редактор).
  '/api/v1/networks/:networkId/mentions/scan',
];

/** Шаблоны allowlist, скомпилированные в регулярные выражения один раз. */
const READ_ONLY_POST_MATCHERS: readonly RegExp[] = READ_ONLY_POST_ROUTES.map(routeMatcher);

/** Регулярка шаблона Fastify: `:param` — непустой сегмент, остальное буквально. */
function routeMatcher(route: string): RegExp {
  const source = route
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : escapeRegExp(segment)))
    .join('/');
  return new RegExp(`^${source}$`);
}

/** Экранирование литерального сегмента пути для регулярного выражения. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Отказ guard'а: машиночитаемая причина и полное тело `details`. */
export interface ClientVersionRejection {
  reason: ClientVersionErrorReason;
  details: ClientVersionErrorDetails;
}

/**
 * Запрос-двойник guard'а: только то, что guard читает — метод, заголовки и путь
 * (шаблон зарегистрированного маршрута из `routeOptions.url`; `url` — сырой
 * адрес с query string, запасной источник). Юнит-тесты не поднимают Fastify.
 */
export type ClientVersionGuardRequest = Pick<FastifyRequest, 'method' | 'headers' | 'url'> & {
  readonly routeOptions?: Pick<FastifyRequest['routeOptions'], 'url'> | undefined;
};

/**
 * Проверка одного запроса. `null` — запрос допустим; иначе — отказ `426
 * CLIENT_VERSION_UNSUPPORTED`.
 */
export type ClientVersionGuardFn = (
  req: ClientVersionGuardRequest,
) => ClientVersionRejection | null;

/** Зависимости guard'а. */
export interface ClientVersionGuardOptions {
  /**
   * Эффективный канал обновления клиента — тот же объект, из которого собран
   * `GET /version` (диапазон и ссылка на скачивание). Второго диапазона в
   * проекте быть не должно.
   */
  clientChannel: Pick<ClientChannel, 'client_compatibility' | 'client_download_url'>;
  /** Версия этого сервера — попадает в `details.server_version`. */
  serverVersion: string;
}

/**
 * Создаёт guard версии клиента. Вызывается из `authPreHandler` после успешной
 * аутентификации (см. `auth-middleware.ts`).
 */
export function createClientVersionGuard(options: ClientVersionGuardOptions): ClientVersionGuardFn {
  const { clientChannel, serverVersion } = options;
  const compatibility = clientChannel.client_compatibility;

  return (req) => {
    if (!MUTATING_METHODS.has(req.method)) {
      return null;
    }
    // Читающий POST: версия не блокирует (см. READ_ONLY_POST_ROUTES). На
    // остальные методы allowlist не распространяется — `DELETE` по тому же
    // пути остаётся изменяющим запросом и проверяется.
    if (req.method === 'POST' && isReadOnlyPostRoute(requestPath(req))) {
      return null;
    }
    // API-интеграция/скрипт: без `Client-Id` версия desktop-клиента не нужна.
    if (readHeader(req.headers, CLIENT_ID_HEADER) === null) {
      return null;
    }

    const rawVersion = readHeader(req.headers, CLIENT_VERSION_HEADER);
    if (rawVersion === null) {
      return { reason: CLIENT_VERSION_ERROR_REASON.missing, details: { reason: CLIENT_VERSION_ERROR_REASON.missing } };
    }
    if (parseSemver(rawVersion) === null) {
      return {
        reason: CLIENT_VERSION_ERROR_REASON.invalid,
        details: {
          reason: CLIENT_VERSION_ERROR_REASON.invalid,
          client_version: rawVersion,
        },
      };
    }
    if (satisfiesRange(rawVersion, compatibility)) {
      return null;
    }
    return {
      reason: CLIENT_VERSION_ERROR_REASON.outOfRange,
      details: {
        reason: CLIENT_VERSION_ERROR_REASON.outOfRange,
        server_version: serverVersion,
        client_version: rawVersion,
        compatibility,
        download_url: clientChannel.client_download_url,
      },
    };
  };
}

/**
 * Человекочитаемое сообщение отказа (оно же уходит в `error.message`).
 *
 * Клиент НЕ разбирает этот текст: пользовательскую формулировку он выбирает по
 * `error.code`/`details.reason`. Сообщение адресовано API-интеграциям и логам.
 */
export function describeClientVersionRejection(rejection: ClientVersionRejection): string {
  const { details } = rejection;
  switch (rejection.reason) {
    case CLIENT_VERSION_ERROR_REASON.missing:
      return 'Изменяющий запрос desktop-клиента без заголовка Client-Version отклонён. Обновите клиент.';
    case CLIENT_VERSION_ERROR_REASON.invalid:
      return `Заголовок Client-Version ${JSON.stringify(details.client_version ?? '')} не является корректной версией. Обновите клиент.`;
    case CLIENT_VERSION_ERROR_REASON.outOfRange:
      return (
        `Версия клиента ${JSON.stringify(details.client_version ?? '')} не поддерживается сервером ` +
        `(совместимые версии: ${JSON.stringify(details.compatibility ?? '')}). Обновите клиент.`
      );
  }
}

/**
 * Путь запроса для сверки с allowlist.
 *
 * Приоритет — шаблон зарегистрированного маршрута (`routeOptions.url`): он уже
 * без query string и с именами параметров (`:networkId`), поэтому сверка не
 * зависит от конкретных id в адресе. Для запроса вне маршрута (теоретический
 * 404 до guard'а) берётся сырой `url`; и он, и шаблон нормализуются одинаково —
 * без query string, фрагмента и завершающего слеша.
 */
function requestPath(req: ClientVersionGuardRequest): string {
  const routeUrl = req.routeOptions?.url;
  const raw = typeof routeUrl === 'string' && routeUrl.length > 0 ? routeUrl : req.url;
  return normalizePath(raw);
}

/** Путь без query string, фрагмента и завершающего слеша (`/x/` → `/x`). */
function normalizePath(raw: string | undefined): string {
  if (typeof raw !== 'string') {
    return '';
  }
  const cut = raw.search(/[?#]/);
  const path = cut === -1 ? raw : raw.slice(0, cut);
  // Корень (`/`) сохраняем как есть: `''` не должен совпасть ни с чем.
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** True для читающего `POST`-маршрута из allowlist. */
function isReadOnlyPostRoute(path: string): boolean {
  return path.length > 0 && READ_ONLY_POST_MATCHERS.some((matcher) => matcher.test(path));
}

/**
 * Первое непустое значение заголовка.
 *
 * Повторённый заголовок Fastify отдаёт массивом — берём первое значение, как и
 * для `Client-Id`. Пустая строка равнозначна отсутствию заголовка: иначе
 * `Client-Version:` с пустым значением проскочил бы как `version-invalid` и
 * смешал две разные причины отказа.
 */
function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
