/**
 * Тесты переиспользуемого стека редактора для вложенных инстансов (0.12.1,
 * задача `a4f4113d`, ТП `fcde7c55` «Живой блок трансклюзии — сплошная правка в
 * одном окне»).
 *
 * Проверяют фундамент следующей задачи («вложенный редактор вместо растворения»):
 * 1. `mdEditorExtensions` отдаёт ТОТ ЖЕ стек, что поле-контейнер (включая
 *    расширения трансклюзий), и вызывается на инстанс;
 * 2. два markdown-редактора НЕЗАВИСИМЫ — правка документа одного не меняет
 *    документ другого;
 * 3. кэш данных источников — ОДИН на сеть, не дублируется по инстансам;
 * 4. кэш заголовков разделов изолирован по инстансу.
 *
 * Headless: настоящий `EditorView` (DOM) в шиме не поднимается (см.
 * `guard-comment-actions-placement.test.ts`), поэтому «инстанс» — это
 * `EditorState` с тем же стеком; сетевая часть проверяется через
 * `transclusionInternals.cachedTransclusionLoader`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EditorState } from '@codemirror/state';

import { mdEditorExtensions } from '../src/renderer/editor/md-editor.js';
import {
  transclusionAtomicRanges,
  transclusionExtensions,
  transclusionInternals,
  transclusionSectionAccept,
  transclusionSectionCompletions,
  transclusionState,
} from '../src/renderer/editor/transclusion.js';

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const NET = 'c4f9a3b2-1111-2222-3333-444455556666';
const NET_2 = 'd5e0b4c3-2222-3333-4444-555566667777';

/** Заглушка моста `etn`: счётчик сетевых загрузок источника и сменное тело. */
function stubEtn(): { fetches: () => number; setBody: (body: string) => void } {
  let fetches = 0;
  let body = '## Альфа\nтекст';
  (globalThis as unknown as { etn: unknown }).etn = {
    thoughts: {
      resolve: async (_networkId: string, ids: string[]) => {
        fetches += 1;
        return ids.map((id) => ({ id, title: 'Источник' }));
      },
    },
    comments: {
      list: async () => [{ id: 'perm-src', kind: 'permanent', body_md: body, body_html: '', version: 1 }],
    },
  };
  return { fetches: () => fetches, setBody: (next) => (body = next) };
}

/** Метки подсказок источника разделов (или `null`, если источник не сработал). */
async function sectionLabels(
  source: ReturnType<typeof transclusionSectionCompletions>,
  thoughtId: string,
): Promise<string[] | null> {
  const accepted = transclusionSectionAccept(`#${thoughtId}]]`);
  assert.ok(accepted !== null, 'ссылка с пустым разделом строится');
  const state = EditorState.create({ doc: accepted.ref });
  const context = { state, pos: accepted.caret } as unknown as Parameters<typeof source>[0];
  const result = await source(context);
  return result === null ? null : result.options.map((option) => option.label).sort();
}

// ---------------------------------------------------------------------------
// Переиспользуемый стек
// ---------------------------------------------------------------------------

test('mdEditorExtensions: стек содержит расширения трансклюзий (тот же, что у поля)', () => {
  const exts = mdEditorExtensions();
  assert.ok(Array.isArray(exts) && exts.length > 0, 'стек не пуст');
  assert.ok(exts.includes(transclusionState), 'языковое расширение трансклюзий в стеке');
  assert.ok(exts.includes(transclusionAtomicRanges), 'атомарные диапазоны трансклюзий в стеке');
  for (const ext of transclusionExtensions) {
    assert.ok(exts.includes(ext), 'все расширения трансклюзий присутствуют в стеке редактора');
  }
});

test('mdEditorExtensions: новый стек на каждый инстанс (свои по-инстансные замыкания)', () => {
  // Общий массив на два редактора сцепил бы по-инстансные кэши расширений
  // (автокомплит, разделы) — каждый инстанс получает свежий вызов.
  assert.notEqual(mdEditorExtensions(), mdEditorExtensions());
});

// ---------------------------------------------------------------------------
// Независимость двух инстансов
// ---------------------------------------------------------------------------

test('два инстанса редактора независимы: правка одного не меняет документ другого', () => {
  const docA = `окружение A ![[#${ID_A}]]`;
  const docB = `окружение B ![[#${ID_A}]]`;
  const a = EditorState.create({ doc: docA, extensions: mdEditorExtensions() });
  const b = EditorState.create({ doc: docB, extensions: mdEditorExtensions() });

  const aAfter = a.update({ changes: { from: 0, insert: 'X' } }).state;
  assert.equal(aAfter.doc.toString(), `X${docA}`, 'правка первого инстанса применилась');
  assert.equal(b.doc.toString(), docB, 'документ второго инстанса не изменился');

  const bAfter = b.update({ changes: { from: 0, insert: 'Y' } }).state;
  assert.equal(bAfter.doc.toString(), `Y${docB}`, 'правка второго инстанса применилась');
  assert.equal(aAfter.doc.toString(), `X${docA}`, 'документ первого инстанса не изменился');
});

// ---------------------------------------------------------------------------
// Кэш источников: один на сеть, не на инстанс
// ---------------------------------------------------------------------------

test('кэш источников один на сеть: два инстанса не дублируют сетевой запрос', async () => {
  const stub = stubEtn();
  transclusionInternals.clearSourceCache();

  // Два «инстанса» берут загрузчик независимо — общий кэш сети один.
  const loadA = transclusionInternals.cachedTransclusionLoader(NET);
  const loadB = transclusionInternals.cachedTransclusionLoader(NET);

  const a = await loadA(ID_A);
  const b = await loadB(ID_A);
  assert.equal(a?.body_md, '## Альфа\nтекст', 'первый инстанс получил тело источника');
  assert.equal(b?.body_md, '## Альфа\nтекст', 'второй инстанс получил то же тело');
  assert.equal(stub.fetches(), 1, 'сетевой запрос за источником сделан ОДИН раз на сеть');

  // Другая сеть — своя запись кэша.
  const loadOther = transclusionInternals.cachedTransclusionLoader(NET_2);
  await loadOther(ID_A);
  assert.equal(stub.fetches(), 2, 'кэш ключуется сетью: другой сети — свой запрос');
});

test('запись в источник сбрасывает его из общего кэша сети', async () => {
  const stub = stubEtn();
  transclusionInternals.clearSourceCache();
  const load = transclusionInternals.cachedTransclusionLoader(NET);

  await load(ID_A);
  assert.equal(stub.fetches(), 1, 'первая загрузка — запрос в сеть');

  stub.setBody('## Бета\nновое тело');
  await load(ID_A);
  assert.equal(stub.fetches(), 1, 'повторная загрузка — из кэша');

  transclusionInternals.invalidateTransclusionSource(NET, ID_A);
  const fresh = await load(ID_A);
  assert.equal(stub.fetches(), 2, 'после сброса источник перечитан');
  assert.equal(fresh?.body_md, '## Бета\nновое тело', 'вернулось свежее тело источника');
});

// ---------------------------------------------------------------------------
// Кэш заголовков разделов: изолирован по инстансу
// ---------------------------------------------------------------------------

test('transclusionSectionCompletions: кэш разделов изолирован по инстансу', async () => {
  const stub = stubEtn();
  const { store } = await import('../src/renderer/state.js');
  store.update({ networkId: NET });
  try {
    transclusionInternals.clearSourceCache();
    const source1 = transclusionSectionCompletions();
    const source2 = transclusionSectionCompletions();

    assert.deepEqual(await sectionLabels(source1, ID_A), ['Альфа'], 'первый инстанс видит свои разделы');
    assert.equal(stub.fetches(), 1, 'первый инстанс загрузил источник');

    // Общий кэш сети сброшен и тело источника сменилось — как будто источник
    // правит другой инстанс. Своя копия заголовков у каждого инстанса, поэтому
    // второй инстанс считает разделы заново (общий модульный кэш вернул бы
    // «Альфа» из чужой записи, не сделав запрос).
    transclusionInternals.clearSourceCache();
    stub.setBody('## Бета\nдругое');
    assert.deepEqual(
      await sectionLabels(source2, ID_A),
      ['Бета'],
      'второй инстанс считает разделы из своего кэша, а не из чужого',
    );
    assert.equal(stub.fetches(), 2, 'второй инстанс не воспользовался чужим кэшем заголовков');
  } finally {
    store.update({ networkId: null });
  }
});
