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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE_LAYER_ID, type PublicationExportFormat } from '@etn/shared';

import { ConfigError, loadConfig, type ServerConfig } from './config.js';
import { logger } from './logger.js';
import { SystemDb } from './db/system-db.js';
import { closeNetworkDb, openNetworkDb } from './db/network-db.js';
import { generateApiKey } from './auth/api-key.js';
import { createApiKeyAuthProvider } from './mcp/auth.js';
import { runStdioMcp } from './mcp/stdio.js';
import { closeReaderPool, configureReaderPool } from './db/reader-pool.js';
import { listLayers } from './domain/layer-service.js';
import { getPublication, listPublications } from './domain/publication-service.js';
import { buildPublicationExportDocument } from './domain/publication-assembly-service.js';
import {
  PUBLICATION_EXPORT_BATCH_MAX,
  buildPublicationArtifact,
  resolvePublicationSlugs,
  writePublicationZip,
  type PublicationFile,
} from './domain/publication-export-service.js';

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
  init          Первичная инициализация сервера: создаёт _system.db, первого
                администратора и первичный API-key.
  mcp           MCP-сервер в stdio-режиме (для локальных AI-агентов). API-key —
                через ETN_API_KEY или --api-key.
  publications  Пересборка публикаций в каталог (CI и git-хуки).

Переменные окружения:
  ETN_DATA_DIR       Каталог данных сервера (обязательный).
  ETN_HOST           Адрес привязки (по умолчанию 127.0.0.1).
  ETN_PORT           Порт (по умолчанию 3000).
  ETN_TLS_CERT,
  ETN_TLS_KEY        Сертификат и ключ для HTTPS/WSS (оба или ни одного).
  ETN_LOG_LEVEL      Уровень логирования (по умолчанию info).
  ETN_MCP_ENABLED    1 — поднять HTTP-эндпоинт MCP /mcp на основном сервере.
  ETN_MCP_PORT       Опционально: отдельный порт только для /mcp.
  ETN_MCP_SESSION_IDLE_TTL_MS
                     Время жизни простаивающей MCP-сессии, мс (по умолчанию
                     86400000 — 24 часа; допустимо 1000…2592000000).
  ETN_API_KEY        API-key для "etn mcp" и "etn publications" (если не
                     передан --api-key).

Запустите: etn <команда> --help для справки по команде.`;

const HELP_INIT = `Использование: etn init --username <логин> [--display-name "<имя>"]

Создаёт корневого администратора и первичный API-key. Повторный запуск
завершается ошибкой «уже инициализировано».`;

const HELP_MCP = `Использование: etn mcp [--api-key <ключ>]

Запускает MCP-сервер в stdio-режиме для локального AI-агента (например,
Claude Desktop или IDE-агент). API-key берётся из --api-key или из
переменной окружения ETN_API_KEY — без ключа запуск отклоняется.`;

const HELP_PUBLICATIONS = `Использование: etn publications <команда> [опции]

Команды:
  rebuild   Пересобрать публикации сети в каталог файлов или единый zip
            (для CI-пайплайнов и git-хуков).

Запустите: etn publications <команда> --help для справки по команде.`;

const HELP_PUBLICATIONS_REBUILD = `Использование: etn publications rebuild --out <каталог> (--network <id> | --network-name <имя>) [опции]

Пересобирает публикации сети тем же доменным кодом экспорта, что и REST/клиент.
Без --zip пишет в каталог файлы <slug>.md|.html и assets/; с --zip — один архив.
Повторный запуск без изменений в базе не меняет содержимое файлов (mtime не в счёт).

Обязательно:
  --out <каталог>        Каталог для файлов (или zip при --zip).
  --network <id>         Сеть по id (для агентов).
  --network-name <имя>   Сеть по отображаемому имени (для людей).

Опции:
  --layer <id>           Слой сборки (по умолчанию — основа).
  --ids <id,...>         Пересобрать перечисленные публикации (через запятую).
  --all-active           Пересобрать все актуальные публикации сети.
  --format <md|html>     Формат документа (по умолчанию md).
  --zip                  Единый zip вместо каталога файлов.
  --api-key <ключ>       API-key (иначе ETN_API_KEY).

API-key обязателен: документ собирается от имени его пользователя.
Переменные окружения: ETN_DATA_DIR (обязательна), ETN_API_KEY, ETN_LOG_LEVEL.`;

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

// ---------------------------------------------------------------------------
// etn publications rebuild (0.11.1, задача 07b09d8b; операция f7824d11)
// ---------------------------------------------------------------------------

/** Parsed arguments of `etn publications rebuild`. */
export interface PublicationsRebuildArgs {
  /** Output directory (`--out`). */
  out: string;
  /** Target network by id (`--network`), or `null`. */
  networkId: string | null;
  /** Target network by display name (`--network-name`), or `null`. */
  networkName: string | null;
  /** Layer context (`--layer`); `null` = base layer. */
  layerId: string | null;
  /** Explicit publication ids (`--ids`), or `null` when `--all-active`. */
  ids: string[] | null;
  /** Rebuild every active publication (`--all-active`). */
  allActive: boolean;
  /** Document format (`--format`, default `md`). */
  format: PublicationExportFormat;
  /** Pack a single zip (`--zip`) instead of a file catalog. */
  zip: boolean;
  /** API-key from `--api-key`; `null` falls back to `ETN_API_KEY`. */
  apiKey: string | null;
}

/** Require a value for a flag (`--flag value` / `--flag=value`). */
function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new CliError(`Аргумент ${flag} требует значения.`);
  }
  return value.trim();
}

/** Parse a comma-separated `--ids` value into a non-empty list. */
function parseIds(raw: string): string[] {
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (ids.length === 0) {
    throw new CliError('Аргумент --ids не содержит ни одного id.');
  }
  return ids;
}

/** Parse `--format` (only `md` | `html`). */
function parseFormat(raw: string): PublicationExportFormat {
  if (raw === 'md' || raw === 'html') return raw;
  throw new CliError(`Неизвестный формат: ${raw} (ожидается md или html).`);
}

/**
 * Parse `publications rebuild` arguments. Accepts `--flag value` and
 * `--flag=value` forms; validates the mutually exclusive pairs
 * (`--network`/`--network-name`, `--ids`/`--all-active`).
 *
 * @throws {CliError} on unknown flags, missing values or a violated pair.
 */
export function parsePublicationsRebuildArgs(tokens: string[]): PublicationsRebuildArgs {
  let out: string | null = null;
  let networkId: string | null = null;
  let networkName: string | null = null;
  let layerId: string | null = null;
  let ids: string[] | null = null;
  let allActive = false;
  let format: PublicationExportFormat = 'md';
  let zip = false;
  let apiKey: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined) break;
    if (t === '--out') out = requireValue('--out', tokens[++i]);
    else if (t.startsWith('--out=')) out = requireValue('--out', t.slice('--out='.length));
    else if (t === '--network') networkId = requireValue('--network', tokens[++i]);
    else if (t.startsWith('--network='))
      networkId = requireValue('--network', t.slice('--network='.length));
    else if (t === '--network-name') networkName = requireValue('--network-name', tokens[++i]);
    else if (t.startsWith('--network-name='))
      networkName = requireValue('--network-name', t.slice('--network-name='.length));
    else if (t === '--layer') layerId = requireValue('--layer', tokens[++i]);
    else if (t.startsWith('--layer=')) layerId = requireValue('--layer', t.slice('--layer='.length));
    else if (t === '--ids') ids = parseIds(requireValue('--ids', tokens[++i]));
    else if (t.startsWith('--ids=')) ids = parseIds(requireValue('--ids', t.slice('--ids='.length)));
    else if (t === '--all-active') allActive = true;
    else if (t === '--format') format = parseFormat(requireValue('--format', tokens[++i]));
    else if (t.startsWith('--format='))
      format = parseFormat(requireValue('--format', t.slice('--format='.length)));
    else if (t === '--zip') zip = true;
    else if (t === '--api-key') apiKey = requireValue('--api-key', tokens[++i]);
    else if (t.startsWith('--api-key='))
      apiKey = requireValue('--api-key', t.slice('--api-key='.length));
    else if (t === '--help' || t === '-h') throw new CliError(HELP_PUBLICATIONS_REBUILD);
    else throw new CliError(`Неизвестный аргумент: ${t}`);
  }

  if (out === null) {
    throw new CliError(
      'Аргумент --out обязателен. Пример: etn publications rebuild --out ./docs --network <id> --all-active',
    );
  }
  if (networkId !== null && networkName !== null) {
    throw new CliError('Укажите что-то одно: --network или --network-name.');
  }
  if (networkId === null && networkName === null) {
    throw new CliError('Укажите сеть: --network <id> или --network-name <имя>.');
  }
  if (ids !== null && allActive) {
    throw new CliError('Укажите что-то одно: --ids или --all-active.');
  }
  if (ids === null && !allActive) {
    throw new CliError('Укажите, что пересобирать: --ids <id,...> или --all-active.');
  }

  return { out, networkId, networkName, layerId, ids, allActive, format, zip, apiKey: apiKey?.trim() || null };
}

/** Write `data` to `absPath` only when the bytes differ (deterministic rebuild). */
function writeFileIfChanged(absPath: string, data: Buffer | string): 'written' | 'unchanged' {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  try {
    if (existsSync(absPath) && readFileSync(absPath).equals(buf)) return 'unchanged';
  } catch {
    // Нет доступа к существующему файлу — перезапишем.
  }
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, buf);
  return 'written';
}

/** Resolve the target network id from `--network` / `--network-name` + access. */
function resolveCliNetwork(
  sys: SystemDb,
  args: PublicationsRebuildArgs,
  auth: { userId: string; isAdmin: boolean },
): string {
  if (args.networkId !== null) {
    if (sys.getNetworkById(args.networkId) === null) {
      throw new CliError(`Сеть не найдена: ${args.networkId}`);
    }
    assertCliNetworkAccess(sys, auth, args.networkId);
    return args.networkId;
  }
  const list = auth.isAdmin ? sys.listAllNetworks() : sys.listNetworksForUser(auth.userId);
  const wanted = args.networkName!.trim().toLowerCase();
  const matches = list.filter((n) => n.display_name.trim().toLowerCase() === wanted);
  if (matches.length === 0) {
    const names = list.map((n) => n.display_name).join(', ') || '—';
    throw new CliError(`Сеть с именем «${args.networkName}» не найдена. Доступные: ${names}.`);
  }
  if (matches.length > 1) {
    const variants = matches.map((n) => `${n.id} (${n.display_name})`).join('; ');
    throw new CliError(`Имя «${args.networkName}» неоднозначно, уточните --network: ${variants}.`);
  }
  const id = matches[0]!.id;
  assertCliNetworkAccess(sys, auth, id);
  return id;
}

/** Member-or-admin check (same rule as REST/MCP network access). */
function assertCliNetworkAccess(
  sys: SystemDb,
  auth: { userId: string; isAdmin: boolean },
  networkId: string,
): void {
  if (auth.isAdmin) return;
  if (sys.getMemberRole(auth.userId, networkId) === null) {
    throw new CliError(`Нет доступа к сети ${networkId}: пользователь не участник.`);
  }
}

/**
 * Validate the requested layer against the network and return its id (base
 * layer by default). A layer id is only meaningful within its own network, so
 * a foreign/unknown id is a hard error (operation f7824d11).
 */
function resolveCliLayer(config: ServerConfig, networkId: string, requested: string | null): string {
  const layerId = requested ?? BASE_LAYER_ID;
  const baseNdb = openNetworkDb(config.dataDir, networkId, undefined, BASE_LAYER_ID);
  const layer = listLayers(baseNdb, { includeService: true }).find((l) => l.id === layerId);
  if (layer === undefined) {
    throw new CliError(`Слой ${layerId} не найден в сети ${networkId}.`);
  }
  if (layer.is_service) {
    throw new CliError(`Слой ${layerId} служебный — выбрать его нельзя.`);
  }
  return layerId;
}

/**
 * Run `etn publications rebuild`: resolve network/layer/user, gather the
 * target ids, reuse the export domain to build the very same files, then write
 * them into the catalog (or one zip). Missing publication ids and asset
 * problems are warnings, not failures (DoD).
 *
 * @returns process exit code (0 = success, 1 = config/auth/IO failure).
 */
async function runPublicationsRebuild(
  args: PublicationsRebuildArgs,
  config: ServerConfig,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const apiKey = args.apiKey ?? env.ETN_API_KEY?.trim() ?? null;
  if (apiKey === null || apiKey === '') {
    console.error(
      'Для сборки публикаций нужен API-key: задайте ETN_API_KEY или передайте --api-key.',
    );
    return 1;
  }

  const sys = SystemDb.open(config.dataDir);
  let networkId: string | null = null;
  try {
    const auth = createApiKeyAuthProvider(sys)(apiKey);
    if (auth === null) {
      console.error('Невалидный или отключённый API-key (проверьте ETN_API_KEY / --api-key).');
      return 1;
    }

    networkId = resolveCliNetwork(sys, args, auth);
    const layerId = resolveCliLayer(config, networkId, args.layerId);
    const ndb = openNetworkDb(config.dataDir, networkId, undefined, layerId);
    const resolveUserName = (userId: string): string | null => {
      const user = sys.getUserById(userId);
      return user === null ? null : (user.display_name ?? user.username);
    };

    // --- Target ids (explicit list or every active publication) ------------
    const warnings: string[] = [];
    let ids: string[];
    if (args.ids !== null) {
      ids = args.ids;
    } else {
      const listed = listPublications(ndb, { active: 'true', limit: PUBLICATION_EXPORT_BATCH_MAX });
      ids = listed.items
        .slice()
        .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : a.id < b.id ? -1 : 1))
        .map((p) => p.id);
      if (listed.total > PUBLICATION_EXPORT_BATCH_MAX) {
        warnings.push(
          `список усечён до ${PUBLICATION_EXPORT_BATCH_MAX} публикаций (в сети ${listed.total} актуальных)`,
        );
      }
    }

    const found: string[] = [];
    for (const id of ids) {
      if (getPublication(ndb, id) === null) warnings.push(`публикация не найдена: ${id}`);
      else found.push(id);
    }
    if (found.length === 0) {
      console.log('Публикаций для пересборки нет.');
      for (const w of warnings) console.log(`предупреждение: ${w}`);
      return 0;
    }

    // --- Build files with the export domain --------------------------------
    const { slugById, titleById } = resolvePublicationSlugs(ndb, found);
    const entries: PublicationFile[] = [];
    for (const id of found) {
      const slug = slugById.get(id)!;
      try {
        const document = buildPublicationExportDocument(ndb, id, auth.userId, resolveUserName);
        const artifact = buildPublicationArtifact(ndb, document, args.format, true, '', slug);
        entries.push(...artifact.entries);
        for (const w of artifact.entry.warnings) warnings.push(w);
      } catch (err) {
        const title = titleById.get(id) ?? id;
        warnings.push(
          `публикация «${title}» не собрана: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (entries.length === 0) {
      console.log('Не удалось собрать ни одной публикации.');
      for (const w of warnings) console.log(`предупреждение: ${w}`);
      return 0;
    }

    // --- Write catalog or single zip ---------------------------------------
    const outDir = path.resolve(args.out);
    mkdirSync(outDir, { recursive: true });
    let written = 0;
    let unchanged = 0;
    if (args.zip) {
      const slug = found.length === 1 ? slugById.get(found[0]!) : undefined;
      const zipPath = path.join(outDir, slug === undefined ? 'publications-export.zip' : `${slug}.zip`);
      const tmp = path.join(os.tmpdir(), `etn-pub-cli-${randomUUID()}.zip`);
      await writePublicationZip(tmp, entries);
      const bytes = readFileSync(tmp);
      rmSync(tmp, { force: true });
      const state = writeFileIfChanged(zipPath, bytes);
      if (state === 'written') written += 1;
      else unchanged += 1;
      console.log(zipPath);
    } else {
      const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of sorted) {
        const state = writeFileIfChanged(path.join(outDir, entry.name), entry.data);
        if (state === 'written') written += 1;
        else unchanged += 1;
        console.log(`  ${entry.name}`);
      }
    }
    for (const w of warnings) console.log(`предупреждение: ${w}`);
    console.log(
      `Готово: файлов ${written + unchanged} (обновлено ${written}, без изменений ${unchanged}).`,
    );
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    if (networkId !== null) closeNetworkDb(networkId);
    sys.close();
  }
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
      // Тяжёлые чтения агента тоже не должны морозить stdio-процесс: тот же
      // пул reader-воркеров, что в HTTP-сервере (ADR bec191e6).
      configureReaderPool({
        size: config.readerPool.size,
        taskTimeoutMs: config.readerPool.taskTimeoutMs,
      });
      // Logger is built inside runStdioMcp (stderr-bound) to keep stdout clean.
      await runStdioMcp({ dataDir: config.dataDir, apiKey });
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    } finally {
      await closeReaderPool();
    }
  }

  if (command === 'publications') {
    const sub = tokens[1];
    if (sub === undefined || sub === '-h' || sub === '--help' || sub === 'help') {
      console.log(HELP_PUBLICATIONS);
      return sub === undefined ? 1 : 0;
    }
    if (sub === 'rebuild') {
      let parsed: PublicationsRebuildArgs;
      try {
        parsed = parsePublicationsRebuildArgs(tokens.slice(2));
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
      return runPublicationsRebuild(parsed, config, env);
    }
    console.error(`Неизвестная команда: publications ${sub}`);
    console.log(HELP_PUBLICATIONS);
    return 1;
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
