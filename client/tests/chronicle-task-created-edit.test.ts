/**
 * «Создать задачу на сегодня» → запись ОТКРЫВАЕТСЯ В ПРАВКЕ, и открытая правка
 * догоняет тело источника после чужой правки (0.16.1, пачка 4; блокер и
 * замечание вердикта `6df70910`).
 *
 * **Что проверяется — РЕАЛЬНЫЙ путь экрана.** `mountChronicle` поднимает ленту
 * ВМЕСТЕ с панелью «Задачи и напоминания»: создание идёт кликом по кнопке строки
 * напоминания через компоненту списка задач и экранные переходы
 * (`openCreatedTask` → `openChronicleTaskLine`), а не прямым вызовом действия
 * (как в `task-create-for-today.test.ts`).
 *
 * **Блокер (гонка).** Вход в правку сначала дочитывает тело записи
 * (`etn.comments.get`), а перечитывание ленты в это же окно пересобирало
 * карточку: тело отсоединялось и `ensureWidget` возвращал `null` — правка не
 * открывалась вовсе (в живом прогоне: выбор записи в 35 мс, пересборка в 49 мс).
 * Тест держит `etn.comments.get` и отпускает перечитывание ленты ровно тогда,
 * когда вход в правку уже ждёт тело, — гонка воспроизводится детерминированно.
 *
 * **Замечание (черновик).** «Отменить задачу» из панели меняет источник под
 * открытой правкой; поле не должно остаться со старым черновиком — иначе
 * сохранение вернёт отменённую строку.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { EditorView } from '@codemirror/view';
import { removeTaskLineMarker } from '@etn/markdown';

import { ShimElement } from './dom-shim.js';

type Dict = Record<string, any>;

const NET = '00000000-0000-4000-8000-0000000000e1';
const HOME = '44444444-4444-4444-8444-444444444444';
const SUBJECT = '11111111-1111-4111-8111-111111111111';
const REC = '33333333-3333-4333-8333-333333333333';

/* ------------------------------------------------------------------ *
 * Подставная сеть: одна дневная запись + одно напоминание
 * ------------------------------------------------------------------ */

interface FakeRecord {
  id: string;
  kind: 'chronological';
  title: string | null;
  body_md: string;
  body_html: string;
  version: number;
  valid_from: string;
  valid_to: string | null;
  use_time: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  targets: Array<{ owner_type: 'thought'; owner_id: string }>;
}

/** Состояние подставной сети на один тест. */
interface Net {
  record: FakeRecord;
  tasks: Array<Dict>;
  /** Тело входа в правку придержано до `release`. */
  getGate: Promise<void> | null;
  getCalled: boolean;
  /** Перечитывание ленты придержано до `releaseRefresh`. */
  refreshGate: Promise<void> | null;
  refreshCalls: number;
}

let net: Net;

const { localDayEnd, localDayStart, todayLocal } = await import('../src/renderer/lib/dates.js');
const { t } = await import('../src/renderer/lib/i18n.js');
const { markdownFieldValue } = await import('../src/renderer/editor/markdown-field.js');

/** Простейший markdown → HTML: тесту важен не рендер, а смена содержимого. */
function mdToHtml(md: string): string {
  return md
    .split('\n')
    .map((line) => `<p>${line.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</p>`)
    .join('');
}

/** Дневная запись на сегодня с заданным телом. */
function makeRecord(bodyMd: string): FakeRecord {
  const today = todayLocal();
  return {
    id: REC,
    kind: 'chronological',
    title: null,
    body_md: bodyMd,
    body_html: mdToHtml(bodyMd),
    version: 1,
    valid_from: localDayStart(today),
    valid_to: localDayEnd(today),
    use_time: false,
    created_at: `${today}T00:00:00.000Z`,
    updated_at: `${today}T00:00:00.000Z`,
    created_by: HOME,
    updated_by: HOME,
    targets: [{ owner_type: 'thought', owner_id: HOME }],
  };
}

/** Строка ленты из текущего состояния записи (привязки HOME в ленте скрыты). */
function feedRow(): Dict {
  return {
    id: net.record.id,
    title: net.record.title,
    valid_from: net.record.valid_from,
    valid_to: net.record.valid_to,
    use_time: net.record.use_time,
    version: net.record.version,
    created_at: net.record.created_at,
    updated_at: net.record.updated_at,
    created_by: net.record.created_by,
    updated_by: net.record.updated_by,
    snippet: (net.record.body_md.split('\n')[0] ?? '').replace(/^-\s*(\[[ xX]\]\s*)?/, ''),
    body_html: net.record.body_html,
    targets: [],
  };
}

/** Строка проекции задачи для панели (адрес — `comment_id` + `line_no`). */
function taskRow(lineNo: number): Dict {
  const today = todayLocal();
  return {
    comment_id: REC,
    line_no: lineNo,
    text: `Задача записи [[#${SUBJECT}]] [[${today}]]`,
    period_from: null,
    period_to: null,
    due: today,
    auto_period: false,
    done: false,
    subject_thoughts: [SUBJECT],
    subject_state: 'active',
    parent_task: null,
    subtask: false,
    revision: net.record.version,
    parsed_revision: net.record.version,
    owner_type: 'thought',
    owner_id: HOME,
    kind: 'chronological',
  };
}

/** Вхождение напоминания на сегодня по субъектной мысли. */
function reminderFixture(): Dict {
  const today = todayLocal();
  return {
    id: 'r-1',
    subject_type: 'thought',
    subject_id: SUBJECT,
    title: `Мысль ${SUBJECT}`,
    schedule: { type: 'once' },
    exceptions: {},
    state: 'active',
    occurrences: [{ occurrence_at: `${today}T09:00:00.000Z`, status: 'active', until: null }],
    created_at: `${today}T00:00:00.000Z`,
    updated_at: `${today}T00:00:00.000Z`,
  };
}

/** Мост `window.etn` для экрана «Дневник» и панели задач. */
function bridge(): Dict {
  return {
    ui: { getState: async () => null, setState: async () => undefined },
    tabs: { list: async () => [], updateState: async () => undefined, get: async () => null },
    propertyRegistry: { list: async () => [] },
    chronicle: {
      query: async () => {
        net.refreshCalls += 1;
        // Первое чтение (монтирование) отдаётся сразу; перечитывание после
        // создания держится до `releaseRefresh`, чтобы пересборка карточки
        // пришла ровно в окно входа в правку.
        if (net.refreshCalls > 1 && net.refreshGate !== null) await net.refreshGate;
        return { rows: [feedRow()], total: 1, warnings: null };
      },
      dayLinks: async () => ({ facts: [], links: [] }),
      calendarMarkers: async () => ({
        record_spans: [],
        task_days: [],
        task_day_counts: {},
        overdue_days: [],
        overdue_day_counts: {},
        fact_days: [],
        fact_day_counts: {},
      }),
    },
    chronicleFilters: {
      list: async () => [],
      create: async () => ({}),
      update: async () => ({}),
      remove: async () => undefined,
    },
    savedFilters: {
      list: async () => [],
      create: async () => ({}),
      update: async () => ({}),
      remove: async () => undefined,
    },
    structures: {
      query: async () => ({ items: [{ id: HOME }], total: 1, directions: {}, next_cursor: null }),
    },
    thoughts: {
      get: async (_networkId: string, id: string) => ({ id, title: `Мысль ${id}` }),
      resolve: async (_networkId: string, ids: string[]) =>
        ids.map((id) => ({ id, title: `Мысль ${id}`, exists: true })),
      batch: async () => [],
      create: async () => ({}),
    },
    publications: {
      get: async (_networkId: string, id: string) => ({ id, title: `Публикация ${id}` }),
    },
    comments: {
      list: async () => [{ ...net.record }],
      get: async () => {
        net.getCalled = true;
        if (net.getGate !== null) await net.getGate;
        return { ...net.record };
      },
      update: async (
        _networkId: string,
        _id: string,
        input: { body_md?: string; title?: string | null },
      ) => {
        const body = input.body_md ?? net.record.body_md;
        net.record = {
          ...net.record,
          body_md: body,
          body_html: mdToHtml(body),
          version: net.record.version + 1,
          updated_at: new Date().toISOString(),
        };
        return { ...net.record };
      },
      createMulti: async () => {
        throw new Error('дневная запись уже есть — создавать нечего');
      },
    },
    reminders: { list: async () => ({ reminders: [reminderFixture()], from: null, to: null }) },
    tasks: {
      list: async (_networkId: string, query: Dict) => ({
        // Строки отдаём только открытым срезом периода: остальные секции пусты.
        items: query.scope === 'open' ? net.tasks.map((row) => ({ ...row })) : [],
        nested: [],
        max_revision: net.record.version,
      }),
      patch: async (_networkId: string, input: Dict) => {
        const ops = (input.ops ?? []) as Array<Dict>;
        for (const op of ops) {
          const lines = net.record.body_md.split('\n');
          const line = lines[Number(op.line_no)] ?? '';
          lines[Number(op.line_no)] =
            op.action === 'cancel' ? (removeTaskLineMarker(line) ?? line) : line;
          const body = lines.join('\n');
          net.record = {
            ...net.record,
            body_md: body,
            body_html: mdToHtml(body),
            version: net.record.version + 1,
          };
        }
        // Отменённая строка перестала быть задачей — проекция её больше не отдаёт.
        net.tasks = [];
        return {
          results: ops.map((op) => ({
            comment_id: op.comment_id,
            line_no: op.line_no,
            ok: true,
          })),
          revisions: ops.map((op) => ({ id: op.comment_id, version: net.record.version })),
        };
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * DOM-шим: достаточно для экрана, ленты и поля markdown (CM6)
 * ------------------------------------------------------------------ */

function installShims(): void {
  const body = new ShimElement('body');
  // CM6 проверяет прокрутку через `elt instanceof Window` и читает `navigator`:
  // в Node этих глобалов нет, без них измерение поля падает на входе в правку.
  (globalThis as Dict).Window = class Window {};
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node', platform: 'node' },
    configurable: true,
  });
  (globalThis as Dict).HTMLElement = ShimElement;
  (globalThis as Dict).getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px' });
  const doc: Dict = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    documentElement: new ShimElement('html'),
    head: new ShimElement('head'),
    body,
    adoptedStyleSheets: [],
    activeElement: null,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    dispatchEvent: (): boolean => true,
    querySelector: (): null => null,
    querySelectorAll: (): [] => [],
    contains: (node: unknown) => body.contains(node as ShimElement | null),
    getSelection: () => null,
    hasFocus: () => false,
    createRange: () => ({
      setStart: (): void => undefined,
      setEnd: (): void => undefined,
      getClientRects: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    }),
  };
  (globalThis as Dict).document = doc;
  (ShimElement.prototype as any).ownerDocument = doc;
  (ShimElement.prototype as any).getSelection = () => null;
  (globalThis as Dict).MutationObserver = class {
    observe(): void {
      /* в шиме наблюдать нечего */
    }
    disconnect(): void {
      /* в шиме наблюдать нечего */
    }
    takeRecords(): unknown[] {
      return [];
    }
  };
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
  const ls = new Map<string, string>();
  (globalThis as Dict).localStorage = {
    getItem: (key: string) => ls.get(key) ?? null,
    setItem: (key: string, value: string) => void ls.set(key, value),
    removeItem: (key: string) => void ls.delete(key),
    clear: () => ls.clear(),
    key: (index: number) => [...ls.keys()][index] ?? null,
    get length() {
      return ls.size;
    },
  };
  const win = ((globalThis as Dict).window ??= {}) as Dict;
  win.innerWidth = 1400;
  win.innerHeight = 900;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.setInterval = setInterval;
  win.clearInterval = clearInterval;
  // Кадры в шиме не исполняются: измерение CM6 требует настоящей геометрии
  // (как в `chronicle-record-edit-pair.test.ts`). Состояние и каретка от этого
  // не зависят — их читают из `EditorView.state`.
  win.requestAnimationFrame = (): number => 1;
  win.cancelAnimationFrame = (): void => undefined;
  win.addEventListener = (): void => undefined;
  win.removeEventListener = (): void => undefined;
  win.dispatchEvent = (): boolean => true;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  });
  win.getSelection = () => null;
  win.localStorage = (globalThis as Dict).localStorage;
  // Компьютед-стили нужны CM6 при измерении: свойств в шиме нет — отдаём пустые.
  const computedStyle = new Proxy(
    { getPropertyValue: () => '', getPropertyPriority: () => '' },
    { get: (target: Dict, prop: string) => (prop in target ? target[prop] : '') },
  );
  win.getComputedStyle = () => computedStyle;
  doc.getComputedStyle = () => computedStyle;
  (globalThis as Dict).getComputedStyle = () => computedStyle;
  doc.defaultView = win;
  win.document = doc;
}

/** Дождаться сетевых продолжений экрана, панели и поля. */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Ждать условие по-настоящему: перечитывание ленты по realtime-событию отложено
 * окном дебаунса (`CHRONICLE_REFRESH_WINDOW_MS` = 250 мс), поэтому проверка
 * крутится на реальных таймерах, а не на одних микрозадачах.
 */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`не дождались: ${what}`);
}

/** Управляемый «замок» промиса. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

installShims();

const stateMod = await import('../src/renderer/state.js');
const chronicleMod = await import('../src/renderer/screens/chronicle/chronicle.js');
const filterPanelMod = await import('../src/renderer/screens/chronicle/filter-panel.js');
const eventRouterMod = await import('../src/renderer/lib/live/event-router.js');

let mounted: (() => void) | null = null;
let host: ShimElement;

/** Смонтировать «Дневник» на сегодняшней ленте. */
async function mountDiary(): Promise<ShimElement> {
  stateMod.store.update({
    networkId: NET,
    network: null,
    activeView: 'chronicle',
    screen: 'workspace',
    tabs: [{ tab_id: 'tab-1', network_id: NET, chronicle_state: null }],
    activeTabId: 'tab-1',
    rtStatusByNetwork: { [NET]: 'connected' },
  } as any);
  host = new ShimElement('div');
  host.isConnected = true;
  mounted = chronicleMod.mountChronicle(host as unknown as HTMLElement);
  await chronicleMod.ensureChronicleInitialised();
  await flush();
  return host;
}

/** Карточка дневной записи в ленте. */
function card(): ShimElement | null {
  return host.querySelector(
    `.diary-record[data-row-key="${REC}"]`,
  ) as unknown as ShimElement | null;
}

/** Тело карточки — узел, который пересборка карточки заменяет. */
function cardBody(): ShimElement | null {
  return card()?.querySelector('.diary-record-body') as unknown as ShimElement | null;
}

/** Открыта ли правка тела записи. */
function editing(): boolean {
  return card()?.querySelector('.md-field--editing') !== null;
}

/** Поле markdown открытой правки (корень компоненты). */
function fieldRoot(): ShimElement | null {
  return card()?.querySelector('.md-field') as unknown as ShimElement | null;
}

/** Номер строки, на которой стоит каретка правки (с нуля). */
function caretLine(): number | null {
  const content = fieldRoot()?.querySelector('.cm-content') as unknown as ShimElement | null;
  if (content === null || content === undefined) return null;
  const view = EditorView.findFromDOM(content as unknown as HTMLElement);
  if (view === null) return null;
  return view.state.doc.lineAt(view.state.selection.main.head).number - 1;
}

/** «Создать задачу на сегодня» у строки напоминания панели. */
function clickCreateTask(): void {
  const button = host.querySelector('.ui-reminder-create-task') as unknown as ShimElement | null;
  assert.ok(button, 'кнопка «Создать задачу на сегодня» в панели');
  button!.emit('click', {
    target: button,
    currentTarget: button,
    preventDefault: (): void => undefined,
    stopPropagation: (): void => undefined,
  });
}

/** «Отменить задачу» строки панели: меню «⋮» → команда строки. */
async function clickCancelTask(): Promise<void> {
  const row = host.querySelector('.ui-task-row') as unknown as ShimElement | null;
  assert.ok(row, 'строка задачи в панели');
  const menu = row!.querySelector('.ui-task-row-menu') as unknown as ShimElement;
  menu.emit('click', {
    target: menu,
    currentTarget: menu,
    preventDefault: (): void => undefined,
    stopPropagation: (): void => undefined,
  });
  const body = (globalThis as Dict).document.body as ShimElement;
  const item = body
    .querySelectorAll('.menu-item')
    .find((node) => node.flatText().includes(t('tasks.cancelRow')));
  assert.ok(item, 'команда «Отменить задачу» в меню строки');
  item!.click();
  await flush();
}

beforeEach(() => {
  net = {
    record: makeRecord('Заметка дня\n- второй пункт'),
    tasks: [],
    getGate: null,
    getCalled: false,
    refreshGate: null,
    refreshCalls: 0,
  };
  (globalThis as Dict).etn = bridge();
  const win = (globalThis as Dict).window as Dict;
  win.etn = (globalThis as Dict).etn;
  eventRouterMod.resetEventRouter();
});

afterEach(() => {
  if (mounted !== null) {
    mounted();
    mounted = null;
  }
  filterPanelMod.unmountChronicleFilterPanel();
});

describe('«Создать задачу на сегодня»: запись открывается в правке (блокер 6df70910)', () => {
  it('пересборка карточки во время дочитывания тела не отменяет вход в правку', async () => {
    const bodyGate = gate();
    const refreshGate = gate();
    net.getGate = bodyGate.promise;
    net.refreshGate = refreshGate.promise;
    await mountDiary();
    // Панель поднялась: строка напоминания и лента на месте.
    await waitFor(
      () => host.querySelector('.ui-reminder-create-task') !== null,
      'строка напоминания в панели',
    );
    assert.ok(card() !== null, 'запись дня в ленте');
    const bodyBefore = cardBody();
    assert.ok(bodyBefore !== null, 'тело карточки собрано');

    clickCreateTask();
    // Панель дописала строку, экран ушёл в переход: вход в правку уже ждёт тело.
    await waitFor(() => net.getCalled, 'дочитывание тела записи на входе в правку');
    // Перечитывание ленты приходит ПОСЛЕ начала входа — как в живом прогоне.
    refreshGate.release();
    await flush();
    assert.equal(
      bodyBefore!.isConnected,
      true,
      'тело карточки не отсоединено пересборкой (вход в правку в полёте)',
    );
    assert.equal(editing(), false, 'правки ещё нет: поле ждёт тело');

    bodyGate.release();
    await waitFor(() => editing(), 'правка тела записи открылась');

    assert.equal(
      cardBody(),
      bodyBefore,
      'после входа правка живёт в том же узле тела — карточку не пересобирали',
    );
    assert.deepEqual(
      net.record.body_md.split('\n'),
      ['Заметка дня', '- второй пункт', `- [ ] [[#${SUBJECT}]] [[${todayLocal()}]]`],
      'задача дописана строкой в дневную запись',
    );
    assert.equal(caretLine(), 2, 'каретка в строке созданной задачи (line_no = 2)');
  });

  it('без гонки (перечитывание уже позади) правка тоже открывается', async () => {
    await mountDiary();
    await waitFor(
      () => host.querySelector('.ui-reminder-create-task') !== null,
      'строка напоминания в панели',
    );
    clickCreateTask();
    await waitFor(() => editing(), 'правка тела записи открылась');
    assert.equal(caretLine(), 2, 'каретка в строке созданной задачи');
  });
});

describe('открытая правка догоняет тело источника (замечание 6df70910)', () => {
  it('«Отменить задачу» из панели обновляет черновик открытой правки', async () => {
    const today = todayLocal();
    net.record = makeRecord(`- [ ] Задача записи [[#${SUBJECT}]] [[${today}]]`);
    net.tasks = [taskRow(0)];
    await mountDiary();
    await waitFor(() => host.querySelector('.ui-task-row') !== null, 'строка задачи в панели');

    await chronicleMod.openChronicleTaskLine({ commentId: REC, lineNo: 0 });
    await waitFor(() => editing(), 'правка тела открыта');
    assert.equal(
      markdownFieldValue(fieldRoot() as unknown as HTMLElement),
      `- [ ] Задача записи [[#${SUBJECT}]] [[${today}]]`,
      'в поле — тело записи с маркером задачи',
    );

    await clickCancelTask();
    // Источник уже переписан — сервер рассылает `comment.updated`, и экран
    // перечитывает ленту по событию. В живом прогоне путь тот же; здесь событие
    // поднимается вручную: подставной сети рассылать некому.
    await waitFor(
      () => net.record.body_md === `- Задача записи [[#${SUBJECT}]] [[${today}]]`,
      'источник обновился после отмены задачи',
    );
    eventRouterMod.routeRealtimeEvent({
      type: 'comment.updated',
      network_id: NET,
      seq: 1,
      data: {
        id: REC,
        kind: 'chronological',
        version: net.record.version,
        changes: { body_md: net.record.body_md, body_html: net.record.body_html },
      },
    } as any);
    await waitFor(
      () =>
        markdownFieldValue(fieldRoot() as unknown as HTMLElement) ===
        `- Задача записи [[#${SUBJECT}]] [[${today}]]`,
      'черновик правки догнал отменённую строку',
    );
    assert.equal(
      net.record.body_md,
      `- Задача записи [[#${SUBJECT}]] [[${today}]]`,
      'в источнике строка без маркера задачи',
    );
    assert.equal(editing(), true, 'правка осталась открытой');
  });
});
