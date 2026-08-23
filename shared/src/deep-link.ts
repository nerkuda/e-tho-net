/**
 * Helpers for the `etn://open?net=<id>&thought=<id>` deep-link URL
 * (task R4, docs/12-wiki-id-refs.md §7, docs/05-mcp-server.md §4).
 *
 * Used by:
 * - The Electron client (`etn://` custom protocol registration + deep-link
 *   dispatcher, task R11).
 * - MCP agents that want to return a human-friendly link to the user
 *   (task R5).
 *
 * The format mirrors `obsidian://open?vault=…&file=…` (Obsidian deep link).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A parsed `etn://open` deep link. Both ids are UUID v4 (any variant;
 * case-insensitive on input).
 */
export interface DeepLink {
  networkId: string;
  thoughtId: string;
}

/** Public scheme constant — also referenced from client/main (R11). */
export const DEEP_LINK_SCHEME = 'etn://open';

/**
 * Build a `etn://open?net=<networkId>&thought=<thoughtId>` URL. Both ids must
 * be UUIDs (any variant, case-insensitive); the returned URL uses lowercase.
 *
 * @throws `RangeError` if either id is not a UUID.
 */
export function buildDeepLinkUrl(params: DeepLink): string {
  const { networkId, thoughtId } = params;
  if (!UUID_RE.test(networkId)) {
    throw new RangeError(`buildDeepLinkUrl: invalid networkId ${networkId}`);
  }
  if (!UUID_RE.test(thoughtId)) {
    throw new RangeError(`buildDeepLinkUrl: invalid thoughtId ${thoughtId}`);
  }
  const params_ = new URLSearchParams({
    net: networkId.toLowerCase(),
    thought: thoughtId.toLowerCase(),
  });
  return `${DEEP_LINK_SCHEME}?${params_.toString()}`;
}

/**
 * Strictly parse a string as an `etn://open?net=<uuid>&thought=<uuid>` URL.
 *
 * Returns `null` for any deviation:
 * - not the `etn://open` scheme;
 * - missing or non-UUID `net` / `thought` query parameters;
 * - unexpected URL shape (extra pathname, malformed query, …).
 *
 * Extra query parameters are ignored (forward-compatible).
 */
export function parseDeepLinkUrl(input: string): DeepLink | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'etn:') return null;
  // `etn://open?…` — protocol `etn:`, host `open`. We require the scheme
  // constant exactly (case-insensitive) and no extra path components.
  if (url.host.toLowerCase() !== 'open') return null;
  if (url.pathname !== '' && url.pathname !== '/') return null;

  const net = url.searchParams.get('net');
  const thought = url.searchParams.get('thought');
  if (net === null || thought === null) return null;
  if (!UUID_RE.test(net) || !UUID_RE.test(thought)) return null;

  return {
    networkId: net.toLowerCase(),
    thoughtId: thought.toLowerCase(),
  };
}

/**
 * Extract a deep link from an `argv`-style array (Win/Linux cold start).
 * Returns `null` if no element looks like an `etn://open?…` URL.
 *
 * The check is intentionally permissive: any element starting with the
 * `etn://open` prefix is fed to {@link parseDeepLinkUrl}. Real Electron
 * platforms only append the URL once, but other flags may share a common
 * prefix (e.g. `--enable-etn-…`) — those don't start with `etn://open`,
 * so they are filtered out by the prefix test.
 */
export function extractDeepLinkFromArgv(argv: readonly string[]): DeepLink | null {
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    if (!arg.toLowerCase().startsWith(DEEP_LINK_SCHEME)) continue;
    const parsed = parseDeepLinkUrl(arg);
    if (parsed !== null) return parsed;
  }
  return null;
}
