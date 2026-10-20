/**
 * Link-down behaviour of the REST client (ошибка de34b35b).
 *
 * Пока сеть помечена недоступной:
 *  - висящий запрос отменяется сразу (без 3 попыток по 30 с);
 *  - изменяющие запросы не отправляются вообще;
 *  - отмена вызывающим (`RequestOptions.signal`) по-прежнему отличается от
 *    потери связи и не подменяется на «connection-lost».
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import { RestClient, networkIdFromApiPath } from '../src/main/net/rest-client.js';

const NET = '123e4567-e89b-12d3-a456-426614174000';

function makeClient(fetchImpl: typeof fetch, isServerDown?: () => boolean): RestClient {
  return new RestClient({
    baseUrl: 'http://localhost:3000',
    getApiKey: async () => 'etn_testkey',
    getClientId: () => '11111111-1111-1111-1111-111111111111',
    fetchImpl,
    random: () => 0,
    ...(isServerDown === undefined ? {} : { isServerDown }),
  });
}

/** Yields so pending microtasks (key resolution, fetch dispatch) run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Fetch that never settles until its signal aborts. */
function hangingFetch(counter: { calls: number }): typeof fetch {
  return ((_url: string, init?: RequestInit): Promise<Response> => {
    counter.calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? null;
      if (signal === null) return;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
}

describe('RestClient — link down (de34b35b)', () => {
  it('networkIdFromApiPath extracts the network from /networks/<uuid>/...', () => {
    assert.equal(networkIdFromApiPath(`/networks/${NET}/members`), NET);
    assert.equal(networkIdFromApiPath(`/networks/${NET}`), NET);
    assert.equal(networkIdFromApiPath('/me'), null);
  });

  it('setLinkDown aborts an in-flight request without retries', async () => {
    const counter = { calls: 0 };
    const client = makeClient(hangingFetch(counter));

    const pending = client.getNetwork(NET);
    await tick();
    assert.equal(counter.calls, 1, 'первый запрос ушёл');

    client.setLinkDown(NET, true);
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof EtnError, `ожидался EtnError, получено ${String(err)}`);
      assert.equal(err.code, 'INTERNAL');
      assert.deepEqual(err.details, { kind: 'connection-lost', networkId: NET });
      return true;
    });
    assert.equal(counter.calls, 1, 'повторов быть не должно');
  });

  it('suspect (abortInflight=false) blocks new writes but lets the in-flight request live', async () => {
    const counter = { calls: 0 };
    const client = makeClient(hangingFetch(counter));
    const pending = client.getNetwork(NET);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await tick();
    client.setLinkDown(NET, true, false); // suspect: probe in flight
    await tick();
    assert.equal(settled, false, 'зависший запрос не должен быть отменён на suspect');
    assert.equal(counter.calls, 1);

    // A failed probe moves the network to `reconnecting` → deferred abort.
    client.setLinkDown(NET, true);
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof EtnError);
      assert.deepEqual(err.details, { kind: 'connection-lost', networkId: NET });
      return true;
    });
    assert.equal(counter.calls, 1);
  });

  it('does not send mutating requests while the network is down', async () => {
    const counter = { calls: 0 };
    const client = makeClient(hangingFetch(counter));
    client.setLinkDown(NET, true);

    await assert.rejects(
      client.updateNetwork(NET, { display_name: 'x' }),
      (err: unknown) => {
        assert.ok(err instanceof EtnError);
        assert.deepEqual(err.details, { kind: 'connection-lost', networkId: NET });
        return true;
      },
    );
    assert.equal(counter.calls, 0, 'изменяющий запрос не должен уйти в сеть');
  });

  it('caller abort keeps its own reason and is not reported as connection-lost', async () => {
    const counter = { calls: 0 };
    const client = makeClient(hangingFetch(counter));
    const ac = new AbortController();
    const reason = new Error('renderer cancelled');

    const pending = client.updateNetwork(NET, { display_name: 'x' }, { signal: ac.signal });
    await tick();
    ac.abort(reason);

    await assert.rejects(pending, (err: unknown) => {
      assert.equal(err, reason);
      assert.equal((err as EtnError).details, undefined);
      return true;
    });
    assert.equal(counter.calls, 1, 'caller abort не ретраится');
  });

  it('global gate: me.update / me.settings / networks.create send 0 fetch when the server is down', async () => {
    const counter = { calls: 0 };
    let serverDown = true;
    const client = makeClient(hangingFetch(counter), () => serverDown);

    for (const call of [
      () => client.updateMe('name'),
      () => client.setMySetting('theme', 'dark'),
      () => client.createNetwork({ display_name: 'Net' }),
    ]) {
      await assert.rejects(call(), (err: unknown) => {
        assert.ok(err instanceof EtnError);
        assert.equal(err.code, 'INTERNAL');
        assert.deepEqual(err.details, { kind: 'connection-lost' });
        return true;
      });
    }
    assert.equal(counter.calls, 0, 'ни один изменяющий запрос не должен уйти в сеть');

    // Healthy server: the same mutating call goes through.
    serverDown = false;
    const okFetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { id: 'u1' } }),
    })) as unknown as typeof fetch;
    const healthy = makeClient(okFetch, () => serverDown);
    const me = await healthy.updateMe('name');
    assert.deepEqual(me, { id: 'u1' });
  });
});
