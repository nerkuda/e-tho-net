/**
 * Unit tests трансклюзий комментариев (0.12.1, ТП2, задачи f72a9134,
 * f59d24e1 и 68591b8a). Проверяют чистые функции контекста/разделов/метки,
 * сборку декораций (блок с шапкой-чипом; черновик ссылки с атомарным `#<id>`
 * при вводе), замену ссылки одной транзакцией, итеративную развёртку с
 * инжектируемым загрузчиком источников, а также режим правки блока и «замочек»
 * чужого захвата. Headless — без DOM и сети.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EditorState, RangeSet, type Extension } from '@codemirror/state';
import { Decoration, keymap, runScopeHandlers, type DecorationSet, type EditorView } from '@codemirror/view';

import { parseTransclusions } from '@etn/markdown';

import { ShimElement } from './dom-shim.js';
import {
  NestedEditorStore,
  blockEditorStoreFacet,
  nestedDepthFacet,
  transclusionNestedInternals,
  type NestedViewFactory,
} from '../src/renderer/editor/transclusion-nested.js';
import {
  TRANSCLUSION_BLOCK_CLASS,
  TRANSCLUSION_CHIP_CLASS,
  TRANSCLUSION_COVERED_CLASS,
  TRANSCLUSION_HEAD_CLASS,
  blockEditorHostExtension,
  blockEditorKey,
  buildTransclusionDecorations,
  createTransclusionHead,
  listSectionTitles,
  mergeSectionContent,
  renderTransclusionMarkdown,
  sectionBodyForEdit,
  sectionBoundaryCrossed,
  setActiveBlock,
  transclusionAtCaret,
  transclusionBlockArrow,
  transclusionCacheKey,
  transclusionExtensions,
  transclusionInternals,
  transclusionLabels,
  transclusionLinkChange,
  transclusionLinkLabel,
  transclusionMenuHandlers,
  transclusionMouseDown,
  transclusionNavHandlers,
  transclusionRefStartingAt,
  transclusionSectionAccept,
  transclusionSectionCompletions,
  transclusionState,
  type TransclusionSource,
  type TransclusionSourceLoader,
} from '../src/renderer/editor/transclusion.js';
import { wikiPrefixAt } from '../src/renderer/editor/wiki-link.js';

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const ID_B = '11111111-2222-3333-4444-555555555555';
const NET = 'c4f9a3b2-1111-2222-3333-444455556666';

/** Собирает плоский список декораций набора (декорации или атомарные диапазоны). */
function collect(
  deco: DecorationSet | RangeSet<Decoration>,
  length: number,
): Array<{ from: number; to: number; value: Decoration }> {
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
// Декорации: блок и черновик ссылки при вводе
// ---------------------------------------------------------------------------

test('buildTransclusionDecorations: курсор вне — блок с развёрнутым текстом', () => {
  const src = `x ![[#${ID_A}]] y`;
  const refs = parseTransclusions(src);
  const key = transclusionCacheKey(NET, refs[0]!);
  const cache = new Map([[key, { title: 'Мысль', exists: true, error: null, html: '<p>тело</p>' }]]);
  const { deco, atomic } = buildTransclusionDecorations(src, { from: 0, to: 0 }, cache, NET);
  const items = collect(deco, src.length);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.from, refs[0]!.start);
  assert.equal(items[0]!.to, refs[0]!.end);
  assert.equal(items[0]!.value.spec.block, true);
  // Неделимость навигации стрелками (блокер верификатора): весь диапазон блока
  // атомарен, иначе второй Right заводит каретку внутрь и блок распадается.
  assert.equal(atomic.size, 1);
  assert.deepEqual(collect(atomic, src.length).map((a) => [a.from, a.to]), [
    [refs[0]!.start, refs[0]!.end],
  ]);
});

test('buildTransclusionDecorations: курсор внутри — атомарный #id при вводе ссылки', () => {
  const src = `![[#${ID_A}#Раздел]]`;
  const ref = parseTransclusions(src)[0]!;
  const key = transclusionCacheKey(NET, ref);
  const cache = new Map([[key, { title: 'Мысль', exists: true, error: null, html: null }]]);
  const inside = ref.start + 5;
  const { deco, atomic } = buildTransclusionDecorations(src, { from: inside, to: inside }, cache, NET);
  const items = collect(deco, src.length);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.from, ref.start + 3); // `#`
  assert.equal(items[0]!.to, ref.start + 3 + 1 + ID_A.length);
  assert.deepEqual(items[0]!.value.spec.widget?.constructor.name, 'TransclusionIdWidget');
  assert.equal(atomic.size, 1, 'токен #id атомарен');
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

// ---------------------------------------------------------------------------
// Режим правки блока и захват источника (задача f59d24e1)
// ---------------------------------------------------------------------------

/** Кэш с одним готовым блоком ссылки `ref`. */
function cacheFor(ref: ReturnType<typeof parseTransclusions>[number]): Map<
  string,
  { title: string; exists: boolean; error: null; html: string }
> {
  return new Map([
    [transclusionCacheKey(NET, ref), { title: 'Мысль', exists: true, error: null, html: '<p>тело</p>' }],
  ]);
}

type BlockSpec = {
  block?: boolean;
  widget?: {
    active?: boolean;
    editorKey?: string;
    sourceId?: string;
    lockedBy?: string | null;
    covered?: boolean;
  };
};

test('buildTransclusionDecorations: активный блок — признак active (73ae1d4b)', () => {
  const src = `до ![[#${ID_A}]] после`;
  const ref = parseTransclusions(src)[0]!;
  const { deco, atomic } = buildTransclusionDecorations(
    src,
    { from: 0, to: 0 },
    cacheFor(ref),
    NET,
    blockEditorKey(ID_A, null),
  );
  const items = collect(deco, src.length);
  assert.equal(items.length, 1);
  const spec = items[0]!.value.spec as BlockSpec;
  assert.equal(spec.block, true);
  assert.equal(spec.widget?.active, true);
  assert.equal(spec.widget?.editorKey, blockEditorKey(ID_A, null));
  assert.equal(spec.widget?.sourceId, ID_A);
  assert.equal(spec.widget?.lockedBy, null);
  // Блок остаётся единым атомарным диапазоном контейнера (неделимость, a2b68d72).
  assert.equal(atomic.size, 1);
  assert.deepEqual(collect(atomic, src.length).map((a) => [a.from, a.to]), [[ref.start, ref.end]]);
});

test('buildTransclusionDecorations: чужой захват источника — lockedBy в блоке', () => {
  const src = `![[#${ID_A}]]`;
  const ref = parseTransclusions(src)[0]!;
  const { deco } = buildTransclusionDecorations(
    src,
    { from: 0, to: 0 },
    cacheFor(ref),
    NET,
    null,
    new Map([[ID_A, 'Алиса']]),
  );
  const spec = collect(deco, src.length)[0]!.value.spec as BlockSpec;
  assert.equal(spec.widget?.lockedBy, 'Алиса');
  assert.equal(spec.widget?.active, false);
});

test('buildTransclusionDecorations: активен только один блок', () => {
  const src = `![[#${ID_A}]] и ![[#${ID_B}]]`;
  const refs = parseTransclusions(src);
  const cache = new Map([
    ...cacheFor(refs[0]!),
    ...cacheFor(refs[1]!),
  ]);
  const { deco } = buildTransclusionDecorations(
    src,
    { from: 0, to: 0 },
    cache,
    NET,
    blockEditorKey(ID_A, null),
  );
  const specs = collect(deco, src.length).map((item) => item.value.spec as BlockSpec);
  assert.equal(specs.length, 2);
  assert.equal(specs[0]!.widget?.sourceId, ID_A);
  assert.equal(specs[0]!.widget?.active, true);
  assert.equal(specs[1]!.widget?.sourceId, ID_B);
  assert.equal(specs[1]!.widget?.active, false);
});

test('transclusionState: setActiveBlock включает и выключает активный блок', () => {
  const state = EditorState.create({
    doc: `![[#${ID_A}]]`,
    extensions: [transclusionState],
  });
  assert.equal(state.field(transclusionState).activeKey, null);
  const key = blockEditorKey(ID_A, null);
  const entered = state.update({ effects: setActiveBlock.of(key) }).state;
  assert.equal(entered.field(transclusionState).activeKey, key);
  const exited = entered.update({ effects: setActiveBlock.of(null) }).state;
  assert.equal(exited.field(transclusionState).activeKey, null);
});

// ---------------------------------------------------------------------------
// Визуальные слои блока в просмотре (задача a2b68d72, ADR c425202a)
// ---------------------------------------------------------------------------

test('transclusionLabels: обе подписи ошибок и пропуск непусты', () => {
  const labels = transclusionLabels();
  assert.ok(labels.noSource.length > 0);
  assert.ok(labels.noSection.length > 0);
  assert.ok(labels.skipped.length > 0);
  assert.notEqual(labels.noSource, labels.noSection);
});

test('renderTransclusionMarkdown: обёртка с глубиной и источником', () => {
  const ID = ID_A;
  const text = `<!-- etn:transclusion begin source=${ID} depth=1 -->\nтело\n<!-- etn:transclusion end source=${ID} depth=1 -->`;
  const html = renderTransclusionMarkdown(text);
  assert.ok(html.includes('class="md-transclusion"'));
  assert.ok(html.includes('data-transclusion-depth="1"'));
  assert.ok(html.includes(`data-transclusion-source="${ID}"`));
});

test('expandWithLoader: текст без трансклюзий возвращается как есть', async () => {
  const { text, top } = await transclusionInternals.expandWithLoader(
    'обычный текст',
    loaderFrom({}),
  );
  assert.equal(text, 'обычный текст');
  assert.equal(top, null);
});

test('loadEntry: развёртка даёт HTML просмотра с блоком глубины 1', async () => {
  const ref = parseTransclusions(`![[#${ID_A}]]`)[0]!;
  const entry = await transclusionInternals.loadEntry(ref, loaderFrom({ [ID_A]: '# Заголовок' }));
  assert.equal(entry.error, null);
  assert.ok((entry.html ?? '').includes('class="md-transclusion"'));
  assert.ok((entry.html ?? '').includes('data-transclusion-depth="1"'));
});

test('loadEntry: вложенный источник даёт блок глубины 2', async () => {
  const ref = parseTransclusions(`![[#${ID_A}]]`)[0]!;
  const entry = await transclusionInternals.loadEntry(
    ref,
    loaderFrom({ [ID_A]: `A ![[#${ID_B}]]`, [ID_B]: 'B' }),
  );
  assert.ok((entry.html ?? '').includes('data-transclusion-depth="2"'));
});

test('просмотр: развёртка + рендер дают блоки с уровнями', async () => {
  // Прод-путь просмотра `markdown-field.renderView`: expandWithLoader даёт
  // развёрнутый текст с маркерами, renderTransclusionMarkdown — HTML с
  // блочными обёртками (глубина/ошибки).
  const { text } = await transclusionInternals.expandWithLoader(
    `![[#${ID_A}]]`,
    loaderFrom({ [ID_A]: `A ![[#${ID_B}]]`, [ID_B]: 'B' }),
  );
  const html = renderTransclusionMarkdown(text);
  assert.ok(html.includes('class="md-transclusion"'));
  assert.ok(html.includes('data-transclusion-depth="1"'));
  assert.ok(html.includes('data-transclusion-depth="2"'));
});

test('просмотр: нет источника — плашка ошибки в HTML', async () => {
  const { text } = await transclusionInternals.expandWithLoader(
    `![[#${ID_A}]]`,
    loaderFrom({}),
  );
  const html = renderTransclusionMarkdown(text);
  assert.ok(html.includes('md-transclusion--missing'));
  assert.ok(html.includes('md-transclusion'));
});

// ---------------------------------------------------------------------------
// Вложенная правка блока с записью в источник (задача e2c14673)
// ---------------------------------------------------------------------------

test('sectionBodyForEdit: содержимое раздела без строки заголовка', () => {
  const body = '## Раздел A\nстрока 1\n### Подраздел\nстрока 2\n## Раздел B\nx';
  assert.equal(sectionBodyForEdit(body, 'Раздел A'), 'строка 1\n### Подраздел\nстрока 2');
  assert.equal(sectionBodyForEdit(body, 'Раздел B'), 'x');
  assert.equal(sectionBodyForEdit(body, 'Нет'), null);
});

test('mergeSectionContent: правка раздела не трогает соседние разделы', () => {
  const body = '## Раздел A\nстарое\n## Раздел B\nkeep';
  const merged = mergeSectionContent(body, 'Раздел A', 'новое');
  assert.equal(merged, '## Раздел A\nновое\n## Раздел B\nkeep');
  assert.equal(mergeSectionContent(body, 'Нет', 'x'), null);
});

test('sectionBoundaryCrossed: заголовок того же/высшего уровня завершает раздел', () => {
  const body = '## Раздел A\nстарое\n### Подраздел\nx';
  assert.equal(sectionBoundaryCrossed(body, 'Раздел A', 'текст'), false);
  assert.equal(sectionBoundaryCrossed(body, 'Раздел A', '### вложенный'), false);
  assert.equal(sectionBoundaryCrossed(body, 'Раздел A', '## новый раздел'), true);
  assert.equal(sectionBoundaryCrossed(body, 'Раздел A', '# H1'), true);
});


// ---------------------------------------------------------------------------
// Контекстное меню блока (задача 955478e8, элемент 1e0fb0bd)
// ---------------------------------------------------------------------------

test('transclusionMenuHandlers: четыре команды навигации, без «Редактировать» и «Изменить ссылку»', () => {
  const src = `![[#${ID_A}]]`;
  const ref = parseTransclusions(src)[0]!;
  const view = { state: EditorState.create({ doc: src }) } as unknown as Parameters<
    typeof transclusionMenuHandlers
  >[0];
  const handlers = transclusionMenuHandlers(view, ref);
  assert.deepEqual(
    Object.keys(handlers).sort(),
    ['transclusion.copyId', 'transclusion.copyLink', 'transclusion.focusSource', 'transclusion.openSource'],
  );
  assert.equal('transclusion.edit' in handlers, false, 'пункта «Редактировать» нет — вход кареткой');
  assert.equal('transclusion.changeLink' in handlers, false, 'сворачивания блока больше нет');
});

test('transclusionNavHandlers: четыре команды навигации без правки ссылки', () => {
  const handlers = transclusionNavHandlers(ID_A, `![[#${ID_A}]]`);
  assert.deepEqual(Object.keys(handlers).sort(), [
    'transclusion.copyId',
    'transclusion.copyLink',
    'transclusion.focusSource',
    'transclusion.openSource',
  ]);
});

test('transclusionLinkChange: одна транзакция замены ссылки, защита от сдвига/совпадения', () => {
  const raw = `до ![[#${ID_A}#Раздел]] после`;
  const ref = parseTransclusions(raw)[0]!;
  // Смена раздела — диапазон прежней ссылки, новая ссылка.
  assert.deepEqual(
    transclusionLinkChange(raw, ref.start, ID_A, ID_A, 'Другой'),
    { from: ref.start, to: ref.end, insert: `![[#${ID_A}#Другой]]` },
  );
  // Смена мысли.
  assert.deepEqual(
    transclusionLinkChange(raw, ref.start, ID_A, ID_B, null),
    { from: ref.start, to: ref.end, insert: `![[#${ID_B}]]` },
  );
  // Ссылка совпала с прежней — менять нечего.
  assert.equal(transclusionLinkChange(raw, ref.start, ID_A, ID_A, 'Раздел'), null);
  // Источник под началом диапазона сменился, пока поповер был открыт, —
  // слепая замена запрещена.
  assert.equal(transclusionLinkChange(raw, ref.start, ID_B, ID_A, null), null);
  // Ссылки по этому смещению нет вовсе.
  assert.equal(transclusionLinkChange(raw, 0, ID_A, ID_A, null), null);
  // Одна транзакция даёт ожидаемый документ и каретку за ссылкой.
  const change = transclusionLinkChange(raw, ref.start, ID_A, ID_B, 'Раздел X')!;
  const state = EditorState.create({ doc: raw }).update({
    changes: change,
    selection: { anchor: change.from + change.insert.length },
  }).state;
  assert.equal(state.doc.toString(), `до ![[#${ID_B}#Раздел X]] после`);
});

// ---------------------------------------------------------------------------
// Блок-атом: выделение, декорации (ошибка 5312142d)
// ---------------------------------------------------------------------------

const BLOCK_RAW = `![[#${ID_A}]]`;

test('transclusionAtCaret: границы исключающие — позиция на start/end не внутри (5312142d)', () => {
  const src = `до ![[#${ID_A}]] после`;
  const ref = parseTransclusions(src)[0]!;
  assert.equal(transclusionAtCaret(src, ref.start), null, 'start — не внутри ссылки');
  assert.equal(transclusionAtCaret(src, ref.end), null, 'end — не внутри ссылки');
  assert.ok(transclusionAtCaret(src, ref.start + 1) !== null, 'строго внутри — ссылка найдена');
});

test('transclusionRefStartingAt: ссылка по началу диапазона найдена (5312142d)', () => {
  const src = `до ![[#${ID_A}]] после`;
  const ref = parseTransclusions(src)[0]!;
  assert.equal(transclusionRefStartingAt(src, ref.start)?.sourceId, ID_A);
  assert.equal(transclusionRefStartingAt(src, ref.start + 1), null);
});

test('buildTransclusionDecorations: выделение покрывает блок целиком — остаётся блок (5312142d)', () => {
  const src = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(src)[0]!;
  const { deco, atomic } = buildTransclusionDecorations(
    src,
    { from: ref.start, to: ref.end },
    cacheFor(ref),
    NET,
  );
  const items = collect(deco, src.length);
  assert.equal(items.length, 1);
  const spec = items[0]!.value.spec as BlockSpec;
  assert.equal(spec.block, true, 'блок не разбирается в markdown при полном выделении');
  assert.equal(spec.widget?.constructor.name, 'TransclusionBlockWidget');
  assert.equal(atomic.size, 1, 'блок остаётся единым атомом');
});

test('buildTransclusionDecorations: выделение внутри ссылки — черновик ссылки с #id (5312142d)', () => {
  const src = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(src)[0]!;
  const { deco } = buildTransclusionDecorations(
    src,
    { from: ref.start + 2, to: ref.end },
    cacheFor(ref),
    NET,
  );
  const widget = collect(deco, src.length)[0]!.value.spec as BlockSpec;
  assert.equal(widget.widget?.constructor.name, 'TransclusionIdWidget', 'частичное выделение — сырой markdown');
});

test('buildTransclusionDecorations: полное покрытие выделением — блок помечен covered (39553204)', () => {
  const src = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(src)[0]!;
  const { deco } = buildTransclusionDecorations(
    src,
    { from: ref.start, to: ref.end },
    cacheFor(ref),
    NET,
  );
  const spec = collect(deco, src.length)[0]!.value.spec as BlockSpec;
  assert.equal(spec.block, true, 'блок не разобран');
  assert.equal(spec.widget?.covered, true, 'блок целиком покрыт выделением — класс «выделен целиком»');
});

test('buildTransclusionDecorations: без/вне выделения блок не covered (39553204)', () => {
  const src = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(src)[0]!;
  const widgetOf = (sel: { from: number; to: number }): BlockSpec =>
    collect(buildTransclusionDecorations(src, sel, cacheFor(ref), NET).deco, src.length)[0]!
      .value.spec as BlockSpec;
  assert.equal(widgetOf({ from: 0, to: 0 }).widget?.covered, false, 'без выделения блок не помечен');
  const beforeRef = widgetOf({ from: 0, to: 2 });
  assert.equal(beforeRef.block, true, 'выделение рядом с блоком его не задевает');
  assert.equal(beforeRef.widget?.covered, false, 'выделение вне блока не помечает его');
});

test('TransclusionBlockWidget.eq учитывает флаг covered — перерисовка (39553204)', () => {
  const src = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(src)[0]!;
  const cache = cacheFor(ref);
  const widgetOf = (sel: { from: number; to: number }) =>
    (collect(buildTransclusionDecorations(src, sel, cache, NET).deco, src.length)[0]!.value
      .spec as BlockSpec).widget as unknown as { eq(other: unknown): boolean };
  const plain = widgetOf({ from: 0, to: 0 });
  const covered = widgetOf({ from: ref.start, to: ref.end });
  assert.equal(plain.eq(covered), false, 'разный covered — виджет перерисовывается');
  const coveredAgain = widgetOf({ from: ref.start, to: ref.end });
  assert.equal(covered.eq(coveredAgain), true, 'тот же covered — виджет переиспользуется');
});

test('TransclusionBlockWidget.toDOM: покрытый блок несёт класс «выделен целиком» (39553204)', () => {
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = ShimElement;
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    querySelectorAll: () => [],
  };
  const src = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(src)[0]!;
  const widgetOf = (sel: { from: number; to: number }) =>
    (collect(buildTransclusionDecorations(src, sel, cacheFor(ref), NET).deco, src.length)[0]!.value
      .spec as BlockSpec).widget as unknown as { toDOM(view: unknown): ShimElement };
  const view = { state: EditorState.create({ doc: src, extensions: [transclusionState] }) };
  const covered = widgetOf({ from: ref.start, to: ref.end }).toDOM(view);
  assert.ok(covered.classList.contains(TRANSCLUSION_COVERED_CLASS), 'класс покрытия на элементе блока');
  const plain = widgetOf({ from: 0, to: 0 }).toDOM(view);
  assert.ok(!plain.classList.contains(TRANSCLUSION_COVERED_CLASS), 'обычный блок класса покрытия не несёт');
});

test('TransclusionBlockWidget.toDOM: шапка-чип без ховер-кнопок (вход в блок кареткой, 73ae1d4b)', () => {
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = ShimElement;
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    querySelectorAll: () => [],
  };
  const src = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(src)[0]!;
  const widget = (
    collect(buildTransclusionDecorations(src, { from: 0, to: 0 }, cacheFor(ref), NET).deco, src.length)[0]!
      .value.spec as BlockSpec
  ).widget as unknown as { toDOM(view: unknown): ShimElement };
  const view = { state: EditorState.create({ doc: src, extensions: [transclusionState] }) };
  const el = widget.toDOM(view);
  // Шапка-чип «имя · раздел» (задача 68591b8a) — всегда видна, одна на блок.
  const heads = el.querySelectorAll(`.${TRANSCLUSION_HEAD_CLASS}`);
  assert.equal(heads.length, 1, 'одна шапка-чип на блок');
  const chip = heads[0]!.querySelector(`.${TRANSCLUSION_CHIP_CLASS}`);
  assert.ok(chip !== null, 'шапка несёт чип-кнопку');
  assert.equal(chip!.textContent, 'Мысль', 'чип подписан именем источника');
  // Ховер-кнопок правки блока больше нет: вход в блок — кареткой, ссылка
  // правится чипом-шапкой (задача 73ae1d4b).
  assert.equal(el.querySelectorAll('.ui-btn').length, 1, 'на блоке ровно одна кнопка — чип');
});

test('TransclusionBlockWidget.updateDOM: косметика не переносит DOM вложенного редактора (ce46723d)', () => {
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = ShimElement;
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    querySelectorAll: () => [],
  };
  const src = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(src)[0]!;
  const key = blockEditorKey(ID_A, null);
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  store.mount(key, 'ТЕЛО', {
    depth: 1,
    onDirty: () => undefined,
    onExit: () => undefined,
    onCommit: () => undefined,
    onCancel: () => undefined,
  });
  const view = {
    state: EditorState.create({
      doc: src,
      extensions: [transclusionState, blockEditorStoreFacet.of(store)],
    }),
  } as unknown as EditorView;

  interface WidgetProbe {
    toDOM(v: unknown): ShimElement;
    updateDOM(dom: unknown, v: unknown): boolean;
    eq(other: unknown): boolean;
  }
  const widgetOf = (
    sel: { from: number; to: number },
    cache: Map<string, { title: string; exists: boolean; error: null; html: string }>,
  ): WidgetProbe =>
    (collect(buildTransclusionDecorations(src, sel, cache, NET, key, new Map()).deco, src.length)[0]!
      .value.spec as { widget: WidgetProbe }).widget;

  const active = widgetOf({ from: 0, to: 0 }, cacheFor(ref));
  const box = active.toDOM(view);
  const nested = store.dom(key)! as unknown as ShimElement;
  assert.ok(box.children.includes(nested), 'активный блок отрисовал DOM вложенного редактора');

  // Косметика covered: false → true. Виджет не равен — но DOM обновляется НА МЕСТЕ.
  const covered = widgetOf({ from: ref.start, to: ref.end }, cacheFor(ref));
  assert.equal(active.eq(covered), false, 'флаг covered отличает виджеты (триггер updateDOM)');
  assert.equal(covered.updateDOM(box, view), true, 'updateDOM сообщает об обновлении на месте');
  assert.ok(box.classList.contains(TRANSCLUSION_COVERED_CLASS), 'класс покрытия отражён в DOM');
  assert.ok(box.children.includes(nested), 'DOM вложенного редактора НЕ перенесён при смене covered');

  // Обновление подписи чипа (имя источника) — тоже без переноса вложенного DOM.
  const renamedCache = cacheFor(ref);
  renamedCache.set(transclusionCacheKey(NET, ref), {
    title: 'Новое имя',
    exists: true,
    error: null,
    html: '<p>тело</p>',
  });
  const renamed = widgetOf({ from: 0, to: 0 }, renamedCache);
  assert.equal(covered.eq(renamed), false, 'смена имени отличает виджеты');
  renamed.updateDOM(box, view);
  const chip = box.querySelector(`.${TRANSCLUSION_CHIP_CLASS}`);
  assert.equal(chip?.textContent, 'Новое имя', 'подпись чипа обновлена на месте');
  assert.ok(box.children.includes(nested), 'DOM вложенного редактора по-прежнему на месте');
});

test('createTransclusionHead: чип-кнопка словаря с подписью и гашением mousedown', () => {
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = ShimElement;
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    querySelectorAll: () => [],
  };
  let clicked = 0;
  const head = createTransclusionHead('Мысль · Раздел', () => {
    clicked += 1;
  });
  const chip = head.querySelector(`.${TRANSCLUSION_CHIP_CLASS}`) as ShimElement | null;
  assert.ok(chip !== null, 'чип собран');
  assert.equal(chip!.textContent, 'Мысль · Раздел');
  const down = { defaultPrevented: false, preventDefault(): void { this.defaultPrevented = true; } };
  chip!.emit('mousedown', down);
  assert.equal(down.defaultPrevented, true, 'mousedown по чипу не двигает каретку/фокус');
  chip!.click();
  assert.equal(clicked, 1, 'клик по чипу вызывает обработчик');
});

// ---------------------------------------------------------------------------
// Вложенный редактор блока: вход/выход, «грязный» флаг, рекурсия (задача 73ae1d4b)
// ---------------------------------------------------------------------------

const NET_ID = 'c4f9a3b2-1111-2222-3333-444455556666';

/** Минимальное событие клавиатуры для `runScopeHandlers`. */
function keyEvent(init: { key: string; code: string; ctrl?: boolean }): KeyboardEvent {
  return {
    key: init.key,
    code: init.code,
    keyCode: init.key === 'Enter' ? 13 : 0,
    ctrlKey: init.ctrl === true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    defaultPrevented: false,
    preventDefault(): void {},
  } as unknown as KeyboardEvent;
}

interface FakeView {
  state: EditorState;
  dispatch(spec: unknown): void;
  focus(): void;
}

function makeView(initial: EditorState): FakeView {
  const view: FakeView = {
    state: initial,
    dispatch(spec: unknown): void {
      view.state = view.state.update(spec as never).state;
    },
    focus(): void {},
  };
  return view;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Заглушка моста `etn`: тела источников (по id либо одно на все). */
function stubEtn(bodies: string | Record<string, string>): void {
  // Изоляция прогонов: вход в блок читает тело из ОБЩЕГО кэша сети, а стаб
  // меняет тело без realtime-инвалидации — чистим кэш перед каждым стабом.
  transclusionInternals.clearSourceCache();
  const bodyFor = (id: string): string =>
    typeof bodies === 'string' ? bodies : bodies[id] ?? '';
  (globalThis as unknown as { etn: unknown }).etn = {
    thoughts: {
      resolve: async (_n: string, ids: string[]) => ids.map((id) => ({ id, title: 'Источник' })),
    },
    comments: {
      list: async (_n: string, _t: string, id: string) => [
        { id: `perm-${id}`, kind: 'permanent', body_md: bodyFor(id), body_html: '', version: 1 },
      ],
    },
  };
}

/** Дублёр вложенного инстанса: EditorState + фокус (настоящий CM в шиме не живёт). */
class FakeNestedView {
  state: EditorState;
  focused = false;
  onInput: ((md: string) => void) | null = null;
  constructor(doc: string, extensions: Extension[]) {
    this.state = EditorState.create({ doc, extensions });
  }
  dispatch(spec: unknown): void {
    const before = this.state.doc.toString();
    this.state = this.state.update(spec as never).state;
    const after = this.state.doc.toString();
    if (after !== before) this.onInput?.(after);
  }
  focus(): void {
    this.focused = true;
  }
}

/** Фабрика-дублёр вложенных редакторов: запоминает инстансы по ключу. */
function fakeFactory(registry: Map<string, FakeNestedView>): NestedViewFactory {
  return (params) => {
    const v = new FakeNestedView(params.initialText, params.extensions);
    v.onInput = params.onInput;
    registry.set(params.key, v);
    const dom = new ShimElement('div');
    return { view: v as unknown as EditorView, dom: dom as unknown as HTMLElement };
  };
}

/** Состояние контейнера с хранилищем вложенных редакторов и (опц.) хостом. */
function withStore(doc: string, store: NestedEditorStore, extra: Extension[] = []): EditorState {
  return EditorState.create({
    doc,
    extensions: [...transclusionExtensions, ...extra, blockEditorStoreFacet.of(store)],
  });
}

test('Enter на выделенном блоке монтирует вложенный редактор, контейнер не меняется (73ae1d4b)', async () => {
  stubEtn('ТЕЛО ИСТОЧНИКА');
  const { store: appStore } = await import('../src/renderer/state.js');
  appStore.update({ networkId: NET_ID });
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const doc = `вступление ${BLOCK_RAW} окончание`;
  const ref = parseTransclusions(doc)[0]!;
  let state = withStore(doc, store);
  state = state.update({ selection: { anchor: ref.start, head: ref.end } }).state;
  const view = makeView(state);

  const handled = runScopeHandlers(view as unknown as EditorView, keyEvent({ key: 'Enter', code: 'Enter' }), 'editor');
  assert.equal(handled, true, 'Enter на выделенном блоке перехвачен (вход в блок)');
  await tick();
  await tick();

  const key = blockEditorKey(ID_A, null);
  assert.equal(view.state.field(transclusionState)!.activeKey, key, 'блок активирован');
  assert.ok(store.has(key), 'вложенный инстанс смонтирован');
  assert.equal(store.text(key), 'ТЕЛО ИСТОЧНИКА', 'текст раздела в инстансе');
  assert.equal(view.state.doc.toString(), doc, 'ДОКУМЕНТ КОНТЕЙНЕРА НЕ ИЗМЕНЁН');
  assert.equal(registry.get(key)!.focused, true, 'фокус перенесён внутрь блока');
});

test('стрелка внутрь блока монтирует вложенный редактор (73ae1d4b)', async () => {
  stubEtn('ТЕЛО');
  const { store: appStore } = await import('../src/renderer/state.js');
  appStore.update({ networkId: NET_ID });
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const doc = `до${BLOCK_RAW}`;
  const ref = parseTransclusions(doc)[0]!;
  let state = withStore(doc, store);
  state = state.update({ selection: { anchor: ref.start } }).state;
  const view = makeView(state);

  const handled = runScopeHandlers(
    view as unknown as EditorView,
    keyEvent({ key: 'ArrowRight', code: 'ArrowRight' }),
    'editor',
  );
  assert.equal(handled, true, 'стрелка, входящая в блок, обрабатывается');
  await tick();
  await tick();
  const key = blockEditorKey(ID_A, null);
  assert.equal(view.state.field(transclusionState)!.activeKey, key);
  assert.ok(store.has(key), 'инстанс смонтирован стрелкой');
});

test('клик по блоку монтирует вложенный редактор (73ae1d4b)', async () => {
  stubEtn('ТЕЛО');
  const { store: appStore } = await import('../src/renderer/state.js');
  appStore.update({ networkId: NET_ID });
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = ShimElement;
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const doc = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(doc)[0]!;
  const view = makeView(withStore(doc, store));

  const el = new ShimElement('div');
  el.className = TRANSCLUSION_BLOCK_CLASS;
  el.dataset['mdFrom'] = String(ref.start);
  el.dataset['mdTo'] = String(ref.end);
  el.dataset['transclusionSource'] = ID_A;
  (el as unknown as { closest: (s: string) => ShimElement | null }).closest = (s) =>
    s.includes(TRANSCLUSION_BLOCK_CLASS) ? el : null;

  const handled = transclusionMouseDown(
    { button: 0, target: el } as unknown as MouseEvent,
    view as unknown as EditorView,
  );
  assert.equal(handled, true, 'клик по блоку обработан');
  await tick();
  await tick();
  const key = blockEditorKey(ID_A, null);
  assert.equal(view.state.field(transclusionState)!.activeKey, key, 'блок активирован кликом');
  assert.ok(store.has(key), 'инстанс смонтирован кликом');
});

test('вход в блок стрелками симметричен с обеих границ (ea9c76d3)', () => {
  // Блок на ОТДЕЛЬНОЙ строке — как в реальном комментарии.
  const doc = `до\n${BLOCK_RAW}\nпосле`;
  const ref = parseTransclusions(doc)[0]!;

  // Каретка на НИЖНЕЙ границе блока (позиция после выхода «вниз»/«вправо»):
  // ArrowUp и ArrowLeft обязаны войти в блок, а не перескочить его.
  const atEnd = makeView(
    EditorState.create({ doc, extensions: [...transclusionExtensions] }).update({
      selection: { anchor: ref.end },
    }).state,
  );
  assert.equal(
    transclusionBlockArrow(atEnd as unknown as EditorView, 'up'),
    true,
    'ArrowUp с нижней границы входит в блок',
  );
  assert.equal(
    transclusionBlockArrow(atEnd as unknown as EditorView, 'left'),
    true,
    'ArrowLeft с нижней границы входит в блок',
  );

  // Каретка на ВЕРХНЕЙ границе блока (позиция после выхода «вверх»/«влево»):
  // ArrowDown и ArrowRight обязаны войти в блок.
  const atStart = makeView(
    EditorState.create({ doc, extensions: [...transclusionExtensions] }).update({
      selection: { anchor: ref.start },
    }).state,
  );
  assert.equal(
    transclusionBlockArrow(atStart as unknown as EditorView, 'down'),
    true,
    'ArrowDown с верхней границы входит в блок',
  );
  assert.equal(
    transclusionBlockArrow(atStart as unknown as EditorView, 'right'),
    true,
    'ArrowRight с верхней границы входит в блок',
  );
});

test('вход в блок синхронен: монтаж из кэша источника, без сети (ce46723d)', async () => {
  stubEtn('ТЕЛО');
  const { store: appStore } = await import('../src/renderer/state.js');
  appStore.update({ networkId: NET_ID });
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const doc = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(doc)[0]!;
  const view = makeView(withStore(doc, store));

  // Тело уже загружено для отрисовки блока (общий кэш сети наполняет loader).
  await transclusionInternals.cachedTransclusionLoader(NET_ID)(ID_A);

  // Первое нажатие обязано смонтировать инстанс и отдать фокус СИНХРОННО —
  // без ожидания сети и микрозадач (иначе каретка теряется, ce46723d).
  transclusionInternals.enterBlock(view as unknown as EditorView, ref);
  const key = blockEditorKey(ID_A, null);
  assert.ok(store.has(key), 'инстанс смонтирован в том же тике, что и вход');
  assert.equal(registry.get(key)!.focused, true, 'фокус во вложенном редакторе получен синхронно');
  assert.equal(view.state.field(transclusionState)!.activeKey, key, 'блок активирован синхронно');
});

test('повторные стрелки при промахе кэша не запускают вторую дозагрузку (ce46723d)', async () => {
  // Кэш пуст, стаб считает сетевые загрузки источника.
  let fetches = 0;
  (globalThis as unknown as { etn: unknown }).etn = {
    thoughts: {
      resolve: async (_n: string, ids: string[]) => {
        fetches += 1;
        return ids.map((id) => ({ id, title: 'Источник' }));
      },
    },
    comments: {
      list: async () => [
        { id: 'perm', kind: 'permanent', body_md: 'ТЕЛО', body_html: '', version: 1 },
      ],
    },
  };
  transclusionInternals.clearSourceCache();
  const { store: appStore } = await import('../src/renderer/state.js');
  appStore.update({ networkId: NET_ID });
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const doc = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(doc)[0]!;
  const view = makeView(withStore(doc, store));

  // Три нажатия до завершения загрузки: дедупликация держит один запрос.
  transclusionInternals.enterBlock(view as unknown as EditorView, ref);
  transclusionInternals.enterBlock(view as unknown as EditorView, ref);
  transclusionInternals.enterBlock(view as unknown as EditorView, ref);
  await tick();
  await tick();
  const key = blockEditorKey(ID_A, null);
  assert.ok(store.has(key), 'блок смонтирован после дозагрузки');
  assert.equal(fetches, 1, 'сетевой запрос за источником сделан ровно один раз');
});

test('изменение текста блока: «грязный» сигнал наружу, контейнер не меняется (73ae1d4b)', async () => {
  stubEtn('ТЕЛО');
  const { store: appStore } = await import('../src/renderer/state.js');
  appStore.update({ networkId: NET_ID });
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  let dirtyCalls = 0;
  const doc = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(doc)[0]!;
  const view = makeView(
    withStore(doc, store, [blockEditorHostExtension({ onBlockDirty: () => (dirtyCalls += 1) })]),
  );

  transclusionInternals.enterBlock(view as unknown as EditorView, ref);
  await tick();
  await tick();
  const key = blockEditorKey(ID_A, null);
  assert.equal(store.isDirty(key), false, 'сразу после входа блок не грязный');

  registry.get(key)!.dispatch({ changes: { from: 0, insert: 'X' } });
  assert.equal(store.isDirty(key), true, 'инстанс помечен грязным');
  assert.equal(dirtyCalls, 1, 'сигнал ушёл в хост');
  assert.equal(view.state.doc.toString(), doc, 'документ контейнера не изменился');
});

test('выход из блока сохраняет текст инстанса и возвращает каретку (73ae1d4b)', async () => {
  stubEtn('ТЕЛО');
  const { store: appStore } = await import('../src/renderer/state.js');
  appStore.update({ networkId: NET_ID });
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const doc = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(doc)[0]!;
  const view = makeView(withStore(doc, store));

  transclusionInternals.enterBlock(view as unknown as EditorView, ref);
  await tick();
  await tick();
  const key = blockEditorKey(ID_A, null);
  registry.get(key)!.dispatch({ changes: { from: 0, to: 0, insert: 'X' } });

  transclusionInternals.exitBlock(view as unknown as EditorView, key, 'ctrl-enter');
  assert.equal(view.state.field(transclusionState)!.activeKey, null, 'блок деактивирован');
  assert.equal(store.text(key), 'XТЕЛО', 'текст правки сохранён в состоянии инстанса');
  assert.equal(view.state.selection.main.head, ref.end, 'каретка вернулась в контейнер за блоком');
});

test('Esc: откат инстанса к загруженному тексту (73ae1d4b)', async () => {
  stubEtn('ТЕЛО');
  const { store: appStore } = await import('../src/renderer/state.js');
  appStore.update({ networkId: NET_ID });
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const doc = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(doc)[0]!;
  const view = makeView(withStore(doc, store));

  transclusionInternals.enterBlock(view as unknown as EditorView, ref);
  await tick();
  await tick();
  const key = blockEditorKey(ID_A, null);
  registry.get(key)!.dispatch({ changes: { from: 0, insert: 'X' } });
  assert.equal(store.isDirty(key), true);

  store.rollback(key);
  assert.equal(store.text(key), 'ТЕЛО', 'текст откатился к загруженному');
  assert.equal(store.isDirty(key), false, 'грязность снята');
});

test('exitBlock: blur не навязывает фокус контейнеру, клавиша — возвращает (b4986d3a)', () => {
  const doc = `до ${BLOCK_RAW} после`;
  const key = blockEditorKey(ID_A, null);
  const make = (): { view: FakeView; focuses: () => number } => {
    let state = EditorState.create({ doc, extensions: [...transclusionExtensions] });
    state = state.update({ effects: setActiveBlock.of(key) }).state;
    const view = makeView(state);
    let focuses = 0;
    (view as unknown as { focus: () => void }).focus = () => {
      focuses += 1;
    };
    return { view, focuses: () => focuses };
  };

  // Причина `blur` (клик по постороннему элементу вне поля): фокус НЕ возвращаем
  // в контейнер — иначе клик «перехватывается» обратно в поле (контракт на
  // `exitBlock`, ошибка b4986d3a).
  const blurred = make();
  transclusionInternals.exitBlock(blurred.view as unknown as EditorView, key, 'blur');
  assert.equal(blurred.focuses(), 0, 'blur не навязывает фокус контейнеру');
  assert.equal(blurred.view.state.field(transclusionState)!.activeKey, null, 'блок деактивирован');

  // Остальные причины выхода инициированы клавишей внутри блока — фокус
  // возвращается на границу блока.
  const keyed = make();
  transclusionInternals.exitBlock(keyed.view as unknown as EditorView, key, 'ctrl-enter');
  assert.equal(keyed.focuses(), 1, 'выход по клавише возвращает фокус в контейнер');
});

test('edgeExit: граница — край ДОКУМЕНТА, а не строки (ce46723d)', () => {
  const exits: string[] = [];
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const key = blockEditorKey(ID_A, null);
  // Строки: «a» (стр.1) / «» (стр.2, пустая) / «bb» (стр.3) / «c» (стр.4).
  // Позиции: 0..1 / 2..2 / 3..5 / 6..7; длина документа 7.
  store.mount(key, 'a\n\nbb\nc', {
    depth: 1,
    onDirty: () => undefined,
    onExit: (_k, reason) => exits.push(reason),
    onCommit: () => undefined,
    onCancel: () => undefined,
  });
  const instance = registry.get(key)!;

  /** Ставит каретку и жмёт стрелку; возвращает причины выходов из блока. */
  const press = (pos: number, dir: 'up' | 'down' | 'left' | 'right'): string[] => {
    instance.dispatch({ selection: { anchor: pos } });
    exits.length = 0;
    transclusionNestedInternals.edgeExit(
      { state: instance.state } as unknown as EditorView,
      {
        depth: 1,
        onDirty: () => undefined,
        onExit: (_k, reason) => exits.push(reason),
        onCommit: () => undefined,
        onCancel: () => undefined,
      },
      key,
      dir,
    );
    return [...exits];
  };

  // Конец ПЕРВОЙ строки (не пустая, середина документа): Down НЕ выходит,
  // Up выходит (первая строка — край документа).
  assert.deepEqual(press(1, 'down'), [], 'Down в конце первой строки не выходит из блока');
  assert.deepEqual(press(1, 'up'), ['up'], 'Up с первой строки выходит из блока');

  // ПУСТАЯ строка: ни Down, ни Up не выходят (был симптом «перескока»).
  assert.deepEqual(press(2, 'down'), [], 'Down на пустой строке не выходит из блока');
  assert.deepEqual(press(2, 'up'), [], 'Up на пустой строке не выходит из блока');

  // Начало/конец СРЕДНЕЙ непустой строки: выходов нет ни вверх, ни вниз.
  assert.deepEqual(press(3, 'down'), [], 'Down в начале средней строки не выходит');
  assert.deepEqual(press(3, 'up'), [], 'Up в начале средней строки не выходит');
  assert.deepEqual(press(5, 'down'), [], 'Down в конце средней строки не выходит');
  assert.deepEqual(press(5, 'up'), [], 'Up в конце средней строки не выходит');

  // Последняя строка документа — там и только там выходит Down; Up не выходит.
  assert.deepEqual(press(6, 'down'), ['down'], 'Down с последней строки выходит из блока');
  assert.deepEqual(press(6, 'up'), [], 'Up с последней строки не выходит');
  assert.deepEqual(press(7, 'down'), ['down'], 'Down в конце последней строки выходит');

  // Горизонтальные края документа: left с начала, right с конца.
  assert.deepEqual(press(0, 'left'), ['left'], 'Left с начала документа выходит');
  assert.deepEqual(press(0, 'down'), [], 'Down в начале документа не выходит');
  assert.deepEqual(press(0, 'up'), ['up'], 'Up с первой строки документа выходит');
  assert.deepEqual(press(7, 'right'), ['right'], 'Right с конца документа выходит');
});

test('applyDraft: черновик принимается только чистым инстансом (ce46723d)', () => {
  const opts = {
    depth: 1,
    onDirty: () => undefined,
    onExit: () => undefined,
    onCommit: () => undefined,
    onCancel: () => undefined,
  };
  const key = blockEditorKey(ID_A, null);

  // Чистый инстанс черновик принимает, блок встаёт «грязным».
  const cleanReg = new Map<string, FakeNestedView>();
  const clean = new NestedEditorStore(fakeFactory(cleanReg));
  clean.mount(key, 'СЕРВЕР', opts);
  assert.equal(clean.applyDraft(key, 'ЧЕРНОВИК'), true, 'чистый инстанс принимает черновик');
  assert.equal(clean.text(key), 'ЧЕРНОВИК', 'текст заменён черновиком');
  assert.equal(clean.isDirty(key), true, 'блок помечен «грязным»');

  // Черновик, равный загруженному тексту, — no-op (блок остаётся чистым).
  const sameReg = new Map<string, FakeNestedView>();
  const same = new NestedEditorStore(fakeFactory(sameReg));
  same.mount(key, 'СЕРВЕР', opts);
  assert.equal(same.applyDraft(key, 'СЕРВЕР'), false, 'совпадающий черновик — no-op');
  assert.equal(same.isDirty(key), false, 'блок не помечен «грязным»');

  // Грязный инстанс черновик НЕ принимает — правка пользователя приоритетна.
  const dirtyReg = new Map<string, FakeNestedView>();
  const dirty = new NestedEditorStore(fakeFactory(dirtyReg));
  dirty.mount(key, 'СЕРВЕР', opts);
  dirtyReg.get(key)!.dispatch({ changes: { from: 0, insert: 'X' } });
  assert.equal(dirty.isDirty(key), true, 'пользователь тронул текст');
  assert.equal(dirty.applyDraft(key, 'ЧЕРНОВИК'), false, 'грязный инстанс черновик не принимает');
  assert.equal(dirty.text(key), 'XСЕРВЕР', 'текст правки пользователя сохранён');

  // `null` — нет черновика, no-op.
  assert.equal(dirty.applyDraft(key, null), false, 'отсутствие черновика — no-op');
});

test('рекурсия: вложенная трансклюзия внутри блока (глубина 2) отображается и входима (73ae1d4b)', async () => {
  stubEtn({ [ID_A]: `![[#${ID_B}]]`, [ID_B]: 'ВНУТРЕННИЙ' });
  const { store: appStore } = await import('../src/renderer/state.js');
  appStore.update({ networkId: NET_ID });
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const doc = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(doc)[0]!;
  const view = makeView(withStore(doc, store));

  transclusionInternals.enterBlock(view as unknown as EditorView, ref);
  await tick();
  await tick();
  const keyA = blockEditorKey(ID_A, null);
  assert.ok(store.has(keyA), 'внешний инстанс смонтирован');
  const outer = registry.get(keyA)!;
  // Документ вложенного редактора содержит вложенную ссылку — она отображается
  // блоком-виджетом (единый стек расширений, рекурсия).
  const innerRef = parseTransclusions(outer.state.doc.toString())[0]!;
  assert.equal(innerRef.sourceId, ID_B, 'вложенная ссылка распознана');
  assert.equal(
    collect(outer.state.field(transclusionState)!.deco, outer.state.doc.length).length,
    1,
    'вложенный блок отображён в инстансе',
  );

  // Входим кареткой во вложенную трансклюзию — глубина 2.
  transclusionInternals.enterBlock(outer as unknown as EditorView, innerRef);
  await tick();
  await tick();
  const keyB = blockEditorKey(ID_B, null);
  assert.ok(store.has(keyB), 'инстанс второго уровня смонтирован');
  assert.equal(registry.get(keyB)!.state.facet(nestedDepthFacet), 2, 'глубина инстанса — 2');
});

test('пакетный захват: блок глубины ≥2 догружает захват своего источника (e9dfc2df)', async () => {
  const ID_C = '22222222-3333-4444-5555-666666666666';
  stubEtn({ [ID_A]: `![[#${ID_B}]]`, [ID_B]: `![[#${ID_C}]]`, [ID_C]: 'ВНУТРЕННИЙ' });
  const { store: appStore } = await import('../src/renderer/state.js');
  appStore.update({ networkId: NET_ID });
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const mounted: string[] = [];
  const doc = `до ${BLOCK_RAW} после`;
  const refA = parseTransclusions(doc)[0]!;
  const view = makeView(
    withStore(doc, store, [
      blockEditorHostExtension({
        onBlockDirty: () => undefined,
        onBlockMounted: (id) => mounted.push(id),
      }),
    ]),
  );

  // Глубина 1.
  transclusionInternals.enterBlock(view as unknown as EditorView, refA);
  await tick();
  await tick();
  assert.deepEqual(mounted, [ID_A], 'источник блока глубины 1 захвачен');
  const outerA = registry.get(blockEditorKey(ID_A, null))!;

  // Глубина 2 — блок ВНУТРИ блока: хост обязан быть проброшен в стек инстанса,
  // иначе захват источника не брался (блокер проверки e9dfc2df).
  const refB = parseTransclusions(outerA.state.doc.toString())[0]!;
  transclusionInternals.enterBlock(outerA as unknown as EditorView, refB);
  await tick();
  await tick();
  assert.ok(store.has(blockEditorKey(ID_B, null)), 'инстанс глубины 2 смонтирован');
  assert.deepEqual(mounted, [ID_A, ID_B], 'источник блока глубины 2 тоже захвачен');
  const outerB = registry.get(blockEditorKey(ID_B, null))!;

  // Глубина 3.
  const refC = parseTransclusions(outerB.state.doc.toString())[0]!;
  transclusionInternals.enterBlock(outerB as unknown as EditorView, refC);
  await tick();
  await tick();
  assert.deepEqual(mounted, [ID_A, ID_B, ID_C], 'источник блока глубины 3 захвачен');
});

// ---------------------------------------------------------------------------
// Нажатие `#` в списке мыслей (ошибка ccf4d25f, элемент 7a479549)
// ---------------------------------------------------------------------------

test('принятие мысли по `#`: ссылка переходит в режим текста раздела', () => {
  const accepted = transclusionSectionAccept(`#${ID_A}]]`);
  assert.ok(accepted !== null);
  // Полная ссылка без раздела + второй `#` перед закрывающими скобками; каретка
  // в пустом тексте раздела (перед `]]`), чтобы сразу открыть список заголовков.
  assert.equal(accepted.ref, `![[#${ID_A}#]]`);
  assert.equal(accepted.caret, accepted.ref.length - 2);
  assert.equal(accepted.ref.slice(accepted.caret), ']]');
});

test('принятие мысли по `#`: не-ID форма не трогается', () => {
  assert.equal(transclusionSectionAccept('какое-то имя'), null);
  assert.equal(transclusionSectionAccept(`#${ID_A}`), null);
  assert.equal(transclusionSectionAccept(''), null);
});

// ---------------------------------------------------------------------------
// Пустой раздел после жеста `#`: контекст и источник разделов (ccf4d25f)
// ---------------------------------------------------------------------------

test('transclusionAtCaret: пустой раздел — каретка «в разделе» (ccf4d25f)', () => {
  // Парсер сворачивает пустой раздел `![[#id#]]` в `section: null`, но каретка
  // сразу после второго `#` обязана считаться «в разделе», иначе список
  // заголовков не открывается немедленно после жеста `#`.
  const doc = `![[#${ID_A}#]]`;
  const caret = doc.length - 2;
  const ctx = transclusionAtCaret(doc, caret);
  assert.ok(ctx !== null);
  assert.equal(ctx!.ref.section, null, 'парсер сворачивает пустой раздел в null');
  assert.equal(ctx!.sectionFrom, caret, 'начало текста раздела — сразу после второго #');
  assert.equal(ctx!.inSection, true, 'пустой раздел — каретка в разделе');
  // Контроль: ссылка без второго `#` — каретка не в разделе.
  const plainDoc = `![[#${ID_A}]]`;
  assert.equal(transclusionAtCaret(plainDoc, plainDoc.length - 2)!.inSection, false);
});

test('transclusionSectionCompletions: пустой раздел — все заголовки источника (ccf4d25f)', async () => {
  const ID = 'a1b2c3d4-1111-4222-8333-444455556666';
  stubEtn('## Альфа\nтекст\n## Бета\nтекст');
  const { store } = await import('../src/renderer/state.js');
  store.update({ networkId: NET_ID });
  try {
    // Ссылка в состоянии ровно после accept из жеста `#` (пустой раздел).
    const accepted = transclusionSectionAccept(`#${ID}]]`);
    assert.ok(accepted !== null);
    const doc = accepted.ref;
    const caret = accepted.caret;
    const state = EditorState.create({ doc });
    const context = { state, pos: caret } as unknown as Parameters<
      ReturnType<typeof transclusionSectionCompletions>
    >[0];
    const result = await transclusionSectionCompletions()(context);
    assert.ok(result !== null, 'список разделов открывается сразу, без минимума символов');
    assert.deepEqual(
      result!.options.map((o) => o.label).sort(),
      ['Альфа', 'Бета'],
      'показаны ВСЕ заголовки источника (пустой префикс)',
    );
    assert.equal(result!.from, caret, 'замена идёт с начала текста раздела');
  } finally {
    store.update({ networkId: null });
  }
});

test('keymap трансклюзий: # привязан к приёму мысли со списком разделов (ccf4d25f)', () => {
  // Жест `#` живёт в keymap трансклюзий; после accept обработчик явно вызывает
  // `startCompletion` — вне DOM/EditorView это не наблюдаемо, но факт привязки
  // жеста к полю проверяем (плюс источник разделов покрыт тестом выше).
  const state = EditorState.create({ doc: 'x', extensions: [...transclusionExtensions] });
  const bindings = state.facet(keymap).flatMap((group) => group);
  assert.ok(
    bindings.some((binding) => binding.key === '#' && typeof binding.run === 'function'),
    'клавиша # привязана к обработчику в keymap трансклюзий',
  );
});
