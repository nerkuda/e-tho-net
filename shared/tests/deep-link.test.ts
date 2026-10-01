/**
 * Unit tests for the deep-link helpers (task R4,
 * docs/12-wiki-id-refs.md §7): build/parse round-trip, strictness, argv
 * extraction.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDeepLinkUrl,
  buildPublicationDeepLinkUrl,
  DEEP_LINK_SCHEME,
  extractDeepLinkFromArgv,
  extractPublicationDeepLinkFromArgv,
  parseDeepLinkUrl,
  parsePublicationDeepLinkUrl,
  PUBLICATION_DEEP_LINK_PARAM,
} from '../src/index.js';

const NET_A = 'c4f9a3b2-1111-2222-3333-444455556666';
const NET_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const THOUGHT = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const PUBLICATION = '1b7c9d2e-3333-4444-5555-666677778888';

describe('buildDeepLinkUrl', () => {
  it('строит корректный URL с lowercase UUID', () => {
    const url = buildDeepLinkUrl({ networkId: NET_A.toUpperCase(), thoughtId: THOUGHT });
    assert.equal(url, `${DEEP_LINK_SCHEME}?net=${NET_A}&thought=${THOUGHT}`);
  });

  it('выбрасывает RangeError на невалидный networkId', () => {
    assert.throws(() => buildDeepLinkUrl({ networkId: 'not-a-uuid', thoughtId: THOUGHT }), RangeError);
  });

  it('выбрасывает RangeError на невалидный thoughtId', () => {
    assert.throws(() => buildDeepLinkUrl({ networkId: NET_A, thoughtId: 'xx' }), RangeError);
  });
});

describe('parseDeepLinkUrl', () => {
  it('парсит корректный URL обратно в DeepLink', () => {
    const url = `${DEEP_LINK_SCHEME}?net=${NET_A}&thought=${THOUGHT}`;
    assert.deepEqual(parseDeepLinkUrl(url), {
      networkId: NET_A,
      thoughtId: THOUGHT,
    });
  });

  it('case-insensitive: верхний регистр UUID нормализуется в нижний', () => {
    const url = `${DEEP_LINK_SCHEME}?net=${NET_A.toUpperCase()}&thought=${THOUGHT.toUpperCase()}`;
    assert.deepEqual(parseDeepLinkUrl(url), { networkId: NET_A, thoughtId: THOUGHT });
  });

  it('round-trip: build → parse возвращает тот же результат', () => {
    const original = { networkId: NET_A, thoughtId: THOUGHT };
    assert.deepEqual(parseDeepLinkUrl(buildDeepLinkUrl(original)), original);
  });

  it('extra query-параметры игнорируются', () => {
    const url = `${DEEP_LINK_SCHEME}?net=${NET_A}&thought=${THOUGHT}&extra=foo&another=bar`;
    assert.deepEqual(parseDeepLinkUrl(url), { networkId: NET_A, thoughtId: THOUGHT });
  });

  it('порядок query-параметров не важен', () => {
    const url1 = `${DEEP_LINK_SCHEME}?net=${NET_A}&thought=${THOUGHT}`;
    const url2 = `${DEEP_LINK_SCHEME}?thought=${THOUGHT}&net=${NET_A}`;
    assert.deepEqual(parseDeepLinkUrl(url1), parseDeepLinkUrl(url2));
  });

  it('возвращает null на неподдерживаемую схему', () => {
    assert.equal(parseDeepLinkUrl(`obsidian://open?vault=x&file=y`), null);
    assert.equal(parseDeepLinkUrl(`http://open?net=${NET_A}&thought=${THOUGHT}`), null);
  });

  it('возвращает null на другой host (не "open")', () => {
    assert.equal(parseDeepLinkUrl(`etn://something-else?net=${NET_A}&thought=${THOUGHT}`), null);
  });

  it('возвращает null на отсутствующий query-параметр', () => {
    assert.equal(parseDeepLinkUrl(`${DEEP_LINK_SCHEME}?net=${NET_A}`), null);
    assert.equal(parseDeepLinkUrl(`${DEEP_LINK_SCHEME}?thought=${THOUGHT}`), null);
  });

  it('возвращает null на невалидный UUID в query', () => {
    assert.equal(parseDeepLinkUrl(`${DEEP_LINK_SCHEME}?net=not-a-uuid&thought=${THOUGHT}`), null);
    assert.equal(parseDeepLinkUrl(`${DEEP_LINK_SCHEME}?net=${NET_A}&thought=xx`), null);
  });

  it('возвращает null на пустую/нестроку', () => {
    assert.equal(parseDeepLinkUrl(''), null);
    assert.equal(parseDeepLinkUrl(null as unknown as string), null);
    assert.equal(parseDeepLinkUrl(123 as unknown as string), null);
  });

  it('возвращает null на лишний pathname', () => {
    assert.equal(parseDeepLinkUrl(`${DEEP_LINK_SCHEME}/foo?net=${NET_A}&thought=${THOUGHT}`), null);
  });
});

describe('extractDeepLinkFromArgv', () => {
  it('находит etn://open URL среди аргументов', () => {
    const argv = [
      'C:\\path\\to\\electron.exe',
      '--some-flag',
      `${DEEP_LINK_SCHEME}?net=${NET_A}&thought=${THOUGHT}`,
      '--enable-logging',
    ];
    assert.deepEqual(extractDeepLinkFromArgv(argv), { networkId: NET_A, thoughtId: THOUGHT });
  });

  it('возвращает первый валидный URL, игнорируя прочие etn://… аргументы', () => {
    const argv = [
      `${DEEP_LINK_SCHEME}?net=${NET_A}&thought=${THOUGHT}`,
      `${DEEP_LINK_SCHEME}?net=${NET_B}&thought=other`,
    ];
    assert.deepEqual(extractDeepLinkFromArgv(argv), { networkId: NET_A, thoughtId: THOUGHT });
  });

  it('возвращает null когда нет etn://open URL', () => {
    const argv = ['C:\\path\\to\\electron.exe', '--some-flag'];
    assert.equal(extractDeepLinkFromArgv(argv), null);
  });

  it('возвращает null когда etn://open URL есть, но с невалидными query', () => {
    const argv = [`${DEEP_LINK_SCHEME}?net=not-a-uuid&thought=${THOUGHT}`];
    assert.equal(extractDeepLinkFromArgv(argv), null);
  });

  it('работает с пустым массивом', () => {
    assert.equal(extractDeepLinkFromArgv([]), null);
  });
});

describe('публикационный deep-link [[#pub:]] (f37b468d)', () => {
  it('строит URL с параметром publication', () => {
    const url = buildPublicationDeepLinkUrl({
      networkId: NET_A.toUpperCase(),
      publicationId: PUBLICATION.toUpperCase(),
    });
    assert.equal(
      url,
      `${DEEP_LINK_SCHEME}?net=${NET_A}&${PUBLICATION_DEEP_LINK_PARAM}=${PUBLICATION}`,
    );
  });

  it('выбрасывает RangeError на невалидные id', () => {
    assert.throws(
      () => buildPublicationDeepLinkUrl({ networkId: 'no', publicationId: PUBLICATION }),
      RangeError,
    );
    assert.throws(
      () => buildPublicationDeepLinkUrl({ networkId: NET_A, publicationId: 'no' }),
      RangeError,
    );
  });

  it('round-trip build → parse', () => {
    const original = { networkId: NET_A, publicationId: PUBLICATION };
    assert.deepEqual(parsePublicationDeepLinkUrl(buildPublicationDeepLinkUrl(original)), original);
  });

  it('мысловая форма publication-парсером не парсится', () => {
    assert.equal(parsePublicationDeepLinkUrl(`${DEEP_LINK_SCHEME}?net=${NET_A}&thought=${THOUGHT}`), null);
  });

  it('смешанная форма (thought + publication) отвергается', () => {
    const url = `${DEEP_LINK_SCHEME}?net=${NET_A}&thought=${THOUGHT}&publication=${PUBLICATION}`;
    assert.equal(parsePublicationDeepLinkUrl(url), null);
  });

  it('мысловой парсер publication-URL не принимает (обратная совместимость)', () => {
    const url = buildPublicationDeepLinkUrl({ networkId: NET_A, publicationId: PUBLICATION });
    assert.equal(parseDeepLinkUrl(url), null);
  });

  it('extractPublicationDeepLinkFromArgv находит URL среди аргументов', () => {
    const argv = [
      'C:\\path\\to\\electron.exe',
      '--flag',
      `${DEEP_LINK_SCHEME}?net=${NET_A}&${PUBLICATION_DEEP_LINK_PARAM}=${PUBLICATION}`,
    ];
    assert.deepEqual(extractPublicationDeepLinkFromArgv(argv), {
      networkId: NET_A,
      publicationId: PUBLICATION,
    });
  });

  it('extractPublicationDeepLinkFromArgv игнорирует мысловую форму', () => {
    const argv = [`${DEEP_LINK_SCHEME}?net=${NET_A}&thought=${THOUGHT}`];
    assert.equal(extractPublicationDeepLinkFromArgv(argv), null);
  });
});
