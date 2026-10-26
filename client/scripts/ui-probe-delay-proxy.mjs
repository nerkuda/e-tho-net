/**
 * Замедляющий HTTP/WS-прокси стенда `ui-probe-stand` — детерминированная
 * проверка гонки «поздний ответ `openNetwork`» (ошибка 58c55bb9, круг 2).
 *
 * Прокси стоит между скрытым клиентом и сервером стенда и задерживает ТОЛЬКО
 * запросы, в пути которых есть `/<networkId>/` (медленная сеть). Остальные
 * проходят сразу, поэтому вторая сеть открывается быстрее первой и может
 * «перекрыть» её запуск. WebSocket-апгрейды не задерживаются: задержка нужна
 * HTTP-ответам открытия сети, а не realtime-каналу.
 *
 * Запуск — из `ui-probe-stand` (`--delay-seed-ms`), отдельного процесса не
 * требуется. Чистая функция {@link needsDelay} покрыта юнит-тестом.
 */
import http from 'node:http';
import net from 'node:net';

/**
 * Задерживать ли запрос: путь содержит сегмент `/<networkId>/` или ЗАКАНЧИВАЕТСЯ
 * этим сегментом (`/networks/<id>` — само открытие сети, `/networks/<id>?…`).
 * `networkId` пустой/не задан — не задерживать ничего. `pathFilter` сужает
 * задержку до запросов, чей путь содержит подстроку (например,
 * `/thoughts/resolve`): так окно гонки создаётся в конкретном ожидании рендера,
 * а не во всей цепочке открытия сети.
 */
export function needsDelay(url, networkId, pathFilter = '') {
  if (typeof url !== 'string' || url === '') return false;
  if (typeof networkId !== 'string' || networkId === '') return false;
  if (typeof pathFilter === 'string' && pathFilter !== '' && !url.includes(pathFilter)) return false;
  const marker = `/${networkId}`;
  const at = url.indexOf(marker);
  if (at < 0) return false;
  const next = url.charAt(at + marker.length);
  // Сегмент целиком: конец пути, `/` или начало query. Похожий префикс id
  // (`<id>x`) своей сетью не считается.
  return next === '' || next === '/' || next === '?';
}

/**
 * Поднять прокси на свободном порту 127.0.0.1.
 *
 * @param {{targetPort:number, networkId:string, delayMs?:number, pathFilter?:string, log?:(line:string)=>void}} opts
 * @returns {Promise<{port:number, close:()=>Promise<void>}>}
 */
export async function startDelayProxy({
  targetPort,
  networkId,
  delayMs = 3000,
  pathFilter = '',
  log = () => undefined,
}) {
  const forwardHttp = (req, res) => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: Number(targetPort),
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`delay-proxy upstream error: ${err.message}`);
    });
    req.pipe(upstream);
  };

  const server = http.createServer((req, res) => {
    if (needsDelay(req.url, networkId, pathFilter)) {
      log(`delay ${delayMs}ms ${req.method} ${req.url}`);
      setTimeout(() => forwardHttp(req, res), delayMs);
      return;
    }
    forwardHttp(req, res);
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
  log(`listening ${port} -> ${targetPort}, delay ${delayMs}ms for /${networkId}/${
    pathFilter === '' ? '' : ` (path ${pathFilter})`
  }`);
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // Не ждать keep-alive соединений скрытого клиента: стенд гасит его
        // перед закрытием прокси, но сокеты могут ещё висеть.
        server.closeAllConnections?.();
      }),
  };
}
