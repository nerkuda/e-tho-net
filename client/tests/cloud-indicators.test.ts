/**
 * Регрессы счётчиков-индикаторов облачков (ошибка 46bda0e8, корень 3).
 *
 * Симптом до фикса: `fetchIndicatorCounts` подписывал мысль навсегда — уход
 * облачка из видимой зоны виртуализированного холста (скролл, смена фокуса)
 * или из свёрнутого дерева «Структур» не снимал подписку. Каждая волна
 * `indicatorsAll` (ресинк после смены слоя, `comment.updated`/
 * `attachment.updated`) перечитывала пару comments.list+attachments.list на
 * КАЖДУЮ когда-либо показанную мысль (за день диагностики 2505+2437 запросов),
 * а серверный пул тяжёлых чтений (1–3 воркера) выстраивал «лестницу».
 *
 * Целевое поведение (проверяется здесь):
 *  1. «подписка = видимость»: повторный набор видимых мыслей не тянет
 *     счётчики заново, на N видимых строк — ровно по паре запросов;
 *  2. ушедшие из видимой зоны отписываются: волна инвалидации
 *     `indicatorsAll` стоит 2 запроса × (число ВИДИМЫХ строк), а не историю
 *     посещений;
 *  3. два владельца (холст и дерево «Структур») делят одну подписку: снятие
 *     одного не отписывает мысль, видимую у другого;
 *  4. параллелизм волны ограничен — не больше
 *     `INDICATOR_MAX_CONCURRENT_FETCHES` одновременных пар за раз.
 *
 * Тест входит в обычный прогон `npm -w @etn/client test`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

const NETWORK_ID = '00000000-0000-4000-8000-0000000000c9';

type CloudIndicatorsModule = typeof import('../src/renderer/lib/cloud-indicators.js');
type LiveModule = typeof import('../src/renderer/lib/live/index.js');
type StateModule = typeof import('../src/renderer/state.js');

let indicators: CloudIndicatorsModule;
let live: LiveModule;
let store: StateModule['store'];

/** id мыслей, по которым ушёл запрос comments.list / attachments.list. */
let commentCalls: string[] = [];
let attachmentCalls: string[] = [];
/** Текущее и пиковое число одновременных пар чтений (комментарии+вложения). */
let activeFetches = 0;
let maxActiveFetches = 0;
/** Задержка ответа мока, мс — чтобы волна реально шла параллельно. */
let fetchDelayMs = 0;

function installApi(): void {
  commentCalls = [];
  attachmentCalls = [];
  activeFetches = 0;
  maxActiveFetches = 0;
  fetchDelayMs = 0;
  const delay = async (): Promise<void> => {
    if (fetchDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, fetchDelayMs));
  };
  const api = {
    comments: {
      list: async (_networkId: string, _ownerType: string, id: string) => {
        commentCalls.push(id);
        await delay();
        return [{ kind: 'permanent' }, { kind: 'chronological' }];
      },
    },
    attachments: {
      list: async (_networkId: string, _ownerType: string, id: string) => {
        attachmentCalls.push(id);
        await delay();
        return [];
      },
    },
  };
  (globalThis as any).etn = api;
}

/** Дождаться микротасок, таймеров и ответов моков. */
async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function ids(count: number, prefix = 't'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

before(async () => {
  // `applyIndicators` патчит реальные облачка: в юнит-тесте их нет.
  (globalThis as any).document = { querySelectorAll: () => [] as unknown[] };
  store = (await import('../src/renderer/state.js')).store;
  live = await import('../src/renderer/lib/live/index.js');
  indicators = await import('../src/renderer/lib/cloud-indicators.js');
});

beforeEach(() => {
  store.update({ networkId: null });
  indicators.resetCloudIndicatorSubscriptions();
  indicators.cloudIndicatorInternals.resetConcurrencyMetric();
  live.resetQueryRegistry();
  store.update({ networkId: NETWORK_ID });
  installApi();
});

describe('индикаторы облачков: «подписка = видимость» (ошибка 46bda0e8)', () => {
  it('на N видимых строк — по паре запросов, повторный набор не перечитывает', async () => {
    const visible = ids(5);
    indicators.setCloudIndicatorInterest('canvas', visible);
    await settle();

    assert.deepEqual([...commentCalls].sort(), visible, 'comments.list — по одному на видимую мысль');
    assert.deepEqual(
      [...attachmentCalls].sort(),
      visible,
      'attachments.list — по одному на видимую мысль',
    );

    commentCalls = [];
    attachmentCalls = [];
    indicators.setCloudIndicatorInterest('canvas', visible);
    await settle();
    assert.deepEqual(commentCalls, [], 'повторная отрисовка того же набора не идёт в сеть');
    assert.deepEqual(attachmentCalls, [], 'повторная отрисовка того же набора не идёт в сеть');
  });

  it('ушедшие из видимой зоны снимаются: волна indicatorsAll не перечитывает историю', async () => {
    // Долгая прокрутка «посетила» 60 мыслей, на экране осталось 5.
    indicators.setCloudIndicatorInterest('canvas', ids(60));
    await settle(120);
    indicators.setCloudIndicatorInterest('canvas', ids(5));
    await settle();

    const visible = ids(5);
    commentCalls = [];
    attachmentCalls = [];
    live.invalidateQueries(live.queryKeys.indicatorsAll(), live.LOCAL_CAUSE);
    await settle(120);

    assert.deepEqual(
      [...commentCalls].sort(),
      visible,
      'ресинк слоя/правка комментария опрашивает только видимые мысли',
    );
    assert.deepEqual(
      [...attachmentCalls].sort(),
      visible,
      'ресинк слоя/правка вложения опрашивает только видимые мысли',
    );
    assert.equal(indicators.cloudIndicatorInternals.subscriberCount(), 5, 'подписок ровно по видимым');
  });

  it('два владельца делят подписку: холст и дерево «Структур»', async () => {
    indicators.setCloudIndicatorInterest('canvas', ['x', 'y']);
    await settle();
    commentCalls = [];
    attachmentCalls = [];

    indicators.setCloudIndicatorInterest('structures', ['y', 'z']);
    await settle();
    assert.deepEqual(commentCalls, ['z'], 'общая с холстом мысль не запрашивается второй раз');

    indicators.releaseCloudIndicatorInterest('canvas');
    commentCalls = [];
    attachmentCalls = [];
    live.invalidateQueries(live.queryKeys.indicatorsAll(), live.LOCAL_CAUSE);
    await settle();

    assert.deepEqual(
      [...commentCalls].sort(),
      ['y', 'z'],
      'мысль, видимая в дереве, остаётся подписанной после ухода холста',
    );
  });

  it('параллелизм волны ограничен', async () => {
    fetchDelayMs = 5;
    const api = (globalThis as any).etn as {
      comments: { list: (...args: unknown[]) => Promise<unknown> };
    };
    // Одна «пара» чтений = один вызов comments.list (вложения идут рядом).
    const original = api.comments.list;
    api.comments.list = async (...args: unknown[]) => {
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      try {
        return await original(...args);
      } finally {
        activeFetches -= 1;
      }
    };

    indicators.setCloudIndicatorInterest('canvas', ids(12));
    await settle(120);

    assert.equal(commentCalls.length, 12, 'все видимые мысли опрошены');
    assert.ok(
      maxActiveFetches <= indicators.INDICATOR_MAX_CONCURRENT_FETCHES,
      `одновременных чтений ${maxActiveFetches} при лимите ${indicators.INDICATOR_MAX_CONCURRENT_FETCHES}`,
    );
    assert.equal(
      maxActiveFetches,
      indicators.INDICATOR_MAX_CONCURRENT_FETCHES,
      'лимит используется полностью: волна идёт параллельно, а не по одному',
    );
    assert.equal(
      indicators.cloudIndicatorInternals.maxConcurrentFetches(),
      indicators.INDICATOR_MAX_CONCURRENT_FETCHES,
      'модуль ведёт тот же пик (лимит внутри, а не в тестовой обёртке)',
    );
  });
});
