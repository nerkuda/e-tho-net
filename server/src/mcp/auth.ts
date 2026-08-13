/**
 * MCP API-key authentication (task F2, docs/05-mcp-server.md §2).
 *
 * Reuses the REST auth stack verbatim: {@link hashApiKey} +
 * {@link SystemDb.findApiKeyByHash} (which already enforces the disabled
 * key / disabled user rules of docs/06-auth.md §3). The result is a compact
 * {@link McpAuthContext} describing the principal the agent acts as (05 §2.1).
 *
 * Key acquisition differs by transport (05 §2):
 *   * stdio  — `ETN_API_KEY` env or `etn mcp --api-key` (see cli.ts);
 *   * HTTP   — `Authorization: Bearer <key>` header (see mcp/http.ts).
 */

import { hashApiKey, isValidApiKeyFormat } from '../auth/api-key.js';
import type { SystemDb } from '../db/system-db.js';
import type { McpAuthContext, McpAuthProvider } from './types.js';

/**
 * Build the production auth provider over an open {@link SystemDb}.
 *
 * A malformed key is rejected without hashing (format check first);
 * `findApiKeyByHash` returns `null` for unknown, disabled keys and for keys
 * whose owner is disabled — all treated as authentication failure. Successful
 * lookups refresh `last_used_at` (docs/06-auth.md §3.5).
 */
export function createApiKeyAuthProvider(systemDb: SystemDb): McpAuthProvider {
  return (rawApiKey: string): McpAuthContext | null => {
    if (rawApiKey === '' || !isValidApiKeyFormat(rawApiKey)) {
      return null;
    }
    const found = systemDb.findApiKeyByHash(hashApiKey(rawApiKey));
    if (found === null) {
      return null;
    }
    systemDb.touchApiKeyUsed(found.apiKey.id);
    return {
      userId: found.user.id,
      username: found.user.username,
      keyId: found.apiKey.id,
      keyPrefix: found.apiKey.prefix,
      readOnly: found.apiKey.read_only,
      isAdmin: found.user.is_admin,
    };
  };
}
