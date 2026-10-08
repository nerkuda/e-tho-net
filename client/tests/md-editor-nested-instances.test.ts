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
 * 3. кэш данных источников — ОДИН на сеть, не дублируется по инстансам и
 *    сбрасывается записью постоянного комментария-источника (в т.ч. realtime);
 * 4. кэш заголовков разделов изолирован по инстансу.
 *
 * Headless: настоящий `EditorView` (DOM) в шиме не поднимается (см.
 * `guard-comment-actions-placement.test.ts`), поэтому «инстанс» — это
 * `EditorState` с тем же стеком; сетевая часть проверяется через
 * `transclusionInternals.cachedTransclusionLoader`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AnyRealtimeEvent } from '@etn/shared';
import { EditorState } from '@codemirror/state';

import { mdEditorExtensions } from '../src/renderer/editor/md-editor.js';
import {
  initTransclusionSourceCache,
  transclusionAtomicRanges,
  transclusionExtensions,
  transclusionInternals,
  transclusionSectionAccept,
  transclusionSectionCompletions,
  transclusionState,
} from '../src/renderer/editor/transclusion.js';
import { resetEventRouter, routeRealtimeEvent } from '../src/renderer/lib/live/index.js';

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

/** Realtime-событие комментария минимальной формы (для проверки инвалидации). */
function commentEvent(
  type: 'comment.updated' | 'comment.created' | 'comment.deleted',
  data: Record<string, unknown>,
  seq: number,
): AnyRealtimeEvent {
  return {
    type,
    seq,
    ts: '2026-10-08T00:00:00.000Z',
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: NET,
    audience: 'network',
    layer_id: '00000000-0000-0000-0000-000000000000',
    data,
  } as unknown as AnyRealtimeEvent;
}

/** Realtime-событие мысли минимальной формы (`thought.deleted`/`thought.updated`). */
function thoughtEvent(
  type: 'thought.deleted' | 'thought.updated',
  id: string,
  seq: number,
  changes: Record<string, unknown> = {},
): AnyRealtimeEvent {
  return {
    type,
    seq,
    ts: '2026-10-08T00:00:00.000Z',
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: NET,
    audience: 'network',
    layer_id: '00000000-0000-0000-0000-000000000000',
    data: type === 'thought.updated' ? { id, changes, version: 2 } : { id },
  } as unknown as AnyRealtimeEvent;
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

test('запись в источник самим полем сбрасывает его из общего кэша сети', async () => {
  const stub = stubEtn();
  transclusionInternals.clearSourceCache();
  const load = transclusionInternals.cachedTransclusionLoader(NET);

  await load(ID_A);
  assert.equal(stub.fetches(), 1, 'первая загрузка — запрос в сеть');

  stub.setBody('## Бета\nновое тело');
  await load(ID_A);
  assert.equal(stub.fetches(), 1, 'пока сброса нет — повторная загрузка из кэша');

  // Тот же путь, что и в `saveBlockEdit` (прямой сброс до перезагрузки блока).
  transclusionInternals.invalidateTransclusionSource(NET, ID_A);
  const fresh = await load(ID_A);
  assert.equal(stub.fetches(), 2, 'после сброса источник перечитан');
  assert.equal(fresh?.body_md, '## Бета\nновое тело', 'вернулось свежее тело источника');
});

test('sourceKeyForCommentEvent: кэш трогают только постоянные комментарии мысли', () => {
  const key = transclusionInternals.sourceKeyForCommentEvent;
  assert.equal(
    key(commentEvent('comment.updated', { id: 'c1', owner_id: ID_A, kind: 'permanent', changes: {}, version: 2 }, 1)),
    `${NET}:${ID_A}`,
    'правка постоянного комментария мысли сбрасывает источник',
  );
  assert.equal(
    key(commentEvent('comment.updated', { id: 'c1', owner_id: ID_A, kind: 'chronological', changes: {}, version: 2 }, 2)),
    null,
    'хроно-комментарий источник не трогает',
  );
  assert.equal(
    key(commentEvent('comment.created', { comment: { id: 'c1', kind: 'permanent', owner_type: 'thought', owner_id: ID_A } }, 3)),
    `${NET}:${ID_A}`,
    'создание постоянного комментария мысли сбрасывает источник',
  );
  assert.equal(
    key(commentEvent('comment.created', { comment: { id: 'c1', kind: 'permanent', owner_type: 'link', owner_id: 'l1' } }, 4)),
    null,
    'владелец-связь источником трансклюзии не является',
  );
  assert.equal(
    key(commentEvent('comment.deleted', { owner_type: 'thought', owner_id: ID_A, id: 'c1' }, 5)),
    `${NET}:${ID_A}`,
    'удаление комментария мысли сбрасывает источник',
  );
  assert.equal(
    key(commentEvent('comment.deleted', { owner_type: 'link', owner_id: 'l1', id: 'c1' }, 6)),
    null,
    'удаление комментария связи источник не трогает',
  );
  assert.equal(
    key(thoughtEvent('thought.deleted', ID_A, 7)),
    `${NET}:${ID_A}`,
    'удаление мысли-источника сбрасывает источник (746e4e59)',
  );
});

test('realtime thought.deleted сбрасывает источник: блок покажет «нет источника» (746e4e59)', async () => {
  const stub = stubEtn();
  transclusionInternals.clearSourceCache();
  initTransclusionSourceCache();
  const load = transclusionInternals.cachedTransclusionLoader(NET);

  await load(ID_A);
  assert.equal(stub.fetches(), 1, 'источник загружен и закэширован');

  // Удаление мысли-источника: сервер эмитит только `thought.deleted` (постоянный
  // комментарий сносится каскадом без `comment.deleted`). Кэш обязан сброситься,
  // иначе повторная отрисовка блока вернула бы старое тело.
  resetEventRouter();
  routeRealtimeEvent(thoughtEvent('thought.deleted', ID_A, 100));
  await load(ID_A);
  assert.equal(stub.fetches(), 2, 'событие сбросило источник — сеть перечитана');
});

test('realtime comment.updated сбрасывает источник (обычная правка/черновик/чужая запись)', async () => {
  const stub = stubEtn();
  transclusionInternals.clearSourceCache();
  initTransclusionSourceCache();
  const load = transclusionInternals.cachedTransclusionLoader(NET);

  await load(ID_A);
  assert.equal(stub.fetches(), 1, 'источник загружен и закэширован');

  // Симуляция пути обычной правки комментария: запись → сервер → realtime-эхо
  // (`comment.updated`) в рендерер (в т.ч. автору — broadcast-to-all).
  stub.setBody('## Бета\nправка обычным путём');
  resetEventRouter();
  routeRealtimeEvent(
    commentEvent(
      'comment.updated',
      { id: 'perm-src', owner_id: ID_A, kind: 'permanent', changes: {}, version: 2 },
      100,
    ),
  );
  const after = await load(ID_A);
  assert.equal(stub.fetches(), 2, 'событие сбросило источник — сеть перечитана');
  assert.equal(after?.body_md, '## Бета\nправка обычным путём', 'отрисовка получит свежее тело');
});

test('realtime thought.updated обновляет имя источника без перечитывания тела (0a11aec5)', async () => {
  const stub = stubEtn();
  transclusionInternals.clearSourceCache();
  initTransclusionSourceCache();
  const load = transclusionInternals.cachedTransclusionLoader(NET);

  const first = await load(ID_A);
  assert.equal(first?.title, 'Источник', 'исходное имя источника закэшировано');
  assert.equal(stub.fetches(), 1, 'источник загружен');

  // Переименование мысли-источника: приходит `thought.updated` с новым именем.
  // Тело источника не менялось — сеть перезапрашивать не нужно, но имя в кэше
  // обязано стать актуальным (чип-шапка показывает именно его).
  resetEventRouter();
  routeRealtimeEvent(thoughtEvent('thought.updated', ID_A, 100, { title: 'Новое имя' }));
  const after = await load(ID_A);
  assert.equal(after?.title, 'Новое имя', 'имя источника обновлено в кэше');
  assert.equal(after?.body_md, '## Альфа\nтекст', 'тело источника сохранено');
  assert.equal(stub.fetches(), 1, 'переименование не вызвало перечитывания тела из сети');
});

test('realtime thought.updated без смены имени не трогает кэш источника (0a11aec5)', async () => {
  const stub = stubEtn();
  transclusionInternals.clearSourceCache();
  initTransclusionSourceCache();
  const load = transclusionInternals.cachedTransclusionLoader(NET);

  await load(ID_A);
  assert.equal(stub.fetches(), 1, 'источник загружен');

  // Правка другого поля мысли (без `title`) — массового сброса кэша быть не
  // должно: иначе любое обновление мысли тянуло бы перезапрос источника в сеть.
  resetEventRouter();
  routeRealtimeEvent(thoughtEvent('thought.updated', ID_A, 100, { active: false }));
  await load(ID_A);
  assert.equal(stub.fetches(), 1, 'обновление без смены имени не сбросило источник');
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
