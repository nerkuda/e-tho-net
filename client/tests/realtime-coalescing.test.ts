/**
 * Коалесирование перечитываний по realtime-волне (задача `96d7f05d`, ошибка
 * `49e05ea0`).
 *
 * Волна событий приходит отдельными кадрами WebSocket — микротаска реестра их
 * не схлопывает. Тест воспроизводит батч агента (13 событий с паузами) под
 * fake timers и считает перечитывания: до изменения — запрос на каждое
 * событие, после — один проход по записям по закрытию окна.
 *
 * Тест мутационно красный: убери окно/перечитывание после in-flight — счётчики
 * вырастут (или запрос потеряется).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it, type TestContext } from 'node:test';

import type { AnyRealtimeEvent, RealtimeEventType } from '@etn/shared';

import {
  REALTIME_REFETCH_MAX_WAIT_MS,
  REALTIME_REFETCH_WINDOW_MS,
  queryKeys,
  refetchQuery,
  registerQuery,
  resetEventRouter,
  resetQueryRegistry,
  routeRealtimeEvent,
  subscribeQuery,
} from '../src/renderer/lib/live/index.js';

const NET = '00000000-0000-4000-8000-0000000000aa';
const OTHER_NET = '00000000-0000-4000-8000-0000000000bb';

/** Пауза между событиями волны (кадры WebSocket идут не в одном тике). */
const EVENT_GAP_MS = 50;

function mkEvent(
  type: RealtimeEventType,
  data: unknown,
  seq: number,
  networkId = NET,
): AnyRealtimeEvent {
  return {
    type,
    seq,
    ts: '2026-10-17T00:00:00.000Z',
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: networkId,
    audience: 'network',
    data,
    layer_id: '00000000-0000-0000-0000-000000000000',
  } as unknown as AnyRealtimeEvent;
}

/** Прогнать микрозадачи (промисы фетчеров, queueMicrotask). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Счётчики перечитываний по ключу. */
function makeCounters() {
  const counts = new Map<string, number>();
  return {
    counts,
    async subscribe(key: string, impl?: () => Promise<unknown>): Promise<() => void> {
      const fetcher = impl ?? (async () => undefined);
      counts.set(key, 0);
      const unsub = subscribeQuery(
        key,
        () => {
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return fetcher();
        },
        () => undefined,
      );
      await flushMicrotasks();
      // Первичная загрузка подписки не входит в счёт волны.
      counts.set(key, 0);
      return unsub;
    },
    total(): number {
      return [...counts.values()].reduce((sum, n) => sum + n, 0);
    },
  };
}

beforeEach(() => {
  resetQueryRegistry();
  resetEventRouter();
});

describe('realtime-волна: одно перечитывание на окно (96d7f05d)', () => {
  it('13 событий батча агента с паузами → один проход по видимым ключам', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const c = makeCounters();
    const keys = [
      queryKeys.focus('f'),
      queryKeys.structuresPage('x'),
      queryKeys.chronicleFeed('all'),
      queryKeys.publicationsListAll(),
      queryKeys.publicationAssembly('p'),
      queryKeys.indicators('t1'),
      queryKeys.indicators('t2'),
      queryKeys.pins(),
      queryKeys.chronicleThought('t1'),
    ];
    for (const key of keys) await c.subscribe(key);
    assert.equal(c.total(), 0, 'после первичной загрузки счётчики обнулены');

    const wave: AnyRealtimeEvent[] = [
      // 5 связей
      ...Array.from({ length: 5 }, (_, i) =>
        mkEvent(
          'link.created',
          { link: { id: `l${i}`, source_id: i === 0 ? 'f' : `s${i}`, target_id: `t${i}` } },
          i + 1,
        ),
      ),
      // 2 новые мысли
      mkEvent('thought.created', { thought: { id: 'n1', title: 'N1', version: 1 } }, 6),
      mkEvent('thought.created', { thought: { id: 'n2', title: 'N2', version: 1 } }, 7),
      // 3 правки (одна — фокусная)
      mkEvent('thought.updated', { id: 'f', changes: { title: 'F2' }, version: 2 }, 8),
      mkEvent('thought.updated', { id: 't1', changes: { title: 'T1' }, version: 2 }, 9),
      mkEvent('thought.updated', { id: 't2', changes: { title: 'T2' }, version: 2 }, 10),
      // 2 комментария к видимым мыслям
      mkEvent(
        'comment.created',
        { comment: { id: 'c1', owner_id: 't1', owner_type: 'thought', kind: 'permanent' } },
        11,
      ),
      mkEvent(
        'comment.created',
        { comment: { id: 'c2', owner_id: 't2', owner_type: 'thought', kind: 'chronological' } },
        12,
      ),
      // 1 значение свойства
      mkEvent(
        'property-value.set',
        { owner_type: 'thought', owner_id: 'f', property_id: 'p1', value: 'v' },
        13,
      ),
    ];
    assert.equal(wave.length, 13, 'батч агента — 13 событий');

    for (const evt of wave) {
      routeRealtimeEvent(evt, { networkId: NET });
      t.mock.timers.tick(EVENT_GAP_MS);
      await flushMicrotasks();
      assert.equal(
        c.total(),
        0,
        'пока волна не затихла, окно не закрыто — сетевых перечитываний нет',
      );
    }

    t.mock.timers.tick(REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();

    assert.equal(
      c.total(),
      keys.length,
      `одно перечитывание на ключ (ожидалось ${keys.length}, получено ${c.total()})`,
    );
    for (const key of keys) assert.equal(c.counts.get(key), 1, `ключ ${key} перечитан один раз`);
  });

  it('событие чужой сети не попадает в окно', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const c = makeCounters();
    const key = queryKeys.focus('f');
    await c.subscribe(key);

    const res = routeRealtimeEvent(
      mkEvent('thought.updated', { id: 'f', changes: { title: 'X' }, version: 2 }, 1, OTHER_NET),
      { networkId: NET },
    );
    assert.equal(res.routed, false);

    t.mock.timers.tick(REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();
    assert.equal(c.counts.get(key), 0, 'граница сети: чужое событие ничего не перечитывает');
  });

  it('layer.merged — полный ре-синк видимых ключей один раз за окно', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const c = makeCounters();
    const keys = [
      queryKeys.layerOverrides(),
      queryKeys.focus('f'),
      queryKeys.structuresPage('x'),
      queryKeys.chronicleFeed('all'),
    ];
    for (const key of keys) await c.subscribe(key);

    routeRealtimeEvent(mkEvent('layer.merged', {}, 1), { networkId: NET });
    await flushMicrotasks();
    assert.equal(c.total(), 0, 'полный ре-синк отложен окном');

    t.mock.timers.tick(REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();
    for (const key of keys) assert.equal(c.counts.get(key), 1, `ключ ${key} перечитан один раз`);
  });
});

describe('непрерывный поток: жёсткий срок волны (96d7f05d)', () => {
  it('поток каждые 100 мс × 3 с: перечитывание не позже maxWait, финальный проход без дублей', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const c = makeCounters();
    const key = queryKeys.focus('f');
    await c.subscribe(key);

    const gapMs = 100;
    const streamMs = 3000;
    // 31 событие: t = 0, 100, …, 3000 — поток длится ровно 3 с.
    const events = streamMs / gapMs + 1;
    let elapsed = 0;
    let firstFetchAt: number | null = null;
    let seq = 0;

    for (let i = 0; i < events; i += 1) {
      routeRealtimeEvent(
        mkEvent(
          'thought.updated',
          { id: 'f', changes: { title: `T${i}` }, version: i + 2 },
          (seq += 1),
        ),
        { networkId: NET },
      );
      if (i < events - 1) {
        t.mock.timers.tick(gapMs);
        elapsed += gapMs;
      }
      await flushMicrotasks();
      if ((c.counts.get(key) ?? 0) > 0 && firstFetchAt === null) firstFetchAt = elapsed;
    }

    assert.notEqual(firstFetchAt, null, 'за непрерывный поток было хотя бы одно перечитывание');
    assert.ok(
      firstFetchAt! <= REALTIME_REFETCH_MAX_WAIT_MS,
      `первое перечитывание не позже maxWait: ${firstFetchAt} > ${REALTIME_REFETCH_MAX_WAIT_MS}`,
    );
    const atStop = c.counts.get(key) ?? 0;
    assert.ok(
      atStop >= Math.floor(streamMs / REALTIME_REFETCH_MAX_WAIT_MS),
      `поток дал ${atStop} проход(ов) — меньше, чем окон maxWait за 3 с`,
    );

    // После остановки — ровно один финальный проход по накопленной волне.
    t.mock.timers.tick(REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();
    assert.equal(c.counts.get(key), atStop + 1, 'после остановки ровно один финальный проход');

    // Больше тишины — больше проходов нет: дублей не осталось.
    t.mock.timers.tick(REALTIME_REFETCH_MAX_WAIT_MS + REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();
    assert.equal(c.counts.get(key), atStop + 1, 'после финального прохода повторов нет');
  });
});

describe('событие во время полёта: один повтор после завершения (96d7f05d)', () => {
  it('инвалидация во время запроса не теряется и не дублируется', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const key = queryKeys.focus('inflight');
    const resolvers: Array<() => void> = [];
    let fetches = 0;
    const fetcher = (): Promise<void> => {
      fetches += 1;
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    };
    const unsub = subscribeQuery(key, fetcher, () => undefined);
    await flushMicrotasks();
    assert.equal(fetches, 1, 'подписка начала первый запрос');

    // Событие пришло, пока запрос в полёте.
    routeRealtimeEvent(
      mkEvent('thought.updated', { id: 'inflight', changes: { title: 'new' }, version: 2 }, 1),
      { networkId: NET },
    );
    await flushMicrotasks();
    t.mock.timers.tick(REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();
    assert.equal(fetches, 1, 'пока запрос в полёте, второй параллельно не запускается');

    resolvers[0]!();
    await flushMicrotasks();
    assert.equal(fetches, 1, 'повтор отложен до закрытия окна, а не запущен сразу');

    t.mock.timers.tick(REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();
    assert.equal(fetches, 2, 'после завершения запроса — ровно одно перечитывание');

    resolvers[1]!();
    await flushMicrotasks();
    t.mock.timers.tick(REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();
    assert.equal(fetches, 2, 'третьего запроса нет: повторы схлопнуты');
    unsub();
  });

  it('действие пользователя не ждёт realtime-окна', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const key = queryKeys.focus('user');
    // Ключ зарегистрирован, но не подписан: realtime-событие лишь гасит его.
    registerQuery(key, async () => undefined);
    routeRealtimeEvent(
      mkEvent('thought.updated', { id: 'user', changes: { title: 'x' }, version: 2 }, 1),
      { networkId: NET },
    );

    let fetches = 0;
    const unsub = subscribeQuery(
      key,
      async () => {
        fetches += 1;
        return undefined;
      },
      () => undefined,
    );
    await flushMicrotasks();
    assert.equal(fetches, 1, 'подписка (открытие панели) читает сразу, окно не ждёт');

    // Явный перезапрос тоже немедленный.
    void refetchQuery(key);
    await flushMicrotasks();
    assert.equal(fetches, 2, 'refetchQuery не задерживается окном');
    unsub();
    t.mock.timers.tick(REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();
  });
});
