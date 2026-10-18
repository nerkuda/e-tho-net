/**
 * Ремап id-ссылок при копировании подграфа внутри одной сети (ошибка
 * 5f03ebc5). Функция живёт в `@etn/markdown`, потому что разбор `[[…]]` и
 * трансклюзий — исключительно его дом (сторож
 * `guard-markdown-single-renderer.test.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { remapSameNetworkLinks } from '../src/index.js';

const T1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const T2 = 'abcdef01-2345-6789-abcd-ef0123456789';
const COPY1 = '11111111-2222-3333-4444-555555555555';

describe('remapSameNetworkLinks (5f03ebc5)', () => {
  it('переписывает простую id-ссылку', () => {
    assert.equal(remapSameNetworkLinks(`См. [[#${T1}]]`, { [T1]: COPY1 }), `См. [[#${COPY1}]]`);
  });

  it('сохраняет алиас', () => {
    assert.equal(
      remapSameNetworkLinks(`[[#${T1}|примечание]]`, { [T1]: COPY1 }),
      `[[#${COPY1}|примечание]]`,
    );
  });

  it('переписывает id внутри трансклюзии, оставляя `!`', () => {
    assert.equal(remapSameNetworkLinks(`![[#${T1}]]`, { [T1]: COPY1 }), `![[#${COPY1}]]`);
  });

  it('нормализует регистр UUID при поиске в карте', () => {
    assert.equal(remapSameNetworkLinks(`[[#${T1.toUpperCase()}]]`, { [T1]: COPY1 }), `[[#${COPY1}]]`);
  });

  it('оставляет ссылки вне карты и кросс-сетевые нетронутыми', () => {
    const text = `[[#${T1}]] [[n:${T2}#${T1}]] [[#${T2}]] [[имя]]`;
    assert.equal(remapSameNetworkLinks(text, { [T1]: COPY1 }), `[[#${COPY1}]] [[n:${T2}#${T1}]] [[#${T2}]] [[имя]]`);
  });
});
