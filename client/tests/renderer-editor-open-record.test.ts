/**
 * Поведенческие тесты программного входа «открыть привязку с записью»
 * (0.15.4, тех.проект 43329662, требование ce121e09, задача 666d1d00):
 * `openRecordInEditor(thoughtId, commentId)` открывает редактор ОТКРЫВАЕМОЙ мысли,
 * активирует вкладку «Дневник» и выбирает в нём строку записи.
 *
 * Сценарий S1 (55c7f9c7, шаг 3) покрывается здесь поведенчески: реальный
 * `mountEditor` под DOM-шимом (образец — `renderer-editor-entity-switch.test.ts`)
 * и мок `etn.comments.list`. Мок повторяет семантику серверного списка
 * (`server/src/domain/comment-service.ts`, listComments — byOwner ∪ byTarget):
 * запись видна в «Дневнике» каждой своей привязки, поэтому ГЛАВНЫЙ случай —
 * «привязка ≠ владелец»: запись принадлежит ЧУЖОМУ владельцу (HOME), а привязана
 * (m2m-цель) к открываемой мысли.
 *
 * Стендовый GUI-прогон S1 — в задаче 33ed043c, здесь он не гоняется.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UI_STATE_KEY, type Comment, type FocusResponse, type Thought } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NET = 'n1';
/** Владелец «чужой» записи — корень сети (HOME), НЕ открываемая мысль. */
const HOME = 'home-thought';

/**
 * Элемент шима, годный для вендорской сетки. Фасад списков (`lib/ui/table.ts`)
 * в тестах работает через адаптер `lib/ui/table-grid.ts`, который ждёт у
 * `<vaadin-grid>` методы Grid (шапка `table-grid.ts`: «сам Grid в тестах
 * замещается стабом»). Здесь стаб — те же элементы шима плюс no-op методы сетки:
 * строки (`items`) и текущая строка (`activeItem`) остаются читаемыми полями,
 * поэтому тест видит выбор строки «как в вендоре».
 */
function vendorElement(tag: string): ShimElement {
  const node = new ShimElement(tag) as ShimElement & Record<string, unknown>;
  if (tag === 'vaadin-grid') {
    node['items'] = [];
    node['activeItem'] = null;
    node['selectedItems'] = [];
    node['shadowRoot'] = null;
    node['clearCache'] = () => undefined;
    node['generateCellPartNames'] = () => undefined;
    node['scrollToIndex'] = () => undefined;
    node['getEventContext'] = () => null;
  }
  return node;
}

function shimDom(): void {
  // `instanceof HTMLElement` проверяет фокус-логика продукта — шим и есть HTMLElement.
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).CustomEvent = class {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as any).requestAnimationFrame = (cb: () => void): number => {
    cb();
    return 0;
  };
  // Продукт зовёт глобальный `getComputedStyle` (раскладка вкладок) — шим обязан
  // отдать его и на `globalThis`, и на `window`.
  (globalThis as any).getComputedStyle = () => ({
    getPropertyValue: () => '',
    paddingLeft: '0px',
    paddingRight: '0px',
  });
  const docElementStyle = {
    setProperty: () => undefined,
    removeProperty: () => undefined,
    getPropertyValue: () => '',
  };
  (globalThis as any).document = {
    createElement: (tag: string) => vendorElement(tag),
    createElementNS: (_ns: string, tag: string) => vendorElement(tag),
    documentElement: { style: docElementStyle },
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
    activeElement: null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.requestAnimationFrame = (cb: () => void): number => {
    cb();
    return 0;
  };
  win.cancelAnimationFrame = () => undefined;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  // Поля markdown (нижняя область записи) читают оформление и настройки темы.
  win.getComputedStyle = () => ({
    getPropertyValue: () => '',
    paddingLeft: '0px',
    paddingRight: '0px',
  });
  win.matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  const ls = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
    removeItem: (k: string) => void ls.delete(k),
    clear: () => ls.clear(),
    key: (i: number) => [...ls.keys()][i] ?? null,
    get length() {
      return ls.size;
    },
  };
}

function makeThought(id: string, title: string, version = 1): Thought {
  return {
    id,
    title,
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    is_protected: false,
    is_root: false,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    synonyms: [],
    version,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function makeFocus(focused: Thought): FocusResponse {
  return {
    focused,
    parents: [],
    siblings: [],
    children: [],
    edges: [],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

/** Хронологическая запись: `targets` — m2m-привязки (включая первичную). */
function makeComment(input: {
  id: string;
  ownerId: string;
  title: string;
  validFrom: string;
  targets?: string[];
  body?: string;
}): Comment {
  const targets = [
    { owner_type: 'thought' as const, owner_id: input.ownerId },
    ...(input.targets ?? []).map((id) => ({ owner_type: 'thought' as const, owner_id: id })),
  ];
  return {
    id: input.id,
    owner_type: 'thought',
    owner_id: input.ownerId,
    targets,
    kind: 'chronological',
    title: input.title,
    body_md: input.body ?? `Тело записи «${input.title}»`,
    body_html: `<p>Тело записи «${input.title}»</p>`,
    valid_from: input.validFrom,
    valid_to: input.validFrom,
    use_time: false,
    version: 1,
    created_at: input.validFrom,
    updated_at: input.validFrom,
    created_by: 'u1',
    updated_by: 'u1',
  };
}

/**
 * Корпус записей тестовой мысли `t1` (открываемая привязка).
 *
 * Порядок таблицы — обратный хронологический (`defaultSort: period desc`),
 * поэтому верхняя строка — `c3`: авто-выбор обязан приводить именно к ней,
 * а программный вход выбирает `c2` — запись ЧУЖОГО владельца (HOME),
 * привязанную к `t1` (главный случай предполёта).
 */
const RECORDS: Comment[] = [
  makeComment({
    id: 'c1',
    ownerId: 't1',
    title: 'Владелец: январь',
    validFrom: '2026-01-01T00:00:00.000Z',
  }),
  makeComment({
    id: 'c2',
    ownerId: HOME,
    title: 'Чужая запись: февраль',
    validFrom: '2026-02-01T00:00:00.000Z',
    targets: ['t1'],
  }),
  makeComment({
    id: 'c3',
    ownerId: 't1',
    title: 'Владелец: март',
    validFrom: '2026-03-01T00:00:00.000Z',
  }),
  makeComment({
    id: 'c8',
    ownerId: 't2',
    title: 'Запись t2: апрель',
    validFrom: '2026-04-01T00:00:00.000Z',
  }),
  makeComment({
    id: 'c9',
    ownerId: 't2',
    title: 'Запись t2: май',
    validFrom: '2026-05-01T00:00:00.000Z',
  }),
];

interface EtnCalls {
  /** Вызовы `etn.ui.setState` — предпочтение вкладки писать запрещено. */
  setState: Array<{ networkId: string; key: string; value: unknown }>;
  /** Сколько раз читали список комментариев. */
  commentLists: number;
}

/**
 * Мок `window.etn`. `etn.comments.list` повторяет серверную семантику:
 * запись отдаётся и по владельцу, и по m2m-цели.
 */
function installEtn(
  options: {
    thoughts?: Record<string, Thought>;
    /** Отложенная доставка сущности: id → промис, который тест разрешает сам. */
    deferred?: Record<string, Promise<Thought>>;
    /** id мыслей, чей ПЕРВЫЙ `etn.thoughts.get` падает (проба П2: вход не состоялся). */
    failOnce?: readonly string[];
  } = {},
): EtnCalls {
  const calls: EtnCalls = { setState: [], commentLists: 0 };
  const failOnce = new Set(options.failOnce ?? []);
  const win = (globalThis as any).window as Record<string, any>;
  win.etn = {
    ui: {
      getState: async () => 'main',
      setState: async (networkId: string, key: string, value: unknown) => {
        calls.setState.push({ networkId, key, value });
      },
    },
    comments: {
      list: async (_networkId: string, ownerType: string, ownerId: string) => {
        calls.commentLists += 1;
        return RECORDS.filter(
          (c) =>
            (c.owner_type === ownerType && c.owner_id === ownerId) ||
            c.targets.some((t) => t.owner_type === ownerType && t.owner_id === ownerId),
        );
      },
    },
    attachments: { list: async () => [] },
    thoughts: {
      get: async (_networkId: string, id: string) => {
        // Проба П2 приёмки: первый запрос этой мысли падает (мысль удалена,
        // нет доступа, сеть) — вход «открыть с записью» не состоялся.
        if (failOnce.delete(id)) throw new Error(`etn.thoughts.get(${id}) failed`);
        const deferred = options.deferred?.[id];
        if (deferred !== undefined) return deferred;
        return options.thoughts?.[id] ?? makeThought(id, id);
      },
    },
    properties: { get: async () => [] },
    types: { listTypeProperties: async () => [] },
    admin: { listUsers: async () => [] },
    networks: { listMembers: async () => [] },
  };
  return calls;
}

/** Даёт осесть асинхронным цепочкам редактора (render, сборка вкладок, reload). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Подпись активной вкладки (то, что реально показано в полосе вкладок). */
function activeTabTitle(scrollBox: ShimElement): string {
  const active = scrollBox
    .querySelectorAll('.editor-tab')
    .find((tab) => tab.classList.contains('active'));
  return active?.textContent ?? '';
}

/** Надпись заголовка открытой записи в нижней области вкладки «Дневник». */
function shownRecordTitle(scrollBox: ShimElement): string {
  return scrollBox.querySelector('.chrono-title-view')?.textContent ?? '';
}

async function mountThoughtEditor(thought: Thought): Promise<{
  editor: typeof import('../src/renderer/editor/editor.js');
  store: any;
  host: ShimElement;
  scrollBox: ShimElement;
}> {
  const editor = await import('../src/renderer/editor/editor.js');
  const { store } = await import('../src/renderer/state.js');
  store.update({
    networkId: NET,
    focus: makeFocus(thought),
    editorTarget: null,
    selectedLinkId: null,
    structuresActiveThoughtId: null,
    structuresActiveThought: null,
    collapsedGroups: {},
  } as any);
  const host = new ShimElement('div');
  editor.mountEditor(host as any);
  await flush();
  const scrollBox = host.children[1] as ShimElement;
  return { editor, store, host, scrollBox };
}

describe('программный вход «открыть привязку с записью» (задача 666d1d00)', () => {
  it('главный случай «привязка ≠ владелец»: открывает «Дневник» и показывает чужую запись', async () => {
    shimDom();
    installEtn();
    const { editor, scrollBox } = await mountThoughtEditor(makeThought('t1', 'T1'));
    const buildsBefore = editor.editorInternals.paneBuildCount('chrono');
    assert.equal(
      activeTabTitle(scrollBox),
      'Комментарий',
      'до входа показана вкладка по умолчанию',
    );

    // Запись c2 принадлежит HOME и привязана к t1 (m2m-цель) — главный случай.
    editor.openRecordInEditor('t1', 'c2');
    await flush();

    assert.equal(
      editor.editorInternals.paneBuildCount('chrono') - buildsBefore,
      1,
      'вкладка «Дневник» собрана РОВНО один раз (инвалидация до активации)',
    );
    assert.ok(activeTabTitle(scrollBox).startsWith('Дневник'), 'вкладка «Дневник» активирована');
    assert.ok(
      scrollBox.querySelector('.chrono-tab') !== null,
      'в хосте вкладок показана панель «Дневника»',
    );
    assert.equal(
      shownRecordTitle(scrollBox),
      'Чужая запись: февраль',
      'нижняя область наполнена ВЫБРАННОЙ записью (buildEditor), а не авто-выбором',
    );
    assert.match(
      scrollBox.querySelector('.chrono-meta-row')?.textContent ?? '',
      /Чужая запись: февраль/,
      'шапка записи показывает заголовок выбранной записи',
    );
  });

  it('повторный вход: другая запись меняет выбор, та же — идемпотентна', async () => {
    shimDom();
    installEtn();
    const { editor, scrollBox } = await mountThoughtEditor(makeThought('t1', 'T1'));

    editor.openRecordInEditor('t1', 'c2');
    await flush();
    assert.equal(shownRecordTitle(scrollBox), 'Чужая запись: февраль');

    // Другая запись ТОЙ ЖЕ мысли: оба молчаливых no-op openThoughtInEditor
    // обойдены, иначе выбор остался бы прежним.
    const buildsBeforeSecond = editor.editorInternals.paneBuildCount('chrono');
    editor.openRecordInEditor('t1', 'c1');
    await flush();
    assert.equal(
      shownRecordTitle(scrollBox),
      'Владелец: январь',
      'выбор сменился на другую запись',
    );
    assert.equal(
      editor.editorInternals.paneBuildCount('chrono') - buildsBeforeSecond,
      1,
      'повторный вход собирает панель один раз',
    );

    // Та же запись: результат идемпотентен (запись та же, показана та же).
    editor.openRecordInEditor('t1', 'c1');
    await flush();
    assert.equal(shownRecordTitle(scrollBox), 'Владелец: январь', 'повторный вход идемпотентен');
    assert.ok(activeTabTitle(scrollBox).startsWith('Дневник'));
  });

  it('активация вкладки не пишет предпочтение и не трогает фокус холста', async () => {
    shimDom();
    const calls = installEtn();
    const { editor, store, scrollBox } = await mountThoughtEditor(makeThought('t1', 'T1'));
    const focusBefore = store.state.focus;

    editor.openRecordInEditor('t1', 'c2');
    await flush();
    // Дебаунс записи предпочтения — 200 мс; ждём больше, чтобы поймать запись,
    // если бы вход шёл через `activateEditorTab`.
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.ok(activeTabTitle(scrollBox).startsWith('Дневник'));
    assert.deepEqual(
      calls.setState.filter((call) => call.key === UI_STATE_KEY.EDITOR_ACTIVE_TAB),
      [],
      'вход активирует вкладку каналом отображения, предпочтение L4 не пишется',
    );
    assert.strictEqual(store.state.focus, focusBefore, 'фокус холста вход не меняет');
  });

  it('пересборка панели при смене владельца выбор не повторяет и не протекает', async () => {
    shimDom();
    installEtn({ thoughts: { t2: makeThought('t2', 'T2') } });
    const { editor, scrollBox } = await mountThoughtEditor(makeThought('t1', 'T1'));

    editor.openRecordInEditor('t1', 'c2');
    await flush();
    assert.equal(shownRecordTitle(scrollBox), 'Чужая запись: февраль', 'pending применён');

    // Другая мысль того же вида: renderRetarget пересобирает показанную вкладку
    // «Дневник». Применённый pending повторно НЕ навязывается — вкладка делает
    // штатный авто-выбор верхней строки нового владельца.
    editor.openThoughtInEditor('t2');
    await flush();

    assert.equal(
      shownRecordTitle(scrollBox),
      'Запись t2: май',
      'пересборка панели сделала авто-выбор чужой мысли, а не повторила выбор прежней записи',
    );
    assert.ok(
      activeTabTitle(scrollBox).startsWith('Дневник'),
      'вкладка «Дневник» осталась показанной',
    );
  });

  it('запись отсутствует (stale) — тихий пропуск и штатный авто-выбор', async () => {
    shimDom();
    installEtn();
    const { editor, scrollBox } = await mountThoughtEditor(makeThought('t1', 'T1'));

    editor.openRecordInEditor('t1', 'c-removed');
    await flush();

    assert.ok(activeTabTitle(scrollBox).startsWith('Дневник'));
    assert.equal(
      shownRecordTitle(scrollBox),
      'Владелец: март',
      'несуществующая запись не выбирается: вкладка применила авто-выбор верхней строки',
    );
  });

  it('вход при незагруженной сущности: выбор применяется после доставки payload', async () => {
    shimDom();
    let release: (thought: Thought) => void = () => undefined;
    const delivered = new Promise<Thought>((resolve) => {
      release = resolve;
    });
    installEtn({ deferred: { t2: delivered } });
    const { editor, scrollBox } = await mountThoughtEditor(makeThought('t1', 'T1'));

    // Мысль t2 ещё не загружена: редактор удерживает прежнюю сущность
    // (error 253505a6), панель «Дневника» собирается по контексту-плейсхолдеру —
    // pending её сборка НЕ применяет.
    editor.openRecordInEditor('t2', 'c8');
    await flush();
    assert.notEqual(
      shownRecordTitle(scrollBox),
      'Запись t2: апрель',
      'до доставки сущности выбор по плейсхолдеру не применяется',
    );

    release(makeThought('t2', 'T2'));
    await flush();

    assert.ok(activeTabTitle(scrollBox).startsWith('Дневник'));
    assert.equal(
      shownRecordTitle(scrollBox),
      'Запись t2: апрель',
      'выбор применён сборкой из ЗАГРУЖЕННОГО контекста после доставки payload',
    );
  });

  it('смена владельца сбрасывает pending: выбор прежней мысли не протекает', async () => {
    shimDom();
    // Доставка t2 в этом тесте не наступает: pending обязан сброситься сменой
    // владельца раньше, чем сущность придёт.
    const neverDelivered = new Promise<Thought>(() => undefined);
    installEtn({ deferred: { t2: neverDelivered } });
    const { editor, store, scrollBox } = await mountThoughtEditor(makeThought('t1', 'T1'));

    // Выбор поставлен для t2, но её панель ещё не собрана из загруженного
    // контекста — pending живёт до применения.
    editor.openRecordInEditor('t2', 'c8');
    await flush();

    // Переход на другого владельца (t3) — pending обязан быть сброшен, а не
    // примениться чужому «Дневнику».
    store.update({
      editorTarget: { kind: 'thought', id: 't3', thought: makeThought('t3', 'T3') },
    } as any);
    await flush();

    // Возврат к t2 с загруженным payload: если бы pending протёк, вкладка
    // показала бы c8 (апрель); штатный авто-выбор даёт верхнюю строку — c9.
    store.update({ editorTarget: { kind: 'thought', id: 't2' } } as any);
    await flush();
    store.update({
      editorTarget: { kind: 'thought', id: 't2', thought: makeThought('t2', 'T2') },
    } as any);
    await flush();

    assert.equal(
      shownRecordTitle(scrollBox),
      'Запись t2: май',
      'pending сброшен сменой владельца: применён штатный авто-выбор, а не выбор прежней мысли',
    );
  });

  it('сборка панели по плейсхолдеру не съедает pending', async () => {
    shimDom();
    let release: (thought: Thought) => void = () => undefined;
    const delivered = new Promise<Thought>((resolve) => {
      release = resolve;
    });
    installEtn({ deferred: { t2: delivered } });
    const { editor, store, host } = await mountThoughtEditor(makeThought('t1', 'T1'));

    // Каркаса нет: редактор показывает пустую панель, следующий render соберёт
    // скелет ЗАНОВО — по контексту-плейсхолдеру открываемой мысли (payload ещё
    // не пришёл). Такая сборка «Дневника» выбор применять не должна: панель
    // пересоберётся доставкой сущности, и выбор применит уже она.
    store.update({ focus: null, editorTarget: null } as any);
    await flush();
    const scrollBox = host.children[1] as ShimElement;

    editor.openRecordInEditor('t2', 'c8');
    await flush();

    release(makeThought('t2', 'T2'));
    await flush();

    assert.equal(
      shownRecordTitle(scrollBox),
      'Запись t2: апрель',
      'выбор применён один раз — сборкой из загруженного контекста, а не плейсхолдером',
    );
  });

  it('неудачное открытие мысли снимает pending: следующий заход даёт авто-выбор (П2)', async () => {
    shimDom();
    // Проба П2 приёмки: `etn.thoughts.get('t2')` падает — вход не состоялся.
    installEtn({ failOnce: ['t2'] });
    const { editor, store, scrollBox } = await mountThoughtEditor(makeThought('t1', 'T1'));

    const targetBefore = store.state.editorTarget;
    editor.openRecordInEditor('t2', 'c8');
    await flush();

    // Неудачное открытие откатило цель к снимку — отложенный выбор записи t2
    // не должен нависнуть над каркасом.
    assert.strictEqual(store.state.editorTarget, targetBefore, 'цель откачена к снимку');

    // Штатный заход в «Дневник» той же мысли (payload приходит) — вкладка
    // обязана сделать авто-выбор верхней строки, а не применить зависший c8.
    editor.openThoughtInEditor('t2');
    await flush();

    assert.ok(activeTabTitle(scrollBox).startsWith('Дневник'));
    assert.equal(
      shownRecordTitle(scrollBox),
      'Запись t2: май',
      'зависший pending снят: показан штатный авто-выбор верхней строки, а не выбор неудавшегося входа',
    );
  });
});
