/**
 * Unit tests for the in-memory thought clipboard (workplan L26,
 * task `bb8277f6`). The cross-network wiki-link rewriter is the part most
 * likely to drift — every `[[#<uuid>]]` form (with or without alias) must
 * end up with the right network prefix, legacy `[[name]]` links must
 * survive untouched, and same-network pastes must be no-ops.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getClipboard,
  initNativeCopyTracking,
  rewriteCrossNetworkLinks,
  setClipboard,
  subscribe,
  thoughtIdLink,
} from '../src/renderer/canvas/clipboard.js';

const NET_A = '11111111-2222-3333-4444-555555555555';
const NET_B = '66666666-7777-8888-9999-000000000000';
const T1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const T2 = 'abcdef01-2345-6789-abcd-ef0123456789';

describe('clipboard.rewriteCrossNetworkLinks', () => {
  it('rewrites a plain id link', () => {
    const out = rewriteCrossNetworkLinks(`[[#${T1}]]`, NET_A, NET_B);
    assert.equal(out, `[[n:${NET_A}#${T1}]]`);
  });

  it('rewrites an id link with an alias', () => {
    const out = rewriteCrossNetworkLinks(`См. [[#${T1}|примечание]].`, NET_A, NET_B);
    assert.equal(out, `См. [[n:${NET_A}#${T1}|примечание]].`);
  });

  it('normalises UUID casing', () => {
    const upper = T1.toUpperCase();
    const out = rewriteCrossNetworkLinks(`[[#${upper}]]`, NET_A, NET_B);
    assert.equal(out, `[[n:${NET_A}#${T1}]]`);
  });

  it('leaves legacy name links untouched', () => {
    const text = 'См. [[Моя мысль|псевдоним]] и [[ещё одна]].';
    const out = rewriteCrossNetworkLinks(text, NET_A, NET_B);
    assert.equal(out, text);
  });

  it('handles multiple links in one body', () => {
    const out = rewriteCrossNetworkLinks(
      `[[#${T1}]] then [[#${T2}|alias]]`,
      NET_A,
      NET_B,
    );
    assert.equal(out, `[[n:${NET_A}#${T1}]] then [[n:${NET_A}#${T2}|alias]]`);
  });

  it('is a no-op when source equals target', () => {
    const text = `[[#${T1}]]`;
    const out = rewriteCrossNetworkLinks(text, NET_A, NET_A);
    assert.equal(out, text);
  });

  it('does not touch non-UUID link targets', () => {
    // The `[[#abc]]` form is not a valid id (must be UUID-shaped), so the
    // rewriter leaves it as a legacy name — matches what the markdown
    // parser does (markdown/src/wiki-link.ts).
    const out = rewriteCrossNetworkLinks(`[[#abc]]`, NET_A, NET_B);
    assert.equal(out, `[[#abc]]`);
  });

  it('does not touch cross-network links that already point elsewhere', () => {
    // A link already rewritten to another network must not be double-rewritten.
    const text = `[[n:${NET_B}#${T1}]]`;
    const out = rewriteCrossNetworkLinks(text, NET_A, NET_B);
    assert.equal(out, text);
  });
});

describe('clipboard.thoughtIdLink', () => {
  it('returns same-network id link', () => {
    assert.equal(thoughtIdLink(T1, NET_A, NET_A), `[[#${T1}]]`);
  });

  it('returns cross-network id link', () => {
    assert.equal(thoughtIdLink(T1, NET_A, NET_B), `[[n:${NET_A}#${T1}]]`);
  });
});

describe('clipboard.set/get', () => {
  it('round-trips a snapshot', () => {
    const snap = {
      sourceNetworkId: NET_A,
      thoughts: [],
      links: [],
    };
    setClipboard(snap);
    assert.equal(getClipboard(), snap);
    setClipboard(null);
    assert.equal(getClipboard(), null);
  });
});

describe('clipboard.initNativeCopyTracking', () => {
  // Bug 731a9d16 («Скопированная мысль не удаляется из "буфера обмена"»):
  // a native text copy/cut must supersede the internal thought snapshot —
  // the same "every copy displaces the previous one" rule as the system
  // clipboard. The thought-copy path never fires a native `copy` event
  // (its Ctrl+C keydown is preventDefault-ed), so any event seen here is a
  // text copy.
  const snap = (): Parameters<typeof setClipboard>[0] => ({
    sourceNetworkId: NET_A,
    thoughts: [],
    links: [],
  });

  it('a native copy event clears the snapshot', () => {
    const target = new EventTarget();
    initNativeCopyTracking(target);
    setClipboard(snap());
    target.dispatchEvent(new Event('copy'));
    assert.equal(getClipboard(), null);
  });

  it('a native cut event clears the snapshot', () => {
    const target = new EventTarget();
    initNativeCopyTracking(target);
    setClipboard(snap());
    target.dispatchEvent(new Event('cut'));
    assert.equal(getClipboard(), null);
  });

  it('clearing an already-empty clipboard does not notify subscribers', () => {
    const target = new EventTarget();
    initNativeCopyTracking(target);
    setClipboard(null);
    let notified = 0;
    subscribe(() => {
      notified += 1;
    });
    target.dispatchEvent(new Event('copy'));
    assert.equal(notified, 0);
  });
});
