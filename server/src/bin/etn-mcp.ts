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
import { isEntryPoint } from './entry-point.js';
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

/**
 * Признак ошибки загрузки нативного модуля better-sqlite3.
 *
 * Экспортируется для теста: вызывающая точка обёртки должна ловить именно эту
 * ошибку и печатать текст про платформу, а не сырой стек.
 */
export function isNativeLoadFailure(err: unknown): boolean {
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
 * Понятный английский текст о неподходящей нативной сборке.
 *
 * Один текст на обе защиты DoD 2: сверку целевой платформы бандла (маркер) и
 * страховочный перехват `ERR_DLOPEN_FAILED` — пользователь не должен видеть
 * сырой `… is not a valid Win32 application` из `require`.
 */
export function nativeLoadErrorMessage(host: string): string {
  return (
    `The native SQLite module (better-sqlite3) could not be loaded on ${host}: ` +
    'this build does not match the current platform or architecture. ' +
    'Use the artifact built for your platform (the platform and architecture are part of ' +
    'the file name).'
  );
}

/** Конструктор `better-sqlite3`: минимальная форма для проверки загрузки аддона. */
type NativeDatabaseConstructor = new (filename: string) => { close(): void };

/**
 * Загрузить нативную сборку заранее — открыть и закрыть БД в памяти.
 *
 * `better-sqlite3` ленив: `import` подключает только JS-обёртку, а аддон
 * `better_sqlite3.node` грузится в конструкторе `Database`
 * (`lib/database.js`: `require('bindings')('better_sqlite3.node')`). Поэтому
 * проверка нативной загрузки — это `new Database(':memory:')`, а не импорт
 * модуля: импорт проходит и с битым аддоном. Делается до `main()` — там
 * ошибку ловит и печатает сырым текстом сам CLI, а каталог данных уже создан.
 *
 * @returns `false`, если ошибка распознана и уже напечатана.
 * @throws неперехваченная ошибка, если она не про нативный модуль.
 */
async function preloadNativeAddon(host: string): Promise<boolean> {
  try {
    const loaded = (await import('better-sqlite3')) as unknown as {
      default?: NativeDatabaseConstructor;
    };
    const Database = (loaded.default ?? loaded) as unknown as NativeDatabaseConstructor;
    const probe = new Database(':memory:');
    probe.close();
    return true;
  } catch (err) {
    if (!isNativeLoadFailure(err)) throw err;
    console.error(nativeLoadErrorMessage(host));
    return false;
  }
}

/**
 * Запустить CLI в текущем процессе.
 *
 * @param argv - `process.argv` (или подмена в тестах).
 * @param env - окружение (подмена в тестах).
 * @param packageDirOverride - корень пакета/бандла (тестовый шов: позволяет
 *   подложить маркер целевой платформы, не трогая реальный каталог пакета).
 * @returns код выхода CLI.
 */
export async function runEtnMcp(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  packageDirOverride?: string,
): Promise<number> {
  const packageDir =
    packageDirOverride ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

  // Нативная сборка проверяется до main(): внутри main() аддон грузится при
  // bootstrap каталога данных, и его ошибку печатает сам CLI сырым текстом.
  if (!(await preloadNativeAddon(host))) return 1;

  let main: (options: { argv?: string[]; env?: NodeJS.ProcessEnv }) => Promise<number>;
  try {
    ({ main } = await import('../cli.js'));
  } catch (err) {
    if (isNativeLoadFailure(err)) {
      console.error(nativeLoadErrorMessage(host));
      return 1;
    }
    throw err;
  }

  try {
    return await main({ argv: cliArgv, env: effectiveEnv });
  } catch (err) {
    // Страховка на случай, если нативный модуль догрузился позже и упал иначе,
    // чем при предзагрузке: тот же понятный текст вместо сырого стека.
    if (isNativeLoadFailure(err)) {
      console.error(nativeLoadErrorMessage(host));
      return 1;
    }
    throw err;
  }
}

/** Запуск как bin-файл (npm создаёт шим на этот файл). */
if (isEntryPoint(process.argv[1], fileURLToPath(import.meta.url))) {
  runEtnMcp()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
