/**
 * Инкрементальное применение realtime-событий к снимку «Структур» (задача
 * afcfb144, уровень 3 тех.проекта `1d48df6d`).
 *
 * Проверяется чистая логика `screens/structures/realtime-apply.ts` (слияние
 * частичных изменений, удаление мысли из снимка, подпись строки, классификация
 * fallback) и ПРОВОДКА экрана `structures.ts` / шины `realtime-ui.ts`
 * структурно по исходнику: сами экраны в node-тесте не поднимаются (тянут
 * `app.js`/холст/редактор).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { FocusEdge, ThoughtRef } from '@etn/shared';

import {
  applyLinkChanges,
  applyLinkUpdateToState,
  applyThoughtChanges,
  applyThoughtUpdateToState,
  linkChangeNeedsReload,
  removeLinkFromState,
  removeThoughtFromState,
  rowRenderSignature,
  thoughtChangeNeedsReload,
  type StructuresCriteriaSnapshot,
  type StructuresLinkCriteria,
  type StructuresState,
} from '../src/renderer/screens/structures/realtime-apply.js';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');

function makeRef(overrides: Partial<ThoughtRef> = {}): ThoughtRef {
  return {
    id: 't1',
    title: 'T1',
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    marked_for_deletion: false,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    ...overrides,
  };
}

function makeEdge(overrides: Partial<FocusEdge> = {}): FocusEdge {
  return {
    id: 'l1',
    source_id: 't1',
    target_id: 't2',
    type_id: null,
    link_marked_for_deletion: false,
    color: null,
    style: null,
    width: null,
    ...overrides,
  };
}

function makeState(): StructuresState {
  const refs = new Map<string, ThoughtRef>([
    ['t1', makeRef({ id: 't1', title: 'T1' })],
    ['t2', makeRef({ id: 't2', title: 'T2' })],
  ]);
  const edges = new Map<string, FocusEdge>([
    ['l1', makeEdge({ id: 'l1', source_id: 't1', target_id: 't2' })],
    ['l2', makeEdge({ id: 'l2', source_id: 't2', target_id: 't9' })],
  ]);
  const resultIds = ['t1', 't2'];
  const directions = new Map([['t1', { has_incoming: true, has_outgoing: true }]]);
  const hierarchy = new Map([
    ['t1/children', { neighbors: [makeRef({ id: 't2', title: 'T2' })], hasMore: false }],
  ]);
  return { refs, edges, resultIds, directions, hierarchy };
}

const CRITERIA: StructuresCriteriaSnapshot = {
  sort: 'created',
  keywords: '',
  typeIds: [],
  showInactive: true,
  showTrash: true,
};

/** Критерии правки РЕБРА: фильтр обхода выключен, корзина показана. */
const LINK_CRITERIA: StructuresLinkCriteria = { linkFilterActive: false, showTrash: true };

describe('structures realtime: классификация fallback', () => {
  it('правка, влияющая на порядок или состав отбора, уходит в полный путь', () => {
    assert.equal(thoughtChangeNeedsReload({ title: 'X' }, { ...CRITERIA, sort: 'alpha' }), true);
    // Блокер 1: keywords по умолчанию ищут и по заголовку — переименование
    // может вывести мысль из отбора, даже без сортировки по алфавиту.
    assert.equal(thoughtChangeNeedsReload({ title: 'X' }, { ...CRITERIA, keywords: 'abc' }), true);
    // Блокер 2: при sort='updated' ключ сортировки — updated_at, двигает ЛЮБАЯ правка.
    assert.equal(thoughtChangeNeedsReload({ fg_color: '#fff' }, { ...CRITERIA, sort: 'updated' }), true);
    assert.equal(thoughtChangeNeedsReload({ title: 'X' }, { ...CRITERIA, sort: 'updated' }), true);
    assert.equal(thoughtChangeNeedsReload({ synonyms: ['s'] }, { ...CRITERIA, keywords: 'abc' }), true);
    assert.equal(thoughtChangeNeedsReload({ type_id: 'ty' }, { ...CRITERIA, typeIds: ['ty'] }), true);
    assert.equal(
      thoughtChangeNeedsReload({ active: false }, { ...CRITERIA, showInactive: false }),
      true,
    );
    assert.equal(
      thoughtChangeNeedsReload({ marked_for_deletion: true }, { ...CRITERIA, showTrash: false }),
      true,
    );
  });

  it('чистое оформление применяется точечно', () => {
    assert.equal(thoughtChangeNeedsReload({ title: 'X' }, CRITERIA), false);
    assert.equal(thoughtChangeNeedsReload({ active: false }, { ...CRITERIA, showInactive: true }), false);
    assert.equal(linkChangeNeedsReload({ color: '#f00' }, LINK_CRITERIA), false);
    assert.equal(linkChangeNeedsReload({ style: 'dashed', width: 3 }, LINK_CRITERIA), false);
    assert.equal(linkChangeNeedsReload({ marked_for_deletion: true }, LINK_CRITERIA), false);
  });

  it('смена концов или активности ребра — полный путь', () => {
    assert.equal(linkChangeNeedsReload({ source_id: 'a', target_id: 'b' }, LINK_CRITERIA), true);
    assert.equal(linkChangeNeedsReload({ active: false }, LINK_CRITERIA), true);
  });

  it('пометка ребра корзиной при скрытой корзине — полный путь (ошибка 8da8e6b4)', () => {
    // При выключенной настройке «Показывать содержимое корзины» помеченное
    // ребро больше не приходит в выборку edges: линия обязана исчезнуть, а не
    // только пометиться инкрементально.
    assert.equal(
      linkChangeNeedsReload({ marked_for_deletion: true }, { ...LINK_CRITERIA, showTrash: false }),
      true,
    );
    assert.equal(
      linkChangeNeedsReload({ marked_for_deletion: false }, { ...LINK_CRITERIA, showTrash: false }),
      true,
    );
    // При показанной корзине пометка — оформление нарисованной линии.
    assert.equal(linkChangeNeedsReload({ marked_for_deletion: true }, LINK_CRITERIA), false);
  });

  it('смена типа ребра под фильтром обхода — полный путь (ошибка 0af1d810)', () => {
    // Ребро может выпасть из типов, по которым раскрываются ветви дерева:
    // сосед исчезает из раскрытых уровней, линия — вместе с ним.
    assert.equal(
      linkChangeNeedsReload({ type_id: 'ty' }, { ...LINK_CRITERIA, linkFilterActive: true }),
      true,
    );
    // Без фильтра обхода тип ребра состав видимого графа не меняет.
    assert.equal(linkChangeNeedsReload({ type_id: 'ty' }, LINK_CRITERIA), false);
  });
});

describe('structures realtime: направления (эллипсы) концов ребра', () => {
  it('додар направлений отбрасывает устаревший ответ (смена отбора/додара) — ошибка 0eebf8eb', () => {
    const src = fs.readFileSync(
      path.join(RENDERER_ROOT, 'screens', 'structures', 'structures.ts'),
      'utf8',
    );
    const body = src.slice(src.indexOf('async function refreshDirections('));
    const end = body.indexOf('\n}\n');
    const fnBody = body.slice(0, end);
    // Поколение ОТБОРА: ответ, переживший смену применённого отбора, отбрасывается.
    assert.match(fnBody, /const seq = querySeq;/);
    assert.match(fnBody, /seq !== querySeq/);
    // Поколение ДОДАРА по id: поздний ответ старого додара не перезаписывает свежие флаги.
    assert.match(fnBody, /const call = \+\+directionsCallSeq;/);
    assert.match(fnBody, /directionsStartedAt\.set\(id, call\)/);
    assert.match(fnBody, /directionsStartedAt\.get\(id\) !== call/);
  });
});

describe('structures realtime: слияние изменений', () => {
  it('thought.updated обновляет title в refs и одну строку', () => {
    const state = makeState();
    const before = rowRenderSignature(state.refs.get('t1'), state.directions.get('t1'), undefined);

    assert.equal(applyThoughtUpdateToState(state, 't1', { title: 'Новое' }), true);
    assert.equal(state.refs.get('t1')?.title, 'Новое');
    assert.equal(state.refs.get('t2')?.title, 'T2', 'соседняя мысль не тронута');

    const after = rowRenderSignature(state.refs.get('t1'), state.directions.get('t1'), undefined);
    assert.notEqual(after, before, 'подпись строки изменилась → сверка зовёт update одной строки');
  });

  it('событие по невидимой сущности игнорируется', () => {
    const state = makeState();
    assert.equal(applyThoughtUpdateToState(state, 'nope', { title: 'X' }), false);
    assert.equal(applyLinkUpdateToState(state, 'nope', { color: '#fff' }), false);
  });

  it('link.updated меняет оформление ребра, сохраняя концы', () => {
    const state = makeState();
    assert.equal(applyLinkUpdateToState(state, 'l1', { color: '#f00', width: 3 }), true);
    const edge = state.edges.get('l1');
    assert.equal(edge?.color, '#f00');
    assert.equal(edge?.width, 3);
    assert.equal(edge?.source_id, 't1');
    assert.equal(edge?.target_id, 't2');
  });

  it('link.deleted убирает линию', () => {
    const state = makeState();
    assert.equal(removeLinkFromState(state, 'l1'), true);
    assert.equal(state.edges.has('l1'), false);
    assert.equal(removeLinkFromState(state, 'l1'), false);
  });

  it('thought.deleted убирает мысль из всех коллекций снимка (removed-путь)', () => {
    const state = makeState();
    const resultIdsRef = state.resultIds;

    assert.equal(removeThoughtFromState(state, 't2'), true);
    assert.deepEqual(state.resultIds, ['t1']);
    assert.equal(state.resultIds, resultIdsRef, 'resultIds правится на месте — экран держит ту же ссылку');
    assert.equal(state.refs.has('t2'), false);
    assert.equal(state.edges.has('l1'), false, 'ребро с удалённой мыслью убрано');
    assert.equal(state.edges.has('l2'), false);
    assert.deepEqual(state.hierarchy.get('t1/children')?.neighbors, [], 'сосед убран из страницы');
    assert.equal(removeThoughtFromState(state, 't2'), false, 'повторно — изменений нет');
  });
});

describe('structures realtime: подпись строки', () => {
  it('меняется от правки мысли и стабильна без неё', () => {
    const ref = makeRef({ title: 'A' });
    const dir = { has_incoming: true, has_outgoing: false };
    const exp = { children: true };
    const base = rowRenderSignature(ref, dir, exp);

    assert.equal(rowRenderSignature({ ...ref }, dir, exp), base, 'структурно равная — та же подпись');
    assert.notEqual(rowRenderSignature({ ...ref, title: 'B' }, dir, exp), base);
    assert.notEqual(rowRenderSignature(ref, { has_incoming: false, has_outgoing: false }, exp), base);
    assert.notEqual(rowRenderSignature(ref, dir, { children: false }), base);
  });

  it('applyThoughtChanges переносит только заданные поля', () => {
    const ref = makeRef({ title: 'A', font_bold: null });
    const next = applyThoughtChanges(ref, { font_bold: true });
    assert.equal(next.font_bold, true);
    assert.equal(next.title, 'A');
    assert.equal(ref.font_bold, null, 'исходный ref не мутируется');
  });

  it('applyLinkChanges переносит оформление ребра', () => {
    const edge = makeEdge();
    const next = applyLinkChanges(edge, { style: 'dashed', marked_for_deletion: true });
    assert.equal(next.style, 'dashed');
    assert.equal(next.link_marked_for_deletion, true);
    assert.equal(edge.style, null, 'исходное ребро не мутируется');
  });
});

describe('structures realtime: проводка экрана и шины', () => {
  const structures = fs.readFileSync(
    path.join(RENDERER_ROOT, 'screens', 'structures', 'structures.ts'),
    'utf8',
  );
  const realtimeUi = fs.readFileSync(path.join(RENDERER_ROOT, 'realtime-ui.ts'), 'utf8');

  it('эллипсы концов удалённого ребра перечитываются точечно', () => {
    // Снимок `directions` нельзя вывести из кэша `edges` (только видимые связи),
    // поэтому батч запускает точечный додар направлений, а не полный путь.
    const body = structures.slice(structures.indexOf('function applyStructuresOps('));
    const end = body.indexOf('\n}\n\n/**');
    const fnBody = body.slice(0, end);
    assert.match(fnBody, /case 'link-deleted':[\s\S]*?refreshDirectionsFor\.add\(edge\.source_id\)/);
    assert.match(fnBody, /refreshDirectionsFor\.add\(edge\.target_id\)/);
    assert.match(fnBody, /void refreshDirections\(refreshDirectionsFor\)/);
    assert.match(structures, /async function refreshDirections\(ids: ReadonlySet<string>\)/);
    assert.match(structures, /fetchHierarchy\(networkId, id, 'children', \{\}\)\)\.directions\[id\]/);
    // Смена типа под фильтром обхода и пометка корзины уходят полным путём,
    // точечного додара направлений по `link.updated` больше нет (ошибки 8da8e6b4/0af1d810).
    assert.ok(!fnBody.includes('linkChangeAffectsDirections'), 'link.updated не должен идти через точечный додар directions');
  });

  it('link.updated классифицируется с критериями отбора/корзины', () => {
    const body = structures.slice(structures.indexOf("case 'link.updated':"));
    const end = body.indexOf("case 'link.deleted':");
    assert.match(body.slice(0, end), /linkChangeNeedsReload\(changes, linkCriteriaSnapshot\(\)\)/);
  });

  it('экран коалессирует события и держит один reconcile на окно', () => {
    assert.match(structures, /export function applyStructuresRealtime\(evt: AnyRealtimeEvent\)/);
    assert.match(structures, /createRealtimeBatch<StructuresRealtimeOp>\(/);
    assert.match(structures, /applyBatch: \(ops\) => applyStructuresOps\(ops\)/);
    assert.match(
      structures,
      /applyFull: \(\) => \{[\s\S]*?void reloadAll\(\);/,
      'полный путь по-прежнему зовёт reloadAll (при показанном виде)',
    );
    const body = structures.slice(structures.indexOf('function applyStructuresOps('));
    const end = body.indexOf('\n}\n');
    const callCount = (body.slice(0, end).match(/renderTree\(/g) ?? []).length;
    assert.equal(callCount, 1, 'один renderTree на батч окна');
  });

  it('полный путь при скрытом виде откладывается до показа (ошибка 8e702d8c)', () => {
    // Скрытый вид не гоняет сетевые перезагрузки вхолостую: fallback-событие
    // помечает снимок «грязным», а перезагрузка идёт при следующем показе вида.
    assert.match(
      structures,
      /applyFull: \(\) => \{[\s\S]*?if \(store\.state\.activeView !== 'structures'\) \{[\s\S]*?fullRefreshPending = true;[\s\S]*?return;[\s\S]*?void reloadAll\(\);/,
      'applyFull откладывает полный путь, пока вид скрыт',
    );
    // Показ вида с отложенной пометкой перезагружает снимок сейчас.
    assert.match(
      structures,
      /store\.subscribe\(\(\) => \{[\s\S]*?fullRefreshPending[\s\S]*?void reloadAll\(\);/,
      'показ вида снимает отложенную пометку полной перезагрузкой',
    );
    // Инкрементальный батч гейта по активному виду НЕ получил: снимок живёт и вне экрана.
    assert.match(structures, /applyBatch: \(ops\) => applyStructuresOps\(ops\)/);
  });

  it('снимок поддерживается и вне активного вида «Структур» (замечание проверки уровня 3)', () => {
    const body = structures.slice(structures.indexOf('export function applyStructuresRealtime('));
    const callEnd = body.indexOf('\n}\n');
    const fnBody = body.slice(0, callEnd);
    assert.ok(
      !fnBody.includes("activeView !== 'structures'"),
      'applyStructuresRealtime не должен гейтиться по активному виду: иначе thought.deleted вне экрана не чистит refs/активную мысль',
    );
  });

  it('realtime-ветки шины зовут инкрементальный путь экрана', () => {
    assert.match(realtimeUi, /case 'thought\.updated':[\s\S]*?applyStructuresRealtime\(evt\)/);
    assert.match(realtimeUi, /case 'thought\.deleted':[\s\S]*?applyStructuresRealtime\(evt\)/);
    assert.match(realtimeUi, /case 'link\.updated':\s*\n\s*case 'link\.deleted':[\s\S]*?applyStructuresRealtime\(evt\)/);
  });
});
