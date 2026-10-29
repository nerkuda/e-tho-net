/**
 * Гейт дедупликации in-flight GET через границу изменения (ошибка da7bbb53).
 *
 * `RestClient` склеивает одинаковые параллельные GET — но только внутри одной
 * эпохи чтения. Медленный ответ, вычисленный ДО изменения данных (своя мутация
 * или применённое data-событие realtime), не должен переиспользоваться чтением,
 * начатым после изменения: иначе панель «Свойства» получает снимок до правки
 * (`properties.ts` считает его успешным чтением и снимает dirty-метку).
 *
 * Ответы держатся на ручном релизе, поэтому тест доказывает именно гонку:
 * старый GET ещё в полёте, данные уже изменились, повторное чтение обязано
 * уйти новым запросом. Мутации гейта: убрать инвалидацию в `performRequest`,
 * `invalidateInFlightReads` или completion-boundary — соответствующий кейс
 * краснеет (проверено в отчёте ошибки).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RestClient } from '../src/main/net/rest-client.js';

const NET = '123e4567-e89b-12d3-a456-426614174000';
const THOUGHT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

interface FetchCall {
  url: string;
  method: string;
}

/**
 * Fetch-заглушка с ручным релизом тела КАЖДОГО ответа: `fetch` разрешается
 * сразу, а `text()` ждёт `resolveBody(index)`. Так запрос остаётся «в полёте»
 * столько, сколько нужно тесту, и порядок доставки ответов не зависит от
 * таймеров.
 */
function makeControlledFetch(): {
  fetch: typeof fetch;
  calls: FetchCall[];
  resolveBody: (index: number, data: unknown, meta?: unknown) => void;
} {
  const calls: FetchCall[] = [];
  const bodies = new Map<number, string>();
  const releases = new Map<number, () => void>();

  const fetchStub = ((url: string, init?: RequestInit): Promise<Response> => {
    const index = calls.length;
    calls.push({ url, method: init?.method ?? 'GET' });
    const gate = new Promise<void>((resolve) => {
      releases.set(index, resolve);
    });
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async (): Promise<string> => {
        await gate;
        return bodies.get(index) ?? '';
      },
      json: async (): Promise<unknown> => JSON.parse(bodies.get(index) ?? 'null'),
    } as unknown as Response;
    return Promise.resolve(response);
  }) as unknown as typeof fetch;

  return {
    fetch: fetchStub,
    calls,
    resolveBody: (index: number, data: unknown, meta?: unknown): void => {
      const release = releases.get(index);
      if (release === undefined) throw new Error(`нет ожидающего запроса #${index}`);
      bodies.set(index, JSON.stringify(meta === undefined ? { data } : { data, meta }));
      releases.delete(index);
      release();
    },
  };
}

function makeClient(fetchImpl: typeof fetch): RestClient {
  return new RestClient({
    baseUrl: 'http://localhost:3000',
    getApiKey: async () => 'etn_testkey',
    getClientId: () => '11111111-1111-1111-1111-111111111111',
    fetchImpl,
    random: () => 0,
  });
}

/** Отдаёт очередь макрозадач: `fetch` уходит после асинхронного резолва ключа. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('RestClient — эпоха чтения и дедупликация in-flight GET (da7bbb53)', () => {
  it('склеивает одинаковые параллельные GET, пока данных не меняли', async () => {
    const stub = makeControlledFetch();
    const client = makeClient(stub.fetch);

    const first = client.listThoughtProperties(NET, THOUGHT);
    const second = client.listThoughtProperties(NET, THOUGHT);
    await tick();

    assert.equal(stub.calls.length, 1, 'параллельные одинаковые GET должны склеиться');
    stub.resolveBody(0, [{ property_name: 'Tags', value: 'old' }]);

    assert.deepEqual(await first, [{ property_name: 'Tags', value: 'old' }]);
    assert.deepEqual(await second, [{ property_name: 'Tags', value: 'old' }]);
    assert.equal(stub.calls.length, 1);
  });

  it('своя мутация инвалидирует GET в полёте: повторное чтение — новый запрос и новое значение', async () => {
    const stub = makeControlledFetch();
    const client = makeClient(stub.fetch);

    // GET P1 «в полёте»: ответ вычислен до правки, доставка придержана.
    const stale = client.listThoughtProperties(NET, THOUGHT);
    await tick();
    assert.equal(stub.calls.length, 1);

    const mutation = client.setThoughtProperty(NET, THOUGHT, 'Tags', 'new');
    await tick();

    // Чтение после начала мутации не переиспользует старый GET.
    const fresh = client.listThoughtProperties(NET, THOUGHT);
    await tick();
    assert.equal(stub.calls.length, 3, 'повторное чтение обязано уйти новым GET');

    stub.resolveBody(0, [{ property_name: 'Tags', value: 'old' }]);
    stub.resolveBody(1, { property_name: 'Tags', value: 'new' });
    stub.resolveBody(2, [{ property_name: 'Tags', value: 'new' }]);

    assert.deepEqual(await stale, [{ property_name: 'Tags', value: 'old' }]);
    await mutation;
    assert.deepEqual(await fresh, [{ property_name: 'Tags', value: 'new' }]);
  });

  it('data-событие realtime (invalidateInFlightReads) инвалидирует GET в полёте', async () => {
    const stub = makeControlledFetch();
    const client = makeClient(stub.fetch);

    const stale = client.listThoughtProperties(NET, THOUGHT);
    await tick();
    assert.equal(stub.calls.length, 1);

    // Так main реагирует на применённое data-событие (property-value.set и др.).
    client.invalidateInFlightReads();

    const fresh = client.listThoughtProperties(NET, THOUGHT);
    await tick();
    assert.equal(stub.calls.length, 2, 'чтение после события обязано уйти новым GET');

    stub.resolveBody(0, [{ property_name: 'Outside', value: 'старое' }]);
    stub.resolveBody(1, [{ property_name: 'Outside', value: 'новое' }]);

    assert.deepEqual(await stale, [{ property_name: 'Outside', value: 'старое' }]);
    assert.deepEqual(await fresh, [{ property_name: 'Outside', value: 'новое' }]);
  });

  it('завершение мутации инвалидирует GET, начатый во время неё', async () => {
    const stub = makeControlledFetch();
    const client = makeClient(stub.fetch);

    const stale = client.listThoughtProperties(NET, THOUGHT);
    await tick();
    const mutation = client.setThoughtProperty(NET, THOUGHT, 'Tags', 'new');
    await tick();
    // Чтение, начатое уже после отправки мутации, но до её завершения: сервер
    // мог вычислить его ДО коммита, поэтому после ответа мутации оно не годится.
    const mid = client.listThoughtProperties(NET, THOUGHT);
    await tick();
    assert.equal(stub.calls.length, 3);

    stub.resolveBody(1, { property_name: 'Tags', value: 'new' });
    await mutation;

    const after = client.listThoughtProperties(NET, THOUGHT);
    await tick();
    assert.equal(stub.calls.length, 4, 'после завершения мутации повторное чтение — новый GET');

    stub.resolveBody(0, [{ property_name: 'Tags', value: 'old' }]);
    stub.resolveBody(2, [{ property_name: 'Tags', value: 'mid' }]);
    stub.resolveBody(3, [{ property_name: 'Tags', value: 'new' }]);

    assert.deepEqual(await stale, [{ property_name: 'Tags', value: 'old' }]);
    assert.deepEqual(await mid, [{ property_name: 'Tags', value: 'mid' }]);
    assert.deepEqual(await after, [{ property_name: 'Tags', value: 'new' }]);
  });

  it('read-only idempotent POST не двигает эпоху — GET продолжает склеиваться', async () => {
    const stub = makeControlledFetch();
    const client = makeClient(stub.fetch);

    const first = client.listThoughtProperties(NET, THOUGHT);
    await tick();
    // Прогон отбора — POST, но объявлен read-only (`idempotentPost`).
    const run = client.runThoughtTypeView(NET, THOUGHT, 'view');
    await tick();
    const second = client.listThoughtProperties(NET, THOUGHT);
    await tick();

    assert.equal(stub.calls.length, 2, 'read-only POST не является границей изменения');

    stub.resolveBody(0, [{ property_name: 'Tags', value: 'old' }]);
    stub.resolveBody(1, []);
    assert.deepEqual(await first, [{ property_name: 'Tags', value: 'old' }]);
    assert.deepEqual((await second).length, 1);
    await run;
  });

  it('read-only idempotent POST тоже не переиспользуется через границу изменения', async () => {
    const stub = makeControlledFetch();
    const client = makeClient(stub.fetch);

    const stale = client.runThoughtTypeView(NET, THOUGHT, 'view');
    await tick();
    assert.equal(stub.calls.length, 1);

    client.invalidateInFlightReads();

    const fresh = client.runThoughtTypeView(NET, THOUGHT, 'view');
    await tick();
    assert.equal(stub.calls.length, 2, 'прогон отбора после изменения — новый POST');

    stub.resolveBody(0, [{ id: 'stale' }]);
    stub.resolveBody(1, [{ id: 'fresh' }]);
    assert.deepEqual((await stale).data, [{ id: 'stale' }]);
    assert.deepEqual((await fresh).data, [{ id: 'fresh' }]);
  });
});
