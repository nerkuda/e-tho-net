/**
 * Юнит-тесты реактивного слоя данных (этап G1 техпроекта `269016e2`).
 *
 * Покрывают: нормализованный кэш (structural sharing, версионный дедуп),
 * реактивный примитив (контракт Svelte + батч в микротаске), реестр запросов
 * (статусы, рефетч только активных наблюдателей, инвалидация по префиксу),
 * роутер событий (таблица, дедуп по seq, граница сети), mutator (кэш + откат) и
 * сценарий «своя правка = чужая». Отдельный подтест паритета эмулирует поток
 * событий сети и мутаций и доказывает, что роутер гасит ровно ожидаемые ключи.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { AnyRealtimeEvent, RealtimeEventType } from '@etn/shared';

import {
  clearEntities,
  commitEntity,
  entityStore,
  entitiesSnapshot,
  getEntity,
  getQueryState,
  getRecord,
  invalidateQueries,
  optimisticEntityPatch,
  patchEntity,
  putEntity,
  queryKeys,
  queryStore,
  registerQuery,
  resetEventRouter,
  resetQueryRegistry,
  routeRealtimeEvent,
  runOptimistic,
  setQueryData,
  subscribeQuery,
  writable,
  derived,
  type QueryState,
} from '../src/renderer/lib/live/index.js';

const NET = '00000000-0000-4000-8000-0000000000aa';

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mkEvent(type: RealtimeEventType, data: unknown, seq: number, networkId = NET): AnyRealtimeEvent {
  return {
    type,
    seq,
    ts: '2026-10-03T00:00:00.000Z',
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: networkId,
    audience: 'network',
    data,
    layer_id: '00000000-0000-0000-0000-000000000000',
  } as unknown as AnyRealtimeEvent;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/**
 * Зарегистрировать «живые» запросы экранов: инвалидация по ключу действует
 * только на записи реестра, поэтому тесты паритета заранее объявляют набор
 * ключей и проверяют, что роутер погасил ровно нужное подмножество.
 */
function registerLive(keys: string[]): void {
  for (const key of keys) registerQuery(key, async () => undefined);
}

beforeEach(() => {
  clearEntities();
  resetQueryRegistry();
  resetEventRouter();
});

describe('кэш сущностей', () => {
  it('put/get и удаление', () => {
    putEntity('thought', 't1', { id: 't1', title: 'A', version: 1 });
    assert.equal(asRecord(getEntity('thought', 't1'))['title'], 'A');
    assert.equal(entitiesSnapshot().length, 1);
    putEntity('link', 'l1', { id: 'l1' });
    assert.equal(entitiesSnapshot().length, 2);
    assert.equal(getEntity('thought', 'missing'), undefined);
  });

  it('structural sharing: no-op патч сохраняет ссылку, изменённый — переиспользует вложенные', () => {
    putEntity('thought', 't1', { id: 't1', title: 'A', nested: { x: 1 }, version: 1 });
    const rec1 = getRecord('thought', 't1')!;
    patchEntity('thought', 't1', { title: 'A' });
    const rec2 = getRecord('thought', 't1')!;
    assert.equal(rec2.entity, rec1.entity, 'патч без изменений обязан вернуть ту же ссылку');

    patchEntity('thought', 't1', { title: 'B' });
    const rec3 = getRecord('thought', 't1')!;
    assert.notEqual(rec3.entity, rec2.entity, 'реальное изменение даёт новый объект');
    assert.equal(
      asRecord(rec3.entity)['nested'],
      asRecord(rec2.entity)['nested'],
      'неизменённое вложенное поле переиспользует ссылку',
    );
  });

  it('версионный дедуп: патч со старым seq не откатывает свежее значение', () => {
    putEntity('thought', 't1', { id: 't1', title: 'new', version: 2 }, { seq: 10 });
    patchEntity('thought', 't1', { title: 'old' }, { seq: 5 });
    assert.equal(asRecord(getEntity('thought', 't1'))['title'], 'new');
  });

  it('реактивный срез сущности обновляется', async () => {
    const seen: Array<string | undefined> = [];
    const unsub = entityStore<{ title: string }>('thought', 't1').subscribe((v) => seen.push(v?.title));
    putEntity('thought', 't1', { id: 't1', title: 'A' });
    await settle();
    assert.deepEqual(seen, [undefined, 'A']);
    unsub();
  });
});

describe('реактивный примитив', () => {
  it('subscribe немедленно отдаёт значение, set уведомляет батчем в микротаске', async () => {
    const store = writable(0);
    const seen: number[] = [];
    store.subscribe((v) => seen.push(v));
    assert.deepEqual(seen, [0], 'начальный вызов синхронный');
    store.set(1);
    store.set(2);
    store.set(3);
    assert.deepEqual(seen, [0], 'до микротаска уведомлений нет — идёт батч');
    await settle();
    assert.deepEqual(seen, [0, 3], 'пачка даёт одно уведомление с финальным значением');
  });

  it('derived пересчитывает срез и отписывается от источников', async () => {
    const store = writable({ a: 1, b: 2 });
    const title = derived(store, (vals) => vals[0]!.a * 10);
    const seen: number[] = [];
    const unsub = title.subscribe((v) => seen.push(v));
    assert.deepEqual(seen, [10]);
    store.set({ a: 2, b: 2 });
    await settle();
    assert.deepEqual(seen, [10, 20]);
    unsub();
    store.set({ a: 3, b: 2 });
    await settle();
    assert.deepEqual(seen, [10, 20], 'после отписки уведомлений нет');
  });
});

describe('реестр запросов', () => {
  it('рефетч только при активном наблюдателе; статусы loading→fresh', async () => {
    let calls = 0;
    const fetcher = async (): Promise<{ n: number }> => {
      calls += 1;
      return { n: 42 };
    };
    invalidateQueries(queryKeys.focus('t1'));
    await settle();
    assert.equal(calls, 0, 'без наблюдателя инвалидация не ходит в сеть');

    const states: QueryState<{ n: number }>[] = [];
    const unsub = subscribeQuery(queryKeys.focus('t1'), fetcher, (s) => states.push(s));
    assert.equal(states[0]!.status, 'stale', 'первое состояние — stale без данных');
    await settle();
    assert.equal(calls, 1, 'подписка запускает запрос');
    assert.equal(getQueryState<{ n: number }>(queryKeys.focus('t1')).status, 'fresh');
    assert.equal(states.at(-1)!.status, 'fresh');
    unsub();
  });

  it('инвалидация по префиксу гасит ровно совпадающие ключи', () => {
    subscribeQuery(queryKeys.focus('t1'), async () => 1, () => undefined);
    subscribeQuery(queryKeys.focus('t2'), async () => 2, () => undefined);
    subscribeQuery(queryKeys.structuresPage('f'), async () => 3, () => undefined);
    const touched = invalidateQueries('focus');
    assert.deepEqual(touched, [queryKeys.focus('t1'), queryKeys.focus('t2')]);
  });

  it('setQueryData кладёт данные как fresh', () => {
    setQueryData('custom:1', { ok: true });
    const state = getQueryState<{ ok: boolean }>('custom:1');
    assert.equal(state.status, 'fresh');
    assert.deepEqual(state.data, { ok: true });
  });

  it('queryStore — реактивный срез состояния', async () => {
    const store = queryStore(queryKeys.pins(), async () => ['a', 'b']);
    const seen: string[][] = [];
    const unsub = store.subscribe((s) => seen.push(s.data ?? []));
    await settle();
    assert.deepEqual(seen.at(-1), ['a', 'b']);
    unsub();
  });

  it('блокер 1: setQueryData не обнуляет fetcher — инвалидация перезапрашивает', async () => {
    let calls = 0;
    const fetcher = async (): Promise<{ n: number }> => {
      calls += 1;
      return { n: calls };
    };
    const key = 'blk1:key';
    const unsub = subscribeQuery(key, fetcher, () => undefined);
    await settle();
    assert.equal(calls, 1, 'подписка запустила запрос');

    setQueryData(key, { n: 100 });
    assert.equal(getQueryState<{ n: number }>(key).status, 'fresh');

    invalidateQueries(key);
    await settle();
    assert.equal(calls, 2, 'fetcher жив: ключ перезапрашивается после мутации');
    assert.equal(getQueryState<{ n: number }>(key).data?.n, 2);
    unsub();
  });

  it('блокер 2: устаревший фетч не затирает результат мутации', async () => {
    let resolveFetch: ((value: string) => void) | undefined;
    const fetcher = (): Promise<string> =>
      new Promise<string>((resolve) => {
        resolveFetch = resolve;
      });
    const key = 'blk2:key';
    const unsub = subscribeQuery(key, fetcher, () => undefined); // запрос в полёте

    // Пока фетч в полёте, пришла свежая мутация.
    setQueryData(key, 'MUTATION');
    assert.equal(getQueryState<string>(key).data, 'MUTATION');

    // Старый ответ приходит после — он обязан быть отброшен по версии записи.
    resolveFetch?.('STALE_FETCH');
    await settle();
    assert.equal(
      getQueryState<string>(key).data,
      'MUTATION',
      'поздний фетч не должен затирать свежий результат мутации',
    );
    unsub();
  });
});

describe('роутер событий', () => {
  it('thought.updated: патчит кэш и гасит ожидаемые ключи', () => {
    putEntity('thought', 't1', { id: 't1', title: 'old', version: 1 });
    registerLive([
      queryKeys.focus('t1'),
      queryKeys.focus('other'),
      queryKeys.structuresPageAll(),
      queryKeys.chronicleThought('t1'),
      queryKeys.pins(),
      queryKeys.publicationAssembly('p1'),
      queryKeys.indicators('t1'),
      queryKeys.publicationsListAll(),
      queryKeys.history(),
    ]);
    const res = routeRealtimeEvent(
      mkEvent('thought.updated', { id: 't1', changes: { title: 'new' }, version: 2 }, 1),
      { networkId: NET },
    );
    assert.equal(res.routed, true);
    assert.deepEqual(res.patched, ['thought:t1']);
    assert.equal(asRecord(getEntity('thought', 't1'))['title'], 'new');
    // Чужие ключи (focus:@other, indicators:@t1, publications-list, history)
    // НЕ задеты — маршрут адресный. Лента «Дневника» гасится адресно ключом
    // мысли (G3): невидимая правка `focus:@other`-подобных ключей не трогает.
    assert.deepEqual(res.invalidated, [
      queryKeys.chronicleThought('t1'),
      queryKeys.focus('t1'),
      queryKeys.pins(),
      queryKeys.publicationAssembly('p1'),
      queryKeys.structuresPageAll(),
    ].sort());
  });

  it('дедуп по seq: повтор и опоздавшее событие игнорируются', () => {
    const first = routeRealtimeEvent(mkEvent('thought.deleted', { id: 't9' }, 7), { networkId: NET });
    assert.equal(first.routed, true);
    const again = routeRealtimeEvent(mkEvent('thought.deleted', { id: 't9' }, 7), { networkId: NET });
    assert.equal(again.routed, false);
    assert.equal(again.reason, 'stale');
    const older = routeRealtimeEvent(mkEvent('thought.deleted', { id: 't9' }, 6), { networkId: NET });
    assert.equal(older.reason, 'stale');
  });

  it('граница сети: событие чужой сети не маршрутизируется', () => {
    const res = routeRealtimeEvent(
      mkEvent('thought.deleted', { id: 'x' }, 3, 'other-network'),
      { networkId: NET },
    );
    assert.equal(res.routed, false);
    assert.equal(res.reason, 'foreign');
  });

  it('намеренно игнорируемый тип даёт reason «ignored»', () => {
    const res = routeRealtimeEvent(mkEvent('presence.joined', { user_id: 'u' }, 4), { networkId: NET });
    assert.equal(res.routed, false);
    assert.equal(res.reason, 'ignored');
  });

  it('патч кэша синхронизирует запись реестра entity:@kind:@id (замечание 3)', async () => {
    const key = queryKeys.entity('thought', 't1');
    const unsub = subscribeQuery(key, async () => ({ id: 't1', title: 'old', version: 1 }), () => undefined);
    await settle();
    assert.equal(asRecord(getQueryState<Record<string, unknown>>(key).data)['title'], 'old');

    routeRealtimeEvent(
      mkEvent('thought.updated', { id: 't1', changes: { title: 'new' }, version: 2 }, 1),
      { networkId: NET },
    );
    assert.equal(
      asRecord(getQueryState<Record<string, unknown>>(key).data)['title'],
      'new',
      'роутер обязан обновить запись-проекцию, а не только нормализованный кэш',
    );
    unsub();
  });
});

describe('mutator-слой', () => {
  it('commitEntity кладёт сущность и её запись-проекцию', () => {
    commitEntity('thought', 't1', { id: 't1', title: 'A', version: 1 });
    assert.equal(asRecord(getEntity('thought', 't1'))['title'], 'A');
    assert.equal(getQueryState(queryKeys.entity('thought', 't1')).status, 'fresh');
  });

  it('optimisticEntityPatch откатывает кэш при ошибке мутации', async () => {
    commitEntity('thought', 't1', { id: 't1', title: 'A', version: 1 });
    await assert.rejects(
      optimisticEntityPatch('thought', 't1', { title: 'B' }, async () => {
        throw new Error('network down');
      }),
    );
    assert.equal(asRecord(getEntity('thought', 't1'))['title'], 'A', 'ошибка мутации откатила патч');
  });

  it('runOptimistic применяет, откатывает и пропускает успех', async () => {
    let value = 1;
    const result = await runOptimistic<number, string>({
      snapshot: () => value,
      apply: () => {
        value = 2;
      },
      rollback: (snap) => {
        value = snap;
      },
      execute: async () => 'ok',
    });
    assert.equal(result, 'ok');
    assert.equal(value, 2);

    let failed = 1;
    await assert.rejects(
      runOptimistic<number, void>({
        snapshot: () => failed,
        apply: () => {
          failed = 99;
        },
        rollback: (snap) => {
          failed = snap;
        },
        execute: async () => {
          throw new Error('boom');
        },
      }),
    );
    assert.equal(failed, 1);
  });

  it('«своя правка = чужая»: мутация и событие дают одинаковое состояние кэша', () => {
    const base = { id: 't1', title: 'Old', fg_color: null, version: 1 };
    commitEntity('thought', 't1', base);

    // 1) Своя правка: REST вернул новый снимок — кладём в кэш.
    const edited = { id: 't1', title: 'New', fg_color: '#abc', version: 2 };
    commitEntity('thought', 't1', edited);
    const afterOwn = getRecord('thought', 't1')!.entity;

    // 2) Чужая правка пришла событием с теми же изменениями.
    routeRealtimeEvent(
      mkEvent('thought.updated', { id: 't1', changes: { title: 'New', fg_color: '#abc' }, version: 2 }, 5),
      { networkId: NET },
    );
    const afterRemote = getRecord('thought', 't1')!.entity;

    assert.deepEqual(afterRemote, afterOwn, 'оба пути дают одно состояние');
    assert.equal(afterRemote, afterOwn, 'structural sharing — сравнение по ссылке');
  });
});

describe('паритет: поток событий сети гасит ровно ожидаемые ключи', () => {
  it('последовательность thought.created → thought.updated → comment.created', () => {
    const focusId = '00000000-0000-4000-8000-000000000100';
    registerLive([
      queryKeys.focus(focusId),
      queryKeys.focus('other'),
      queryKeys.structuresPageAll(),
      queryKeys.chronicleFeedAll(),
      queryKeys.chronicleThought(focusId),
      queryKeys.publicationsListAll(),
      queryKeys.indicators(focusId),
      queryKeys.indicators('other'),
      queryKeys.pins(),
      queryKeys.publicationAssembly('p1'),
    ]);

    const created = routeRealtimeEvent(
      mkEvent('thought.created', { thought: { id: focusId, title: 'T', version: 1 } }, 1),
      { networkId: NET },
    );
    assert.deepEqual(
      created.invalidated,
      [
        'chronicle-feed',
        `focus:@${focusId}`,
        'focus:@other',
        `indicators:@${focusId}`,
        'publications-list',
        'structures-page',
      ].sort(),
    );
    assert.deepEqual(created.patched, [`thought:${focusId}`]);

    const updated = routeRealtimeEvent(
      mkEvent('thought.updated', { id: focusId, changes: { title: 'T2' }, version: 2 }, 2),
      { networkId: NET },
    );
    assert.deepEqual(
      updated.invalidated,
      [
        `chronicle-thought:@${focusId}`,
        `focus:@${focusId}`,
        'pins',
        'pub-assembly:@p1',
        'structures-page',
      ].sort(),
    );

    const comment = routeRealtimeEvent(
      mkEvent('comment.created', { comment: { id: 'c1', owner_id: focusId, owner_type: 'thought', kind: 'permanent' } }, 3),
      { networkId: NET },
    );
    assert.deepEqual(
      comment.invalidated,
      ['chronicle-feed', `indicators:@${focusId}`, 'pub-assembly:@p1'].sort(),
    );
    assert.deepEqual(comment.patched, ['comment:c1']);
  });

  it('публикации/полки/вложения/свойства/слои (замечание 6)', () => {
    const P1 = 'p1';
    registerLive([
      queryKeys.focus('t1'),
      queryKeys.focus('other'),
      queryKeys.structuresPageAll(),
      queryKeys.chronicleFeedAll(),
      queryKeys.publicationsListAll(),
      queryKeys.shelves(),
      queryKeys.publicationCard(P1),
      queryKeys.publicationAssembly(P1),
      queryKeys.indicators('t1'),
      queryKeys.indicators('other'),
      queryKeys.attachments('thought', 't1'),
      queryKeys.layerOverrides(),
    ]);

    // publication.updated — патч публикации + список/карточка/документ.
    const pubUpdated = routeRealtimeEvent(
      mkEvent('publication.updated', { id: P1, changes: { title: 'X' }, version: 2 }, 1),
      { networkId: NET },
    );
    assert.deepEqual(pubUpdated.patched, [`publication:${P1}`]);
    assert.deepEqual(
      pubUpdated.invalidated,
      ['publications-list', `pub-card:@${P1}`, `pub-assembly:@${P1}`].sort(),
    );

    // publication.purged — удаление сущности + те же ключи.
    const pubPurged = routeRealtimeEvent(mkEvent('publication.purged', { id: P1 }, 2), { networkId: NET });
    assert.deepEqual(pubPurged.patched, [`publication:${P1}`]);
    assert.deepEqual(
      pubPurged.invalidated,
      ['publications-list', `pub-card:@${P1}`, `pub-assembly:@${P1}`].sort(),
    );

    // shelf.updated — патч полки + список полок/библиотеки.
    const shelf = routeRealtimeEvent(
      mkEvent('shelf.updated', { shelf: { id: 's1', title: 'S' } }, 3),
      { networkId: NET },
    );
    assert.deepEqual(shelf.patched, ['shelf:s1']);
    assert.deepEqual(shelf.invalidated, ['publications-list', 'shelves'].sort());

    // attachment.created — владелец известен: адресные ключи.
    const attCreated = routeRealtimeEvent(
      mkEvent('attachment.created', { attachment: { id: 'a1', owner_type: 'thought', owner_id: 't1' } }, 4),
      { networkId: NET },
    );
    assert.deepEqual(attCreated.patched, ['attachment:a1']);
    assert.deepEqual(
      attCreated.invalidated,
      ['focus:@t1', 'indicators:@t1', 'attachments:@thought:@t1'].sort(),
    );

    // attachment.deleted — владельца в payload нет: сброс всех наборов (broad).
    const attDeleted = routeRealtimeEvent(mkEvent('attachment.deleted', { id: 'a1' }, 5), { networkId: NET });
    assert.deepEqual(attDeleted.patched, ['attachment:a1']);
    assert.deepEqual(
      attDeleted.invalidated,
      ['indicators:@t1', 'indicators:@other', 'attachments:@thought:@t1'].sort(),
    );

    // property-value.set — окрестность владельца-мысли.
    const propSet = routeRealtimeEvent(
      mkEvent('property-value.set', { owner_type: 'thought', owner_id: 't1', property_id: 'pp', value: 'v' }, 6),
      { networkId: NET },
    );
    assert.deepEqual(propSet.patched, []);
    assert.deepEqual(
      propSet.invalidated,
      [
        'chronicle-feed',
        'focus:@t1',
        'focus:@other',
        'publications-list',
        'structures-page',
      ].sort(),
    );

    // layer.merged — полный ре-синк видимого состояния.
    const layer = routeRealtimeEvent(mkEvent('layer.merged', {}, 7), { networkId: NET });
    assert.deepEqual(
      layer.invalidated,
      [
        'chronicle-feed',
        'focus:@t1',
        'focus:@other',
        'layer-overrides',
        'structures-page',
      ].sort(),
    );
  });
});
