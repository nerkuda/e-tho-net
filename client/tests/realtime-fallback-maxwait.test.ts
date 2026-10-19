/**
 * Fallback-путь `scheduleRefresh` в `app.ts`: жёсткий срок realtime-волны
 * (задача `96d7f05d`).
 *
 * Когда окрестность фокуса ещё не подписана на слой запросов (переходный
 * период: экран не смонтирован, ключ `focus` не зарегистрирован), realtime-
 * событие перечитывает её напрямую через `refreshFocus`. Trailing-окно
 * `REALTIME_REFETCH_WINDOW_MS` продлевается каждым событием, поэтому без
 * жёсткого срока непрерывный поток снова голодал бы — ровно так, как это было
 * с реестром до блокера `96d7f05d`. Тест держит три контракта:
 *  1) при потоке чаще окна проход случается не позже
 *     `REALTIME_REFETCH_MAX_WAIT_MS` от ПЕРВОГО события;
 *  2) после затишья — ровно один финальный проход, дублей нет;
 *  3) локальный путь (`LOCAL_CAUSE`) живёт по своему дебаунсу и maxWait
 *     realtime-волны не ждёт.
 *
 * Тест мутационно красный: убери блок `refreshMaxWaitTimer` из fallback —
 * первый тест перестанет видеть проход внутри потока.
 *
 * Запускается на РЕАЛЬНОМ `scheduleRefresh` с минимальным DOM-шимом (тот же
 * приём, что в `copy-hotkey.test.ts`) и fake timers node:test.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it, type TestContext } from 'node:test';

import {
  LOCAL_CAUSE,
  REALTIME_REFETCH_MAX_WAIT_MS,
  REALTIME_REFETCH_WINDOW_MS,
  resetQueryRegistry,
} from '../src/renderer/lib/live/index.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NET = '00000000-0000-4000-8000-0000000000aa';
const FOCUS_ID = 'f';

/**
 * Минимальные `document`/`window`-шимы. Ставятся ДО первого динамического
 * импорта `app.ts`; `window.setTimeout`/`clearTimeout` делегируют глобальным
 * функциям на момент вызова — node:test подменяет их уже после установки шима.
 */
function shimDom(): void {
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = (handler: (...args: any[]) => void, ms?: number, ...rest: any[]) =>
    (globalThis as any).setTimeout(handler, ms, ...rest);
  win.clearTimeout = (id: any) => (globalThis as any).clearTimeout(id);
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

/** Realtime-событие как причина инвалидации (`asRealtimeCause`). */
function realtimeCause(seq: number): { type: string; data: Record<string, unknown> } {
  return { type: 'thought.updated', data: { id: FOCUS_ID, version: seq } };
}

/** Прогнать микрозадачи (промисы `refreshFocus`). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/**
 * Счётчик fallback-проходов. `thoughts.focus` — единственный сетевой вызов
 * `refreshFocus`; бросаем, чтобы `publishFocusResponse`/`activateFocusQuery`
 * не зарегистрировали ключ `focus` и fallback-ветка оставалась активной всю
 * волну (это и есть условие «экрана на слое ещё нет»).
 */
let fallbackPasses = 0;

function stubEtn(): void {
  const win = (globalThis as any).window;
  win.etn = {
    thoughts: {
      focus: async () => {
        fallbackPasses += 1;
        throw new Error('focus query is not subscribed');
      },
    },
  };
}

beforeEach(() => {
  resetQueryRegistry();
  fallbackPasses = 0;
});

/**
 * Общая подготовка теста: шим, заглушка моста, состояние store и fake timers.
 * `scheduleRefresh(LOCAL_CAUSE)` + прокрутка дебаунса снимают таймеры, которые
 * мог оставить предыдущий упавший тест: модульные `refreshTimer`/
 * `refreshMaxWaitTimer` живут дольше теста, а mock-контекст у каждого свой.
 */
async function prepare(t: TestContext) {
  shimDom();
  stubEtn();
  const { appInternals, scheduleRefresh } = await import('../src/renderer/app.js');
  const { store } = await import('../src/renderer/state.js');
  store.update({
    networkId: NET,
    focus: { focused: { id: FOCUS_ID } },
  } as any);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Упавший тест не должен оставлять pending-таймеры: node:test в этом случае
  // ломает mock-таймеры следующего теста. `after` исполняется до их сброса.
  t.after(() => {
    scheduleRefresh(LOCAL_CAUSE);
    t.mock.timers.tick(appInternals.refreshDebounceMs);
  });
  scheduleRefresh(LOCAL_CAUSE);
  t.mock.timers.tick(appInternals.refreshDebounceMs);
  await flushMicrotasks();
  fallbackPasses = 0;
  return { appInternals, scheduleRefresh };
}

describe('fallback scheduleRefresh: жёсткий срок realtime-волны (96d7f05d)', () => {
  it('непрерывный поток чаще окна: проход не позже maxWait, после остановки — один финал', async (t: TestContext) => {
    const { scheduleRefresh } = await prepare(t);

    const gapMs = 100;
    const streamMs = 3000;
    // t = 0, 100, …, 3000 — поток длится ровно 3 с (31 событие).
    const events = streamMs / gapMs + 1;
    let elapsed = 0;
    let firstPassAt: number | null = null;

    for (let i = 0; i < events; i += 1) {
      scheduleRefresh(realtimeCause(i + 1));
      if (i < events - 1) {
        t.mock.timers.tick(gapMs);
        elapsed += gapMs;
      }
      await flushMicrotasks();
      if (fallbackPasses > 0 && firstPassAt === null) firstPassAt = elapsed;
    }

    assert.notEqual(firstPassAt, null, 'за непрерывный поток был хотя бы один fallback-проход');
    assert.ok(
      firstPassAt! <= REALTIME_REFETCH_MAX_WAIT_MS,
      `первый проход не позже maxWait: ${firstPassAt} > ${REALTIME_REFETCH_MAX_WAIT_MS}`,
    );
    const atStop = fallbackPasses;
    assert.ok(
      atStop >= Math.floor(streamMs / REALTIME_REFETCH_MAX_WAIT_MS),
      `поток дал ${atStop} проход(ов) — меньше, чем окон maxWait за ${streamMs} мс`,
    );

    // После остановки — ровно один финальный проход по накопленной волне.
    t.mock.timers.tick(REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();
    assert.equal(fallbackPasses, atStop + 1, 'после остановки ровно один финальный проход');

    // Дальше тишина — новых проходов нет: дублей не осталось.
    t.mock.timers.tick(REALTIME_REFETCH_MAX_WAIT_MS + REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();
    assert.equal(fallbackPasses, atStop + 1, 'после финального прохода повторов нет');
  });

  it('после затишья — ровно один проход, maxWait не добавляет второй', async (t: TestContext) => {
    const { scheduleRefresh } = await prepare(t);

    scheduleRefresh(realtimeCause(1));
    assert.equal(fallbackPasses, 0, 'событие не перечитывает сразу');

    t.mock.timers.tick(REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();
    assert.equal(fallbackPasses, 1, 'по закрытию окна — один проход');

    // maxWait первого события снят тем же флашем: второго прохода нет.
    t.mock.timers.tick(REALTIME_REFETCH_MAX_WAIT_MS + REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();
    assert.equal(fallbackPasses, 1, 'затишье не даёт дублей');
  });

  it('локальный путь не ждёт maxWait и работает по своему дебаунсу', async (t: TestContext) => {
    const { appInternals, scheduleRefresh } = await prepare(t);

    // Непрерывные локальные вызовы чаще дебаунса: maxWait-срока у них нет,
    // поэтому проход ждёт затишья, а не секунды от первого вызова.
    const gapMs = 50;
    const calls = 26; // t = 0 … 1250 мс — дольше REALTIME_REFETCH_MAX_WAIT_MS
    for (let i = 0; i < calls; i += 1) {
      scheduleRefresh(LOCAL_CAUSE);
      if (i < calls - 1) t.mock.timers.tick(gapMs);
      await flushMicrotasks();
      assert.equal(fallbackPasses, 0, 'пока локальные вызовы идут, дебаунс продлевается');
    }
    assert.ok(
      (calls - 1) * gapMs > REALTIME_REFETCH_MAX_WAIT_MS,
      'поток локальных вызовов длиннее realtime-срока',
    );

    t.mock.timers.tick(appInternals.refreshDebounceMs);
    await flushMicrotasks();
    assert.equal(fallbackPasses, 1, 'после затишья — ровно один локальный проход');

    t.mock.timers.tick(REALTIME_REFETCH_MAX_WAIT_MS + REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();
    assert.equal(fallbackPasses, 1, 'локальный путь не создаёт maxWait-проход');
  });
});
