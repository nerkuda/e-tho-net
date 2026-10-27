/**
 * Меню мысли ВНЕ холста: «Добавить → налево (родственник)» создаёт соседа под
 * родителем КЛИКНУТОЙ мысли, а не мысли в фокусе карты (ошибка 2baa78fb).
 *
 * Дефект: конструктор меню (`canvas/context-menu.ts`) при отсутствии
 * `target.siblingParentId` берёт `focus.parents[0].id`. Места вне холста обязаны
 * передать родителя явно — резолв `resolveSiblingParentId` ДО открытия меню и
 * сверка сети ПОСЛЕ ответа (класс a3151e33). Проверка поведенческая: реальный
 * экран поднимается на DOM-шиме (`./dom-shim.js`), правый клик по чипу мысли M
 * (ребёнок P2) при фокусе T (ребёнок P1) открывает меню, клик по «налево»
 * доходит до `etn.thoughts.create` с `create_link.target_thought_id = P2`.
 *
 * Покрытие по местам:
 *  - полоса истории: чип полосы и строка overflow-дропдауна
 *    (`wireHistoryContextMenu`) — `screens/history-bar.ts`;
 *  - лента «Дневника» — `screens/chronicle/chronicle.ts`;
 *  - панель использования — `screens/usage-panel.ts`, плюс гонка: смена сети
 *    во время ленивого импорта/резолва не открывает меню;
 *  - дерево «Структур» — экран целиком монтируется на DOM-шиме
 *    (`mountStructures`, как в `structures-network-snapshot-race.test.ts`).
 *
 * Мутации, краснящие кейсы: вернуть в месте прямой `showThoughtContextMenu`
 * без `siblingParentId` (чип истории, строка дропдауна, дерево «Структур»,
 * панель использования) — создание уходит под P1; убрать в `usage-panel`
 * сверку сети после `await import` — меню открывается для мысли прежней сети;
 * убрать сверку сети в общем фасаде — поздний ответ родителя открывает меню.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

type Dict = Record<string, unknown>;

const NET_A = '00000000-0000-4000-8000-0000000000a1';
const NET_B = '00000000-0000-4000-8000-0000000000b2';
/** Мысль в фокусе карты — ребёнок P1. */
const FOCUS_ID = '00000000-0000-4000-8000-0000000000f1';
const FOCUS_PARENT = '00000000-0000-4000-8000-0000000000f2';
/** Кликнутая мысль — ребёнок P2. */
const CLICKED_ID = '00000000-0000-4000-8000-0000000000c1';
const CLICKED_PARENT = '00000000-0000-4000-8000-0000000000c2';
/** Ещё одна запись истории: держит чип M в overflow-дропдауне. */
const OTHER_ID = '00000000-0000-4000-8000-0000000000d1';

/** Полная форма мысли для дерева «Структур» (refs экрана — из ответа query). */
const CLICKED_REF = {
  id: CLICKED_ID,
  title: 'Меншн',
  active: true,
  type_id: null,
  icon: null,
  icon_kind: 'emoji',
  icon_attachment_id: null,
  marked_for_deletion: false,
  fg_color: null,
  bg_color: null,
  font_bold: null,
  font_italic: null,
  font_underline: null,
  font_strike: null,
};

/** Журнал кейсов: у кого просили родителя и с какими аргументами создавали. */
interface Calls {
  neighbors: Array<{ networkId: string; id: string }>;
  creates: Array<{ networkId: string; input: any }>;
}

const calls: Calls = { neighbors: [], creates: [] };

/** Задержка ответа `neighbors` для гонок (сеть/поздний ответ). */
let holdNeighbors: Promise<void> | null = null;
/** Отпустить отложенный ответ. */
let releaseNeighbors: (() => void) | null = null;
/** Что вернуть `neighbors` в сети B (родитель «чужой» сети). */
let parentsInB: string[] = [];

function shimDom(): void {
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
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  win.localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
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
  (globalThis as Dict).requestAnimationFrame = win.requestAnimationFrame;
  (globalThis as Dict).localStorage = win.localStorage;
}

/** Записи истории текущего кейса: по умолчанию один чип M. */
let historyIds: string[] = [CLICKED_ID];

/** Результаты отбора «Структур»; по умолчанию HOME (его же ищет дневник). */
let structuresItems: Dict[] = [{ id: 'home-root' }];

/** Фальшивый мост: ровно те чтения, что трогают четыре экрана и диалог «Добавить». */
const bridge: Dict = {
  ui: {
    getState: async () => null,
    setState: async () => undefined,
  },
  networks: {
    list: async () => [{ id: NET_A }, { id: NET_B }],
  },
  propertyRegistry: {
    list: async () => [],
  },
  tabs: {
    list: async () => [],
    updateState: async () => undefined,
  },
  history: {
    list: async () => historyIds.map((thoughtId) => ({ thoughtId, visitedAt: '' })),
  },
  chronicle: {
    query: async () => ({ rows: [], total: 0, warnings: null }),
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
    query: async () => ({
      items: structuresItems,
      total: structuresItems.length,
      directions: {},
      next_cursor: null,
    }),
    hierarchy: async () => ({ neighbors: [], has_more: false }),
    edges: async () => [],
  },
  thoughts: {
    get: async (_networkId: string, id: string) => ({
      id,
      title: `t-${id}`,
      active: true,
      marked_for_deletion: false,
    }),
    resolve: async (_networkId: string, ids: string[]) =>
      ids.map((id) => ({
        id,
        title: id === CLICKED_ID ? 'Меншн' : `t-${id}`,
        active: true,
        marked_for_deletion: false,
      })),
    neighbors: async (networkId: string, id: string) => {
      calls.neighbors.push({ networkId, id });
      if (holdNeighbors !== null) await holdNeighbors;
      if (networkId === NET_B) return parentsInB.map((parentId) => ({ id: parentId }));
      return [{ id: id === CLICKED_ID ? CLICKED_PARENT : FOCUS_PARENT }];
    },
    create: async (networkId: string, input: any) => {
      calls.creates.push({ networkId, input });
      return { id: 'created-thought' };
    },
    findDuplicates: async () => [],
    findDuplicatesAcrossNetworks: async () => ({ hits: [], networks: { networks: [] } }),
    usage: async () => ({
      total: 1,
      groups: [
        {
          property_id: 'prop-1',
          key: 'автор',
          thoughts: [
            {
              id: CLICKED_ID,
              title: 'Меншн',
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
            },
          ],
        },
      ],
      holding_layers: [],
    }),
    deletionCheck: async (_networkId: string, ids: string[]) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          { blocked: false, blocking: { layers: [] }, orphaned_children: 0 },
        ]),
      ),
  },
  links: {
    deletionCheck: async () => ({}),
    get: async () => ({ id: 'link', marked_for_deletion: false }),
  },
};

shimDom();
const win = (globalThis as Dict).window as Dict;
win.etn = bridge;

const stateMod = await import('../src/renderer/state.js');
const historyMod = await import('../src/renderer/screens/history-bar.js');
const chronicleMod = await import('../src/renderer/screens/chronicle/chronicle.js');
const usageMod = await import('../src/renderer/screens/usage-panel.js');
const structuresMod = await import('../src/renderer/screens/structures/structures.js');

/** Дождаться асинхронных чтений/продолжений экрана и диалога. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Смонтированное состояние между кейсами снимается первым делом. */
let teardown: (() => void) | null = null;

afterEach(() => {
  if (teardown !== null) {
    teardown();
    teardown = null;
  }
  calls.neighbors = [];
  calls.creates = [];
  holdNeighbors = null;
  releaseNeighbors = null;
  parentsInB = [];
  historyIds = [CLICKED_ID];
  structuresItems = [{ id: 'home-root' }];
  stateMod.store.update({ networkId: null, focus: null } as any);
  const body = (globalThis as Dict).document as { body: ShimElement };
  body.body.replaceChildren();
});

/** Общее состояние стора: сеть A, фокус T (ребёнок P1). */
function installStore(focus: unknown): void {
  stateMod.store.update({
    profileId: 'profile-1',
    networkId: NET_A,
    network: null,
    activeTabId: 'tab-A',
    tabs: [{ tab_id: 'tab-A', network_id: NET_A }],
    activeView: 'map',
    screen: 'workspace',
    editorTarget: null,
    focus,
    showInactive: false,
    showTrash: true,
    rtStatusByNetwork: { [NET_A]: 'connected' },
  } as any);
}

/** Ответ фокуса: T в фокусе, его родитель — P1. */
function focusOnT(): unknown {
  return {
    focused: { id: FOCUS_ID, title: 'Фокус' },
    parents: [{ id: FOCUS_PARENT, title: 'Родитель Фокуса' }],
    children: [],
    siblings: [],
    edges: [],
    sorts: {
      parents: { sort: 'alpha', order: 'asc' },
      children: { sort: 'alpha', order: 'asc' },
      siblings: { sort: 'alpha', order: 'asc' },
    },
  };
}

/** Все строки меню, открытого над документом (меню порталится в `body`). */
function menuRows(): ShimElement[] {
  const body = (globalThis as Dict).document as { body: ShimElement };
  return body.body.findAll('menu-item');
}

/** Строка меню по началу подписи. */
function rowByLabel(prefix: string): ShimElement | undefined {
  return menuRows().find((row) => (row.textContent ?? '').trim().startsWith(prefix));
}

/** Клик «Добавить → налево (родственник)» в открытом меню. */
function clickAddSibling(): void {
  const add = rowByLabel('Добавить');
  assert.ok(add !== undefined, 'в меню есть подменю «Добавить»');
  add.emit('mouseenter');
  const body = (globalThis as Dict).document as { body: ShimElement };
  const sub = body.body.findAll('menu-sub')[0];
  assert.ok(sub !== undefined, 'подменю «Добавить» построено');
  const sibling = sub.findAll('menu-item').find((row) => (row.textContent ?? '').includes('налево'));
  assert.ok(sibling !== undefined, 'в подменю есть «налево (родственник)»');
  assert.equal(sibling.classList.contains('menu-item-disabled'), false, '«налево» активна');
  sibling.click();
}

/** Подтвердить диалог «Добавить» вводом имени: создаёт новую мысль. */
async function confirmCreate(title: string): Promise<void> {
  await flush();
  const body = (globalThis as Dict).document as { body: ShimElement };
  const backdrop = body.body.children.find((node) => node.className === 'dialog-backdrop');
  assert.ok(backdrop !== undefined, 'диалог «Добавить» открылся');
  const box = backdrop.children[0];
  assert.ok(box !== undefined, 'тело диалога построено');
  const input = box.querySelector('textarea');
  assert.ok(input !== null, 'поле имени в диалоге есть');
  input!.value = title;
  input!.emit('input', {});
  const primary = box.querySelector('.ui-btn--primary');
  assert.ok(primary !== null, 'кнопка подтверждения в диалоге есть');
  primary!.click();
  await flush();
}

/** Родитель, под которым создана новая мысль (`create_link.target_thought_id`). */
function createdParent(): string | null {
  assert.equal(calls.creates.length, 1, 'мысль создана ровно один раз');
  return calls.creates[0]!.input?.create_link?.target_thought_id ?? null;
}

/** Смонтировать полосу истории с чипом M и открыть его меню. */
async function openHistoryMenu(): Promise<{ host: ShimElement; body: ShimElement }> {
  installStore(focusOnT());
  const host = new ShimElement('div', 'history-bar');
  teardown = historyMod.mountHistoryBar(host as unknown as HTMLElement);
  await flush();
  const chip = host.findAll('history-cloud')[0];
  assert.ok(chip !== undefined, 'чип истории M отрисован');
  chip.dispatchContextMenu();
  await flush();
  const body = (globalThis as Dict).document as { body: ShimElement };
  return { host, body: body.body };
}

/** Смонтировать полосу истории и открыть её overflow-дропдаун на мысли M. */
async function openHistoryDropdownMenu(): Promise<{ host: ShimElement; body: ShimElement }> {
  // Фокус T исключается из истории как «текущая» мысль; M остаётся в хвосте,
  // который при узкой полосе уходит в кнопку «Остальная история».
  historyIds = [FOCUS_ID, OTHER_ID, CLICKED_ID];
  installStore(focusOnT());
  const host = new ShimElement('div', 'history-bar');
  // Раскладки в шиме нет: ширина полосы и natural-ширины чипов (rect 100)
  // оставляют первый чип на полосе, а M — в дропдауне.
  (host as unknown as { clientWidth: number }).clientWidth = 220;
  teardown = historyMod.mountHistoryBar(host as unknown as HTMLElement);
  await flush();
  const more = host.querySelector('.history-more');
  assert.ok(more !== null, 'часть истории ушла в overflow-дропдаун');
  more!.click();
  await flush();
  const body = (globalThis as Dict).document as { body: ShimElement };
  const row = body.body.findAll('menu-item').find((el) => el.dataset['dragId'] === CLICKED_ID);
  assert.ok(row !== undefined, 'строка мысли M есть в дропдауне истории');
  row!.dispatchContextMenu();
  await flush();
  return { host, body: body.body };
}

/** Смонтировать дерево «Структур» с мыслью M в результатах отбора. */
async function openStructuresMenu(): Promise<ShimElement> {
  structuresItems = [CLICKED_REF];
  installStore(focusOnT());
  stateMod.store.update({ activeView: 'structures' } as any);
  const host = new ShimElement('div', 'structures');
  teardown = structuresMod.mountStructures(host as unknown as HTMLElement);
  await flush();
  const cloud = host.findAll('st-cloud').find((el) => el.dataset['id'] === CLICKED_ID);
  assert.ok(cloud !== undefined, 'облачко мысли M отрисовано в дереве');
  cloud!.dispatchContextMenu();
  await flush();
  return host;
}

/** Смонтировать «Дневник» с записью, у которой есть чип мысли M. */
async function openChronicleMenu(): Promise<{ host: ShimElement; body: ShimElement }> {
  const row = {
    id: 'row-1',
    title: null,
    valid_from: '2026-10-27T10:00:00.000Z',
    valid_to: '2026-10-27T10:00:00.000Z',
    use_time: false,
    version: 1,
    created_at: '2026-10-27T10:00:00.000Z',
    updated_at: '2026-10-27T10:00:00.000Z',
    created_by: 'user-1',
    updated_by: 'user-1',
    snippet: 'Запись с упоминанием',
    body_html: '',
    targets: [
      {
        kind: 'thought',
        thought: {
          id: CLICKED_ID,
          title: 'Меншн',
          icon: null,
          fg_color: null,
          bg_color: null,
        },
      },
    ],
  };
  (bridge.chronicle as Dict).query = async () => ({ rows: [row], total: 1, warnings: null });
  installStore(focusOnT());
  stateMod.store.update({ activeView: 'chronicle' } as any);
  const host = new ShimElement('div');
  teardown = chronicleMod.mountChronicle(host as unknown as HTMLElement);
  await chronicleMod.ensureChronicleInitialised();
  await flush();
  const chip = host.findAll('diary-chip')[0];
  assert.ok(chip !== undefined, 'чип мысли записи отрисован');
  chip.dispatchContextMenu();
  await flush();
  const body = (globalThis as Dict).document as { body: ShimElement };
  return { host, body: body.body };
}

/** Смонтировать экранную панель использования и открыть её для цели. */
async function mountUsage(): Promise<ShimElement> {
  installStore(focusOnT());
  const host = new ShimElement('div', 'usage-panel');
  const resizer = new ShimElement('div', 'usage-resizer');
  teardown = usageMod.mountUsagePanel(
    host as unknown as HTMLElement,
    resizer as unknown as HTMLElement,
  );
  usageMod.openUsagePanel({ kind: 'thought', id: 'target-thought', title: 'Цель' });
  await flush();
  return host;
}

describe('меню вне холста: «налево» создаёт под родителем кликнутой мысли (2baa78fb)', () => {
  it('чип полосы истории: клик по M (ребёнок P2) при фокусе T (ребёнок P1)', async () => {
    await openHistoryMenu();
    assert.deepEqual(
      calls.neighbors,
      [{ networkId: NET_A, id: CLICKED_ID }],
      'родитель запрошен у САМОЙ кликнутой мысли',
    );
    clickAddSibling();
    await confirmCreate('Исторический Сосед');
    assert.equal(createdParent(), CLICKED_PARENT, 'сосед создан под P2, а не под родителем фокуса');
  });

  it('строка overflow-дропдауна истории: клик по M (ребёнок P2) при фокусе T (ребёнок P1)', async () => {
    await openHistoryDropdownMenu();
    assert.deepEqual(
      calls.neighbors,
      [{ networkId: NET_A, id: CLICKED_ID }],
      'родитель запрошен у САМОЙ кликнутой мысли',
    );
    clickAddSibling();
    await confirmCreate('Сосед Дропдауна');
    assert.equal(createdParent(), CLICKED_PARENT, 'сосед создан под P2, а не под родителем фокуса');
  });

  it('чип ленты «Дневника»: клик по M (ребёнок P2) при фокусе T (ребёнок P1)', async () => {
    await openChronicleMenu();
    assert.deepEqual(
      calls.neighbors,
      [{ networkId: NET_A, id: CLICKED_ID }],
      'родитель запрошен у САМОЙ кликнутой мысли',
    );
    clickAddSibling();
    await confirmCreate('Дневниковый Сосед');
    assert.equal(createdParent(), CLICKED_PARENT, 'сосед создан под P2, а не под родителем фокуса');
  });

  it('панель использования: строка M (ребёнок P2) при фокусе T (ребёнок P1)', async () => {
    const host = await mountUsage();
    const cloud = host.findAll('prop-ref-cloud')[0];
    assert.ok(cloud !== undefined, 'облачко строки использования отрисовано');
    cloud.dispatchContextMenu();
    await flush();
    assert.deepEqual(
      calls.neighbors,
      [{ networkId: NET_A, id: CLICKED_ID }],
      'родитель запрошен у САМОЙ кликнутой мысли',
    );
    clickAddSibling();
    await confirmCreate('Использованный Сосед');
    assert.equal(createdParent(), CLICKED_PARENT, 'сосед создан под P2, а не под родителем фокуса');
  });

  it('панель использования: смена сети во время ленивого импорта не открывает меню', async () => {
    const host = await mountUsage();
    const cloud = host.findAll('prop-ref-cloud')[0];
    assert.ok(cloud !== undefined, 'облачко строки использования отрисовано');
    parentsInB = ['parent-in-B'];
    // Меню строки подключает фасад лениво: смена сети в этом окне не должна
    // привести к меню мысли прежней сети (сверка после `await import`).
    cloud.dispatchContextMenu();
    stateMod.store.update({ networkId: NET_B } as any);
    await flush();
    assert.equal(calls.neighbors.length, 0, 'родитель не запрашивался в чужой сети');
    assert.equal(menuRows().length, 0, 'меню для мысли прежней сети не открылось');
  });

  it('панель использования: поздний ответ родителя прежней сети не открывает меню', async () => {
    const host = await mountUsage();
    const cloud = host.findAll('prop-ref-cloud')[0];
    assert.ok(cloud !== undefined, 'облачко строки использования отрисовано');
    // Удерживаем ответ родителя: резолв начался в сети A, ответ придёт после
    // смены сети на B — меню открывать нельзя (класс a3151e33).
    holdNeighbors = new Promise<void>((resolve) => {
      releaseNeighbors = resolve;
    });
    cloud.dispatchContextMenu();
    await flush();
    assert.equal(calls.neighbors.length, 1, 'резолв родителя начался в сети A');
    stateMod.store.update({ networkId: NET_B } as any);
    parentsInB = ['parent-in-B'];
    releaseNeighbors?.();
    await flush();
    assert.equal(menuRows().length, 0, 'поздний ответ прежней сети не открыл меню');
  });

  it('дерево «Структур»: клик по M (ребёнок P2) при фокусе T (ребёнок P1)', async () => {
    await openStructuresMenu();
    assert.deepEqual(
      calls.neighbors,
      [{ networkId: NET_A, id: CLICKED_ID }],
      'родитель запрошен у САМОЙ кликнутой мысли',
    );
    clickAddSibling();
    await confirmCreate('Сосед Структур');
    assert.equal(createdParent(), CLICKED_PARENT, 'сосед создан под P2, а не под родителем фокуса');
  });
});
