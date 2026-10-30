/**
 * Server version and the client compatibility/update channel contract of
 * `GET /api/v1/version` (компонент `server/src/version.ts`; сущность «Ответ
 * GET /version», требование e3ef572c, ADR 065a925d).
 *
 * The server version is read from `@etn/server`'s `package.json` so it cannot
 * drift from the published artefact. Every other value is derived from it:
 * `client_compatibility` is the minor window of the server version (computed
 * by `compatibilityRangeFor` from `@etn/shared` — never a hardcoded range),
 * `min_client` is that window's lower bound, `recommended_client_version`
 * defaults to the server version and `client_download_url` to the GitHub
 * release page of that version.
 *
 * Emergency overrides (`ETN_CLIENT_COMPATIBILITY`,
 * `ETN_RECOMMENDED_CLIENT_VERSION`, `ETN_CLIENT_DOWNLOAD_URL`,
 * `ETN_CLIENT_SHA256`) are read once at startup by `config.ts`; invalid values
 * abort the start with an operator-friendly `ConfigError` instead of serving a
 * silently broken contract.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compatibilityRangeFor,
  parseRangeBounds,
  parseSemver,
  satisfiesRange,
  type HealthResponse,
  type VersionResponse,
} from '@etn/shared';

/** API path/major version segment (`/api/v1`). Bumped only on a parallel `/api/v2`. */
export const API_VERSION = 'v1' as const;

/**
 * Repository slug that owns the published releases. Single source for every
 * release URL the server builds (release page, update feed, download links).
 */
export const ETN_REPOSITORY = 'nerkuda/e-tho-net';

/**
 * Base of the default `client_download_url`: the GitHub release **page**
 * (never a direct asset link — the client opens it in a browser, and the user
 * downloads and verifies the artefact manually).
 */
export const CLIENT_RELEASE_PAGE_BASE = `https://github.com/${ETN_REPOSITORY}/releases/tag/v`;

/** Shape of the `ETN_CLIENT_SHA256` value: a lowercase or uppercase SHA-256 hex digest. */
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Client compatibility and update channel exposed by `GET /api/v1/version`.
 *
 * Produced by {@link resolveClientChannel} from the server version and the
 * `ETN_CLIENT_*` overrides, kept in `ServerConfig.clientChannel` and rendered
 * into the response by {@link buildVersionPayload}.
 */
export interface ClientChannel {
  /** Semver range `>=X.Y.Z <X.Y.Z` of compatible client versions. */
  readonly client_compatibility: string;
  /** Lower bound of {@link client_compatibility}. */
  readonly min_client: string;
  /** Client version the server recommends installing. */
  readonly recommended_client_version: string;
  /** Release page (absolute `https://` URL) the client opens in a browser. */
  readonly client_download_url: string;
  /** SHA-256 of the Linux client archive, or `null` when not configured. */
  readonly client_sha256: string | null;
}

/**
 * Invalid `ETN_CLIENT_*` configuration. Raised while resolving the channel;
 * `config.ts` re-throws it as its `ConfigError` so the operator sees a
 * uniform startup error and the server does not start.
 */
export class VersionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionConfigError';
  }
}

/** Read the server `version` field from the nearest `package.json`. */
function readServerVersion(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  // Works under tsx (src/) and the compiled build (dist/) — both sit one or two
  // levels below the package root that owns package.json.
  let cur = dir;
  for (let i = 0; i < 4; i++) {
    const pkgPath = path.join(cur, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) {
        return pkg.version;
      }
    }
    cur = path.dirname(cur);
  }
  // Fallback: should never happen in a checked-out repo.
  return '0.0.0-unknown';
}

/** Resolved server version (read once at module load). */
export const SERVER_VERSION: string = readServerVersion();

/** Process start timestamp, frozen at module load for `uptime` reporting. */
export const HEALTH_STARTED_AT: string = new Date().toISOString();

/** Static part of the `/health` response (uptime is filled in per-request). */
export const HEALTH_RESPONSE: Omit<HealthResponse, 'uptime'> = {
  status: 'ok',
  version: SERVER_VERSION,
};

/** Default release page of a version: `https://github.com/nerkuda/e-tho-net/releases/tag/v<version>`. */
export function defaultClientDownloadUrl(version: string): string {
  return `${CLIENT_RELEASE_PAGE_BASE}${version}`;
}

/**
 * Resolve the client compatibility/update channel from the environment.
 *
 * Defaults come from `serverVersion` (`client_compatibility` via
 * `compatibilityRangeFor`, `min_client` — its lower bound,
 * `recommended_client_version` — the server version itself,
 * `client_download_url` — the GitHub release page of that version,
 * `client_sha256` — `null`).
 *
 * Overrides replace the defaults after validation; a violation throws
 * {@link VersionConfigError} with a message naming the variable:
 * - `ETN_CLIENT_COMPATIBILITY` — the two-bound grammar `>=X.Y.Z <X.Y.Z` whose
 *   window is satisfiable (a non-canonical upper bound such as
 *   `>=0.15.0 <0.15.4` admits nothing and is rejected);
 * - `ETN_RECOMMENDED_CLIENT_VERSION` — a version inside the effective range;
 * - `ETN_CLIENT_DOWNLOAD_URL` — an absolute `https://` URL (a release page);
 * - `ETN_CLIENT_SHA256` — 64 hex characters (stored lowercase).
 *
 * Blank values are treated as "not set" (the variable is simply empty).
 */
export function resolveClientChannel(
  env: NodeJS.ProcessEnv = process.env,
  serverVersion: string = SERVER_VERSION,
): ClientChannel {
  const defaultRange = compatibilityRangeFor(serverVersion);
  if (defaultRange === null) {
    throw new VersionConfigError(
      `Cannot derive client_compatibility: server version ${JSON.stringify(serverVersion)} is not a valid semver.`,
    );
  }

  const overrideRaw = env.ETN_CLIENT_COMPATIBILITY?.trim();
  const overrideRange =
    overrideRaw !== undefined && overrideRaw !== '' ? resolveRange(overrideRaw) : null;
  const fallbackBounds = parseRangeBounds(defaultRange);
  /* c8 ignore next — `compatibilityRangeFor` always emits the two-bound grammar. */
  if (fallbackBounds === null) {
    throw new VersionConfigError(
      `Cannot derive min_client: ${JSON.stringify(defaultRange)} is not a two-bound range.`,
    );
  }
  const client_compatibility = overrideRange?.range ?? defaultRange;
  const min_client = overrideRange?.lower ?? fallbackBounds.lower;

  const recommendedRaw = env.ETN_RECOMMENDED_CLIENT_VERSION?.trim();
  const recommended_client_version =
    recommendedRaw !== undefined && recommendedRaw !== '' ? recommendedRaw : serverVersion;
  if (parseSemver(recommended_client_version) === null) {
    throw new VersionConfigError(
      `ETN_RECOMMENDED_CLIENT_VERSION must be a version like "0.15.1", got: ${JSON.stringify(recommended_client_version)}.`,
    );
  }
  if (!satisfiesRange(recommended_client_version, client_compatibility)) {
    throw new VersionConfigError(
      `ETN_RECOMMENDED_CLIENT_VERSION ${JSON.stringify(recommended_client_version)} is outside client_compatibility ${JSON.stringify(client_compatibility)}.`,
    );
  }

  const urlRaw = env.ETN_CLIENT_DOWNLOAD_URL?.trim();
  const client_download_url =
    urlRaw !== undefined && urlRaw !== '' ? urlRaw : defaultClientDownloadUrl(serverVersion);
  if (!isAbsoluteHttpsUrl(client_download_url)) {
    throw new VersionConfigError(
      `ETN_CLIENT_DOWNLOAD_URL must be an absolute https:// URL (a release page), got: ${JSON.stringify(client_download_url)}.`,
    );
  }

  const shaRaw = env.ETN_CLIENT_SHA256?.trim();
  let client_sha256: string | null = null;
  if (shaRaw !== undefined && shaRaw !== '') {
    if (!SHA256_PATTERN.test(shaRaw)) {
      throw new VersionConfigError(
        `ETN_CLIENT_SHA256 must be a 64-character hex SHA-256 digest, got: ${JSON.stringify(shaRaw)}.`,
      );
    }
    client_sha256 = shaRaw.toLowerCase();
  }

  return {
    client_compatibility,
    min_client,
    recommended_client_version,
    client_download_url,
    client_sha256,
  };
}

/**
 * Build the `GET /api/v1/version` body from the resolved channel.
 *
 * All seven fields are always present; the optional ones carry `null` when
 * unset, so a consumer sees the complete contract in one response.
 */
export function buildVersionPayload(channel: ClientChannel): VersionResponse {
  return {
    version: SERVER_VERSION,
    api: API_VERSION,
    min_client: channel.min_client,
    client_compatibility: channel.client_compatibility,
    recommended_client_version: channel.recommended_client_version,
    client_download_url: channel.client_download_url,
    client_sha256: channel.client_sha256,
  };
}

/**
 * Validate the `ETN_CLIENT_COMPATIBILITY` override.
 *
 * The override must pass the shared two-bound grammar and admit at least one
 * version. Satisfiability is checked by feeding the lower bound back into
 * `satisfiesRange`: the window is non-empty exactly when the lower bound
 * itself satisfies it (the upper bound is compared by `(major, minor)`), so a
 * same-minor upper bound like `>=0.15.0 <0.15.4` is rejected here instead of
 * silently blocking every client.
 */
function resolveRange(raw: string): { range: string; lower: string } {
  const bounds = parseRangeBounds(raw);
  if (bounds === null) {
    throw new VersionConfigError(
      `ETN_CLIENT_COMPATIBILITY must be a range of the form ">=X.Y.Z <X.Y.Z", got: ${JSON.stringify(raw)}.`,
    );
  }
  if (!satisfiesRange(bounds.lower, raw)) {
    throw new VersionConfigError(
      `ETN_CLIENT_COMPATIBILITY ${JSON.stringify(raw)} admits no version: its upper bound is not above the lower one.`,
    );
  }
  return { range: raw, lower: bounds.lower };
}

/** True for an absolute `https://` URL with a non-empty host. */
function isAbsoluteHttpsUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.hostname !== '';
}
