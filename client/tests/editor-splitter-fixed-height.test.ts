/**
 * Structural checks for the always-fixed splitter policy (bugs 6b757336,
 * 4cc6248c; требование «Высота областей и таблиц не зависит от содержимого»):
 * every area with a `persistKey` rowSplitter must keep its saved height as an
 * exact `height` (inline via `applyGroupClamp` or through a `--clamp-*` CSS
 * variable) so the visible size survives re-renders and restarts and never
 * depends on the current row count; the drag range must be content-unbounded
 * (FIXED_MAX_PX) — no call site may clamp it to the area's `scrollHeight`,
 * otherwise the user cannot grow a one-row table above its single row.
 *
 * The DOM-bound code pulls in IPC, realtime and dialog modules — heavy for
 * the unit runner. Like the sibling structural tests
 * (`editor-tabs-structure.test.ts`, `type-editor-tabs.test.ts`), these
 * checks stay cheap by asserting the source text of the relevant files.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const SRC = {
  splitter: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'splitter.ts'),
  listHeights: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'list-heights.ts'),
  links: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'links-tab.ts'),
  chronoTab: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'chrono-tab.ts'),
  attachments: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'attachments.ts'),
  chronicle: resolve(
    import.meta.dirname,
    '..',
    'src',
    'renderer',
    'screens',
    'chronicle',
    'chronicle.ts',
  ),
};

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('always-fixed политика сплиттера (bug 4cc6248c, требование фиксированных высот)', () => {
  it('applyGroupClamp задаёт фиксированную высоту inline, а не max-height', () => {
    const src = readText(SRC.listHeights);
    const idx = src.indexOf('export function applyGroupClamp');
    assert.ok(idx >= 0, 'applyGroupClamp is exported');
    const body = src.slice(idx);
    assert.ok(
      /group\.style\.height\s*=\s*`\$\{px\}px`/.test(body),
      'applyGroupClamp sets inline style.height from the saved px value',
    );
    assert.ok(
      /group\.style\.flexGrow\s*=\s*'0'/.test(body),
      'applyGroupClamp sets flex-grow: 0 (no flex-fill past the saved size)',
    );
    assert.ok(
      /group\.style\.maxHeight\s*=\s*''/.test(body),
      'applyGroupClamp clears any stale inline max-height',
    );
    assert.ok(
      !/group\.style\.maxHeight\s*=\s*`\$\{px\}px`/.test(body),
      'applyGroupClamp no longer applies the legacy content-bound cap',
    );
  });

  it('rowSplitter: диапазон драга не зависит от содержимого, фикс применяется сразу', () => {
    const src = readText(SRC.splitter);
    assert.ok(
      /FIXED_MAX_PX\s*=\s*800/.test(src),
      'rowSplitter defines FIXED_MAX_PX = 800',
    );
    // Дефолтный потолок — константа, а не scrollHeight текущего контента.
    assert.ok(
      /options\.max\?\.\(\)\s*\?\?\s*FIXED_MAX_PX/.test(src),
      'default drag max is FIXED_MAX_PX (content-unbounded)',
    );
    assert.ok(
      !/scrollHeight/.test(src),
      'rowSplitter no longer reads scrollHeight (content-bound range removed)',
    );
    assert.ok(
      !/CSS_VAR_KEYS/.test(src),
      'no special content-bound branch for CSS-var keys anymore',
    );
    // Драг завершается немедленным применением точной высоты — поведение до
    // пересборки вкладки совпадает с поведением после (applyGroupClamp).
    assert.ok(
      /saveListClamp\(\s*options\.persistKey,\s*[^)]*\)\s*;\s*applyGroupClamp\(resizeEl, options\.persistKey\)/.test(
        src.replace(/\n\s*/g, ' '),
      ) || /applyGroupClamp\(resizeEl,\s*options\.persistKey\)/.test(src),
      'drag end commits the exact height via applyGroupClamp right away',
    );
  });

  it('ни один вызов rowSplitter не ограничивает драг scrollHeight', () => {
    for (const [name, path] of Object.entries(SRC)) {
      if (name === 'splitter' || name === 'listHeights') continue;
      const src = readText(path);
      const splitterCalls = src.split('rowSplitter(').slice(1);
      for (const call of splitterCalls) {
        const opts = call.slice(0, call.indexOf('})') + 1);
        assert.ok(
          !/scrollHeight/.test(opts),
          `${name}: a rowSplitter call clamps the drag range to scrollHeight`,
        );
      }
    }
  });

  it('вкладка «Связи» использует applyGroupClamp для обеих групп', () => {
    const src = readText(SRC.links);
    assert.ok(
      /applyGroupClamp\(mentions,\s*'links\.mentions'\)/.test(src),
      'mentions group uses applyGroupClamp(links.mentions)',
    );
    assert.ok(
      /applyGroupClamp\(localGraph,\s*'links\.local-graph'\)/.test(src),
      'localGraph group uses applyGroupClamp(links.local-graph)',
    );
    assert.ok(
      /persistKey:\s*'links\.mentions'/.test(src),
      'splitter carries the persistKey for the mentions group',
    );
  });

  it('doc-комментарий applyGroupClamp явно говорит про фиксированную высоту, а не про потолок', () => {
    const src = readText(SRC.listHeights);
    const idx = src.indexOf('Applies a saved height to an area');
    assert.ok(idx >= 0, 'applyGroupClamp doc-comment found');
    const tail = src.slice(idx, idx + 1500);
    assert.ok(/inline `height`/.test(tail),
      'applyGroupClamp doc-comment mentions inline height');
    assert.ok(
      !/max-height` plus `flex-grow: 0`/.test(tail),
      'applyGroupClamp doc-comment no longer describes the legacy cap channel',
    );
  });
});
