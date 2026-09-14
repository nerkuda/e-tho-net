/**
 * Structural checks for the always-fixed splitter policy (bug 4cc6248c):
 * every group with a `persistKey` rowSplitter must use `applyGroupClamp` as
 * an inline `height` (so the saved size survives re-renders and restarts and
 * does not depend on the current row count) instead of the older content-
 * bound `max-height` cap; the splitter drag range must let the user grow
 * the group past the current content; and the CSS-var consumers
 * (`props`/`chrono`/`attachments`) must keep their natural-content range
 * (otherwise dragging past the content would inflate the table on every
 * render via the `--clamp-*` CSS variable).
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
};

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('always-fixed политика сплиттера (bug 4cc6248c)', () => {
  it('applyGroupClamp задаёт фиксированную высоту inline, а не max-height', () => {
    const src = readText(SRC.listHeights);
    // Ищем тело функции applyGroupClamp: первое `group.style.height = ...`
    // после ключевого комментария.
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
    // Никакого устаревшего `maxHeight = ${px}px` внутри applyGroupClamp.
    assert.ok(
      !/group\.style\.maxHeight\s*=\s*`\$\{px\}px`/.test(body),
      'applyGroupClamp no longer applies the legacy content-bound cap',
    );
  });

  it('CSS_VAR_KEYS экспортирован (для rowSplitter)', () => {
    const src = readText(SRC.listHeights);
    assert.ok(/export const CSS_VAR_KEYS/.test(src), 'CSS_VAR_KEYS exported for splitter');
    for (const key of ['props', 'chrono', 'attachments']) {
      assert.ok(
        new RegExp(`${key}:\\s*'--clamp-${key}'`).test(src),
        `CSS_VAR_KEYS contains ${key} → --clamp-${key}`,
      );
    }
  });

  it('rowSplitter поднимает верхнюю границу max для не-CSS-var ключей (до 800px)', () => {
    const src = readText(SRC.splitter);
    assert.ok(/import\s*\{[^}]*CSS_VAR_KEYS[^}]*\}\s*from\s*'\.\/list-heights\.js'/.test(src),
      'rowSplitter imports CSS_VAR_KEYS from list-heights');
    assert.ok(/FIXED_MAX_PX\s*=\s*800/.test(src),
      'rowSplitter defines FIXED_MAX_PX = 800');
    // Логика подъёма max должна учитывать, что ключ НЕ входит в CSS_VAR_KEYS.
    assert.ok(
      /CSS_VAR_KEYS/.test(src) && /isExpandablePersist/.test(src),
      'rowSplitter has the isExpandablePersist branch over CSS_VAR_KEYS',
    );
    // CSS-var ключи не должны попасть в «expandable» ветку: иначе drag
    // выше scrollHeight запишет огромное значение в --clamp-* и раздует
    // таблицу на каждом рендере.
    assert.ok(
      /!Object\.prototype\.hasOwnProperty\.call\(\s*CSS_VAR_KEYS\s*,\s*options\.persistKey\s*\)/.test(src),
      'isExpandablePersist explicitly excludes CSS-var keys',
    );
  });

  it('вкладка «Связи» использует applyGroupClamp для обеих групп', () => {
    const src = readText(SRC.links);
    assert.ok(
      /applyGroupClamp\(mentions,\s*'links\.mentions'\)/.test(src),
      'mentions group uses applyGroupClamp(links.mentions)',
    );
    assert.ok(
      /applyGroupClamp\(localGraph,\s*'links\.local-graph'\)/.test(src),
      'local-graph group uses applyGroupClamp(links.local-graph)',
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
