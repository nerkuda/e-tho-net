/**
 * Unit tests for the ID-based wiki-link plugin (task R6,
 * docs/12-wiki-id-refs.md §3). Headless — EditorState/StateField (no
 * EditorView, no DOM). Tests the internal `parseIdLinks`,
 * `computeWikiIdDecos`/`buildDecorations` helpers, the state field's
 * selection-driven recompute and the arrow-key block navigation exposed via
 * `__testing`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { __testing, wikiIdState } from '../src/renderer/editor/wiki-id-plugin.js';

const { parseIdLinks, buildDecorations, computeWikiIdDecos, moveAcrossWikiIdBlock, cacheKey, collectUnresolvedTokens } =
  __testing;

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const ID_B = '11111111-2222-3333-4444-555555555555';
const NET = 'c4f9a3b2-1111-2222-3333-444455556666';

/**
 * Active network id used by same-network `[[#<id>]]` cache lookups. The
 * plugin routes those entries through `<networkId>:<id>` keys (see R12 fix
 * for the `__current__` placeholder mismatch).
 */
const CUR = 'cur-net-1111-2222-3333-444455556666';

const idStart = 2; // позиция `#` (после "[[")

/** Fake view for `moveAcrossWikiIdBlock` — the handler only needs state/dispatch. */
function fakeView(state: EditorState, dispatch: (spec: TransactionSpec) => void): EditorView {
  return { state, dispatch } as unknown as EditorView;
}

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

test('computeWikiIdDecos: edit-mode (selection внутри) — replace на #id-токене + atomic range', () => {
  const source = `[[#${ID_A}]]`;
  const idEnd = idStart + 1 + ID_A.length;
  const cache = new Map([[cacheKey(CUR, ID_A), { title: 'Цель', exists: true, networkId: CUR }]]);
  const { decorations, atomic } = computeWikiIdDecos(source, { from: 5, to: 10 }, cache, CUR);
  const ranges: Array<{ from: number; to: number }> = [];
  decorations.between(0, source.length, (from, to) => ranges.push({ from, to }));
  assert.deepEqual(ranges, [{ from: idStart, to: idEnd }], 'одна replace-декорация на #id-токене');
  const atoms: Array<{ from: number; to: number }> = [];
  atomic.between(0, source.length, (from, to) => atoms.push({ from, to }));
  assert.deepEqual(atoms, [{ from: idStart, to: idEnd }], 'atomic range покрывает #id-токен');
});

test('computeWikiIdDecos: normal-mode — atomic set пуст (курсор может войти в скобки)', () => {
  const source = `[[#${ID_A}]]`;
  const cache = new Map([[cacheKey(CUR, ID_A), { title: 'Цель', exists: true, networkId: CUR }]]);
  const { atomic } = computeWikiIdDecos(source, { from: 100, to: 100 }, cache, CUR);
  const atoms: unknown[] = [];
  atomic.between(0, source.length, (from, to) => atoms.push({ from, to }));
  assert.equal(atoms.length, 0);
});

test('buildDecorations: label — alias приоритетнее title', () => {
  const source = `[[#${ID_A}|мой алиас]]`;
  const cache = new Map([[cacheKey(CUR, ID_A), { title: 'Цель', exists: true, networkId: CUR }]]);
  const decos = buildDecorations(source, { from: 100, to: 100 }, cache, CUR);
  let label = '';
  decos.between(0, source.length, (_f, _t, value) => {
    label = value.spec.widget.label as string;
  });
  assert.equal(label, 'мой алиас');
});

test('buildDecorations: пустой кеш — label «…», НИКОГДА не сырой id', () => {
  const source = `[[#${ID_A}]]`;
  const decos = buildDecorations(source, { from: 100, to: 100 }, new Map(), CUR);
  let label = '';
  decos.between(0, source.length, (_f, _t, value) => {
    label = value.spec.widget.label as string;
  });
  assert.equal(label, '…');
  assert.notEqual(label, ID_A);
});

test('buildDecorations: edit-mode — виджет показывает title или «…», не id', () => {
  const source = `[[#${ID_A}]]`;
  const cache = new Map([[cacheKey(CUR, ID_A), { title: 'Цель', exists: true, networkId: CUR }]]);
  const withTitle = buildDecorations(source, { from: 5, to: 10 }, cache, CUR);
  let label = '';
  withTitle.between(0, source.length, (_f, _t, value) => {
    label = value.spec.widget.label as string;
  });
  assert.equal(label, 'Цель');

  const withoutTitle = buildDecorations(source, { from: 5, to: 10 }, new Map(), CUR);
  withoutTitle.between(0, source.length, (_f, _t, value) => {
    label = value.spec.widget.label as string;
  });
  assert.equal(label, '…');
});

test('buildDecorations: deleted мысль — виджет помечен deleted', () => {
  const source = `[[#${ID_A}]]`;
  const cache = new Map([
    [cacheKey(CUR, ID_A), { title: '', exists: false, networkId: CUR }],
  ]);
  const decos = buildDecorations(source, { from: 100, to: 100 }, cache, CUR);
  let deleted = false;
  decos.between(0, source.length, (_f, _t, value) => {
    deleted = value.spec.widget.deleted as boolean;
  });
  assert.equal(deleted, true);
});

test('buildDecorations: networkId=null — ссылка всё равно скрыта виджетом (сырой id не виден)', () => {
  const source = `[[#${ID_A}]]`;
  const decos = buildDecorations(source, { from: 100, to: 100 }, new Map(), null);
  const ranges: Array<{ from: number; to: number }> = [];
  decos.between(0, source.length, (from, to) => ranges.push({ from, to }));
  assert.deepEqual(ranges, [{ from: 0, to: source.length }], 'вся ссылка под виджетом даже без сети');
});

test('wikiIdState: смена выделения переключает normal↔edit (пересчёт на selectionSet)', () => {
  const source = `[[#${ID_A}]]`;
  const state = EditorState.create({ doc: source, extensions: [wikiIdState] });
  const ranges = (s: EditorState): Array<{ from: number; to: number }> => {
    const out: Array<{ from: number; to: number }> = [];
    s.field(wikiIdState).decorations.between(0, source.length, (from, to) => out.push({ from, to }));
    return out;
  };

  // Курсор в начале документа — ссылка в normal-mode (виджет на всю ссылку).
  assert.deepEqual(ranges(state), [{ from: 0, to: source.length }]);
  // Курсор внутри ссылки — edit-mode: виджет только на #id-токене.
  const inside = state.update({ selection: { anchor: 5 } }).state;
  const idEnd = idStart + 1 + ID_A.length;
  assert.deepEqual(ranges(inside), [{ from: idStart, to: idEnd }]);
  // Atomic set появляется только в edit-mode.
  const atoms: Array<{ from: number; to: number }> = [];
  inside.field(wikiIdState).atomic.between(0, source.length, (from, to) => atoms.push({ from, to }));
  assert.deepEqual(atoms, [{ from: idStart, to: idEnd }]);
  // Обратно наружу — снова normal-mode.
  const outside = inside.update({ selection: { anchor: 0 } }).state;
  assert.deepEqual(ranges(outside), [{ from: 0, to: source.length }]);
});

test('moveAcrossWikiIdBlock: ← справа от блока — выделяет имя целиком', () => {
  const source = `[[#${ID_A}]]`;
  const idEnd = idStart + 1 + ID_A.length;
  const dispatched: TransactionSpec[] = [];
  const state = EditorState.create({ doc: source, selection: { anchor: idEnd } });
  const handled = moveAcrossWikiIdBlock(fakeView(state, (s) => dispatched.push(s)), -1);
  assert.equal(handled, true);
  assert.deepEqual(dispatched, [
    { selection: { anchor: idEnd, head: idStart }, scrollIntoView: true, userEvent: 'select' },
  ]);
});

test('moveAcrossWikiIdBlock: ← при выделенном блоке — курсор влево от имени', () => {
  const source = `[[#${ID_A}]]`;
  const idEnd = idStart + 1 + ID_A.length;
  const dispatched: TransactionSpec[] = [];
  const state = EditorState.create({ doc: source, selection: { anchor: idEnd, head: idStart } });
  const handled = moveAcrossWikiIdBlock(fakeView(state, (s) => dispatched.push(s)), -1);
  assert.equal(handled, true);
  assert.deepEqual(dispatched, [
    { selection: { anchor: idStart }, scrollIntoView: true, userEvent: 'select' },
  ]);
});

test('moveAcrossWikiIdBlock: → слева от блока — выделяет имя, ещё раз → курсор справа', () => {
  const source = `[[#${ID_A}]]`;
  const idEnd = idStart + 1 + ID_A.length;
  const dispatched: TransactionSpec[] = [];
  const atLeft = EditorState.create({ doc: source, selection: { anchor: idStart } });
  const first = moveAcrossWikiIdBlock(fakeView(atLeft, (s) => dispatched.push(s)), 1);
  assert.equal(first, true);
  assert.deepEqual(dispatched, [
    { selection: { anchor: idStart, head: idEnd }, scrollIntoView: true, userEvent: 'select' },
  ]);

  dispatched.length = 0;
  const selected = EditorState.create({ doc: source, selection: { anchor: idStart, head: idEnd } });
  const second = moveAcrossWikiIdBlock(fakeView(selected, (s) => dispatched.push(s)), 1);
  assert.equal(second, true);
  assert.deepEqual(dispatched, [
    { selection: { anchor: idEnd }, scrollIntoView: true, userEvent: 'select' },
  ]);
});

test('moveAcrossWikiIdBlock: курсор не у блока — отдаёт навигацию по умолчанию', () => {
  const source = `хвост [[#${ID_A}]]`;
  const dispatched: TransactionSpec[] = [];
  const state = EditorState.create({ doc: source, selection: { anchor: 1 } });
  const handled = moveAcrossWikiIdBlock(fakeView(state, (s) => dispatched.push(s)), -1);
  assert.equal(handled, false);
  assert.equal(dispatched.length, 0);
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
