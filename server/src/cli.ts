/**
 * ETN command-line interface (task B6, docs/06-auth.md §8).
 *
 * Entry point published as the `etn` bin (`dist/cli.js`). Implements the only
 * MVP subcommand:
 *
 *   etn init --username <login> [--display-name "<name>"]
 *
 * `etn init` creates the data directory and `_system.db`, applies migrations,
 * creates the first (root) administrator with `is_admin=1, is_first_user=1`,
 * issues a primary API-key, prints it **exactly once**, and writes an
 * `audit_log` row (`category=system, action=init`). A repeated invocation
 * fails with a clear "already initialised" message.
 *
 * Argument parsing is hand-rolled (no external parser dep). `main()` is
 * exported for tests; a module-level guard runs it when this file is the entry
 * point.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { ConfigError, loadConfig, type ServerConfig } from './config.js';
import { logger } from './logger.js';
import { SystemDb } from './db/system-db.js';
import { generateApiKey } from './auth/api-key.js';
import { runStdioMcp } from './mcp/stdio.js';

/** Error for CLI usage problems (missing/unknown arguments). */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/** Parsed arguments for the `init` subcommand. */
export interface InitArgs {
  username: string;
  displayName: string | null;
}

/** Options accepted by {@link main} (for testability). */
export interface MainOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Parse `init` subcommand arguments. Accepts `--username`/`-u` and
 * `--display-name`/`-d` in both `--flag value` and `--flag=value` forms.
 *
 * @throws {CliError} when `--username` is missing or an unknown flag appears.
 */
export function parseInitArgs(tokens: string[]): InitArgs {
  let username: string | null = null;
  let displayName: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined) break;
    if (t === '--username' || t === '-u') {
      username = tokens[++i] ?? null;
    } else if (t.startsWith('--username=')) {
      username = t.slice('--username='.length);
    } else if (t === '--display-name' || t === '-d') {
      displayName = tokens[++i] ?? null;
    } else if (t.startsWith('--display-name=')) {
      displayName = t.slice('--display-name='.length);
    } else if (t === '--help' || t === '-h') {
      throw new CliError(HELP_INIT);
    } else {
      throw new CliError(`Неизвестный аргумент: ${t}`);
    }
  }

  if (username === null || username.trim() === '') {
    throw new CliError('Аргумент --username обязателен. Пример: etn init --username admin');
  }
  const trimmedName = username.trim();
  if (trimmedName.length === 0) {
    throw new CliError('--username не может быть пустым.');
  }
  return {
    username: trimmedName,
    displayName: displayName === null ? null : displayName.trim() || null,
  };
}

const HELP_GLOBAL = `Использование: etn <команда> [опции]

Команды:
  init    Первичная инициализация сервера: создаёт _system.db, первого
          администратора и первичный API-key.
  mcp     MCP-сервер в stdio-режиме (для локальных AI-агентов). API-key —
          через ETN_API_KEY или --api-key.

Переменные окружения:
  ETN_DATA_DIR       Каталог данных сервера (обязательный).
  ETN_HOST           Адрес привязки (по умолчанию 127.0.0.1).
  ETN_PORT           Порт (по умолчанию 3000).
  ETN_TLS_CERT,
  ETN_TLS_KEY        Сертификат и ключ для HTTPS/WSS (оба или ни одного).
  ETN_LOG_LEVEL      Уровень логирования (по умолчанию info).
  ETN_MCP_ENABLED    1 — поднять HTTP-эндпоинт MCP /mcp на основном сервере.
  ETN_MCP_PORT       Опционально: отдельный порт только для /mcp.
  ETN_API_KEY        API-key для "etn mcp" (если не передан --api-key).

Запустите: etn <команда> --help для справки по команде.`;

const HELP_INIT = `Использование: etn init --username <логин> [--display-name "<имя>"]

Создаёт корневого администратора и первичный API-key. Повторный запуск
завершается ошибкой «уже инициализировано».`;

const HELP_MCP = `Использование: etn mcp [--api-key <ключ>]

Запускает MCP-сервер в stdio-режиме для локального AI-агента (например,
Claude Desktop или IDE-агент). API-key берётся из --api-key или из
переменной окружения ETN_API_KEY — без ключа запуск отклоняется.`;

/** Parsed arguments for the `mcp` subcommand. */
export interface McpArgs {
  apiKey: string | null;
}

/**
 * Parse `mcp` subcommand arguments. Accepts `--api-key`/`--api-key=...` and
 * `--help`/`-h`. The key may also come from `ETN_API_KEY` (checked by the
 * caller, which knows the env).
 */
export function parseMcpArgs(tokens: string[]): McpArgs {
  let apiKey: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined) break;
    if (t === '--api-key') {
      apiKey = tokens[++i] ?? null;
    } else if (t.startsWith('--api-key=')) {
      apiKey = t.slice('--api-key='.length);
    } else if (t === '--help' || t === '-h') {
      throw new CliError(HELP_MCP);
    } else {
      throw new CliError(`Неизвестный аргумент: ${t}`);
    }
  }
  return { apiKey: apiKey?.trim() || null };
}

/** Print the global help text. */
function printGlobalHelp(): void {
  console.log(HELP_GLOBAL);
}

/**
 * Run the `init` subcommand against `config.dataDir`.
 *
 * @returns process exit code (0 = success, 1 = failure).
 */
function runInit(args: InitArgs, config: ServerConfig): number {
  const sys = SystemDb.open(config.dataDir, logger);
  try {
    if (sys.hasFirstUser()) {
      console.error(
        'Ошибка: сервер ETN уже инициализирован (первый администратор существует). ' +
          'Повторная инициализация не требуется.',
      );
      return 1;
    }

    const gen = generateApiKey();
    const userId = randomUUID();
    const apiKeyId = randomUUID();

    sys.transaction(() => {
      const user = sys.createUser({
        id: userId,
        username: args.username,
        displayName: args.displayName,
        isAdmin: true,
        isFirstUser: true,
      });
      sys.createApiKey({
        id: apiKeyId,
        userId: user.id,
        label: 'primary',
        keyHash: gen.keyHash,
        keyPrefix: gen.keyPrefix,
      });
      sys.insertAuditLog({
        category: 'system',
        action: 'init',
        actorUserId: user.id,
        targetType: 'user',
        targetId: user.id,
      });
    });

    console.log('ETN инициализирован.');
    console.log('');
    console.log('Создан пользователь-администратор:');
    console.log(`  Имя пользователя:  ${args.username}`);
    if (args.displayName) {
      console.log(`  Отображаемое имя:  ${args.displayName}`);
    }
    console.log('');
    console.log('Первичный API-key (показан один раз — сохраните его):');
    console.log(`  ${gen.key}`);
    console.log('');
    console.log(
      'Внимание: ключ не передавайте по открытым каналам. Восстановить его ' +
        'нельзя — только перевыпустить через администратора.',
    );
    return 0;
  } finally {
    sys.close();
  }
}

/**
 * CLI entry point.
 *
 * @returns the process exit code.
 */
export async function main(opts: MainOptions = {}): Promise<number> {
  const argv = opts.argv ?? process.argv;
  const env = opts.env ?? process.env;

  // argv = [nodePath, scriptPath, command, ...args]
  const tokens = argv.slice(2);
  const command = tokens[0];

  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    printGlobalHelp();
    return command === undefined ? 1 : 0;
  }

  if (command === 'init') {
    let parsed: InitArgs;
    try {
      parsed = parseInitArgs(tokens.slice(1));
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
    let config: ServerConfig;
    try {
      config = loadConfig(env);
    } catch (err) {
      console.error(
        err instanceof ConfigError ? `Ошибка конфигурации: ${err.message}` : (err as Error).message,
      );
      return 1;
    }
    return runInit(parsed, config);
  }

  if (command === 'mcp') {
    let parsed: McpArgs;
    try {
      parsed = parseMcpArgs(tokens.slice(1));
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
    let config: ServerConfig;
    try {
      config = loadConfig(env);
    } catch (err) {
      console.error(
        err instanceof ConfigError ? `Ошибка конфигурации: ${err.message}` : (err as Error).message,
      );
      return 1;
    }
    const apiKey = parsed.apiKey ?? env.ETN_API_KEY?.trim() ?? null;
    try {
      // Logger is built inside runStdioMcp (stderr-bound) to keep stdout clean.
      await runStdioMcp({ dataDir: config.dataDir, apiKey });
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  console.error(`Неизвестная команда: ${command}`);
  printGlobalHelp();
  return 1;
}

// Run when invoked directly as the process entry point.
const invokedScript = process.argv[1];
const thisFile = fileURLToPath(import.meta.url);
if (invokedScript === thisFile) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
