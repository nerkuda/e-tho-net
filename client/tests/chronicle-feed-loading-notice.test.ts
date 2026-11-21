/**
 * «Дневник»: индикатор долгой перезагрузки ленты в статус-строке (0.16.1,
 * пачка 10, задача a33b5fc7).
 *
 * Решение пользователя: индикатор долгой загрузки — в СУЩЕСТВУЮЩЕЙ статус-строке
 * внизу окна (`.statusbar .sb-message`, канал notice), не новая полоса. Анимацию
 * ленты не делаем (закрыто).
 *
 * Контракты:
 *   • перечитывание при уже показанном содержимом: «Загрузка…» появляется в
 *     статус-строке только если ответ не пришёл за {@link FEED_LOADING_NOTICE_DELAY_MS};
 *   • быстрый ответ не показывает ничего (нет мелькания);
 *   • по завершении гасится ТОЛЬКО своё сообщение — чужой notice не затирается;
 *   • чужое сообщение, появившееся до срабатывания задержки, не перебивается;
 *   • первая загрузка (лента пуста) — «Загрузка…» в области ленты, статус-бар
 *     её не дублирует; ошибка перечитывания идёт прежним путём.
 *
 * Экран монтируется целиком на DOM-шиме (как `chronicle-period-switch.test.ts`);
 * зона статусной строки подключается общим фасадом `lib/status-message`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

type Dict = Record<string, unknown>;

const NET = '00000000-0000-4000-8000-0000000000e3';

/** Строки фейковой ленты (меняются тестом). */
let feedRows: any[] = [];
/** Придержанный ответ ленты: пока не released, запрос не завершается. */
let queryHold: { promise: Promise<void>; release: () => void } | null = null;
/** Журнал запросов ленты. */
const queries: any[] = [];

function installShims(bridge: Dict): void {
  (globalThis as Dict).HTMLElement = ShimElement;
  (globalThis as Dict).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body: new ShimElement('body'),
    documentElement: {
      style: { setProperty: () => undefined, removeProperty: () => undefined },
      classList: new ShimElement('html').classList,
    },
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

/** Строка ленты за день (поля, которые читает рендер). */
function rowFor(day: string): any {
  const local = new Date(`${day}T10:00:00`);
  const from = local.toISOString();
  return {
    id: `r-${day}`,
    title: `Запись ${day}`,
    valid_from: from,
    valid_to: from,
    use_time: false,
    version: 1,
    created_at: from,
    updated_at: from,
    created_by: 'u',
    updated_by: 'u',
    snippet: `Запись ${day}`,
    body_html: `<p>Тело ${day}</p>`,
    targets: [],
  };
}

installShims({
  ui: { getState: async () => null, setState: async () => undefined },
  tabs: { updateState: async () => undefined, list: async () => [] },
  propertyRegistry: { list: async () => [] },
  chronicle: {
    query: async (_networkId: string, filter: any) => {
      queries.push(filter);
      const hold = queryHold;
      if (hold !== null) {
        queryHold = null;
        await hold.promise;
      }
      const rows = filter?.offset === 0 ? feedRows : [];
      return { rows, total: feedRows.length, warnings: null };
    },
    dayLinks: async () => ({ facts: [], links: [] }),
  },
  chronicleFilters: {
    list: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    remove: async () => undefined,
  },
  structures: {
    query: async () => ({
      items: [{ id: 'home-root' }],
      total: 1,
      directions: {},
      next_cursor: null,
    }),
  },
  thoughts: { get: async () => ({ id: 'home-root' }), resolve: async () => [] },
  savedFilters: {
    list: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    remove: async () => undefined,
  },
});

const stateMod = await import('../src/renderer/state.js');
const panelMod = await import('../src/renderer/screens/chronicle/filter-panel.js');
const chronicleMod = await import('../src/renderer/screens/chronicle/chronicle.js');
const diaryMod = await import('../src/renderer/screens/chronicle/diary.js');
const catalogueMod = await import('../src/renderer/lib/property-catalogue.js');
const i18nMod = await import('../src/renderer/lib/i18n.js');
const statusMod = await import('../src/renderer/lib/status-message.js');
const noticeMod = await import('../src/renderer/lib/notice.js');

/** Дождаться асинхронных чтений и их продолжений. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let mountedScreen: (() => void) | null = null;
let host: ShimElement;
/** Узел зоны сообщений статусной строки (`.sb-message`). */
let sb: ShimElement;

async function mountDiary(tabId: string): Promise<void> {
  sb = new ShimElement('span', 'sb-item sb-message');
  statusMod.mountStatusMessage(sb);
  stateMod.store.update({
    networkId: NET,
    network: null,
    activeView: 'chronicle',
    screen: 'workspace',
    tabs: [{ tab_id: tabId, network_id: NET, chronicle_state: null }] as any,
    activeTabId: tabId,
    rtStatusByNetwork: { [NET]: 'connected' },
  } as any);
  host = new ShimElement('div');
  mountedScreen = chronicleMod.mountChronicle(host as unknown as HTMLElement);
  await chronicleMod.ensureChronicleInitialised();
  await flush();
}

/** Ячейка календаря по дате. */
function dayCell(day: string): ShimElement {
  const cell = host
    .querySelectorAll('.cal-day')
    .find((node) => ((node as unknown as { title?: string }).title ?? '') === day);
  assert.notEqual(cell, undefined, `в календаре есть ячейка ${day}`);
  return cell!;
}

/** День выбранной клетки, отличный от сегодняшнего (в текущем месяце). */
function otherDayOfMonth(today: string): string {
  const month = today.slice(0, 7);
  const candidate = `${month}-10`;
  return candidate === today ? `${month}-11` : candidate;
}

/** Ответ ленты придержан до `release` — имитация долгого запроса. */
function holdNextQuery(): () => void {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  queryHold = { promise, release };
  return release;
}

/** Статус-строка показывает наше сообщение о загрузке. */
function loadingNotice(): string {
  return i18nMod.t('common.loading');
}

beforeEach(() => {
  queries.length = 0;
  queryHold = null;
  const today = diaryMod.todayLocal();
  feedRows = [rowFor(today)];
});

afterEach(() => {
  if (mountedScreen !== null) {
    mountedScreen();
    mountedScreen = null;
  }
  panelMod.unmountChronicleFilterPanel();
  catalogueMod.resetPropertyCatalogue();
  statusMod.unmountStatusMessage();
});

describe('«Дневник»: индикатор долгой загрузки ленты в статус-строке (a33b5fc7)', () => {
  it('быстрый ответ при показанном содержимом не показывает ничего', async () => {
    await mountDiary('tab-ln-1');
    const today = diaryMod.todayLocal();
    const target = otherDayOfMonth(today);
    feedRows = [rowFor(target)];
    const release = holdNextQuery();

    dayCell(target).click();
    // Перечитывание уже началось, но ответ ещё не пришёл: в этом окне
    // мутация «показать сразу» видна — сообщения быть не должно.
    await flush();
    assert.equal(sb.textContent, '', 'начавшееся перечитывание не показывает «Загрузку…» сразу');

    // Ответ раньше задержки индикатора: сообщения так и не было.
    release();
    await flush();
    assert.equal(sb.textContent, '', 'быстрый ответ не мелькает «Загрузкой…»');
    assert.equal(
      host.querySelector('.chron-feed-status')?.hidden,
      true,
      'статус области ленты скрыт после отрисовки',
    );
  });

  it('долгий ответ: «Загрузка…» появляется после задержки и гаснет по завершении', async () => {
    await mountDiary('tab-ln-2');
    const today = diaryMod.todayLocal();
    const target = otherDayOfMonth(today);
    feedRows = [rowFor(target)];
    const release = holdNextQuery();

    dayCell(target).click();
    await sleep(150);
    assert.equal(sb.textContent, '', 'до истечения задержки сообщения нет');

    await sleep(250);
    assert.equal(sb.textContent, loadingNotice(), 'через ~300 мс — «Загрузка…» в статус-строке');

    release();
    await flush();
    assert.equal(sb.textContent, '', 'по завершении перечитывания сообщение погашено');
    assert.deepEqual(
      host.querySelectorAll('.diary-day').map((section) => section.dataset['day']),
      [target],
      'лента перечитана',
    );
  });

  it('чужой notice поверх индикатора не затирается завершением перечитывания', async () => {
    await mountDiary('tab-ln-3');
    const today = diaryMod.todayLocal();
    const target = otherDayOfMonth(today);
    feedRows = [rowFor(target)];
    const release = holdNextQuery();

    dayCell(target).click();
    await sleep(380);
    assert.equal(sb.textContent, loadingNotice(), 'индикатор показан');

    noticeMod.notice('Комментарий записан.', 'info');
    assert.equal(sb.textContent, 'Комментарий записан.', 'чужое сообщение заменило индикатор');

    release();
    await flush();
    assert.equal(sb.textContent, 'Комментарий записан.', 'гасим только своё сообщение');
  });

  it('чужой notice, появившийся до задержки, не перебивается индикатором', async () => {
    await mountDiary('tab-ln-4');
    const today = diaryMod.todayLocal();
    const target = otherDayOfMonth(today);
    feedRows = [rowFor(target)];
    const release = holdNextQuery();

    dayCell(target).click();
    await sleep(100);
    noticeMod.notice('Другое сообщение.', 'info');

    await sleep(300);
    assert.equal(sb.textContent, 'Другое сообщение.', 'занятую зону индикатор не перебивает');

    release();
    await flush();
    assert.equal(sb.textContent, 'Другое сообщение.', 'завершение перечитывания чужое не гасит');
  });

  it('первая загрузка (лента пуста): «Загрузка…» в области ленты, статус-бар не дублирует', async () => {
    feedRows = [];
    await mountDiary('tab-ln-5');
    const target = otherDayOfMonth(diaryMod.todayLocal());
    const release = holdNextQuery();

    dayCell(target).click();
    await sleep(380);

    const status = host.querySelector('.chron-feed-status')!;
    assert.equal(status.hidden, false, 'статус области ленты показан');
    assert.match(status.flatText(), new RegExp(loadingNotice()), 'в области ленты — «Загрузка…»');
    assert.equal(sb.textContent, '', 'статус-бар первую загрузку не дублирует');

    release();
    await flush();
    assert.equal(sb.textContent, '', 'после завершения статус-бар пуст');
  });

  it('ошибка перечитывания идёт прежним путём и в статус-бар не дублируется', async () => {
    await mountDiary('tab-ln-6');
    const today = diaryMod.todayLocal();
    const target = otherDayOfMonth(today);
    // Отказ следующего запроса ленты (первая страница).
    let fail = true;
    const bridge = ((globalThis as Dict).window as Dict).etn as any;
    const original = bridge.chronicle.query;
    bridge.chronicle.query = async (networkId: string, filter: any) => {
      if (fail) {
        fail = false;
        throw new Error('сеть недоступна');
      }
      return original(networkId, filter);
    };

    dayCell(target).click();
    await sleep(380);
    assert.equal(sb.textContent, '', 'ошибку в статус-бар не дублируем');
    await flush();
    const status = host.querySelector('.chron-feed-status')!;
    assert.equal(status.hidden, false, 'ошибка показана в области ленты');
    assert.equal(sb.textContent, '', 'после ошибки статус-бар пуст');
  });
});
