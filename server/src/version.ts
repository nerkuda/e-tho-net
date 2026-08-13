/**
 * Server version and client-compatibility contract (tasks B7, 03-server-api.md
 * §16–17).
 *
 * The server version is read from `@etn/server`'s `package.json` so it cannot
 * drift from the published artefact. `MIN_CLIENT_VERSION` / `API_VERSION` are
 * bumped manually on breaking changes — clients consult `GET /api/v1/version`
 * to decide whether they may connect.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { HealthResponse, VersionResponse } from '@etn/shared';

/** API path/major version segment (`/api/v1`). Bumped only on a parallel `/api/v2`. */
export const API_VERSION = 'v1' as const;

/**
 * Lowest client version considered compatible with this server. Bump when an
 * incompatible wire change lands under `/api/v1`.
 */
export const MIN_CLIENT_VERSION = '0.1.0';

/** Semver range string exposed to clients via {@link VersionResponse}. */
export const CLIENT_COMPATIBILITY = `>=${MIN_CLIENT_VERSION}`;

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

/**
 * Payload of `GET /api/v1/version`.
 *
 * Satisfies the shared {@link VersionResponse} contract and additionally
 * surfaces `api` and `min_client` (the shape described in the B7 task spec),
 * so clients built against either form keep working.
 */
export const VERSION_PAYLOAD: VersionResponse & { api: typeof API_VERSION; min_client: string } = {
  version: SERVER_VERSION,
  api: API_VERSION,
  min_client: MIN_CLIENT_VERSION,
  client_compatibility: CLIENT_COMPATIBILITY,
};
