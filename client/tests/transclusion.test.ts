/**
 * Unit tests трансклюзий комментариев (0.12.1, ТП2, задачи f72a9134 и
 * f59d24e1). Проверяют чистые функции контекста/разделов/метки, сборку
 * декораций трёх режимов ссылки (блок, свёрнутая ссылка, правка с атомарным
 * `#<id>`), итеративную развёртку с инжектируемым загрузчиком источников,
 * а также режим правки блока и «замочек» чужого захвата. Headless — без DOM и
 * сети.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EditorState, RangeSet } from '@codemirror/state';
import { Decoration, keymap, runScopeHandlers, type DecorationSet, type EditorView } from '@codemirror/view';

import { parseTransclusions } from '@etn/markdown';

import {
  buildTransclusionDecorations,
  isBlockEditing,
  listSectionTitles,
  mergeSectionContent,
  renderTransclusionMarkdown,
  sectionBodyForEdit,
  sectionBoundaryCrossed,
  setBlockEdit,
  transclusionAtCaret,
  transclusionCacheKey,
  transclusionExtensions,
  transclusionInternals,
  transclusionLabels,
  transclusionLinkLabel,
  transclusionMenuHandlers,
  transclusionState,
  type TransclusionSource,
  type TransclusionSourceLoader,
} from '../src/renderer/editor/transclusion.js';
import { wikiPrefixAt } from '../src/renderer/editor/wiki-link.js';

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const ID_B = '11111111-2222-3333-4444-555555555555';
const ID_C = '99999999-8888-4777-8666-555555555555';
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
  // Неделимость навигации стрелками (блокер верификатора): весь диапазон блока
  // атомарен, иначе второй Right заводит каретку внутрь и блок распадается.
  assert.equal(atomic.size, 1);
  assert.deepEqual(collect(atomic, src.length).map((a) => [a.from, a.to]), [
    [refs[0]!.start, refs[0]!.end],
  ]);
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
  const { deco, atomic } = buildTransclusionDecorations(src, { from: 0, to: 0 }, cache, NET, new Set([key]));
  const items = collect(deco, src.length);
  assert.equal(items.length, 1);
  assert.notEqual(items[0]!.value.spec.block, true);
  assert.equal(items[0]!.value.spec.widget?.constructor.name, 'TransclusionLinkWidget');
  // Свёрнутая ссылка — тоже единый атомарный элемент.
  assert.equal(atomic.size, 1);
  assert.deepEqual(collect(atomic, src.length).map((a) => [a.from, a.to]), [[ref.start, ref.end]]);
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

type BlockSpec = { block?: boolean; widget?: { editing?: boolean; sourceId?: string; lockedBy?: string | null } };

test('buildTransclusionDecorations: источник в правке — блок с признаком editing', () => {
  const src = `до ![[#${ID_A}]] после`;
  const ref = parseTransclusions(src)[0]!;
  // Каретка внутри ссылки — но режим правки блока перекрывает правку ссылки.
  const inside = ref.start + 5;
  const { deco, atomic } = buildTransclusionDecorations(
    src,
    { from: inside, to: inside },
    cacheFor(ref),
    NET,
    new Set(),
    ID_A,
  );
  const items = collect(deco, src.length);
  assert.equal(items.length, 1);
  const spec = items[0]!.value.spec as BlockSpec;
  assert.equal(spec.block, true);
  assert.equal(spec.widget?.editing, true);
  assert.equal(spec.widget?.sourceId, ID_A);
  assert.equal(spec.widget?.lockedBy, null);
  // Блок в правке — единый атомарный диапазон (неделимость навигации, a2b68d72).
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
    new Set(),
    null,
    new Map([[ID_A, 'Алиса']]),
  );
  const spec = collect(deco, src.length)[0]!.value.spec as BlockSpec;
  assert.equal(spec.widget?.lockedBy, 'Алиса');
  assert.equal(spec.widget?.editing, false);
});

test('buildTransclusionDecorations: правка одного источника не задевает второй', () => {
  const src = `![[#${ID_A}]] и ![[#${ID_B}]]`;
  const refs = parseTransclusions(src);
  const cache = new Map([
    ...cacheFor(refs[0]!),
    ...cacheFor(refs[1]!),
  ]);
  const { deco } = buildTransclusionDecorations(src, { from: 0, to: 0 }, cache, NET, new Set(), ID_A);
  const specs = collect(deco, src.length).map((item) => item.value.spec as BlockSpec);
  assert.equal(specs.length, 2);
  assert.equal(specs[0]!.widget?.sourceId, ID_A);
  assert.equal(specs[0]!.widget?.editing, true);
  assert.equal(specs[1]!.widget?.sourceId, ID_B);
  assert.equal(specs[1]!.widget?.editing, false);
});

test('transclusionState: setBlockEdit включает и выключает режим правки', () => {
  const state = EditorState.create({
    doc: `![[#${ID_A}]]`,
    extensions: [transclusionState],
  });
  assert.equal(state.field(transclusionState).editingSourceId, null);
  const entered = state.update({ effects: setBlockEdit.of(ID_A) }).state;
  assert.equal(entered.field(transclusionState).editingSourceId, ID_A);
  const exited = entered.update({ effects: setBlockEdit.of(null) }).state;
  assert.equal(exited.field(transclusionState).editingSourceId, null);
});

test('transclusionState: вход в правку разворачивает свёрнутую ссылку', () => {
  const src = `![[#${ID_A}]]`;
  const ref = parseTransclusions(src)[0]!;
  const key = transclusionCacheKey(NET, ref);
  let state = EditorState.create({ doc: src, extensions: [transclusionState] });
  state = state.update({
    effects: transclusionInternals.setCollapsed.of({ key, collapsed: true }),
  }).state;
  assert.equal(state.field(transclusionState).collapsed.has(key), true);
  state = state.update({ effects: setBlockEdit.of(ID_A) }).state;
  assert.equal(state.field(transclusionState).collapsed.size, 0);
  assert.equal(state.field(transclusionState).editingSourceId, ID_A);
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

test('transclusionState: диапазон правки блока едет за правками документа', () => {
  const src = `до ![[#${ID_A}]] после`;
  const ref = parseTransclusions(src)[0]!;
  let state = EditorState.create({ doc: src, extensions: [transclusionState] });
  const be = {
    sourceId: ID_A,
    section: null,
    refRaw: ref.raw,
    from: ref.start,
    to: ref.start + 5,
  };
  state = state.update({ effects: transclusionInternals.setBlockEditRange.of(be) }).state;
  assert.deepEqual(state.field(transclusionState).blockEdit, be);
  // Вставка в начале диапазона расширяет его (assoc), каретка — внутри.
  state = state.update({ changes: { from: ref.start, insert: 'X' } }).state;
  const moved = state.field(transclusionState).blockEdit!;
  assert.equal(moved.from, ref.start);
  assert.equal(moved.to, ref.start + 6);
  state = state.update({ effects: transclusionInternals.setBlockEditRange.of(null) }).state;
  assert.equal(state.field(transclusionState).blockEdit, null);
});

test('buildTransclusionDecorations: текст блока в правке — линейные декорации поля, без виджетов', () => {
  const src = `до ![[#${ID_A}]] после`;
  const { deco } = buildTransclusionDecorations(
    src,
    { from: 0, to: 0 },
    new Map(),
    NET,
    new Set(),
    ID_A,
    new Map(),
    { sourceId: ID_A, section: null, refRaw: '', from: 0, to: src.length },
  );
  const items = collect(deco, src.length);
  // Ссылка внутри диапазона не заменяется виджетом — остаётся текстом; рамка
  // вложенного поля — ЛИНЕЙНЫЕ декорации (ошибка 9c2e077a): одна строка даёт
  // одну линию с ролью и первого, и последнего ряда.
  assert.equal(items.length, 1);
  assert.equal(items[0]!.from, items[0]!.to, 'рамка поля — линейная декорация');
  assert.equal(
    items[0]!.value.spec.class,
    'cm-transclusion-edit-range cm-transclusion-edit-range--first cm-transclusion-edit-range--last',
  );
  assert.equal(items[0]!.value.spec.widget, undefined, 'вложенное поле — не виджет');
});

test('buildTransclusionDecorations: многострочное поле правки — сплошная рамка (first/mid/last)', () => {
  const ID = ID_A;
  const src = 'до\n' + 'строка источника 1\nстрока источника 2\nстрока источника 3' + '\nпосле';
  const from = src.indexOf('строка источника 1');
  const to = src.indexOf('\nпосле');
  const { deco } = buildTransclusionDecorations(
    src,
    { from: 0, to: 0 },
    new Map(),
    NET,
    new Set(),
    ID,
    new Map(),
    { sourceId: ID, section: null, refRaw: '', from, to },
  );
  const items = collect(deco, src.length);
  assert.equal(items.length, 3, 'три строки поля — три линейные декорации');
  const classes = items.map((it) => it.value.spec.class as string);
  assert.ok(classes[0]!.includes('cm-transclusion-edit-range--first'));
  assert.ok(!classes[0]!.includes('--last'));
  assert.ok(classes[1]!.includes('cm-transclusion-edit-range') && !classes[1]!.includes('--first') && !classes[1]!.includes('--last'));
  assert.ok(classes[2]!.includes('cm-transclusion-edit-range--last'));
  assert.ok(!classes[2]!.includes('--first'));
});

test('buildTransclusionDecorations: ссылка вне диапазона правки — по-прежнему блок', () => {
  const src = `![[#${ID_A}]] и ![[#${ID_B}]]`;
  const refs = parseTransclusions(src);
  const { deco } = buildTransclusionDecorations(
    src,
    { from: 0, to: 0 },
    new Map(),
    NET,
    new Set(),
    ID_A,
    new Map(),
    { sourceId: ID_A, section: null, refRaw: '', from: refs[0]!.start, to: refs[0]!.end },
  );
  const items = collect(deco, src.length);
  // Одна mark-рамка на первый диапазон + один виджет второго (вне правки).
  const widget = items.find((it) => it.value.spec.widget !== undefined);
  assert.ok(widget !== undefined);
  assert.equal(widget!.from, refs[1]!.start);
});

test('isBlockEditing: Enter отдаётся родительскому keymap в правке блока', () => {
  const src = `до ![[#${ID_A}]] после`;
  const ref = parseTransclusions(src)[0]!;
  let state = EditorState.create({ doc: src, extensions: [transclusionState] });
  assert.equal(isBlockEditing(state), false, 'вне правки блока Enter обрабатываем сами');
  state = state.update({
    effects: transclusionInternals.setBlockEditRange.of({
      sourceId: ID_A,
      section: null,
      refRaw: ref.raw,
      from: ref.start,
      to: ref.start + 5,
    }),
  }).state;
  assert.equal(isBlockEditing(state), true, 'в правке блока Enter отдаём родителю (перевод строки)');
});

// ---------------------------------------------------------------------------
// Контекстное меню блока (задача 955478e8, элемент 1e0fb0bd)
// ---------------------------------------------------------------------------

test('transclusionMenuHandlers: ровно шесть команд макета', () => {
  const src = `![[#${ID_A}]]`;
  const ref = parseTransclusions(src)[0]!;
  const view = { state: EditorState.create({ doc: src }) } as unknown as Parameters<
    typeof transclusionMenuHandlers
  >[0];
  const handlers = transclusionMenuHandlers(view, ref);
  assert.deepEqual(
    Object.keys(handlers).sort(),
    [
      'transclusion.changeLink',
      'transclusion.copyId',
      'transclusion.copyLink',
      'transclusion.edit',
      'transclusion.focusSource',
      'transclusion.openSource',
    ],
  );
});

test('transclusionMenuHandlers: «Изменить ссылку» без сети не трогает документ', () => {
  const src = `![[#${ID_A}]]`;
  const ref = parseTransclusions(src)[0]!;
  let dispatches = 0;
  const view = {
    state: EditorState.create({ doc: src }),
    dispatch: () => {
      dispatches += 1;
    },
  } as unknown as Parameters<typeof transclusionMenuHandlers>[0];
  const handlers = transclusionMenuHandlers(view, ref);
  handlers['transclusion.changeLink']!();
  // Вне сети ключ кэша не строится — сворачивание не выполняется.
  assert.equal(dispatches, 0);
});

// ---------------------------------------------------------------------------
// Ctrl+Enter и Enter в правке блока: запись в источник, контейнер не коммитится
// (ошибки 3c51aee8, 9c2e077a; задача e2c14673)
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

/** Фейковый EditorView: настоящий EditorState + dispatch, применяющий транзакции. */
interface FakeView {
  state: EditorState;
  dispatch(spec: unknown): void;
}

function makeView(initial: EditorState): FakeView {
  const view: FakeView = {
    state: initial,
    dispatch(spec: unknown): void {
      view.state = view.state.update(spec as never).state;
    },
  };
  return view;
}

/** Заполняет `view.state` правкой блока: ссылка заменена текстом источника. */
function enterBlockEdit(
  raw: string,
  inlined: string,
): { view: FakeView; containerDoc: string; from: number; to: number } {
  const containerDoc = `вступление ${raw} окончание`;
  const ref = parseTransclusions(containerDoc)[0]!;
  const doc = containerDoc.slice(0, ref.start) + inlined + containerDoc.slice(ref.end);
  let state = EditorState.create({ doc, extensions: [transclusionState] });
  const from = ref.start;
  const to = ref.start + inlined.length;
  state = state.update({
    effects: transclusionInternals.setBlockEditRange.of({
      sourceId: ID_A,
      section: null,
      refRaw: raw,
      from,
      to,
    }),
  }).state;
  return { view: makeView(state), containerDoc, from, to };
}

test('Mod-Enter в правке блока пишет в источник и НЕ коммитит окружение', async () => {
  const updates: Array<{ id: string; body: string }> = [];
  (globalThis as unknown as { etn: unknown }).etn = {
    comments: {
      list: async () => [
        { id: 'perm-src', kind: 'permanent', body_md: 'старое', body_html: '', version: 3 },
      ],
      update: async (_n: string, id: string, changes: { body_md: string }) => {
        updates.push({ id, body: changes.body_md });
        return { id, kind: 'permanent', body_md: changes.body_md, body_html: '', version: 4 };
      },
    },
    thoughts: { resolve: async () => [] },
  };
  const { store } = await import('../src/renderer/state.js');
  store.update({ networkId: NET_ID });

  let commitCalls = 0;
  const raw = `![[#${ID_A}]]`;
  const inlined = 'ИЗМЕНЁННЫЙ ТЕКСТ';
  const base = enterBlockEdit(raw, inlined);
  // Собираем поле как прод: ниже по приоритету — «коммит окружения»
  // родительского keymap (как в md-editor), выше — жесты трансклюзии.
  let state = EditorState.create({
    doc: base.view.state.doc.toString(),
    extensions: [
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            commitCalls += 1;
            return true;
          },
        },
      ]),
      transclusionState,
      ...transclusionExtensions,
    ],
  });
  state = state.update({
    effects: transclusionInternals.setBlockEditRange.of({
      sourceId: ID_A,
      section: null,
      refRaw: raw,
      from: base.from,
      to: base.to,
    }),
  }).state;
  const view = makeView(state);

  runScopeHandlers(view as unknown as EditorView, keyEvent({ key: 'Enter', code: 'Enter', ctrl: true }), 'editor');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(commitCalls, 0, 'окружение не коммитится, пока идёт правка блока');
  assert.deepEqual(updates, [{ id: 'perm-src', body: inlined }], 'правка ушла в источник');
  assert.equal(view.state.doc.toString(), base.containerDoc, 'ссылка на месте, текст окружения не изменён');
  assert.equal(view.state.field(transclusionState)!.blockEdit, null, 'правка блока завершена');
});

test('Enter в правке блока отдаётся родительскому редактору (перевод строки)', () => {
  let newlineCalls = 0;
  const raw = `![[#${ID_A}]]`;
  const base = enterBlockEdit(raw, 'текст');
  let state = EditorState.create({
    doc: base.view.state.doc.toString(),
    extensions: [
      keymap.of([
        {
          key: 'Enter',
          run: () => {
            newlineCalls += 1;
            return true;
          },
        },
      ]),
      transclusionState,
      ...transclusionExtensions,
    ],
  });
  state = state.update({
    effects: transclusionInternals.setBlockEditRange.of({
      sourceId: ID_A,
      section: null,
      refRaw: raw,
      from: base.from,
      to: base.to,
    }),
  }).state;
  const view = makeView(state);

  runScopeHandlers(view as unknown as EditorView, keyEvent({ key: 'Enter', code: 'Enter' }), 'editor');

  assert.equal(newlineCalls, 1, 'Enter в правке блока обрабатывает родительский keymap');
  assert.ok(view.state.field(transclusionState)!.blockEdit !== null, 'правка блока не завершена');
});

// ---------------------------------------------------------------------------
// Правка блока ВЛОЖЕННОГО источника из просмотра (ошибка 23570aef)
// ---------------------------------------------------------------------------

/** Микрозадача: даёт осесть асинхронной загрузке источника/записи. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Заглушка моста `etn`: постоянный комментарий с заданным телом. */
function stubEtn(body: string): { updates: Array<{ id: string; body: string }> } {
  const updates: Array<{ id: string; body: string }> = [];
  (globalThis as unknown as { etn: unknown }).etn = {
    comments: {
      list: async () => [
        { id: 'perm-src', kind: 'permanent', body_md: body, body_html: '', version: 1 },
      ],
      update: async (_n: string, id: string, changes: { body_md: string }) => {
        updates.push({ id, body: changes.body_md });
        return { id, kind: 'permanent', body_md: changes.body_md, body_html: '', version: 2 };
      },
    },
    thoughts: { resolve: async () => [] },
  };
  return { updates };
}

/**
 * Состояние редактора с родительским keymap «коммит окружения» (ниже по
 * приоритету) и жестами трансклюзии — как собирает поле комментария.
 */
function nestedEditorState(doc: string, onCommit: () => void): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            onCommit();
            return true;
          },
        },
      ]),
      transclusionState,
      ...transclusionExtensions,
    ],
  });
}

test('beginNestedBlockEdit: на месте внешней ссылки — текст вложенного источника (23570aef)', async () => {
  stubEtn('ТЕЛО B');
  const { store } = await import('../src/renderer/state.js');
  store.update({ networkId: NET_ID });

  const raw = `вступление ![[#${ID_A}]] окончание`;
  const outerRef = parseTransclusions(raw)[0]!;
  const view = makeView(EditorState.create({ doc: raw, extensions: [transclusionState] }));

  await transclusionInternals.beginNestedBlockEdit(view, outerRef, { sourceId: ID_B, section: null });

  const field = view.state.field(transclusionState)!;
  assert.ok(field.blockEdit !== null, 'открыта правка блока вложенного источника');
  assert.equal(field.blockEdit!.sourceId, ID_B, 'пишем во вложенный источник, а не в контейнер');
  assert.equal(field.editingSourceId, ID_B);
  assert.equal(field.blockEdit!.refRaw, `![[#${ID_A}]]`, 'внешняя ссылка сохранена для восстановления');
  // В поле временно лежит текст вложенного источника на месте внешней ссылки.
  assert.equal(view.state.doc.toString(), 'вступление ТЕЛО B окончание');
});

test('beginNestedBlockEdit: 3-й уровень вложенности правится так же (23570aef)', async () => {
  stubEtn('САМЫЙ ГЛУБОКИЙ');
  const { store } = await import('../src/renderer/state.js');
  store.update({ networkId: NET_ID });

  const raw = `вступление ![[#${ID_A}]] окончание`;
  const outerRef = parseTransclusions(raw)[0]!;
  const view = makeView(EditorState.create({ doc: raw, extensions: [transclusionState] }));

  await transclusionInternals.beginNestedBlockEdit(view, outerRef, { sourceId: ID_C, section: null });

  const field = view.state.field(transclusionState)!;
  assert.equal(field.blockEdit!.sourceId, ID_C, 'глубина клика не ограничивает правку источника');
  assert.equal(field.blockEdit!.refRaw, `![[#${ID_A}]]`);
  assert.equal(view.state.doc.toString(), 'вступление САМЫЙ ГЛУБОКИЙ окончание');
});

test('beginNestedBlockEdit с разделом берёт содержимое без заголовка (23570aef)', async () => {
  stubEtn('## Раздел B\nстрока раздела\n## Другой\nx');
  const { store } = await import('../src/renderer/state.js');
  store.update({ networkId: NET_ID });

  const raw = `вступление ![[#${ID_A}]] окончание`;
  const outerRef = parseTransclusions(raw)[0]!;
  const view = makeView(EditorState.create({ doc: raw, extensions: [transclusionState] }));

  await transclusionInternals.beginNestedBlockEdit(view, outerRef, {
    sourceId: ID_B,
    section: 'Раздел B',
  });

  const field = view.state.field(transclusionState)!;
  assert.equal(field.blockEdit!.section, 'Раздел B');
  assert.equal(view.state.doc.toString(), 'вступление строка раздела окончание');
});

test('Mod-Enter в правке вложенного блока пишет в источник и не трогает контейнер (23570aef)', async () => {
  const { updates } = stubEtn('старое B');
  const { store } = await import('../src/renderer/state.js');
  store.update({ networkId: NET_ID });

  let commitCalls = 0;
  const raw = `вступление ![[#${ID_A}]] окончание`;
  const outerRef = parseTransclusions(raw)[0]!;
  const view = makeView(nestedEditorState(raw, () => {
    commitCalls += 1;
  }));

  await transclusionInternals.beginNestedBlockEdit(view, outerRef, { sourceId: ID_B, section: null });
  const be = view.state.field(transclusionState)!.blockEdit!;
  view.dispatch({ changes: { from: be.from, to: be.to, insert: 'ИЗМЕНЁННЫЙ B' } });

  runScopeHandlers(
    view as unknown as EditorView,
    keyEvent({ key: 'Enter', code: 'Enter', ctrl: true }),
    'editor',
  );
  await tick();
  await tick();

  assert.equal(commitCalls, 0, 'окружение не коммитится, пока идёт правка блока');
  assert.deepEqual(updates, [{ id: 'perm-src', body: 'ИЗМЕНЁННЫЙ B' }], 'правка ушла во вложенный источник');
  assert.equal(view.state.doc.toString(), raw, 'внешняя ссылка восстановлена — контейнер не изменён');
  assert.equal(view.state.field(transclusionState)!.blockEdit, null, 'правка блока завершена');
});
