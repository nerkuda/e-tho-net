/**
 * Unit tests трансклюзий комментариев (0.12.1, ТП2, задача f72a9134).
 * Проверяют чистые функции контекста/разделов/метки, сборку декораций трёх
 * режимов ссылки (блок, свёрнутая ссылка, правка с атомарным `#<id>`) и
 * итеративную развёртку с инжектируемым загрузчиком источников. Headless —
 * без DOM и сети.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Decoration, type DecorationSet } from '@codemirror/view';

import { parseTransclusions } from '@etn/markdown';

import {
  buildTransclusionDecorations,
  listSectionTitles,
  transclusionAtCaret,
  transclusionCacheKey,
  transclusionInternals,
  transclusionLinkLabel,
  type TransclusionSource,
  type TransclusionSourceLoader,
} from '../src/renderer/editor/transclusion.js';
import { wikiPrefixAt } from '../src/renderer/editor/wiki-link.js';

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const ID_B = '11111111-2222-3333-4444-555555555555';
const NET = 'c4f9a3b2-1111-2222-3333-444455556666';

/** Собирает плоский список декораций набора. */
function collect(deco: DecorationSet, length: number): Array<{ from: number; to: number; value: Decoration }> {
  const out: Array<{ from: number; to: number; value: Decoration }> = [];
  deco.between(0, length, (from, to, value) => {
    out.push({ from, to, value });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Контекст каретки
// ---------------------------------------------------------------------------

test('transclusionAtCaret: каретка в токене #id', () => {
  const src = `до ![[#${ID_A}]] после`;
  const ref = parseTransclusions(src)[0]!;
  const inId = transclusionAtCaret(src, ref.start + 4);
  assert.ok(inId !== null);
  assert.equal(inId.inId, true);
  assert.equal(inId.inSection, false);
  assert.equal(inId.sectionFrom, null);
  assert.equal(inId.idFrom, ref.start + 3);
  assert.equal(inId.idTo, ref.end - 2);
});

test('transclusionAtCaret: каретка в разделе', () => {
  const src = `![[#${ID_A}#Раздел A]]`;
  const ref = parseTransclusions(src)[0]!;
  const hit = transclusionAtCaret(src, ref.start + ref.raw.indexOf('Раздел') + 2);
  assert.ok(hit !== null);
  assert.equal(hit.inSection, true);
  assert.equal(hit.inId, false);
  assert.equal(src.slice(hit.sectionFrom!, hit.sectionTo!), 'Раздел A');
});

test('transclusionAtCaret: вне ссылки — null', () => {
  assert.equal(transclusionAtCaret(`до ![[#${ID_A}]] после`, 0), null);
});

// ---------------------------------------------------------------------------
// Разделы источника
// ---------------------------------------------------------------------------

test('listSectionTitles: ATX-заголовки по порядку, дубли схлопнуты', () => {
  const body = '## Раздел A\ntext\n### Подраздел\ntext\n## Раздел A\n## Раздел B';
  assert.deepEqual(listSectionTitles(body), ['Раздел A', 'Подраздел', 'Раздел B']);
});

test('listSectionTitles: заголовки с закрывающими # и разными уровнями', () => {
  assert.deepEqual(listSectionTitles('# H1 ##\n#### H4\nне заголовок'), ['H1', 'H4']);
});

test('transclusionLinkLabel: имя и раздел', () => {
  assert.equal(transclusionLinkLabel('Мысль', null), 'Мысль');
  assert.equal(transclusionLinkLabel('Мысль', 'Раздел'), 'Мысль · Раздел');
  assert.equal(transclusionLinkLabel('', null), 'Без имени');
});

// ---------------------------------------------------------------------------
// Автокомплит: порог трансклюзии
// ---------------------------------------------------------------------------

test('wikiPrefixAt: трансклюзия помечается флагом', () => {
  assert.deepEqual(wikiPrefixAt('![[аб'), { open: 1, prefix: 'аб', transclusion: true });
  // Обычная wiki-ссылка — форма ответа прежняя.
  assert.deepEqual(wikiPrefixAt('[[аб'), { open: 0, prefix: 'аб' });
});

// ---------------------------------------------------------------------------
// Декорации трёх режимов
// ---------------------------------------------------------------------------

test('buildTransclusionDecorations: курсор вне — блок с развёрнутым текстом', () => {
  const src = `x ![[#${ID_A}]] y`;
  const refs = parseTransclusions(src);
  const key = transclusionCacheKey(NET, refs[0]!);
  const cache = new Map([[key, { title: 'Мысль', exists: true, error: null, html: '<p>тело</p>' }]]);
  const { deco, atomic } = buildTransclusionDecorations(src, { from: 0, to: 0 }, cache, NET, new Set());
  const items = collect(deco, src.length);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.from, refs[0]!.start);
  assert.equal(items[0]!.to, refs[0]!.end);
  assert.equal(items[0]!.value.spec.block, true);
  assert.equal(atomic.size, 0);
});

test('buildTransclusionDecorations: курсор внутри — атомарный #id, раздел свободен', () => {
  const src = `![[#${ID_A}#Раздел]]`;
  const ref = parseTransclusions(src)[0]!;
  const key = transclusionCacheKey(NET, ref);
  const cache = new Map([[key, { title: 'Мысль', exists: true, error: null, html: null }]]);
  const inside = ref.start + 5;
  const { deco, atomic } = buildTransclusionDecorations(src, { from: inside, to: inside }, cache, NET, new Set());
  const items = collect(deco, src.length);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.from, ref.start + 3); // `#`
  assert.equal(items[0]!.to, ref.start + 3 + 1 + ID_A.length);
  assert.deepEqual(items[0]!.value.spec.widget?.constructor.name, 'TransclusionIdWidget');
  assert.equal(atomic.size, 1, 'токен #id атомарен');
});

test('buildTransclusionDecorations: свёрнутая ссылка — виджет-ссылка без block', () => {
  const src = `![[#${ID_A}]]`;
  const ref = parseTransclusions(src)[0]!;
  const key = transclusionCacheKey(NET, ref);
  const cache = new Map([[key, { title: 'Мысль', exists: true, error: null, html: '<p>тело</p>' }]]);
  const { deco } = buildTransclusionDecorations(src, { from: 0, to: 0 }, cache, NET, new Set([key]));
  const items = collect(deco, src.length);
  assert.equal(items.length, 1);
  assert.notEqual(items[0]!.value.spec.block, true);
  assert.equal(items[0]!.value.spec.widget?.constructor.name, 'TransclusionLinkWidget');
});

// ---------------------------------------------------------------------------
// Развёртка и ошибки
// ---------------------------------------------------------------------------

/** Загрузчик из карты id → тело постоянного комментария. */
function loaderFrom(map: Record<string, string>, titles: Record<string, string> = {}): TransclusionSourceLoader {
  return async (id): Promise<TransclusionSource | null> => {
    const body = map[id];
    if (body === undefined) return null;
    return { found: true, title: titles[id] ?? '', body_md: body };
  };
}

test('expandWithLoader: вложенные источники догружаются итеративно', async () => {
  const load = loaderFrom({
    [ID_A]: `A-тело\n![[#${ID_B}]]`,
    [ID_B]: 'B-тело',
  });
  const { text, top } = await transclusionInternals.expandWithLoader(`![[#${ID_A}]]`, load);
  assert.ok(text.includes('A-тело'), 'текст первого источника развёрнут');
  assert.ok(text.includes('B-тело'), 'вложенный источник развёрнут');
  assert.equal(top?.title ?? '', '');
});

test('loadEntry: источник отсутствует — ошибка source', async () => {
  const ref = parseTransclusions(`![[#${ID_A}]]`)[0]!;
  const entry = await transclusionInternals.loadEntry(ref, loaderFrom({}));
  assert.equal(entry.error, 'source');
  assert.equal(entry.html, null);
});

test('loadEntry: раздела нет в источнике — ошибка section', async () => {
  const ref = parseTransclusions(`![[#${ID_A}#Нет такого]]`)[0]!;
  const entry = await transclusionInternals.loadEntry(ref, loaderFrom({ [ID_A]: '## Другой\nx' }));
  assert.equal(entry.error, 'section');
});

test('loadEntry: успешная развёртка отдаёт HTML без ошибки', async () => {
  const ref = parseTransclusions(`![[#${ID_A}]]`)[0]!;
  const entry = await transclusionInternals.loadEntry(ref, loaderFrom({ [ID_A]: '# Заголовок' }));
  assert.equal(entry.error, null);
  assert.equal(entry.exists, true);
  assert.ok((entry.html ?? '').includes('Заголовок'));
});
