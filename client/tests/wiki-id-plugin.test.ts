/**
 * Unit tests for the ID-based wiki-link plugin (task R6,
 * docs/12-wiki-id-refs.md §3). Pure — no CM6 EditorView, no DOM. Tests the
 * internal `parseIdLinks` and `buildDecorations` helpers exposed via
 * `__testing`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testing } from '../src/renderer/editor/wiki-id-plugin.js';

const { parseIdLinks, buildDecorations, cacheKey, collectUnresolvedTokens } = __testing;

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const ID_B = '11111111-2222-3333-4444-555555555555';
const NET = 'c4f9a3b2-1111-2222-3333-444455556666';

/**
 * Active network id used by same-network `[[#<id>]]` cache lookups. The
 * plugin routes those entries through `<networkId>:<id>` keys (see R12 fix
 * for the `__current__` placeholder mismatch).
 */
const CUR = 'cur-net-1111-2222-3333-444455556666';

test('parseIdLinks: [[#<uuid>]] — пустая ссылка по id', () => {
  const links = parseIdLinks(`см. [[#${ID_A}]]`);
  assert.equal(links.length, 1);
  const l = links[0]!;
  assert.equal(l.kind, 'id');
  assert.equal(l.thoughtId, ID_A);
  assert.equal(l.networkId, null);
  assert.equal(l.alias, null);
  assert.equal(l.from, 4);
  assert.equal(l.to, 4 + 2 + 1 + ID_A.length + 2); // "[[#" + id + "]]"
});

test('parseIdLinks: [[#<uuid>|alias]] — id с алиасом', () => {
  const links = parseIdLinks(`[[#${ID_A}|мой алиас]]`);
  assert.equal(links.length, 1);
  assert.equal(links[0]!.alias, 'мой алиас');
});

test('parseIdLinks: [[n:<net>#<id>]] — кросс-сеть', () => {
  const links = parseIdLinks(`[[n:${NET}#${ID_A}]]`);
  assert.equal(links.length, 1);
  const l = links[0]!;
  assert.equal(l.kind, 'cross');
  assert.equal(l.thoughtId, ID_A);
  assert.equal(l.networkId, NET);
});

test('parseIdLinks: [[n:<net>#<id>|alias]] — кросс-сеть с алиасом', () => {
  const links = parseIdLinks(`[[n:${NET}#${ID_A}|alias]]`);
  assert.equal(links.length, 1);
  assert.equal(links[0]!.alias, 'alias');
});

test('parseIdLinks: legacy [[Имя|alias]] — не парсится как ID', () => {
  const links = parseIdLinks('[[Имя мысли|алиас]]');
  assert.equal(links.length, 0);
});

test('parseIdLinks: невалидный UUID — не парсится', () => {
  assert.equal(parseIdLinks('[[#not-a-uuid]]').length, 0);
  assert.equal(parseIdLinks(`[[n:not-a-uuid#${ID_A}]]`).length, 0);
  assert.equal(parseIdLinks(`[[n:${NET}#not-a-uuid]]`).length, 0);
});

test('parseIdLinks: UUID в верхнем регистре нормализуется в нижний', () => {
  const links = parseIdLinks(`[[#${ID_A.toUpperCase()}]]`);
  assert.equal(links.length, 1);
  assert.equal(links[0]!.thoughtId, ID_A);
});

test('parseIdLinks: несколько ссылок в одном документе', () => {
  const links = parseIdLinks(`a [[#${ID_A}]] b [[#${ID_B}|x]] c`);
  assert.equal(links.length, 2);
  assert.equal(links[0]!.thoughtId, ID_A);
  assert.equal(links[1]!.thoughtId, ID_B);
  assert.equal(links[1]!.alias, 'x');
});

test('parseIdLinks: пустой документ — пустой результат', () => {
  assert.deepEqual(parseIdLinks(''), []);
});

test('parseIdLinks: незакрытая скобка — не парсится', () => {
  assert.equal(parseIdLinks(`[[#${ID_A}`).length, 0);
});

test('buildDecorations: пустой документ — пустые декорации', () => {
  const cache = new Map();
  const decos = buildDecorations('', { from: 0, to: 0 }, cache, CUR);
  // DecorationSet has no public iterator; check via iteration of iter() result.
  const ranges: unknown[] = [];
  decos.between(0, 0, (from, to, value) => {
    ranges.push({ from, to, value });
  });
  assert.equal(ranges.length, 0);
});

test('buildDecorations: normal-mode (selection вне ссылки) — replace на всю ссылку', () => {
  const source = `[[#${ID_A}]]`;
  const cache = new Map([[cacheKey(CUR, ID_A), { title: 'Цель', exists: true, networkId: CUR }]]);
  const decos = buildDecorations(source, { from: 100, to: 100 }, cache, CUR); // selection далеко
  const ranges: Array<{ from: number; to: number }> = [];
  decos.between(0, source.length, (from, to) => ranges.push({ from, to }));
  // В normal-mode одна замена на всю длину ссылки.
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.from, 0);
  assert.equal(ranges[0]!.to, source.length);
});

test('buildDecorations: edit-mode (selection внутри) — два декорации на #id-токене (atomic mark + replace с виджетом)', () => {
  const source = `[[#${ID_A}]]`;
  // В edit-mode ставятся ДВЕ декорации на одном диапазоне `#<id>`:
  // - Decoration.mark({ atomic: true }) — atomic range для CM6 (стрелки
  //   перепрыгивают блок, курсор не входит);
  // - Decoration.replace({ widget }) — рисует имя поверх исходника,
  //   inclusive: true — чтобы граничные позиции не «выпадали» из декорации.
  // Без atomic-марка стрелки влево/вправо заходят внутрь виджета и
  // застревают там (contenteditable="false" блокирует ввод, но CM6 это не
  // считает atomic). Без inclusive: true двойной клик ставит курсор на
  // границу диапазона, и пользователь видит `#<uuid>` вместо виджета.
  const idStart = 2; // позиция `#` (после "[[")
  const idEnd = idStart + 1 + ID_A.length; // после `]]`
  const cache = new Map([[cacheKey(CUR, ID_A), { title: 'Цель', exists: true, networkId: CUR }]]);
  const decos = buildDecorations(source, { from: 5, to: 10 }, cache, CUR);
  const ranges: Array<{ from: number; to: number }> = [];
  decos.between(0, source.length, (from, to) => ranges.push({ from, to }));
  assert.equal(ranges.length, 2, 'mark + replace на одном диапазоне');
  assert.equal(ranges[0]!.from, idStart);
  assert.equal(ranges[0]!.to, idEnd);
  assert.equal(ranges[1]!.from, idStart);
  assert.equal(ranges[1]!.to, idEnd);
});

test('buildDecorations: использует alias если задан — структурная проверка', () => {
  const source = `[[#${ID_A}|мой алиас]]`;
  const cache = new Map([[cacheKey(CUR, ID_A), { title: 'Цель', exists: true, networkId: CUR }]]);
  const decos = buildDecorations(source, { from: 100, to: 100 }, cache, CUR);
  const ranges: Array<{ from: number; to: number }> = [];
  decos.between(0, source.length, (from, to) => ranges.push({ from, to }));
  // В normal-mode одна декорация на всю длину ссылки.
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.from, 0);
  assert.equal(ranges[0]!.to, source.length);
});

test('buildDecorations: использует id как fallback когда cache пуст', () => {
  const source = `[[#${ID_A}]]`;
  const decos = buildDecorations(source, { from: 100, to: 100 }, new Map(), CUR);
  const ranges: Array<{ from: number; to: number }> = [];
  decos.between(0, source.length, (from, to) => ranges.push({ from, to }));
  assert.equal(ranges.length, 1, 'должна быть одна декорация даже с пустым cache');
  assert.equal(ranges[0]!.from, 0);
  assert.equal(ranges[0]!.to, source.length);
});

test('buildDecorations: deleted мысль — декорация создаётся', () => {
  const source = `[[#${ID_A}]]`;
  const cache = new Map([
    [cacheKey(CUR, ID_A), { title: 'Удалённая', exists: false, networkId: CUR }],
  ]);
  const decos = buildDecorations(source, { from: 100, to: 100 }, cache, CUR);
  const ranges: Array<{ from: number; to: number }> = [];
  decos.between(0, source.length, (from, to) => ranges.push({ from, to }));
  assert.equal(ranges.length, 1, 'одна декорация для удалённой мысли');
  assert.equal(ranges[0]!.from, 0);
  assert.equal(ranges[0]!.to, source.length);
});

test('cacheKey: формирует "<net>:<id>"', () => {
  assert.equal(cacheKey('net1', 'id1'), 'net1:id1');
  assert.equal(cacheKey(CUR, ID_A), `${CUR}:${ID_A}`);
});

test('collectUnresolvedTokens: после полного resolve возвращает пустое множество', () => {
  // Регрессионный тест для R6-bugfix: schedule() делает early return, если
  // collectUnresolvedTokens возвращает пустое. Без early return возникает
  // бесконечный цикл (resolve → dispatch → update → schedule → …).
  const source = `[[#${ID_A}]] [[#${ID_B}]]`;
  const cache = new Map([
    [cacheKey(CUR, ID_A), { title: 'A', exists: true, networkId: CUR }],
    [cacheKey(CUR, ID_B), { title: 'B', exists: true, networkId: CUR }],
  ]);
  const unresolved = collectUnresolvedTokens(source, cache, CUR);
  assert.equal(unresolved.size, 0, 'полный кеш → unresolved пуст → schedule early return');
});

test('collectUnresolvedTokens: пустой кеш возвращает все токены активной сети', () => {
  const source = `[[#${ID_A}]] [[#${ID_B}]]`;
  const unresolved = collectUnresolvedTokens(source, new Map(), CUR);
  assert.equal(unresolved.size, 1);
  assert.ok(unresolved.has(CUR));
  assert.equal(unresolved.get(CUR)!.size, 2);
});

test('collectUnresolvedTokens: networkId=null — same-network ссылки пропускаются', () => {
  // Без активной сети некуда резолвить `[[#<id>]]` — такие токены игнорируются.
  // Cross-network ссылки (явный n:<net>) всё равно собираются.
  const source = `[[#${ID_A}]] [[n:${NET}#${ID_B}]]`;
  const unresolved = collectUnresolvedTokens(source, new Map(), null);
  assert.equal(unresolved.size, 1, 'только cross-network');
  assert.ok(unresolved.has(NET));
  assert.ok(unresolved.get(NET)!.has(ID_B));
});

test('collectUnresolvedTokens: только отсутствующие id попадают в результат', () => {
  const source = `[[#${ID_A}]] [[#${ID_B}]]`;
  const cache = new Map([
    [cacheKey(CUR, ID_A), { title: 'A', exists: true, networkId: CUR }],
  ]);
  const unresolved = collectUnresolvedTokens(source, cache, CUR);
  assert.equal(unresolved.size, 1);
  assert.ok(unresolved.has(CUR));
  assert.equal(unresolved.get(CUR)!.size, 1);
  assert.ok(unresolved.get(CUR)!.has(ID_B));
});
