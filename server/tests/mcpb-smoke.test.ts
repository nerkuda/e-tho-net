/**
 * Диагностика smoke-теста MCPB-бандла (ошибка 06f03d71).
 *
 * Релизный run v0.16.2 на macOS падал с единственной строкой «MCP error -32000:
 * Connection closed»: транспорт MCP SDK пайпит stderr потомка в `PassThrough`,
 * который никто не читает, а код выхода в `onclose` не передаёт. Проверки
 * держат контракт диагностики: stderr сервера виден в логе сборки, при смерти
 * печатаются код выхода/сигнал и хвост stderr, «пустая смерть» (код 0) получает
 * подсказку про точку входа.
 *
 * Red-green: мутация «диагностика не печатает stderr» (`formatBundleFailure` без
 * блока stderr) краснит тест «смерть сервера: stderr и код выхода попадают в
 * лог сборки».
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface StderrTap {
  tail(): string;
}

interface SmokeLib {
  STDERR_TAIL_LIMIT: number;
  tapStderr(
    transport: { stderr: PassThrough | null },
    out: { write(chunk: string): unknown },
  ): StderrTap;
  formatBundleFailure(input: {
    label: string;
    error: unknown;
    exit: { code: number | null; signal: string | null } | null;
    stderrTail: string;
  }): string;
  withBundleHandshake(options: {
    entryPoint: string;
    env: Record<string, string>;
    label: string;
    run: (client: unknown) => Promise<unknown>;
    out: { write(chunk: string): unknown };
    transportFactory?: () => {
      transport: unknown;
      exit(): { code: number | null; signal: string | null } | null;
      stderrTail(): string;
    };
    clientFactory?: () => { connect(transport: unknown): Promise<void>; close(): Promise<void> };
  }): Promise<unknown>;
}

const smoke = (await import(
  pathToFileURL(path.join(SERVER_ROOT, 'scripts', 'lib', 'mcpb-smoke.mjs')).href
)) as SmokeLib;

/** Сборщик вывода: вместо stderr процесса — массив строк. */
function collector(): { write(chunk: string): boolean; text(): string } {
  const chunks: string[] = [];
  return {
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
    text(): string {
      return chunks.join('');
    },
  };
}

describe('smoke-тест бандла: stderr и код выхода сервера в логе сборки', () => {
  it('stderr сервера идёт в лог прозрачно, по строкам, с префиксом', () => {
    const stream = new PassThrough();
    const out = collector();
    const tap = smoke.tapStderr({ stderr: stream }, out);

    stream.write('migration 001 ok\n');
    stream.write('boom: native addon failed\npartial');
    assert.equal(
      out.text(),
      '  [server] migration 001 ok\n  [server] boom: native addon failed\n',
      'каждая строка stderr — сразу в лог, с префиксом',
    );
    assert.match(tap.tail(), /partial$/, 'недописанная строка остаётся в хвосте');
    assert.match(tap.tail(), /migration 001 ok/, 'хвост хранит и предыдущие строки');
  });

  it('смерть сервера: хвост stderr и код выхода попадают в лог сборки', async () => {
    const out = collector();
    const transport = { stderr: null };
    await assert.rejects(
      smoke.withBundleHandshake({
        entryPoint: 'C:/bundle/dist/bin/etn-mcp.js',
        env: {},
        label: 'личный каталог',
        out,
        transportFactory: () => ({
          transport,
          exit: () => ({ code: 1, signal: null }),
          stderrTail: () => 'Error: better_sqlite3.node is not a valid mach-o file',
        }),
        clientFactory: () => ({
          connect: async () => {
            throw new Error('MCP error -32000: Connection closed');
          },
          close: async () => undefined,
        }),
        run: async () => 0,
      }),
      /Connection closed/,
    );
    const text = out.text();
    assert.match(text, /диагностика сервера \(личный каталог\)/, 'шаг smoke назван в логе');
    assert.match(text, /exit code=1 signal=null/, 'код выхода сервера виден');
    assert.match(
      text,
      /better_sqlite3\.node is not a valid mach-o file/,
      'stderr умирающего сервера виден — без него причина смерти невосстановима',
    );
  });

  it('смерть по сигналу: сигнал печатается вместо кода выхода', () => {
    const text = smoke.formatBundleFailure({
      label: 'присоединение',
      error: new Error('MCP error -32000: Connection closed'),
      exit: { code: null, signal: 'SIGSEGV' },
      stderrTail: '',
    });
    assert.match(text, /exit code=null signal=SIGSEGV/);
    assert.match(text, /stderr: пусто/);
  });

  it('код 0 и пустой stderr: подсказка про нераспознанную точку входа', () => {
    const text = smoke.formatBundleFailure({
      label: 'личный каталог',
      error: new Error('MCP error -32000: Connection closed'),
      exit: { code: 0, signal: null },
      stderrTail: '',
    });
    assert.match(text, /exit code=0 signal=null/);
    assert.match(text, /точка входа не распознала себя/, 'молчаливый exit 0 объясняется в логе');
    assert.match(text, /entry-point\.ts/);
  });

  it('живой сервер: провал проверки инструментов не печатает диагностику смерти', async () => {
    const out = collector();
    await assert.rejects(
      smoke.withBundleHandshake({
        entryPoint: 'C:/bundle/dist/bin/etn-mcp.js',
        env: {},
        label: 'личный каталог',
        out,
        transportFactory: () => ({
          transport: { stderr: null },
          exit: () => null,
          stderrTail: () => '',
        }),
        clientFactory: () => ({
          connect: async () => undefined,
          close: async () => undefined,
        }),
        run: async () => {
          throw new Error('в tools/list нет etn.guide');
        },
      }),
      /нет etn\.guide/,
    );
    assert.equal(out.text(), '', 'живой сервер — диагностика смерти не нужна');
  });

  it('сборщик бандла ходит через диагностику, а не заводит свой транспорт', () => {
    const source = fs.readFileSync(path.join(SERVER_ROOT, 'scripts', 'build-mcpb.mjs'), 'utf8');
    assert.match(source, /withBundleHandshake\(/, 'рукопожатие — через модуль диагностики');
    assert.doesNotMatch(
      source,
      /new StdioClientTransport\(/,
      'свой транспорт без чтения stderr вернётся — сторож обязан краснеть',
    );
    assert.doesNotMatch(source, /from '@modelcontextprotocol\/sdk\/client\/stdio\.js'/);
  });
});
