/**
 * «Публикации»: состояние экрана (полка/поиск) и запросы принадлежат паре
 * «сеть + вкладка» (ошибка 5768f479).
 *
 * Дефект: `publications.ts` — модульный синглтон, переживающий
 * `teardownWorkspace()`. `load()` снимал сеть на входе и не сверял ничего после
 * `await`, `viewState` после смены сети оставался от прежней, `persist()` писал
 * его под ключ текущей сети. В окне `openNetwork` (store уже B, экран ещё A)
 * отложенные таймеры уходили в B с фильтром полки A; поздний ответ A после
 * перемонтирования B рисовался в B, а бейджи ходили в B с id публикаций A
 * (404); конкурентные `load()` применялись в порядке прихода, а не запуска.
 *
 * Кейсы (красные на дофиксовой сборке):
 * 1. Окно `openNetwork`: пока L4 новой сети ещё читается, ни одного
 *    `list(B, { shelf: <полка A> })` и ни одной записи `setState(B, состояние A)`
 *    (в т.ч. от отложенного поиска прежнего экрана).
 * 2. Поздний ответ A после teardown A и монтирования B: в DOM B только B,
 *    `candidates` только с сетью B и id B, ни одного 404.
 * 3. Конкуренция `load()`: побеждает последний ЗАПУЩЕННЫЙ, а не последний
 *    пришедший.
 *
 * Мутации, которые обязаны краснить: (1) убрать владельца `viewStateNetworkId`
 * (`load`/`persist`) — кейсы 1–2; (2) убрать проверку поколения/`ui` в
 * `canApplyLoad` — кейс 2; (3) убрать проверку владельца в `persist` — кейс 1;
 * (4) убрать `loadSeq` — кейс 3.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { EtnError, type Publication, type Shelf } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

type Dict = Record<string, unknown>;

const NET_A = '00000000-0000-4000-8000-0000000000a1';
const NET_B = '00000000-0000-4000-8000-0000000000b2';
const SHELF_A = '00000000-0000-4000-8000-0000000000c1';
const PUB_A = '00000000-0000-4000-8000-0000000000d1';
const PUB_OLD = '00000000-0000-4000-8000-0000000000d2';
const PUB_NEW = '00000000-0000-4000-8000-0000000000d3';
const PUB_B = '00000000-0000-4000-8000-0000000000e1';

interface ListCall {
  networkId: string;
  params: any;
}

interface HeldList {
  call: ListCall;
  resolve: () => void;
}

/** Запросы списка публикаций: сеть и условия (журнал гейта). */
let listCalls: ListCall[] = [];
/** Удерживать ли новые запросы списка (гонка с поздним ответом). */
let holdList = false;
/** Удержанные запросы списка в порядке запуска. */
let heldLists: HeldList[] = [];
/** Запросы бейджей «+N»: сеть и id публикации. */
let candidateCalls: Array<{ networkId: string; id: string }> = [];
/** 404 на бейджи (id публикации чужой сети). */
let notFoundCount = 0;
/** Записи L4: чьё состояние легло под чей ключ. */
let setStateCalls: Array<{ networkId: string; value: string }> = [];
/** Сохранённое состояние L4 по сети. */
let l4States: Record<string, string | null> = {};
/** Удерживать чтение L4 сети B (окно `openNetwork`). */
let holdGetStateB = false;
/** Удерживать СЛЕДУЮЩЕЕ чтение L4 (поздний разбор прежнего экрана). */
let holdGetStateNext = false;
let heldGetStateB: Array<() => void> = [];

function publication(id: string, title: string, overrides: Partial<Publication> = {}): Publication {
  return {
    id,
    title,
    subtitle: null,
    summary_md: null,
    authorship: null,
    cover_attachment_id: null,
    cover_url: null,
    cover_kind: 'none',
    assembly_date: null,
    title_recipe: null,
    text_sources: [],
    extra_properties: [],
    numbering_from: null,
    numbering_to: null,
    active: true,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    version: 1,
    created_at: '2026-10-01T00:00:00.000Z',
    created_by: 'u',
    updated_at: '2026-10-01T00:00:00.000Z',
    updated_by: 'u',
    ...overrides,
  };
}

function shelf(id: string, title: string, publicationId: string | null): Shelf {
  return {
    id,
    title,
    position: 1,
    version: 1,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    created_at: '2026-10-01T00:00:00.000Z',
    created_by: 'u',
    updated_at: '2026-10-01T00:00:00.000Z',
    updated_by: 'u',
    items:
      publicationId === null
        ? []
        : [{ shelf_id: id, publication_id: publicationId, position: 1 }],
  };
}

/** Ответ сервера на список: сервер молча пуст для неизвестной полки. */
function listResult(networkId: string, params: any): { items: Publication[]; total: number } {
  if (networkId === NET_A) {
    if (params.q === 'старый') return { items: [publication(PUB_A, 'Устаревшая выдача')], total: 1 };
    if (params.q === 'нов') return { items: [publication(PUB_NEW, 'Новая выдача')], total: 1 };
    if (params.shelf === SHELF_A) return { items: [publication(PUB_A, 'Публикация A')], total: 1 };
    return { items: [publication(PUB_OLD, 'Первая выдача')], total: 1 };
  }
  if (networkId === NET_B) {
    // Неизвестная полка (id полки A) — пустой список без ошибки (publication-service).
    if (params.shelf !== undefined) return { items: [], total: 0 };
    return { items: [publication(PUB_B, 'Публикация B')], total: 1 };
  }
  return { items: [], total: 0 };
}

function shelvesFor(networkId: string): Shelf[] {
  if (networkId === NET_A) return [shelf(SHELF_A, 'Полка A 5768f479', PUB_A)];
  return [];
}

function installShims(bridge: Dict): void {
  (globalThis as Dict).HTMLElement = ShimElement;
  (globalThis as Dict).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body: new ShimElement('body'),
    documentElement: { style: {}, classList: new ShimElement('html').classList },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
    getSelection: () => null,
  } satisfies Dict;
  const win = ((globalThis as Dict).window ?? ((globalThis as Dict).window = {})) as Dict;
  win.innerWidth = 1400;
  win.innerHeight = 900;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.setInterval = setInterval;
  win.clearInterval = clearInterval;
  win.requestAnimationFrame = (fn: () => void) => {
    fn();
    return 1;
  };
  win.cancelAnimationFrame = () => undefined;
  win.etn = bridge;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  win.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  (globalThis as Dict).ResizeObserver = class {
    observe(): void {
      /* раскладки в шиме нет */
    }
    unobserve(): void {
      /* раскладки в шиме нет */
    }
    disconnect(): void {
      /* раскладки в шиме нет */
    }
  };
  (globalThis as Dict).requestAnimationFrame = win.requestAnimationFrame;
  (globalThis as Dict).localStorage = win.localStorage;
}

installShims({
  ui: {
    getState: async (networkId: string) => {
      // Значение снимается в момент ЗАПРОСА: удержанный разбор возвращает то,
      // что экран прочитал до смены состояния.
      const value = l4States[networkId] ?? null;
      const hold = holdGetStateNext || (networkId === NET_B && holdGetStateB);
      holdGetStateNext = false;
      if (hold) {
        await new Promise<void>((resolve) => heldGetStateB.push(resolve));
      }
      return value;
    },
    setState: async (networkId: string, _key: string, value: string) => {
      setStateCalls.push({ networkId, value });
      l4States[networkId] = value;
    },
  },
  publications: {
    list: async (networkId: string, params: any) => {
      const call: ListCall = { networkId, params };
      listCalls.push(call);
      if (holdList) {
        await new Promise<void>((resolve) => heldLists.push({ call, resolve }));
      }
      return listResult(networkId, params);
    },
    listShelves: async (networkId: string) => shelvesFor(networkId),
    candidates: async (networkId: string, id: string) => {
      candidateCalls.push({ networkId, id });
      const known = listResult(networkId, {}).items.some((item) => item.id === id);
      if (!known) {
        notFoundCount += 1;
        throw new EtnError('NOT_FOUND', `publication ${id} not found`);
      }
      return { items: [], total: 0, limit: 1, offset: 0, has_more: false };
    },
    get: async (networkId: string, id: string) => {
      if (networkId === NET_B && id === PUB_A) throw new EtnError('NOT_FOUND', 'not found');
      return publication(id, 'Публикация');
    },
    assembly: async () => ({
      publication: {
        title: '',
        subtitle: null,
        authorship: null,
        assembly_date: null,
        summary_html: '',
        cover: { kind: 'placeholder', ref: null },
        new_candidates: 0,
      },
      sections: [],
      excluded: [],
      warnings: [],
      meta: { page: 1, per_page: 20, total_roots: 0, has_more: false },
    }),
    addShelfItem: async () => undefined,
    removeShelfItem: async () => undefined,
    createShelf: async () => undefined,
    updateShelf: async () => undefined,
  },
  tabs: {
    updateState: async () => undefined,
    list: async () => [],
  },
  propertyRegistry: { list: async () => [] },
  admin: { listUsers: async () => [] },
  networks: { listMembers: async () => [] },
  linkTypes: { list: async () => [] },
  attachments: { get: async () => null },
  storage: { get: async () => null, set: async () => undefined },
});

const stateMod = await import('../src/renderer/state.js');
const publicationsMod = await import('../src/renderer/screens/publications/publications.js');

/** Дождаться асинхронных чтений и продолжений. */
async function flush(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/** Дождаться условия (шаги с дебаунсом таймеров). */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (predicate()) return;
    await flush(5);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`не дождались: ${label}`);
}

function callsTo(networkId: string): ListCall[] {
  return listCalls.filter((call) => call.networkId === networkId);
}

function releasesHeld(count: number): void {
  const pending = heldLists.splice(0, count);
  for (const entry of pending) entry.resolve();
}

/** Отпустить удержанный запрос по порядковому номеру запуска (не FIFO). */
function releaseHeldAt(index: number): void {
  const entry = heldLists.splice(index, 1)[0];
  assert.ok(entry !== undefined, `удержанный запуск #${index} существует`);
  entry.resolve();
}

function hostTitles(host: ShimElement): string[] {
  return host
    .findAll((node) => node.classList.contains('pub-card-title'))
    .map((node) => node.textContent);
}

function searchInput(host: ShimElement): ShimElement {
  const input = host.findAll((node) => node.classList.contains('pub-search'))[0];
  assert.ok(input !== undefined, 'поле поиска построено');
  return input;
}

let teardown: (() => void) | null = null;
let host: ShimElement | null = null;

afterEach(() => {
  holdList = false;
  holdGetStateB = false;
  holdGetStateNext = false;
  releasesHeld(heldLists.length);
  for (const resolve of heldGetStateB.splice(0)) resolve();
  if (teardown !== null) {
    teardown();
    teardown = null;
  }
  host = null;
});

beforeEach(() => {
  listCalls = [];
  holdList = false;
  heldLists = [];
  candidateCalls = [];
  notFoundCount = 0;
  setStateCalls = [];
  l4States = {};
  holdGetStateB = false;
  holdGetStateNext = false;
  heldGetStateB = [];
});

/** Store на паре A, экран «Публикации». */
function storeOnA(): void {
  stateMod.store.update({
    networkId: NET_A,
    network: null,
    activeView: 'publications',
    screen: 'workspace',
    tabs: [{ tab_id: 'tab-A', network_id: NET_A }],
    activeTabId: 'tab-A',
    editorTarget: null,
    me: { id: 'user-1', username: 'u', display_name: 'U', is_admin: false },
  } as any);
}

/** Смонтировать экран; инициализацию запускает вызывающий. */
function mountScreen(): ShimElement {
  host = new ShimElement('div');
  teardown = publicationsMod.mountPublications(host as unknown as HTMLElement);
  return host;
}

describe('«Публикации»: состояние и запросы в паре «сеть + вкладка» (5768f479)', () => {
  it('1. окно openNetwork: никакой полки A в запросах B и никакой записи состояния A под ключ B', async () => {
    l4States[NET_A] = JSON.stringify({
      viewMode: 'shelves',
      sort: 'manual',
      activeFilter: 'true',
      shelfFilter: SHELF_A,
      query: '',
      filtersOpen: false,
      textWidth: 100,
    });
    storeOnA();
    const root = mountScreen();
    void publicationsMod.ensurePublicationsInitialised();
    await waitFor(
      () => callsTo(NET_A).length > 0 && hostTitles(root).includes('Публикация A'),
      'старт A: библиотека с полкой A загружена',
    );
    assert.ok(
      callsTo(NET_A).every((call) => call.params.shelf === SHELF_A),
      'старт: запрос A несёт полку A',
    );

    // Отложенный запуск A (reloadTimer) удерживается — он переживёт смену сети.
    holdList = true;
    publicationsMod.invalidatePublications();
    await waitFor(() => heldLists.length >= 1, 'запуск A удержан');

    // Окно openNetwork: L4 сети B читается медленно, store уже B.
    holdGetStateB = true;
    const markSetState = setStateCalls.length;
    stateMod.store.update({
      networkId: NET_B,
      tabs: [
        { tab_id: 'tab-A', network_id: NET_A },
        { tab_id: 'tab-B', network_id: NET_B },
      ],
      activeTabId: 'tab-B',
      activeView: 'publications',
    } as any);
    await flush();

    // Пока владение состоянием не восстановлено для B, отложенные триггеры
    // прежнего экрана не имеют права уйти в B.
    publicationsMod.invalidatePublications();
    const search = searchInput(root);
    search.value = 'чужой запрос';
    search.emit('input');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await flush();

    assert.deepEqual(
      callsTo(NET_B),
      [],
      'в окне openNetwork ни одного запроса списка в B (полки A там нет)',
    );
    assert.equal(
      setStateCalls.length,
      markSetState,
      'состояние A не записано под ключ B (ни фильтром, ни отложенным поиском)',
    );

    // Положительный контроль: после разбора L4 B библиотека грузится СВОИМ
    // состоянием и показывает публикацию B.
    holdList = false;
    for (const resolve of heldGetStateB.splice(0)) resolve();
    await waitFor(
      () => callsTo(NET_B).length > 0 && hostTitles(root).includes('Публикация B'),
      'B: библиотека загружена своим состоянием',
    );
    assert.ok(
      callsTo(NET_B).every((call) => call.params.shelf === undefined),
      'в B не ушла полка A',
    );
    assert.ok(
      setStateCalls.every((call) => call.networkId === NET_A),
      'записи L4 — только под ключ A',
    );
    // Отпускаем удержанный запуск A (поздний ответ прежней сети) — на B он
    // влиять не должен.
    releasesHeld(heldLists.length);
    await flush();
    assert.ok(
      callsTo(NET_B).every((call) => call.params.shelf === undefined),
      'поздний ответ A не породил запрос B с полкой A',
    );
  });

  it('2. поздний ответ A после teardown A и монтирования B: в B только B, бейджи без 404', async () => {
    l4States[NET_A] = JSON.stringify({
      viewMode: 'shelves',
      sort: 'manual',
      activeFilter: 'true',
      shelfFilter: SHELF_A,
      query: '',
      filtersOpen: false,
      textWidth: 100,
    });
    storeOnA();
    const rootA = mountScreen();
    // Запуск A удерживается: его ответ придёт уже после снятия экрана.
    holdList = true;
    void publicationsMod.ensurePublicationsInitialised();
    await waitFor(() => heldLists.length >= 1, 'запуск A удержан');
    assert.equal(heldLists[0]?.call.networkId, NET_A, 'удержан ответ сети A');

    // teardown A (teardownWorkspace) + публикация B и новое монтирование.
    assert.ok(teardown !== null, 'экран A смонтирован');
    teardown?.();
    teardown = null;
    holdList = false;
    stateMod.store.update({
      networkId: NET_B,
      tabs: [
        { tab_id: 'tab-A', network_id: NET_A },
        { tab_id: 'tab-B', network_id: NET_B },
      ],
      activeTabId: 'tab-B',
      activeView: 'publications',
    } as any);
    const rootB = mountScreen();
    void publicationsMod.ensurePublicationsInitialised();
    await waitFor(
      () => hostTitles(rootB).includes('Публикация B'),
      'B: библиотека загружена',
    );

    // Поздний ответ A (полка A, публикация A) приходит в смонтированный B.
    releasesHeld(heldLists.length);
    await flush(60);
    await flush(60);

    assert.deepEqual(
      hostTitles(rootB),
      ['Публикация B'],
      'в DOM B только публикация B — ответ A не применён',
    );
    assert.equal(hostTitles(rootA).length, 0, 'снятый экран A ничего не дорисовал');
    assert.ok(candidateCalls.length > 0, 'бейджи B запрошены');
    assert.ok(
      candidateCalls.every((call) => call.networkId === NET_B && call.id === PUB_B),
      'бейджи — только сеть B и id публикаций B',
    );
    assert.equal(notFoundCount, 0, 'ни одного 404 на бейджах');
  });

  it('3. конкуренция load(): применяется последний запущенный, а не последний пришедший', async () => {
    l4States[NET_A] = null;
    storeOnA();
    const root = mountScreen();
    void publicationsMod.ensurePublicationsInitialised();
    await waitFor(
      () => callsTo(NET_A).length > 0 && hostTitles(root).includes('Первая выдача'),
      'старт A: первая выдача',
    );

    // Два запуска в одной паре: reload (q = '') и отложенный поиск (q = 'нов').
    holdList = true;
    publicationsMod.invalidatePublications();
    await waitFor(() => heldLists.length >= 1, 'первый запуск удержан');
    const search = searchInput(root);
    search.value = 'нов';
    search.emit('input');
    await waitFor(() => heldLists.length >= 2, 'второй запуск (поиск) удержан');
    assert.equal(heldLists[0]?.call.params.q, undefined, 'первый запуск — без поиска');
    assert.equal(heldLists[1]?.call.params.q, 'нов', 'второй запуск — с новым поиском');

    // Ответы приходят в обратном порядке: второй (последний запущенный) — раньше.
    releaseHeldAt(1);
    await flush();
    assert.ok(hostTitles(root).includes('Новая выдача'), 'применён ответ последнего запуска');
    releasesHeld(heldLists.length);
    await flush(60);

    assert.ok(
      hostTitles(root).includes('Новая выдача'),
      'поздний ответ первого запуска не перетёр последний запущенный',
    );
    assert.ok(
      !hostTitles(root).includes('Первая выдача'),
      'выдача устаревшего запуска не применена',
    );
  });

  it('4. перемонтирование на той же паре: поздний разбор L4 прежнего экрана не переписывает состояние нового', async () => {
    // Прежний экран прочитал СТАРОЕ состояние (полка A + поиск), новый экран —
    // чистое. Поколение/владелец обязаны отбросить запоздавший разбор.
    l4States[NET_A] = JSON.stringify({
      viewMode: 'shelves',
      sort: 'manual',
      activeFilter: 'true',
      shelfFilter: SHELF_A,
      query: 'старый',
      filtersOpen: false,
      textWidth: 100,
    });
    storeOnA();
    mountScreen();
    holdGetStateNext = true;
    void publicationsMod.ensurePublicationsInitialised();
    await waitFor(() => heldGetStateB.length >= 1, 'разбор L4 прежнего экрана удержан');

    // Перемонтирование того же вида на ТОЙ ЖЕ паре (сеть не менялась): новый
    // экран читает уже чистое состояние и загружает свою выдачу.
    teardown?.();
    teardown = null;
    l4States[NET_A] = null;
    const root = mountScreen();
    void publicationsMod.ensurePublicationsInitialised();
    await waitFor(
      () => callsTo(NET_A).length > 0 && hostTitles(root).includes('Первая выдача'),
      'новый экран загружен своим состоянием',
    );
    const mark = listCalls.length;

    // Прежний экран дочитал СВОЁ (старое) состояние — после await владельца уже нет.
    for (const resolve of heldGetStateB.splice(0)) resolve();
    await flush(60);
    await flush(60);

    assert.equal(listCalls.length, mark, 'поздний разбор не породил ни одного запроса');
    assert.ok(
      !listCalls.some((call) => call.networkId === NET_A && call.params.q === 'старый'),
      'старый поиск не ушёл в сеть',
    );
    assert.deepEqual(
      hostTitles(root),
      ['Первая выдача'],
      'состояние нового экрана не переписано разбором прежнего',
    );
  });
});
