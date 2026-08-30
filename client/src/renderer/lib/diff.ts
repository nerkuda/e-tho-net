/**
 * Minimal line-based text diff (S11, 13-layers.md §10.3) — no dependencies.
 *
 * Powers the «Содержание» tab of the layer diff dialog: two documents are
 * split into lines and compared with a classic LCS dynamic program. The cell
 * budget keeps pathological inputs (documents far beyond MVP scale) from
 * freezing the renderer — beyond it the diff degrades to one delete block
 * followed by one add block, which is honest, just less readable.
 */

/** One rendered line of the diff. */
export interface LineDiffEntry {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** LCS cells beyond which the diff degrades to a coarse delete+add pair. */
const MAX_CELLS = 4_000_000;

/**
 * Compare two documents line by line. `oldText` lines are emitted as `del`,
 * `newText` lines as `add`, shared lines as `same` — a classic unified-diff
 * reading order (deletes first, then adds, blocks grouped).
 */
export function lineDiff(oldText: string, newText: string): LineDiffEntry[] {
  // An empty document has no lines — `''.split('\n')` would yield a single
  // empty line and show a spurious delete block.
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const n = oldLines.length;
  const m = newLines.length;

  if (n * m > MAX_CELLS) {
    return [
      ...oldLines.map((text) => ({ kind: 'del' as const, text })),
      ...newLines.map((text) => ({ kind: 'add' as const, text })),
    ];
  }

  // dp[i][j] = LCS length of oldLines[0..i) vs newLines[0..j).
  const cols = m + 1;
  const dp = new Uint32Array((n + 1) * cols);
  for (let i = 1; i <= n; i++) {
    const rowBase = i * cols;
    const prevBase = (i - 1) * cols;
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[rowBase + j] = dp[prevBase + j - 1]! + 1;
      } else {
        dp[rowBase + j] = Math.max(dp[prevBase + j]!, dp[rowBase + j - 1]!);
      }
    }
  }

  // Backtrace from the end; collect reversed, then flip once.
  const entries: LineDiffEntry[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const base = i * cols;
    if (oldLines[i - 1] === newLines[j - 1]) {
      entries.push({ kind: 'same', text: oldLines[i - 1]! });
      i--;
      j--;
    } else if (dp[base + j - 1]! >= dp[(i - 1) * cols + j]!) {
      entries.push({ kind: 'add', text: newLines[j - 1]! });
      j--;
    } else {
      entries.push({ kind: 'del', text: oldLines[i - 1]! });
      i--;
    }
  }
  while (i > 0) {
    entries.push({ kind: 'del', text: oldLines[i - 1]! });
    i--;
  }
  while (j > 0) {
    entries.push({ kind: 'add', text: newLines[j - 1]! });
    j--;
  }
  entries.reverse();
  return entries;
}
