/**
 * «Дневник»: период по умолчанию при входе — текущая дата (ошибка 167860ac).
 *
 * Корень: экран НИКОГДА не применял период по умолчанию. `resetFilterState()`
 * даёт пустое дерево (`defaultState()`), снимок `chronicle_state` читался
 * только при его наличии, и `reload()` уходил на сервер без `record_time` —
 * лента показывала все записи, `syncCalendar()` ставил `setSelection('','')`.
 *
 * Ожидаемое: «снимка нет» либо снимок без периода → `$today`/`$today` ТОКЕНОМ
 * (раскрытие в момент применения — требование 91f8d8dd, поэтому вход на
 * следующий день снова даёт «сегодня»), выделен сегодняшний день, лента
 * запрошена за сегодня. Свой период снимка не подменяется; прочие критерии
 * (ключевые слова/свойства) сохраняются. Дефолт НЕ персистится: «снимка нет»
 * остаётся признаком «отбор не настраивался».
 *
 * Путь ретрая (`retryPendingFilterSnapshot`, отказ чтения реестра) обёрнут тем
 * же дефолтом — иначе повтор разбора снимка снимал бы `$today`.
 *
 * Экран монтируется ЦЕЛИКОМ на DOM-шиме (`./dom-shim.js`), как
 * `chronicle-filter-registry-retry.test.ts`: проверяются настоящая инициализация
 * вида, первый запрос ленты и календарь.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { CHRONICLE_PAGE_SIZE, type NetworkProperty } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

type Dict = Record<string, unknown>;

const NET = '00000000-0000-4000-8000-0000000000d1';
const PROPERTY_ID = '00000000-0000-4000-8000-0000000000d2';

/** Строка реестра: текстовое свойство (условие по нему теряется без реестра). */
const PROPERTY_ROW: NetworkProperty = {
  id: PROPERTY_ID,
  name: 'Версия',
  value_type: 'text',
  config: null,
  description: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

/** Сколько раз читали реестр свойств (включая отказные чтения). */
let registryCalls = 0;
/** Поведение чтения реестра по номеру вызова (1-based). */
let registryImpl: (call: number) => Promise<NetworkProperty[]> = async () => [];

/** Тела запросов ленты/счётчиков — журнал применённого отбора. */
const queries: any[] = [];
/** Записи пер-вкладочного состояния: дефолт не должен персиститься. */
let tabUpdates: Array<{ tabId: string; patch: Dict }> = [];

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
  ui: { getState: async () => null, setState: async () => undefined },
  tabs: {
    updateState: async (tabId: string, patch: Dict) => {
      tabUpdates.push({ tabId, patch });
    },
    list: async () => [],
  },
  propertyRegistry: {
    list: async (): Promise<NetworkProperty[]> => {
      registryCalls += 1;
      return registryImpl(registryCalls);
    },
  },
  chronicle: {
    query: async (_networkId: string, filter: any) => {
      queries.push(filter);
      return { rows: [], total: 0, warnings: null };
    },
  },
  chronicleFilters: {
    list: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    remove: async () => undefined,
  },
  // HOME экрана (`findRootThought`) и минимальный шим транзитивных вызовов.
  structures: {
    query: async () => ({ items: [{ id: 'home-root' }], total: 1, directions: {}, next_cursor: null }),
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
// Живой справочник свойств — модульный кэш (ошибка 6d25c224): кейсы «холодного
// старта» сбрасывают его, иначе успешное чтение предыдущего кейса переживает
// монтаж и снимок разбирается с готовым реестром.
const catalogueMod = await import('../src/renderer/lib/property-catalogue.js');

/** Дождаться асинхронных чтений реестра/запроса и их продолжений. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Все узлы-листья произвольного AST/дерева (обход по любым полям). */
function nodes(value: unknown, out: any[] = []): any[] {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) nodes(item, out);
    return out;
  }
  const rec = value as Record<string, unknown>;
  if (rec['operator'] !== undefined && rec['entity'] !== undefined) out.push(rec);
  for (const child of Object.values(rec)) nodes(child, out);
  return out;
}

/** Условие «Период записи» (`record_time`) в теле запроса; `null` — нет. */
function timeLeaf(query: any): any {
  return (
    nodes(query?.ast?.filter ?? null).find(
      (node) => (node.entity as Dict)['kind'] === 'record_time' && node.operator === 'between',
    ) ?? null
  );
}

/** Запрос ленты (не счётчиков месяца): ограничение страницы — CHRONICLE_PAGE_SIZE. */
function feedQueries(): any[] {
  return queries.filter((query) => query?.limit === CHRONICLE_PAGE_SIZE);
}

/** Живые стенды: упавший кейс не обязан успеть размонтировать экран. */
let mountedScreen: (() => void) | null = null;
let host: ShimElement;

/**
 * Смонтировать экран и выполнить штатную инициализацию вкладки. `tabId`
 * уникален на кейс: `networkIdSeen` экрана переживает unmount, повторный монтаж
 * той же вкладки не переинициализировал бы снимок.
 */
async function mountDiary(tabId: string, snapshot: string | null, rtStatus = 'connected'): Promise<void> {
  stateMod.store.update({
    networkId: NET,
    network: null,
    activeView: 'chronicle',
    screen: 'workspace',
    tabs: [{ tab_id: tabId, network_id: NET, chronicle_state: snapshot }] as any,
    activeTabId: tabId,
    rtStatusByNetwork: { [NET]: rtStatus },
  } as any);
  host = new ShimElement('div');
  mountedScreen = chronicleMod.mountChronicle(host as unknown as HTMLElement);
  await chronicleMod.ensureChronicleInitialised();
  await flush();
}

/** Снять текущий стенд и кэши, которые переживают монтаж (общий teardown). */
function teardownScreen(): void {
  if (mountedScreen !== null) {
    mountedScreen();
    mountedScreen = null;
  }
  panelMod.unmountChronicleFilterPanel();
  catalogueMod.resetPropertyCatalogue();
}

afterEach(() => {
  teardownScreen();
});

beforeEach(() => {
  registryCalls = 0;
  registryImpl = async () => [];
  queries.length = 0;
  tabUpdates = [];
});

describe('«Дневник»: период по умолчанию при входе (167860ac)', () => {
  it('1. снимка нет → $today в первом запросе ленты, сегодня выделено, дефолт не персистится', async () => {
    await mountDiary('tab-dp-1', null);
    const today = diaryMod.todayLocal();
    assert.deepEqual(
      panelMod.chroniclePeriod(),
      { from: '$today', to: '$today' },
      'период панели — токен $today (не голая дата)',
    );
    const feeds = feedQueries();
    assert.ok(feeds.length >= 1, 'лента запрошена');
    const leaf = timeLeaf(feeds[0]);
    assert.notEqual(leaf, null, 'первый запрос ленты несёт условие «Период записи»');
    assert.deepEqual(
      leaf.value,
      [diaryMod.localDayStart(today), diaryMod.localDayEnd(today)],
      'границы периода в запросе — локальные сутки сегодняшнего дня',
    );
    assert.equal(
      host.querySelectorAll('.cal-day.is-selected').length,
      1,
      'в календаре выделен ровно один день',
    );
    assert.equal(
      host.querySelectorAll('.cal-day.is-today').length,
      1,
      'выделен именно сегодняшний день',
    );
    assert.deepEqual(tabUpdates, [], 'дефолт не записывается в chronicle_state');
  });

  it('2. снимок с $weekStart/$weekEnd восстановлен, дефолт его не подменяет', async () => {
    const snapshot = JSON.stringify({
      filter: { date_from: '$weekStart', date_to: '$weekEnd', order: 'asc' },
      month: null,
      savedFilterId: null,
    });
    await mountDiary('tab-dp-2', snapshot);
    assert.deepEqual(panelMod.chroniclePeriod(), { from: '$weekStart', to: '$weekEnd' });
    const week = diaryMod.resolvePeriodForQuery('$weekStart', '$weekEnd', diaryMod.todayLocal(), 1);
    const leaf = timeLeaf(feedQueries()[0]);
    assert.notEqual(leaf, null, 'период недели ушёл в запрос');
    assert.deepEqual(leaf.value, [week.from, week.to], 'границы — неделя сети, а не сегодня');
  });

  it('3. снимок с ключевыми словами без периода → $today рядом с keywords', async () => {
    const snapshot = JSON.stringify({
      filter: { keywords: 'кофе', keyword_scope: ['title'], order: 'desc' },
      month: null,
      savedFilterId: null,
    });
    await mountDiary('tab-dp-3', snapshot);
    assert.deepEqual(panelMod.chroniclePeriod(), { from: '$today', to: '$today' });
    const query = feedQueries()[0];
    const leaf = timeLeaf(query);
    assert.notEqual(leaf, null, 'период по умолчанию добавлен');
    const keywords = nodes(query?.ast?.filter ?? null).find(
      (node) => (node.entity as Dict)['kind'] === 'keywords',
    );
    assert.equal(keywords?.value, 'кофе', 'критерий снимка не потерян');
  });

  it('4. пустой AST-снимок → $today', async () => {
    const snapshot = JSON.stringify({
      filter: { ast: { version: 1, filter: { op: 'and', children: [] } }, order: 'asc' },
      month: null,
      savedFilterId: null,
    });
    await mountDiary('tab-dp-4', snapshot);
    assert.deepEqual(panelMod.chroniclePeriod(), { from: '$today', to: '$today' });
    assert.notEqual(timeLeaf(feedQueries()[0]), null, 'пустой отбор получил период в запросе');
  });

  it('5. отказ реестра при разборе + повтор: $today остаётся, условие свойства возвращается', async () => {
    const snapshot = JSON.stringify({
      filter: {
        targets: { properties: [{ property_id: PROPERTY_ID, op: 'eq', value: '2.0' }] },
        order: 'asc',
      },
      month: null,
      savedFilterId: null,
    });
    let phase: 'start' | 'recovery' = 'start';
    registryImpl = async () => {
      if (phase === 'start') throw new Error('сеть недоступна');
      return [PROPERTY_ROW];
    };
    await mountDiary('tab-dp-5', snapshot, 'offline');
    assert.deepEqual(
      panelMod.chroniclePeriod(),
      { from: '$today', to: '$today' },
      'дефолт применён и при отказе реестра',
    );
    // Восстановление связи — штатный тик store: повтор разбора снимка.
    phase = 'recovery';
    stateMod.store.update({ rtStatusByNetwork: { [NET]: 'connected' } });
    await flush();
    assert.deepEqual(
      panelMod.chroniclePeriod(),
      { from: '$today', to: '$today' },
      'повтор разбора не снимает дефолт (обёртка в retryPendingFilterSnapshot)',
    );
    const restored = nodes(panelMod.getFilterState().tree).filter(
      (node) => (node.entity as Dict)['kind'] === 'property',
    );
    assert.equal(restored.length, 1, 'условие по свойству вернулось после перечитывания реестра');
    assert.ok(
      feedQueries().some(
        (query) => timeLeaf(query) !== null && nodes(query?.ast?.filter ?? null).some(
          (node) => (node.entity as Dict)['kind'] === 'property',
        ),
      ),
      'лента перезапрошена с периодом и восстановленным свойством',
    );
  });

  it('6. повторный монтаж той же пары инициализирует новый хост (вторая вкладка сети)', async () => {
    await mountDiary('tab-dp-9', null);
    assert.ok(feedQueries().length >= 1, 'первый хост ленту запросил');
    // Пересборка рабочего пространства на второй вкладке той же сети: экран
    // инициализировался на ПРЕЖНЕМ хосте до неё, новый хост оставался пустым
    // (найдено GUI-стендом 167860ac).
    mountedScreen?.();
    mountedScreen = null;
    queries.length = 0;
    host = new ShimElement('div');
    mountedScreen = chronicleMod.mountChronicle(host as unknown as HTMLElement);
    // Тик store, который шлёт `showScreen` после пересборки workspace.
    stateMod.store.update({ screen: 'workspace' } as any);
    await flush();
    assert.ok(feedQueries().length >= 1, 'лента НОВОГО хоста запрошена после монтажа');
    assert.deepEqual(
      panelMod.chroniclePeriod(),
      { from: '$today', to: '$today' },
      'период по умолчанию у нового хоста',
    );
  });
});

/** Дни сетки календаря (подсказка `title` ячейки — её дата). */
function calendarDays(): string[] {
  return host.querySelectorAll('.cal-day').map((cell) => cell.title);
}

/** Двузначная запись числа. */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

describe('«Дневник»: сохранённый месяц календаря (9b49d672)', () => {
  it('1. снимок с месяцем: календарь показывает его, период подсвечен', async () => {
    const snapshot = JSON.stringify({
      filter: { date_from: '2026-03-10', date_to: '2026-03-12', order: 'asc' },
      month: { year: 2026, month: 3 },
      savedFilterId: null,
    });
    await mountDiary('tab-dp-6', snapshot);
    assert.equal(panelMod.chroniclePeriod().from, '2026-03-10', 'период снимка не подменён');
    const days = calendarDays();
    assert.ok(days.includes('2026-03-01'), 'сетка сохранённого месяца марта 2026 показана');
    assert.ok(days.includes('2026-03-31'), 'месяц показан целиком');
    assert.ok(
      !days.includes(`${diaryMod.todayLocal().slice(0, 7)}-01`),
      'сегодняшний месяц не подставлен вместо сохранённого',
    );
    const selected = host
      .querySelectorAll('.cal-day.is-selected')
      .map((cell) => cell.title)
      .sort();
    assert.deepEqual(selected, ['2026-03-10', '2026-03-11', '2026-03-12']);
  });

  it('2. смена месяца пользователем пишется в chronicle_state и восстанавливается', async () => {
    await mountDiary('tab-dp-7', null);
    const today = diaryMod.todayLocal();
    const next = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1));
    const nextMonth = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
    (host.querySelector('.cal-next') as ShimElement).click();
    await flush();
    const saved = tabUpdates.filter((row) => typeof row.patch['chronicle_state'] === 'string').at(-1);
    assert.notEqual(saved, undefined, 'смена месяца записана в состояние вкладки');
    const state = saved!.patch['chronicle_state'] as string;
    assert.deepEqual(JSON.parse(state).month, nextMonth, 'в снимок лёг новый месяц');
    // «Перезапуск»: модульный `month` не должен переживать процесс. Прогрев на
    // другой вкладке сбрасывает его к текущему месяцу (в холодном старте он
    // `null`) — без этого кейс зеленел бы и без `alignEntryMonth`: сетка нового
    // монтажа строилась бы из месяца, оставшегося от клика, а не из снимка.
    teardownScreen();
    await mountDiary('tab-dp-8-restart', null);
    // Кнопка «Сегодня» доводит календарь прогрева до текущего месяца детермини-
    // рованно (не завися от месяца, оставшегося от предыдущего кейса).
    (host.querySelector('.cal-today') as ShimElement).click();
    await flush();
    teardownScreen();
    queries.length = 0;
    tabUpdates = [];
    await mountDiary('tab-dp-8', state);
    const firstDay = `${nextMonth.year}-${pad2(nextMonth.month)}-01`;
    // Дни СВОЕГО месяца сетки (без приглушённых ячеек соседних месяцев):
    // только так видно, что показан сохранённый месяц, а не текущий с
    // дописанным в конец первой датой следующего.
    const ownDays = host
      .querySelectorAll('.cal-day')
      .filter((cell) => !cell.classList.contains('is-out'))
      .map((cell) => cell.title);
    assert.ok(ownDays.includes(firstDay), 'сетка сохранённого месяца восстановлена');
    assert.equal(
      ownDays.length,
      new Date(Date.UTC(nextMonth.year, nextMonth.month, 0)).getUTCDate(),
      'показан именно сохранённый месяц (число дней своего месяца)',
    );
    assert.ok(
      !ownDays.some((day) => day.startsWith(today.slice(0, 7))),
      'текущий месяц не подставлен вместо сохранённого',
    );
    // Восстановление месяца не должно терять период по умолчанию: он остаётся
    // ТОКЕНОМ `$today` (раскрывается в момент применения) — это не зависит от
    // календарной даты.
    assert.deepEqual(
      panelMod.chroniclePeriod(),
      { from: '$today', to: '$today' },
      'период по умолчанию ($today) пережил восстановление месяца',
    );
    // Подсветка обязана совпасть с периодом В СЕТКЕ сохранённого месяца.
    // «Сегодня» попадает в чужую сетку только через приглушённые ячейки
    // соседних месяцев (первая/последняя неделя) — в середине месяца её там
    // нет вовсе. Поэтому ожидание «ровно одна выделенная ячейка» было верно
    // лишь в конце месяца (ошибка 062bc426): сравниваем выделение с
    // пересечением периода и сетки. Подсветку непустого фиксированного
    // периода проверяет предыдущий кейс — от календарной даты он не зависит.
    const allDays = calendarDays();
    assert.deepEqual(
      host.querySelectorAll('.cal-day.is-selected').map((cell) => cell.title),
      allDays.filter((day) => day === today),
      'выделение — пересечение периода $today и сетки сохранённого месяца',
    );
    assert.deepEqual(tabUpdates, [], 'восстановление месяца не пишет состояние повторно');
  });

  it('3. легаси-снимок: месяц без периода игнорируется — текущая дата (2770c2cc)', async () => {
    // Пользователь: месяц без периода — не отбор, а остаток прежнего формата.
    // Дневник должен открыться как без снимка: период $today, текущий месяц,
    // сегодня выделено; нормальный снимок (кейс 1) применяется целиком.
    const snapshot = JSON.stringify({
      filter: { keywords: 'кофе', keyword_scope: ['title'], order: 'asc' },
      month: { year: 2026, month: 3 },
      savedFilterId: null,
    });
    await mountDiary('tab-dp-10', snapshot);
    assert.deepEqual(
      panelMod.chroniclePeriod(),
      { from: '$today', to: '$today' },
      'легаси-месяц не сделал снимок отбором: период — $today',
    );
    const today = diaryMod.todayLocal();
    const todayMonth = today.slice(0, 7);
    const days = calendarDays();
    assert.ok(days.includes(`${todayMonth}-01`), 'календарь открыт на текущем месяце');
    if (todayMonth !== '2026-03') {
      assert.ok(!days.includes('2026-03-01'), 'сохранённый в легаси-снимке март не показан');
    }
    assert.deepEqual(
      host.querySelectorAll('.cal-day.is-selected').map((cell) => cell.title),
      [today],
      'выделен сегодняшний день',
    );
    assert.deepEqual(tabUpdates, [], 'легаси-месяц не персистится повторно');
  });

  it('4. выбор дня перезаписывает легаси-снимок нормальным форматом: период + месяц (2770c2cc)', async () => {
    // DoD карточки: «после выбора любого отбора снимок перезаписывается
    // нормальным форматом». Монтирование легаси-снимок не трогает (кейс 3),
    // но первое действие пользователя обязано записать период и месяц —
    // иначе игнорируемый месяц оставался бы в снимке навсегда.
    const snapshot = JSON.stringify({
      filter: { order: 'asc' },
      month: { year: 2001, month: 3 },
      savedFilterId: null,
    });
    await mountDiary('tab-dp-11', snapshot);
    assert.deepEqual(panelMod.chroniclePeriod(), { from: '$today', to: '$today' });
    (host.querySelector('.cal-day.is-today') as ShimElement).click();
    await flush();
    const saved = tabUpdates.filter((row) => typeof row.patch['chronicle_state'] === 'string').at(-1);
    assert.notEqual(saved, undefined, 'выбор дня записал снимок');
    const state = JSON.parse(saved!.patch['chronicle_state'] as string) as Dict;
    const leaf = nodes(state.filter).find(
      (node) => (node.entity as Dict)['kind'] === 'record_time' && node.operator === 'between',
    );
    assert.notEqual(leaf, null, 'снимок содержит период «Период записи»');
    const today = diaryMod.todayLocal();
    assert.deepEqual(
      state.month,
      { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) },
      'в снимок лёг текущий месяц',
    );
  });
});
