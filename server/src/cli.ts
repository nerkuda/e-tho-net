/**
 * ETN command-line interface (task B6, docs/06-auth.md §8).
 *
 * Entry point published as the `etn` bin (`dist/cli.js`). Implements the only
 * MVP subcommand:
 *
 *   etn init --username <login> [--display-name "<name>"] [--key-out <file>]
 *   etn init --check
 *
 * `etn init` creates the data directory and `_system.db`, applies migrations,
 * creates the first (root) administrator with `is_admin=1, is_first_user=1`,
 * issues a primary API-key, prints it **exactly once** (or writes it to the
 * `--key-out` file requested by the installer), and writes an `audit_log` row
 * (`category=system, action=init`). A repeated invocation fails with a clear
 * "already initialised" message.
 *
 * `etn init --check` is the installer's idempotency probe (task 686c5d76): it
 * reports whether the first administrator exists (`hasFirstUser()`) without
 * creating the data directory, the database or running migrations. The database
 * is opened strictly read-only; SQLite in WAL mode may still create the
 * `_system.db-shm`/`_system.db-wal` sidecars next to it — normal SQLite files,
 * not a change of the database contents (9b310991). Exit codes:
 * 0 — initialised, 1 — not initialised, 2 — check failed.
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

import { BASE_LAYER_ID, filterProfileHasTime, type PublicationExportFormat } from '@etn/shared';

import { ConfigError, loadConfig, type ServerConfig } from './config.js';
import { logger } from './logger.js';
import { SystemDb } from './db/system-db.js';
import { closeNetworkDb, openNetworkDb } from './db/network-db.js';
import { generateApiKey } from './auth/api-key.js';
import { createApiKeyAuthProvider } from './mcp/auth.js';
import { runStdioMcp } from './mcp/stdio.js';
import { closeReaderPool, configureReaderPool } from './db/reader-pool.js';
import { closeWritePool, configureWritePool, drainWritePool } from './db/write-pool.js';
import { listLayers } from './domain/layer-service.js';
import { getPublication } from './domain/publication-service.js';
import { buildPublicationExportDocument } from './domain/publication-assembly-service.js';
import {
  PUBLICATION_EXPORT_BATCH_MAX,
  buildPublicationArtifact,
  resolvePublicationSlugs,
  selectActivePublicationIds,
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
  /** Login of the first administrator; empty in `--check` mode. */
  username: string;
  displayName: string | null;
  /** `--check`: report whether the first administrator exists, change nothing. */
  check: boolean;
  /** `--key-out <path>`: write the key into this file instead of printing it. */
  keyOut: string | null;
}

/** Options accepted by {@link main} (for testability). */
export interface MainOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Parse `init` subcommand arguments. Accepts `--username`/`-u`,
 * `--display-name`/`-d`, `--key-out` and `--check` in both `--flag value`
 * and `--flag=value` forms.
 *
 * `--check` is mutually exclusive with the initialisation arguments: it only
 * reports state (installer contract, task 686c5d76).
 *
 * @throws {CliError} when `--username` is missing (outside `--check`), when
 *   `--check` is combined with initialisation arguments, or on an unknown flag.
 */
export function parseInitArgs(tokens: string[]): InitArgs {
  let username: string | null = null;
  let displayName: string | null = null;
  let keyOut: string | null = null;
  let check = false;

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
    } else if (t === '--key-out') {
      keyOut = requireValue('--key-out', tokens[++i]);
    } else if (t.startsWith('--key-out=')) {
      keyOut = requireValue('--key-out', t.slice('--key-out='.length));
    } else if (t === '--check') {
      check = true;
    } else if (t === '--help' || t === '-h') {
      throw new CliError(HELP_INIT);
    } else {
      throw new CliError(`Unknown argument: ${t}`);
    }
  }

  if (check) {
    if (username !== null || displayName !== null || keyOut !== null) {
      throw new CliError(
        "The --check argument is incompatible with --username, --display-name and --key-out: " +
          "it only reports the initialization state.",
      );
    }
    return { username: '', displayName: null, check: true, keyOut: null };
  }

  if (username === null || username.trim() === '') {
    throw new CliError("The --username argument is required. Example: etn init --username admin");
  }
  const trimmedName = username.trim();
  if (trimmedName.length === 0) {
    throw new CliError("--username must not be empty.");
  }
  return {
    username: trimmedName,
    displayName: displayName === null ? null : displayName.trim() || null,
    check: false,
    keyOut,
  };
}

const HELP_GLOBAL = `Usage: etn <command> [options]

Commands:
  init          Initial server setup: creates _system.db, the first
                administrator and the primary API key. "etn init --check" only
                reports the initialization state (for the installer).
  mcp           MCP server in stdio mode (for local AI agents). The API key —
                via ETN_API_KEY or --api-key.
  publications  Rebuild publications into a directory (CI and git hooks).

Environment variables:
  ETN_DATA_DIR       Server data directory (required).
  ETN_HOST           Bind address (default 127.0.0.1).
  ETN_PORT           Port (default 3000).
  ETN_TLS_CERT,
  ETN_TLS_KEY        Certificate and key for HTTPS/WSS (both or neither).
  ETN_LOG_LEVEL      Log level (default info).
  ETN_MCP_ENABLED    1 — expose the MCP HTTP endpoint /mcp on the main server.
  ETN_MCP_PORT       Optional: a separate port for /mcp only.
  ETN_MCP_SESSION_IDLE_TTL_MS
                     Idle MCP session lifetime, ms (default
                     86400000 — 24 hours; allowed 1000…2592000000).
  ETN_CLIENT_COMPATIBILITY
                     Emergency override of the compatible client range
                     (default — the server version's minor window,
                     ">=X.Y.0 <X.(Y+1).0").
  ETN_RECOMMENDED_CLIENT_VERSION
                     Emergency override of the recommended client version
                     (default — the server version; must fall within
                     the compatibility range).
  ETN_CLIENT_DOWNLOAD_URL
                     Emergency override of the release page for the
                     "Update client" button (an absolute https:// URL).
  ETN_CLIENT_SHA256  SHA-256 (64 hex) of the Linux client archive for install.sh.
  ETN_API_KEY        API key for "etn mcp" and "etn publications" (unless
                     --api-key is passed).

Run: etn <command> --help for command help.`;

const HELP_INIT = `Usage: etn init --username <login> [--display-name "<name>"] [--key-out <file>]
                etn init --check

Creates the root administrator and the primary API key. A repeated run
fails with "already initialized".

  --key-out <file>   Write the key to a file (for the installer — a directory
                     with restricted access) and do not print it. The key is
                     still issued once: it cannot be recovered.
  --check            Only report the initialization state, change nothing
                     and create nothing. Codes: 0 — the first administrator exists,
                     1 — the server is not initialized, 2 — the check failed.
                     The database is opened strictly read-only; SQLite in WAL mode
                     may create the service files _system.db-shm and
                     _system.db-wal next to it — these are normal SQLite files, the
                     contents of _system.db do not change.`;

const HELP_MCP = `Usage: etn mcp [--api-key <key>]

Starts the MCP server in stdio mode for a local AI agent (for example,
Claude Desktop or an IDE agent). The API key is taken from --api-key or from
the ETN_API_KEY environment variable — startup is rejected without a key.`;

const HELP_PUBLICATIONS = `Usage: etn publications <command> [options]

Commands:
  rebuild   Rebuild the network's publications into a file directory or a single zip
            (for CI pipelines and git hooks).

Run: etn publications <command> --help for command help.`;

const HELP_PUBLICATIONS_REBUILD = `Usage: etn publications rebuild --out <directory> (--network <id> | --network-name <name>) [options]

Rebuilds the network's publications with the same export domain code as REST/the client.
Without --zip it writes <slug>.md|.html files and assets/ into the directory; with --zip — a single archive.
A repeated run with no database changes does not change the file contents (mtime does not count).

Required:
  --out <directory>      Directory for the files (or the zip with --zip).
  --network <id>         Network by id (for agents).
  --network-name <name>  Network by display name (for humans).

Options:
  --layer <id>           Build layer (default — base).
  --ids <id,...>         Rebuild the listed publications (comma-separated).
  --all-active           Rebuild all active publications of the network.
  --format <md|html>     Document format (default md).
  --zip                  A single zip instead of a file directory.
  --api-key <key>        API key (otherwise ETN_API_KEY).

The API key is required: the document is built on behalf of its user.
Environment variables: ETN_DATA_DIR (required), ETN_API_KEY, ETN_LOG_LEVEL.`;

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
      throw new CliError(`Unknown argument: ${t}`);
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
    throw new CliError(`Argument ${flag} requires a value.`);
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
    throw new CliError("The --ids argument contains no ids.");
  }
  return ids;
}

/** Parse `--format` (only `md` | `html`). */
function parseFormat(raw: string): PublicationExportFormat {
  if (raw === 'md' || raw === 'html') return raw;
  throw new CliError(`Unknown format: ${raw} (expected md or html).`);
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
    else throw new CliError(`Unknown argument: ${t}`);
  }

  if (out === null) {
    throw new CliError(
      "The --out argument is required. Example: etn publications rebuild --out ./docs --network <id> --all-active",
    );
  }
  if (networkId !== null && networkName !== null) {
    throw new CliError("Provide only one of: --network or --network-name.");
  }
  if (networkId === null && networkName === null) {
    throw new CliError("Specify a network: --network <id> or --network-name <name>.");
  }
  if (ids !== null && allActive) {
    throw new CliError("Provide only one of: --ids or --all-active.");
  }
  if (ids === null && !allActive) {
    throw new CliError("Specify what to rebuild: --ids <id,...> or --all-active.");
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
      throw new CliError(`Network not found: ${args.networkId}`);
    }
    assertCliNetworkAccess(sys, auth, args.networkId);
    return args.networkId;
  }
  const list = auth.isAdmin ? sys.listAllNetworks() : sys.listNetworksForUser(auth.userId);
  const wanted = args.networkName!.trim().toLowerCase();
  const matches = list.filter((n) => n.display_name.trim().toLowerCase() === wanted);
  if (matches.length === 0) {
    const names = list.map((n) => n.display_name).join(', ') || '—';
    throw new CliError(`Network named "${args.networkName}" not found. Available: ${names}.`);
  }
  if (matches.length > 1) {
    const variants = matches.map((n) => `${n.id} (${n.display_name})`).join('; ');
    throw new CliError(`The name "${args.networkName}" is ambiguous, specify --network: ${variants}.`);
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
    throw new CliError(`No access to network ${networkId}: the user is not a member.`);
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
    throw new CliError(`Layer ${layerId} not found in network ${networkId}.`);
  }
  if (layer.is_service) {
    throw new CliError(`Layer ${layerId} is a service layer — it cannot be selected.`);
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
      "An API key is required to build publications: set ETN_API_KEY or pass --api-key.",
    );
    return 1;
  }

  const sys = SystemDb.open(config.dataDir);
  let networkId: string | null = null;
  try {
    const auth = createApiKeyAuthProvider(sys)(apiKey);
    if (auth === null) {
      console.error("Invalid or disabled API key (check ETN_API_KEY / --api-key).");
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
      const selected = selectActivePublicationIds(ndb);
      ids = selected.ids;
      if (selected.total > PUBLICATION_EXPORT_BATCH_MAX) {
        warnings.push(
          `the list was truncated to ${PUBLICATION_EXPORT_BATCH_MAX} publications (the network has ${selected.total} active ones)`,
        );
      }
    }

    const found: string[] = [];
    for (const id of ids) {
      if (getPublication(ndb, id) === null) warnings.push(`publication not found: ${id}`);
      else found.push(id);
    }
    if (found.length === 0) {
      console.log("No publications to rebuild.");
      for (const w of warnings) console.log(`warning: ${w}`);
      return 0;
    }

    // --- Build files with the export domain --------------------------------
    const { slugById, titleById } = resolvePublicationSlugs(ndb, found);
    const entries: PublicationFile[] = [];
    // Контекст токенов AST-рецепта (профиль «публикации»): часы пересборки,
    // пользователь и первый день недели сети из системной БД. Пересборка CLI
    // обязана видеть тот же отбор, что сборка/экспорт на сервере.
    const net = sys.getNetworkById(networkId);
    const tokenContext = {
      nowMs: Date.now(),
      userId: auth.userId,
      ...(net !== null && net.first_day_of_week !== undefined
        ? { firstDayOfWeek: net.first_day_of_week }
        : {}),
      withTime: filterProfileHasTime('publications'),
    };
    for (const id of found) {
      const slug = slugById.get(id)!;
      try {
        const document = buildPublicationExportDocument(
          ndb,
          id,
          auth.userId,
          resolveUserName,
          tokenContext,
        );
        const artifact = buildPublicationArtifact(ndb, document, args.format, true, '', slug);
        entries.push(...artifact.entries);
        for (const w of artifact.entry.warnings) warnings.push(w);
      } catch (err) {
        const title = titleById.get(id) ?? id;
        warnings.push(
          `publication "${title}" was not built: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (entries.length === 0) {
      console.log("Failed to build any publication.");
      for (const w of warnings) console.log(`warning: ${w}`);
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
    for (const w of warnings) console.log(`warning: ${w}`);
    console.log(
      `Done: ${written + unchanged} files (updated ${written}, unchanged ${unchanged}).`,
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
 * Write the freshly generated key into the installer's protected file
 * (`--key-out`). The file is recreated so that it inherits the ACL of the
 * restricted directory instead of keeping a stale one, and permissions are
 * narrowed to the owner at the POSIX level (`mode` is advisory on Windows —
 * the directory DACL is what actually restricts access, see installer).
 *
 * @returns `true` when the key is safely on disk.
 */
function writeKeyOutFile(keyPath: string, key: string): boolean {
  try {
    mkdirSync(path.dirname(keyPath), { recursive: true });
    rmSync(keyPath, { force: true });
    writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
    return true;
  } catch (err) {
    console.error(
      `Failed to write the key to ${keyPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "The key was not created in the database: fix the directory access and repeat etn init.",
    );
    return false;
  }
}

/**
 * Run the `init` subcommand against `config.dataDir`.
 *
 * The key is delivered exactly once: printed to stdout by default, or written
 * into the `--key-out` file when the installer asks for it. With `--key-out`
 * the file is written **before** the database transaction, so a crash between
 * the two never leaves an administrator whose key is unknown; a failed
 * transaction removes the file again.
 *
 * @returns process exit code (0 = success, 1 = failure).
 */
function runInit(args: InitArgs, config: ServerConfig): number {
  const sys = SystemDb.open(config.dataDir, logger);
  try {
    if (sys.hasFirstUser()) {
      console.error(
        "Error: the ETN server is already initialized (the first administrator exists). " +
          "Re-initialization is not required.",
      );
      return 1;
    }

    const gen = generateApiKey();
    const userId = randomUUID();
    const apiKeyId = randomUUID();

    let keyPath: string | null = null;
    if (args.keyOut !== null) {
      keyPath = path.resolve(args.keyOut);
      if (!writeKeyOutFile(keyPath, gen.key)) return 1;
    }

    try {
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
    } catch (err) {
      if (keyPath !== null) rmSync(keyPath, { force: true });
      throw err;
    }

    console.log("ETN is initialized.");
    console.log('');
    console.log("Administrator user created:");
    console.log(`  Username:          ${args.username}`);
    if (args.displayName) {
      console.log(`  Display name:      ${args.displayName}`);
    }
    console.log('');
    if (keyPath !== null) {
      console.log("The primary API key was written to a protected file (not printed to the console):");
      console.log(`  ${keyPath}`);
    } else {
      console.log("Primary API key (shown once — save it):");
      console.log(`  ${gen.key}`);
    }
    console.log('');
    console.log(
      "Warning: do not send the key over open channels. It cannot be " +
        "recovered — only reissued by an administrator.",
    );
    return 0;
  } finally {
    sys.close();
  }
}

/** Exit code of `etn init --check`: the first administrator exists. */
const INIT_CHECK_INITIALIZED = 0;
/** Exit code of `etn init --check`: no first administrator (init is needed). */
const INIT_CHECK_NOT_INITIALIZED = 1;
/** Exit code of `etn init --check`: the state could not be determined. */
const INIT_CHECK_FAILED = 2;

/**
 * Run `etn init --check` — the installer's idempotency probe (task 686c5d76).
 *
 * The criterion is `hasFirstUser()`, not the presence of `_system.db`: a
 * database left over from an interrupted attempt must be initialised again.
 * The check opens the database strictly read-only and never creates the data
 * directory, the database file or migrations. SQLite in WAL mode can create the
 * `_system.db-shm`/`_system.db-wal` sidecars on a read-only open: they are
 * normal SQLite service files and do not change the database contents
 * (9b310991); `hasFirstUser()` behaviour is unchanged.
 *
 * @returns 0 — initialised, 1 — not initialised, 2 — check failed.
 */
function runInitCheck(config: ServerConfig): number {
  const result = SystemDb.checkFirstUser(config.dataDir);
  if (result.state === 'unreadable') {
    console.error(`Failed to check initialization: ${result.error}`);
    return INIT_CHECK_FAILED;
  }
  if (result.state === 'initialized') {
    console.log("The server is initialized: the first administrator exists.");
    return INIT_CHECK_INITIALIZED;
  }
  if (result.reason === 'no-db') {
    console.log("The server is not initialized: the _system.db file does not exist.");
  } else if (result.reason === 'no-users-table') {
    console.log("The server is not initialized: _system.db has no users table.");
  } else {
    console.log("The server is not initialized: there is no first administrator.");
  }
  return INIT_CHECK_NOT_INITIALIZED;
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
        err instanceof ConfigError ? `Configuration error: ${err.message}` : (err as Error).message,
      );
      return 1;
    }
    return parsed.check ? runInitCheck(config) : runInit(parsed, config);
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
        err instanceof ConfigError ? `Configuration error: ${err.message}` : (err as Error).message,
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
      // Батч-запись идёт через пул записи (задача c8920d04, ADR ca3a9218): та же
      // причина — синхронный better-sqlite3 заморозил бы stdio-процесс целиком.
      // `ETN_WRITE_POOL_SIZE=0` выключает пул и возвращает запись в главный поток.
      configureWritePool({
        size: config.writePool.size,
        taskTimeoutMs: config.writePool.taskTimeoutMs,
        idleEvictionMs: config.writePool.idleEvictionMs,
      });
      // Logger is built inside runStdioMcp (stderr-bound) to keep stdout clean.
      await runStdioMcp({ dataDir: config.dataDir, apiKey });
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    } finally {
      // Порядок как при остановке HTTP-сервера: сначала дождаться слива очереди
      // записи и закрыть воркеры, потом читателей.
      const drained = await drainWritePool();
      if (!drained.drained) {
        console.error("write pool: the queue did not drain within the allotted time");
      }
      await closeWritePool();
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
          err instanceof ConfigError ? `Configuration error: ${err.message}` : (err as Error).message,
        );
        return 1;
      }
      return runPublicationsRebuild(parsed, config, env);
    }
    console.error(`Unknown command: publications ${sub}`);
    console.log(HELP_PUBLICATIONS);
    return 1;
  }

  console.error(`Unknown command: ${command}`);
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
