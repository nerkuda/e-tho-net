/**
 * Unit tests for the "independent close" fix (карточка ошибки ETN 420a1f7e
 * «Некорректное закрытие предпросмотров»): before the fix, the whole chain of
 * open hover-preview popups shared ONE close timer keyed on "has the cursor
 * left every open popup at once" — so a nested (deeper) popup covering a
 * shallower one meant neither ever closed on its own; both only closed
 * together once the cursor left the union of all of them.
 *
 * `isChainEntryAlive` is the pure decision function behind the fix: for a
 * chain entry at `index`, it answers "does this node keep entry `index`
 * alive" — true when the node sits over the entry's own element OR over any
 * DEEPER entry (so browsing a nested popup keeps every ancestor from
 * closing), and — for `index === 0` only — also true over the root trigger
 * element that originally opened the chain. Tested here with plain mock
 * containers (`{ contains }`) — no real DOM needed, matching this module's
 * "importing it must stay side-effect-free" rule (see
 * hover-preview-links.test.ts's header comment).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hoverPreviewInternals } from '../src/renderer/lib/hover-preview.js';

const { isChainEntryAlive } = hoverPreviewInternals;

/** A container that "contains" only the exact node(s) it was built for —
 *  mirrors `Element.contains` closely enough for the pure decision function,
 *  which only ever calls `.contains(node)`. */
function container(...owned: object[]): { contains(node: object | null): boolean } {
  return { contains: (node) => node !== null && owned.includes(node) };
}

test('isChainEntryAlive: наведение на глубокий (вложенный) попап держит открытым и родительский', () => {
  const rootNode = {};
  const entry0Node = {};
  const entry1Node = {}; // nested, opened from inside entry 0
  const root = container(rootNode);
  const chain = [{ el: container(entry0Node) }, { el: container(entry1Node) }];

  // Курсор внутри самого глубокого (второго) попапа.
  assert.equal(isChainEntryAlive(chain, 0, root, entry1Node as never), true, 'родительский (0) остаётся открытым');
  assert.equal(isChainEntryAlive(chain, 1, root, entry1Node as never), true, 'сам он тоже остаётся открытым');
});

test('isChainEntryAlive: возврат курсора на первый попап закрывает только вложенный', () => {
  const rootNode = {};
  const entry0Node = {};
  const entry1Node = {};
  const root = container(rootNode);
  const chain = [{ el: container(entry0Node) }, { el: container(entry1Node) }];

  // Курсор вернулся на первый (список), второй (вложенный) больше не наведён.
  assert.equal(isChainEntryAlive(chain, 0, root, entry0Node as never), true, 'первый остаётся открытым');
  assert.equal(isChainEntryAlive(chain, 1, root, entry0Node as never), false, 'второй должен начать закрываться');
});

test('isChainEntryAlive: наведение на исходный триггер держит открытым первый попап', () => {
  const rootNode = {};
  const entry0Node = {};
  const root = container(rootNode);
  const chain = [{ el: container(entry0Node) }];

  assert.equal(isChainEntryAlive(chain, 0, root, rootNode as never), true);
});

test('isChainEntryAlive: курсор вне всего — ни один попап не остаётся открытым', () => {
  const rootNode = {};
  const entry0Node = {};
  const entry1Node = {};
  const elsewhere = {};
  const root = container(rootNode);
  const chain = [{ el: container(entry0Node) }, { el: container(entry1Node) }];

  assert.equal(isChainEntryAlive(chain, 0, root, elsewhere as never), false);
  assert.equal(isChainEntryAlive(chain, 1, root, elsewhere as never), false);
});

test('isChainEntryAlive: root-триггер не спасает глубокие (index > 0) попапы', () => {
  const rootNode = {};
  const entry0Node = {};
  const entry1Node = {};
  const root = container(rootNode);
  const chain = [{ el: container(entry0Node) }, { el: container(entry1Node) }];

  // Наведение обратно на исходный триггер — первый попап жив (via root),
  // второй (вложенный) — нет: у него нет своего root-исключения.
  assert.equal(isChainEntryAlive(chain, 0, root, rootNode as never), true);
  assert.equal(isChainEntryAlive(chain, 1, root, rootNode as never), false);
});
