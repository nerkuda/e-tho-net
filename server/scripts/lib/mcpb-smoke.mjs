/**
 * MCP-рукопожатие smoke-теста MCPB-бандла с диагностикой смерти сервера
 * (ошибка 06f03d71).
 *
 * `StdioClientTransport` MCP SDK пайпит stderr потомка в `PassThrough`, который
 * никто не читает, а код выхода/сигнал в `onclose` не передаёт. Из-за этого
 * умирающий сервер оставляет в логе сборки только «MCP error -32000: Connection
 * closed» — ни причины, ни последних строк stderr. Здесь stderr идёт в лог
 * сборки по мере поступления (прозрачно, не только в отладке), а при отказе в
 * лог попадают код выхода/сигнал и хвост stderr.
 *
 * Модуль ничего не решает про содержимое бандла: `run(client)` — шаг
 * вызывающего скрипта (`build-mcpb.mjs` проверяет `tools/list` и `etn.guide`).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Сколько последних символов stderr печатать при смерти сервера. */
export const STDERR_TAIL_LIMIT = 8192;

/** Префикс строк stderr сервера в логе сборки. */
export const STDERR_LINE_PREFIX = '  [server] ';

/**
 * Транспорт с наблюдаемым потомком.
 *
 * SDK хранит процесс в поле `_process` и в `onclose` код выхода отбрасывает
 * (`this._process.on('close', _code => …)`), поэтому подписываемся на `exit`
 * сразу после старта: события `spawn` → `exit` идут в этом порядке, и
 * обработчик успевает встать до смерти сервера.
 */
export class ObservedStdioTransport extends StdioClientTransport {
  /** Код выхода и сигнал потомка; `null`, пока сервер жив (или не стартовал). */
  exit = null;

  async start() {
    const started = await super.start();
    this._process?.once('exit', (code, signal) => {
      this.exit = { code, signal };
    });
    return started;
  }
}

/**
 * Прозрачный вывод stderr сервера: строки уходят в `out` по мере поступления,
 * хвост хранится для отчёта о смерти.
 *
 * @param {object} transport - транспорт с потоком `stderr` (или `null`).
 * @param {{ write(chunk: string): unknown }} [out] - куда печатать (по умолчанию stderr).
 * @returns {{ tail(): string }} доступ к последним строкам.
 */
export function tapStderr(transport, out = process.stderr) {
  const stream = transport.stderr;
  let tail = '';
  if (stream === null || stream === undefined) return { tail: () => tail };
  let pending = '';
  stream.on('data', (chunk) => {
    const text = String(chunk);
    tail = (tail + text).slice(-STDERR_TAIL_LIMIT);
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) out.write(`${STDERR_LINE_PREFIX}${line}\n`);
  });
  return { tail: () => tail };
}

/**
 * Транспорт бандла: `node <entryPoint>` с чистым окружением, stderr в трубу,
 * потомок наблюдаем.
 *
 * @param {{ entryPoint: string, env: Record<string, string>, out?: { write(chunk: string): unknown } }} input
 * @returns {{ transport: ObservedStdioTransport, exit(): { code: number|null, signal: string|null }|null, stderrTail(): string }}
 */
export function createBundleTransport({ entryPoint, env, out = process.stderr }) {
  const transport = new ObservedStdioTransport({
    command: process.execPath,
    args: [entryPoint],
    env: { ...env },
    stderr: 'pipe',
  });
  const tap = tapStderr(transport, out);
  return { transport, exit: () => transport.exit, stderrTail: tap.tail };
}

/** Текст ошибки для отчёта. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Отчёт о смерти сервера: код выхода/сигнал и хвост stderr.
 *
 * Пустой stderr при коде 0 — особый случай: процесс вышел штатно, ничего не
 * сделав. Так выглядит нераспознанная точка входа (симлинк в пути), и без
 * подсказки такой лог читается как «сервер умер молча».
 *
 * @param {{ label: string, error: unknown, exit: object|null, stderrTail: string }} input
 * @returns {string} готовый блок для лога сборки.
 */
export function formatBundleFailure({ label, error, exit, stderrTail }) {
  const lines = [`  диагностика сервера (${label}): ${errorText(error)}`];
  if (exit === null || exit === undefined) {
    lines.push('    потомок: код выхода не получен (процесс жив или не стартовал)');
  } else {
    lines.push(`    потомок: exit code=${exit.code ?? 'null'} signal=${exit.signal ?? 'null'}`);
  }
  const tail = (stderrTail ?? '').trimEnd();
  if (tail === '') {
    lines.push('    stderr: пусто — сервер ничего не напечатал');
    if (exit?.code === 0) {
      lines.push(
        '    подсказка: код 0 и пустой stderr — точка входа не распознала себя ' +
          '(симлинк в пути: npm .bin, macOS /var/folders); см. src/bin/entry-point.ts',
      );
    }
  } else {
    lines.push('    stderr:');
    for (const line of tail.split('\n')) lines.push(`      ${line}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Клиент smoke-теста: своё имя, чтобы отличать сессии в логах сервера. */
function defaultClientFactory() {
  return new Client({ name: 'etn-mcpb-smoke', version: '1.0.0' }, { capabilities: {} });
}

/**
 * Рукопожатие с бандлом и диагностика смерти сервера.
 *
 * Диагностика печатается, когда умер потомок (`Connection closed` и любой
 * другой отказ после смерти процесса) и при отказе `connect`; провал проверок
 * `run(client)` на живом сервере печатает только текст ошибки.
 *
 * @template T
 * @param {{
 *   entryPoint: string,
 *   env: Record<string, string>,
 *   label: string,
 *   run: (client: object) => Promise<T>,
 *   out?: { write(chunk: string): unknown },
 *   transportFactory?: Function,
 *   clientFactory?: Function,
 * }} options
 * @returns {Promise<T>} результат `run`.
 */
export async function withBundleHandshake({
  entryPoint,
  env,
  label,
  run,
  out = process.stderr,
  transportFactory = createBundleTransport,
  clientFactory = defaultClientFactory,
}) {
  const bundle = transportFactory({ entryPoint, env, out });
  const client = clientFactory();
  let connected = false;
  try {
    await client.connect(bundle.transport);
    connected = true;
    return await run(client);
  } catch (err) {
    if (!connected || bundle.exit() !== null) {
      out.write(
        formatBundleFailure({
          label,
          error: err,
          exit: bundle.exit(),
          stderrTail: bundle.stderrTail(),
        }),
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    await client.close().catch(() => undefined);
  }
}
