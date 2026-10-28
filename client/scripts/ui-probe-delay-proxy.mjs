/**
 * Прокси стенда `ui-probe-stand`: задержка ответов (гонки «поздний ответ»,
 * ошибки 58c55bb9/6d78ccab) и подмена статуса на отказе (ошибка b213cf60).
 *
 * Прокси стоит между скрытым клиентом и сервером стенда и задерживает ТОЛЬКО
 * запросы, в пути которых есть `/<networkId>/` (медленная сеть). Остальные
 * проходят сразу, поэтому вторая сеть открывается быстрее первой и может
 * «перекрыть» её запуск. WebSocket-апгрейды не задерживаются: задержка нужна
 * HTTP-ответам открытия сети, а не realtime-каналу.
 *
 * Режим `failPath` — «форвард + подмена статуса»: запрос ВСЁ РАВНО уходит на
 * сервер (read-only операция, и serverLog стенда видит, сколько запросов
 * реально дошло), а клиенту возвращается заданный статус (по умолчанию 404).
 * Так проверяется поведение интерфейса на отказе сервера и одновременно
 * работает счётчик `atMost` в правилах серверного лога.
 *
 * Два независимых вида задержки:
 * - `rules` — задерживается ОТПРАВКА запроса (сервер прочитает данные только
 *   после паузы). Этим моделируется медленная сеть и гонка «поздний ответ
 *   openNetwork»;
 * - `responseRules` — запрос уходит сразу, а ОТВЕТ придерживается. Только так
 *   воспроизводится «ответ вычислен до правки, а доставлен после»: клиент,
 *   склеивший такой GET с более поздним чтением (`rest-client.ts`, дедуп
 *   in-flight GET), получает снимок ДО правки (задача ddcb8e84, H-C).
 *
 * Запуск — из `ui-probe-stand` (`--delay-seed-ms` / `--delay-seed-response-rule`
 * / `--fail-seed-path`), отдельного процесса не требуется. Чистая функция
 * {@link needsDelay} покрыта юнит-тестом.
 */
import http from 'node:http';
import net from 'node:net';

/**
 * Относится ли URL к запросам засеянной сети: путь содержит сегмент
 * `/<networkId>/` или ЗАКАНЧИВАЕТСЯ этим сегментом (`/networks/<id>` — само
 * открытие сети, `/networks/<id>?…`). Похожий префикс id (`<id>x`) своей сетью
 * не считается.
 */
function isSeedNetworkUrl(url, networkId) {
  if (typeof url !== 'string' || url === '') return false;
  if (typeof networkId !== 'string' || networkId === '') return false;
  const marker = `/${networkId}`;
  const at = url.indexOf(marker);
  if (at < 0) return false;
  const next = url.charAt(at + marker.length);
  return next === '' || next === '/' || next === '?';
}

/**
 * Задерживать ли запрос: путь принадлежит засеянной сети, а `pathFilter`
 * (если задан) — подстрока пути (например, `/thoughts/resolve`): так окно
 * гонки создаётся в конкретном ожидании рендера, а не во всей цепочке
 * открытия сети.
 */
export function needsDelay(url, networkId, pathFilter = '') {
  if (!isSeedNetworkUrl(url, networkId)) return false;
  return typeof pathFilter !== 'string' || pathFilter === '' || url.includes(pathFilter);
}

/**
 * Индекс первого подходящего правила (первое совпадение выигрывает) или -1.
 * Отдельно от {@link delayForUrl}, чтобы сервер прокси вёл счётчик по правилу.
 */
export function matchDelayRule(url, networkId, rules) {
  if (!isSeedNetworkUrl(url, networkId)) return -1;
  const list = Array.isArray(rules) ? rules : [];
  return list.findIndex((rule) => {
    const filter = typeof rule.pathFilter === 'string' ? rule.pathFilter : '';
    return filter === '' || url.includes(filter);
  });
}

/**
 * Задержка по списку правил (первое совпавшее выигрывает): нужна сценариям,
 * где ответ B обязан прийти РАНЬШЕ ответа A (разные задержки разных путей,
 * замечание верификатора круга 2 к ошибке 6d78ccab). Возвращает миллисекунды
 * или `null`, если ни одно правило не совпало.
 */
export function delayForUrl(url, networkId, rules) {
  const index = matchDelayRule(url, networkId, rules);
  if (index < 0) return null;
  const delay = rules[index]?.delayMs;
  return typeof delay === 'number' ? delay : null;
}

/**
 * Поднять прокси на свободном порту 127.0.0.1.
 *
 * `rules` — список правил `{delayMs, pathFilter}` (первое совпадение); без них
 * действует прежняя пара `delayMs`/`pathFilter`. Счётчик задержек ведётся и
 * по каждому правилу: стенд проверяет, что фильтр с опечаткой не сделал гейт
 * вакуумным.
 *
 * `failPath` — путь (подстрока URL засеянной сети) для режима «форвард +
 * подмена статуса»: запрос уходит на сервер, клиенту возвращается
 * `failStatus`. Счётчик подмен — `failedCount()`; ноль при заданном
 * `failPath` означает вакуумный гейт.
 *
 * `responseRules` — задержка ОТВЕТА (первое совпадение): запрос уходит сразу,
 * сервер читает данные в момент запроса, а клиент получает ответ позже. Так
 * проверяется дедупликация in-flight GET: чтение, вычисленное до правки, не
 * должно переиспользоваться после неё (задача ddcb8e84). Счётчики —
 * `delayedResponseCount()` / `delayedResponseByRule()`.
 *
 * @param {{targetPort:number, networkId:string, delayMs?:number, pathFilter?:string,
 *          rules?:Array<{delayMs:number, pathFilter?:string}>,
 *          responseRules?:Array<{delayMs:number, pathFilter?:string}>,
 *          failPath?:string, failStatus?:number, log?:(line:string)=>void}} opts
 * @returns {Promise<{port:number, delayedCount:()=>number, delayedByRule:()=>number[],
 *                    delayedResponseCount:()=>number, delayedResponseByRule:()=>number[],
 *                    failedCount:()=>number, close:()=>Promise<void>}>}
 */
export async function startDelayProxy({
  targetPort,
  networkId,
  delayMs = 3000,
  pathFilter = '',
  rules = [],
  responseRules = [],
  failPath = '',
  failStatus = 404,
  log = () => undefined,
}) {
  const effectiveRules =
    Array.isArray(rules) && rules.length > 0
      ? rules
      : delayMs > 0
        ? [{ delayMs, pathFilter }]
        : [];
  /** Сколько запросов реально задержано — стенд проверяет, что path-фильтр
   *  не сделал гейт вакуумным (опечатка в пути молча отключает задержку). */
  let delayed = 0;
  /** По правилу: правило, не совпавшее ни разу, — ошибка стенда. */
  const delayedPerRule = effectiveRules.map(() => 0);
  /** Задержка ОТВЕТА: запрос уходит сразу, ответ придерживается. */
  const effectiveResponseRules = Array.isArray(responseRules) ? responseRules : [];
  let delayedResponses = 0;
  const delayedResponsesPerRule = effectiveResponseRules.map(() => 0);
  /** Сколько запросов получило подменённый статус (режим failPath). */
  let failed = 0;
  const sendInjected = (res, status) => {
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(
      JSON.stringify({
        error: { code: 'PROBE_INJECTED', message: `ui-probe-stand: injected HTTP ${status}` },
      }),
    );
  };
  /**
   * `injectStatus === null` — обычный форвард. Иначе запрос всё равно уходит
   * на сервер (серверный лог видит его, read-only путь не мутирует данные), но
   * клиент получает подменённый статус вместо ответа сервера.
   *
   * `responseDelayMs > 0` — ответ сервера придерживается: запрос уже прочитан
   * сервером (снимок данных — на момент запроса), но клиент получает его
   * позже. Так воспроизводится переиспользование устаревшего in-flight GET.
   */
  const forwardHttp = (req, res, injectStatus = null, responseDelayMs = 0) => {
    let settled = false;
    const finishInjected = () => {
      if (settled) return;
      settled = true;
      sendInjected(res, injectStatus);
    };
    const afterResponseDelay = (send) => {
      if (responseDelayMs > 0) setTimeout(send, responseDelayMs);
      else send();
    };
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: Number(targetPort),
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (upRes) => {
        if (injectStatus !== null) {
          // Дренаж тела: сервер должен завершить запись/лог, соединение —
          // закрыться штатно, а не висеть keep-alive.
          upRes.resume();
          upRes.on('end', () => afterResponseDelay(finishInjected));
          upRes.on('error', () => afterResponseDelay(finishInjected));
          return;
        }
        afterResponseDelay(() => {
          // Клиент мог уйти за время паузы — писать в закрытый ответ нельзя.
          if (res.writableEnded || res.destroyed) {
            upRes.resume();
            return;
          }
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        });
      },
    );
    upstream.on('error', (err) => {
      if (injectStatus !== null) {
        finishInjected();
        return;
      }
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`delay-proxy upstream error: ${err.message}`);
    });
    req.pipe(upstream);
  };

  const server = http.createServer((req, res) => {
    const injectStatus =
      failPath !== '' && needsDelay(req.url, networkId, failPath) ? failStatus : null;
    if (injectStatus !== null) {
      failed += 1;
      log(`inject ${injectStatus} ${req.method} ${req.url}`);
    }
    const responseIndex = matchDelayRule(req.url, networkId, effectiveResponseRules);
    let responseDelayMs = 0;
    if (responseIndex >= 0) {
      responseDelayMs = effectiveResponseRules[responseIndex]?.delayMs ?? 0;
      delayedResponses += 1;
      delayedResponsesPerRule[responseIndex] =
        (delayedResponsesPerRule[responseIndex] ?? 0) + 1;
      log(`delay-response ${responseDelayMs}ms ${req.method} ${req.url}`);
    }
    const hitIndex = matchDelayRule(req.url, networkId, effectiveRules);
    if (hitIndex >= 0) {
      const hitDelay = effectiveRules[hitIndex]?.delayMs ?? delayMs;
      delayed += 1;
      delayedPerRule[hitIndex] = (delayedPerRule[hitIndex] ?? 0) + 1;
      log(`delay ${hitDelay}ms ${req.method} ${req.url}`);
      setTimeout(() => forwardHttp(req, res, injectStatus, responseDelayMs), hitDelay);
      return;
    }
    forwardHttp(req, res, injectStatus, responseDelayMs);
  });

  // WebSocket и прочие upgrade — без задержки: realtime-канал не относится к
  // проверяемой гонке открытия сети.
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(Number(targetPort), '127.0.0.1', () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n` +
          Object.entries(req.headers)
            .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
            .join('\r\n') +
          '\r\n\r\n',
      );
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const describeRule = (rule, i) =>
    `#${i} ${rule.delayMs}ms${typeof rule.pathFilter === 'string' && rule.pathFilter !== '' ? ` (path ${rule.pathFilter})` : ''}`;
  log(
    `listening ${port} -> ${targetPort}, ${effectiveRules.length} request rule(s) for /${networkId}/: ` +
      effectiveRules.map(describeRule).join(', ') +
      (effectiveResponseRules.length > 0
        ? `; ${effectiveResponseRules.length} response rule(s): ` +
          effectiveResponseRules.map(describeRule).join(', ')
        : '') +
      (failPath === '' ? '' : `; inject ${failStatus} on path ${failPath}`),
  );
  return {
    port,
    /** Сколько запросов прокси реально задержал (0 — фильтр не совпал). */
    delayedCount: () => delayed,
    /** Счётчики по правилам: не совпавшее ни разу правило — вакуумный гейт. */
    delayedByRule: () => [...delayedPerRule],
    /** Сколько ОТВЕТОВ придержано (0 — фильтр не совпал). */
    delayedResponseCount: () => delayedResponses,
    /** Счётчики по правилам задержки ответа. */
    delayedResponseByRule: () => [...delayedResponsesPerRule],
    /** Сколько запросов получило подменённый статус (0 — failPath не совпал). */
    failedCount: () => failed,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // Не ждать keep-alive соединений скрытого клиента: стенд гасит его
        // перед закрытием прокси, но сокеты могут ещё висеть.
        server.closeAllConnections?.();
      }),
  };
}
