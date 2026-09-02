/**
 * URL protocol allow-list for the unified renderer (parity with the previous
 * server-only renderer, docs/03-server-api.md §10): links — `http`/`https`/
 * `mailto` plus the app's `etnimg:` scheme for local attachment files
 * (`[имя](etnimg://…)` references inserted by the client's clipboard-paste
 * flow); images additionally allow `data:` and `file:` (`etnimg:` is served
 * by the Electron client for local attachment files). Scheme-less (relative)
 * URLs are accepted. Control characters are always rejected.
 */

const LINK_PROTOCOLS: readonly string[] = ['http', 'https', 'mailto', 'etnimg'];
const IMAGE_PROTOCOLS: readonly string[] = [
  'http',
  'https',
  'mailto',
  'data',
  'file',
  'etnimg',
];

/** True when `url` is safe for an `<a href>` / `<img src>` under `allowData`. */
export function isSafeUrl(url: string, allowData: boolean): boolean {
  const trimmed = url.trim();
  if (trimmed === '') return false;
  // Reject control characters anywhere in the URL (C0 range + DEL).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (schemeMatch === null) return true; // relative URL
  const scheme = schemeMatch[1]!.toLowerCase();
  return (allowData ? IMAGE_PROTOCOLS : LINK_PROTOCOLS).includes(scheme);
}
