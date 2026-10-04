/**
 * Публикации в плагине wiki-ссылок редактора (0.11.1, задача 3275fd8d,
 * элемент интерфейса d421c5d8): префиксная ID-форма `[[#pub:<uuid>]]` /
 * `[[#pub:<uuid>|<alias>]]` (ADR 7168009e) разбирается тем же плагином, что
 * ссылки на мысли, и подсвечивается/цельно выделяется как они. Резолв — по
 * публикациям текущего слоя (отдельное пространство кеш-ключей `pub:`).
 *
 * Headless — EditorState/StateField (без EditorView и DOM).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  __testing,
  publicationCacheKey,
} from '../src/renderer/editor/wiki-id-plugin.js';

const { parseIdLinks, buildDecorations, collectUnresolvedPublications } = __testing;

const PUB = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const THOUGHT = '11111111-2222-3333-4444-555555555555';
const CUR = 'c4f9a3b2-1111-2222-3333-444455556666';

test('parseIdLinks: [[#pub:<uuid>]] — публикация, токен включает #pub:', () => {
  const source = `см. [[#pub:${PUB}]]`;
  const links = parseIdLinks(source);
  assert.equal(links.length, 1);
  const l = links[0]!;
  assert.equal(l.kind, 'pub');
  assert.equal(l.thoughtId, PUB);
  assert.equal(l.alias, null);
  // Токен атомарного выделения — `#pub:<uuid>` целиком.
  assert.equal(source.slice(l.idFrom - 1, l.idTo), `#pub:${PUB}`);
});

test('parseIdLinks: [[#pub:<uuid>|alias]] — алиас сохраняется', () => {
  const links = parseIdLinks(`[[#pub:${PUB}|Раздел 1]]`);
  assert.equal(links.length, 1);
  assert.equal(links[0]!.kind, 'pub');
  assert.equal(links[0]!.alias, 'Раздел 1');
});

test('parseIdLinks: невалидный pub-uuid не парсится; голый id остаётся мыслью', () => {
  assert.equal(parseIdLinks('[[#pub:not-a-uuid]]').length, 0);
  assert.equal(parseIdLinks(`[[#${THOUGHT}]]`)[0]!.kind, 'id');
});

test('buildDecorations: pub-ссылка нормализуется названием из кеша публикаций', () => {
  const source = `[[#pub:${PUB}]]`;
  const cache = new Map([
    [publicationCacheKey(CUR, PUB), { title: 'Публикация', exists: true, networkId: CUR }],
  ]);
  const decos = buildDecorations(source, { from: 100, to: 100 }, cache, CUR);
  const ranges: Array<{ from: number; to: number }> = [];
  decos.between(0, source.length, (from, to) => {
    ranges.push({ from, to });
  });
  assert.equal(ranges.length, 1);
  assert.deepEqual(ranges[0], { from: 0, to: source.length });
});

test('collectUnresolvedPublications: находит pub-id, не игнорирует кеш', () => {
  const source = `[[#pub:${PUB}]] и [[#${THOUGHT}]]`;
  assert.deepEqual(collectUnresolvedPublications(source, new Map(), CUR), [PUB]);
  const cache = new Map([
    [publicationCacheKey(CUR, PUB), { title: 'Публикация', exists: true, networkId: CUR }],
  ]);
  assert.deepEqual(collectUnresolvedPublications(source, cache, CUR), []);
});

test('collectUnresolvedPublications: без активной сети — пусто', () => {
  assert.deepEqual(collectUnresolvedPublications(`[[#pub:${PUB}]]`, new Map(), null), []);
});
