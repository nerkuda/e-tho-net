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
 *
 * Publications (0.11.1, задача f37b468d, требование 7f583ef9) reuse the same
 * scheme with the `publication` query parameter instead of `thought`:
 * `etn://open?net=<id>&publication=<id>`. The thought and publication forms are
 * mutually exclusive — a URL carries exactly one of them.
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

/** A parsed publication `etn://open` deep link (задача f37b468d). */
export interface PublicationDeepLink {
  networkId: string;
  publicationId: string;
}

/** Public scheme constant — also referenced from client/main (R11). */
export const DEEP_LINK_SCHEME = 'etn://open';

/** Query parameter naming a publication in an `etn://open` URL. */
export const PUBLICATION_DEEP_LINK_PARAM = 'publication';

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
 * Extra query parameters are ignored (forward-compatible), EXCEPT the
 * publication form (`publication`) — a URL carrying it is the mutually
 * exclusive publication deep link and is rejected here (see
 * `parsePublicationDeepLinkUrl`).
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
  // The thought and publication forms are mutually exclusive: a URL carrying
  // both is ambiguous and rejected (симметрично с parsePublicationDeepLinkUrl).
  if (url.searchParams.has(PUBLICATION_DEEP_LINK_PARAM)) return null;

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

// ---------------------------------------------------------------------------
// Publications (0.11.1, задача f37b468d, требование 7f583ef9)
// ---------------------------------------------------------------------------

/**
 * Build a `etn://open?net=<networkId>&publication=<publicationId>` URL. Both
 * ids must be UUIDs (any variant, case-insensitive); the returned URL uses
 * lowercase.
 *
 * @throws `RangeError` if either id is not a UUID.
 */
export function buildPublicationDeepLinkUrl(params: PublicationDeepLink): string {
  const { networkId, publicationId } = params;
  if (!UUID_RE.test(networkId)) {
    throw new RangeError(`buildPublicationDeepLinkUrl: invalid networkId ${networkId}`);
  }
  if (!UUID_RE.test(publicationId)) {
    throw new RangeError(`buildPublicationDeepLinkUrl: invalid publicationId ${publicationId}`);
  }
  const search = new URLSearchParams({
    net: networkId.toLowerCase(),
    [PUBLICATION_DEEP_LINK_PARAM]: publicationId.toLowerCase(),
  });
  return `${DEEP_LINK_SCHEME}?${search.toString()}`;
}

/**
 * Strictly parse a string as an `etn://open?net=<uuid>&publication=<uuid>` URL.
 *
 * Returns `null` for any deviation: wrong scheme/host, extra path, missing or
 * non-UUID `net`/`publication`, or a URL that also carries `thought` (the two
 * forms are mutually exclusive). Extra query parameters are ignored
 * (forward-compatible).
 */
export function parsePublicationDeepLinkUrl(input: string): PublicationDeepLink | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'etn:') return null;
  if (url.host.toLowerCase() !== 'open') return null;
  if (url.pathname !== '' && url.pathname !== '/') return null;
  // A thought URL is not a publication URL.
  if (url.searchParams.has('thought')) return null;

  const net = url.searchParams.get('net');
  const publication = url.searchParams.get(PUBLICATION_DEEP_LINK_PARAM);
  if (net === null || publication === null) return null;
  if (!UUID_RE.test(net) || !UUID_RE.test(publication)) return null;

  return {
    networkId: net.toLowerCase(),
    publicationId: publication.toLowerCase(),
  };
}

/**
 * Extract a publication deep link from an `argv`-style array (Win/Linux cold
 * start). Returns `null` if no element looks like a publication
 * `etn://open?…` URL.
 */
export function extractPublicationDeepLinkFromArgv(
  argv: readonly string[],
): PublicationDeepLink | null {
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    if (!arg.toLowerCase().startsWith(DEEP_LINK_SCHEME)) continue;
    const parsed = parsePublicationDeepLinkUrl(arg);
    if (parsed !== null) return parsed;
  }
  return null;
}
