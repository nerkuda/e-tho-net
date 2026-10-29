/**
 * Semver parsing, precedence comparison and the minor-window compatibility
 * range shared by `@etn/server` and `@etn/client`.
 *
 * Compatibility policy (ADR "диапазон совместимости — minor-окно, вычисляемое
 * из версии сервера"): a version belongs to a window when its `major.minor`
 * pair matches the server's and it is not older than `X.Y.0`. The generated
 * range is `>=X.Y.0 <X.(Y+1).0`.
 *
 * The upper bound is checked by the `(major, minor)` pair, not by full semver
 * precedence: `0.16.0-rc.1` sorts below `0.16.0` as a prerelease, so a plain
 * string comparison would leak a prerelease of the next minor into the
 * `0.15.x` window. The lower bound is compared as a full version, so a
 * prerelease of `X.Y.0` itself stays outside (`0.15.0-rc.1` < `0.15.0`).
 *
 * This is the single semver implementation of the project — neither side may
 * duplicate the parsing or hardcode the range. Pure functions only: no I/O, no
 * configuration and no knowledge of headers or HTTP.
 *
 * Leniency (documented on purpose, narrower than a full semver library):
 * - leading zeros in numeric parts are accepted and normalised (`0.015.01` is
 *   `0.15.1`), so comparison never depends on the spelling;
 * - build metadata (`+build.7`) is accepted and ignored: it does not take part
 *   in precedence (SemVer 2.0.0 §10).
 */

/** Parsed version. `prerelease` is empty for a release. */
export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

/** `X.Y.Z` with optional `-prerelease` and `+build` suffixes (SemVer 2.0.0). */
const SEMVER_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * The only range grammar we accept: `>=X.Y.Z <X.Y.Z` — both bounds are
 * mandatory and separated by one space. Anything else (the legacy `>=0.1.0`,
 * `<=`, a bare version) is rejected by {@link satisfiesRange}.
 */
const RANGE_PATTERN = /^>=([^\s]+) <([^\s]+)$/;

/** A pre-release identifier made of digits only compares numerically. */
const NUMERIC_IDENTIFIER = /^\d+$/;

/**
 * Parses a version into its components.
 *
 * Returns `null` for anything that is not a version — including `''`, `0.15`,
 * `v0.15.0`, `garbage` and non-string values coming from JSON or headers. The
 * function never throws.
 */
export function parseSemver(input: string | null | undefined): Semver | null {
  if (typeof input !== 'string') return null;
  const match = SEMVER_PATTERN.exec(input);
  if (match === null) return null;
  const major = parseNumericComponent(match[1]);
  const minor = parseNumericComponent(match[2]);
  const patch = parseNumericComponent(match[3]);
  if (major === null || minor === null || patch === null) return null;
  const prerelease = match[4];
  return {
    major,
    minor,
    patch,
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  };
}

/**
 * Compares two versions by SemVer 2.0.0 precedence: a release ranks above its
 * prereleases, numeric pre-release identifiers compare numerically and rank
 * below alphanumeric ones, a longer identical prefix ranks higher.
 *
 * Returns `-1`/`0`/`1`, or `null` when either side is not a version — ordering
 * is never guessed for unparseable input.
 */
export function compareSemver(
  a: string | null | undefined,
  b: string | null | undefined,
): -1 | 0 | 1 | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === null || right === null) return null;
  return compareParsed(left, right);
}

/**
 * Builds the compatibility range for a server version: `>=X.Y.0 <X.(Y+1).0`.
 *
 * Only `major` and `minor` are used — patch and prerelease are dropped, so
 * `0.15.1-rc.1` yields `>=0.15.0 <0.16.0`. Returns `null` for an invalid
 * version: callers must fail loudly instead of substituting a default range.
 */
export function compatibilityRangeFor(serverVersion: string | null | undefined): string | null {
  const parsed = parseSemver(serverVersion);
  if (parsed === null) return null;
  return `>=${parsed.major}.${parsed.minor}.0 <${parsed.major}.${parsed.minor + 1}.0`;
}

/**
 * Returns the two bounds of `range` as written, or `null` when the string is
 * not the accepted grammar `>=X.Y.Z <X.Y.Z` (both bounds required, exactly one
 * space between them) or either bound is not a version.
 *
 * The bounds are returned verbatim (no normalisation) so callers can expose
 * the lower bound to clients — that is how `GET /version` reports `min_client`
 * and `client_compatibility` from the same range. Grammar lives here, next to
 * {@link satisfiesRange}, so no consumer re-implements it.
 */
export function parseRangeBounds(
  range: string | null | undefined,
): { lower: string; upper: string } | null {
  if (typeof range !== 'string') return null;
  const match = RANGE_PATTERN.exec(range.trim());
  if (match === null) return null;
  const lower = match[1];
  const upper = match[2];
  if (lower === undefined || upper === undefined) return null;
  if (parseSemver(lower) === null || parseSemver(upper) === null) return null;
  return { lower, upper };
}

/**
 * Checks whether `version` belongs to the minor window described by `range`.
 *
 * `range` must be the exact two-bound grammar `>=X.Y.Z <X.Y.Z`; both bounds are
 * required, so the legacy `>=0.1.0` form is not satisfied by anything. The
 * lower bound is compared as a full version, the upper one by `(major, minor)`
 * — the window is defined by the upper bound's minor, not by its patch.
 *
 * Returns `false` — never throws — for a malformed range or version.
 */
export function satisfiesRange(
  version: string | null | undefined,
  range: string | null | undefined,
): boolean {
  const parsedVersion = parseSemver(version);
  if (parsedVersion === null) return false;
  const bounds = parseRange(range);
  if (bounds === null) return false;
  if (compareParsed(parsedVersion, bounds.lower) < 0) return false;
  return compareMajorMinor(parsedVersion, bounds.upper) < 0;
}

/** Parses the two-bound range grammar; `null` when it is anything else. */
function parseRange(range: string | null | undefined): { lower: Semver; upper: Semver } | null {
  if (typeof range !== 'string') return null;
  const match = RANGE_PATTERN.exec(range.trim());
  if (match === null) return null;
  const lower = parseSemver(match[1]);
  const upper = parseSemver(match[2]);
  if (lower === null || upper === null) return null;
  return { lower, upper };
}

/** Numeric component: leading zeros are fine, precision loss is not. */
function parseNumericComponent(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function compareParsed(a: Semver, b: Semver): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** Compares only `major.minor`, ignoring patch, prerelease and build. */
function compareMajorMinor(a: Semver, b: Semver): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  return 0;
}

function comparePrerelease(a: readonly string[], b: readonly string[]): -1 | 0 | 1 {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const common = Math.min(a.length, b.length);
  for (let i = 0; i < common; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) break;
    const order = compareIdentifier(left, right);
    if (order !== 0) return order;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function compareIdentifier(a: string, b: string): -1 | 0 | 1 {
  const aNumeric = NUMERIC_IDENTIFIER.test(a);
  const bNumeric = NUMERIC_IDENTIFIER.test(b);
  if (aNumeric && bNumeric) return compareNumericStrings(a, b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  // ASCII order on purpose: comparison must not depend on the runtime locale.
  return a < b ? -1 : 1;
}

/** Compares digit strings numerically without `Number()` precision loss. */
function compareNumericStrings(a: string, b: string): -1 | 0 | 1 {
  const left = a.replace(/^0+(?=\d)/, '');
  const right = b.replace(/^0+(?=\d)/, '');
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
