#!/usr/bin/env node
/**
 * Опубликованная входная точка пакета `etn-mcp` (ADR ad67950b п. 4, ADR
 * aa9507e6 п. 2, задача 760402ba).
 *
 * Что делает обёртка (и только она):
 *
 * - проверяет хост по матрице пакета и целевую платформу MCPB-бандла
 *   (`etn-mcp-target.json`) **до** загрузки сервера — иначе чужой
 *   `better-sqlite3` упадёт сырым стеком;
 * - если `ETN_DATA_DIR` не задан, подставляет личный каталог по умолчанию
 *   (`%LOCALAPPDATA%\etn-mcp` и аналоги): правило личного каталога относится
 *   именно к входной точке пакета, `etn mcp` его не получает;
 * - подставляет подкоманду `mcp`, если первым аргументом не идёт известная
 *   подкоманда CLI; знакомая подкоманда (`init`, `backup`, ...) проходит как есть;
 * - перехватывает ошибку загрузки нативного модуля (`ERR_DLOPEN_FAILED`) и
 *   печатает тот же понятный текст про платформу вместо стека;
 * - вызывает `main()` CLI **в том же процессе** (никакой второй реализации
 *   bootstrap/инициализации).
 *
 * Все пользовательские сообщения — английские (ADR daab6ac4). stdout не
 * трогаем: в stdio-режиме там MCP-кадры.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultDataDir } from '../bootstrap/personal-dir.js';
import {
  assertBundleTarget,
  assertSupportedHost,
  PlatformError,
  readBundleTarget,
} from './platform.js';

/** Подкоманды, которые обёртка пропускает без подстановки `mcp`. */
const PASSTHROUGH_COMMANDS = new Set([
  'init',
  'backup',
  'restore',
  'mcp',
  'publications',
  'help',
  '--help',
  '-h',
]);

/** Признак ошибки загрузки нативного модуля better-sqlite3. */
function isNativeLoadFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ERR_DLOPEN_FAILED') return true;
  const text = `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`;
  return (
    /better-sqlite3|\.node\b/i.test(text) &&
    /cannot open|invalid ELF|not a valid Win32|mach-o/i.test(text)
  );
}

/**
 * Запустить CLI в текущем процессе.
 *
 * @param argv - `process.argv` (или подмена в тестах).
 * @param env - окружение (подмена в тестах).
 * @returns код выхода CLI.
 */
export async function runEtnMcp(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  let host: string;
  try {
    host = assertSupportedHost();
    assertBundleTarget(readBundleTarget(packageDir), host);
  } catch (err) {
    if (err instanceof PlatformError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }

  const effectiveEnv: NodeJS.ProcessEnv = { ...env };
  const dataDir = effectiveEnv.ETN_DATA_DIR?.trim();
  if (dataDir === undefined || dataDir === '') {
    effectiveEnv.ETN_DATA_DIR = defaultDataDir(effectiveEnv);
  }

  const tokens = argv.slice(2);
  const first = tokens[0];
  const cliTokens =
    first === undefined || !PASSTHROUGH_COMMANDS.has(first) ? ['mcp', ...tokens] : [...tokens];
  const cliArgv = [argv[0] ?? process.execPath, 'etn-mcp', ...cliTokens];

  let main: (options: { argv?: string[]; env?: NodeJS.ProcessEnv }) => Promise<number>;
  try {
    ({ main } = await import('../cli.js'));
  } catch (err) {
    if (isNativeLoadFailure(err)) {
      console.error(
        `The native SQLite module (better-sqlite3) could not be loaded on ${host}. ` +
          'The prebuilt binary does not match this host; reinstall etn-mcp on this machine ' +
          '(npm rebuild better-sqlite3) or use the artifact built for this platform.',
      );
      return 1;
    }
    throw err;
  }

  return main({ argv: cliArgv, env: effectiveEnv });
}

/** Запуск как bin-файл (npm создаёт шим на этот файл). */
const invoked = process.argv[1];
if (
  invoked !== undefined &&
  path.resolve(invoked) === path.resolve(fileURLToPath(import.meta.url))
) {
  runEtnMcp()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
