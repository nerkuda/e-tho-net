/**
 * Unit tests of the wiki-link prefix parsing (task M3) and ID-target resolver
 * (task R8). Pure — no DOM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wikiPrefixAt } from '../src/renderer/editor/wiki-link.js';

// ---------------------------------------------------------------------------
// wikiPrefixAt (M3)
// ---------------------------------------------------------------------------

test('открытая ссылка: позиция [[ и префикс', () => {
  assert.deepEqual(wikiPrefixAt('[[аб'), { open: 0, prefix: 'аб' });
  assert.deepEqual(wikiPrefixAt('см. [[связ'), { open: 4, prefix: 'связ' });
  // Последнее «[[» побеждает.
  assert.deepEqual(wikiPrefixAt('[[а [[бв'), { open: 4, prefix: 'бв' });
});

test('закрытая, пустая, с алиасом или переносом — не автокомплит', () => {
  for (const before of ['[[аб]]', '[[аб]', '[[аб|синон', '[[', '[[аб\nб', 'без скобок']) {
    assert.equal(wikiPrefixAt(before), null, JSON.stringify(before));
  }
});

test('префикс не может содержать скобки и вертикальную черту', () => {
  assert.equal(wikiPrefixAt('[[a[b'), null);
  assert.equal(wikiPrefixAt('[[a|b'), null);
});
