/**
 * Усыновление существующего постоянного комментария (ошибка ecdb2e7a).
 *
 * Симптом заказчика: после обрыва связи во время правки комментария каждая
 * смена мысли давала «a permanent comment already exists for this owner».
 * Комментарий успевал создаться за клиента (досыл pending-черновика после
 * восстановления связи, H19), а редактор продолжал считать его
 * несуществующим. Контракт `createOrAdoptPermanentComment`:
 *
 * 1. обычное создание — как раньше, без лишних чтений;
 * 2. `DUPLICATE` → существующий комментарий усыновляется, набранный текст
 *    переписывает серверный (правка новее, last-write-wins на поле);
 * 3. `DUPLICATE` при совпадающем тексте → без лишней записи (не бумпаем
 *    версию зря);
 * 4. `DUPLICATE`, а комментарий не читается → исходный отказ, не выдуманный;
 * 5. прочие ошибки (нет связи, чужой захват) не перехватываются.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Минимальный `window.etn.comments` для проверки ветвей усыновления. */
interface Harness {
  calls: string[];
  updates: Array<{ id: string; body: string; version: number }>;
}

const OWNER = {
  networkId: 'net-1',
  ownerType: 'thought' as const,
  ownerId: 'thought-1',
};

/** Комментарий-заглушка: проверяются только поля, которыми оперирует хелпер. */
function permanentComment(bodyMd: string, version = 3): any {
  return { id: 'comment-1', kind: 'permanent', body_md: bodyMd, body_html: `<p>${bodyMd}</p>`, version };
}

function installHarness(opts: {
  createError?: unknown;
  existing?: any;
}): Harness {
  const harness: Harness = { calls: [], updates: [] };
  const api = {
    comments: {
      create: async (_networkId: string, _ownerType: string, _ownerId: string, input: any) => {
        harness.calls.push('create');
        if (opts.createError !== undefined) throw opts.createError;
        return permanentComment(input.body_md, 1);
      },
      list: async () => {
        harness.calls.push('list');
        return opts.existing === undefined ? [] : [opts.existing];
      },
      update: async (_networkId: string, id: string, patch: any, version: number) => {
        harness.calls.push('update');
        harness.updates.push({ id, body: patch.body_md, version });
        return permanentComment(patch.body_md, version + 1);
      },
    },
  };
  (globalThis as any).window = { ...((globalThis as any).window ?? {}), etn: api };
  return harness;
}

const { createOrAdoptPermanentComment, findPermanentComment } = await import(
  '../src/renderer/lib/permanent-comment.js'
);

describe('createOrAdoptPermanentComment: создание и усыновление', () => {
  it('обычное создание не читает и не обновляет существующее', async () => {
    const h = installHarness({});

    const created = await createOrAdoptPermanentComment(OWNER, 'новый текст');

    assert.equal(created.body_md, 'новый текст');
    assert.deepEqual(h.calls, ['create'], 'только create');
  });

  it('DUPLICATE: усыновляет существующий и пишет в него набранный текст', async () => {
    const h = installHarness({
      createError: new EtnError('DUPLICATE', 'a permanent comment already exists for this owner'),
      existing: permanentComment('серверный текст', 7),
    });

    const result = await createOrAdoptPermanentComment(OWNER, 'текст пользователя');

    assert.deepEqual(h.calls, ['create', 'list', 'update'], 'create → чтение → запись');
    assert.deepEqual(h.updates, [
      { id: 'comment-1', body: 'текст пользователя', version: 7 },
    ], 'update идёт с версией УСЫНОВЛЁННОГО комментария');
    assert.equal(result.body_md, 'текст пользователя', 'возвращён обновлённый комментарий');
  });

  it('DUPLICATE при совпадающем тексте: усыновляет без лишней записи', async () => {
    const h = installHarness({
      createError: new EtnError('DUPLICATE', 'a permanent comment already exists for this owner'),
      existing: permanentComment('тот же текст', 4),
    });

    const result = await createOrAdoptPermanentComment(OWNER, 'тот же текст');

    assert.deepEqual(h.calls, ['create', 'list'], 'update не нужен — сервер уже хранит этот текст');
    assert.equal(result.version, 4, 'вернулся существующий комментарий');
  });

  it('DUPLICATE без читаемого комментария: прокидывает исходный отказ', async () => {
    const duplicate = new EtnError('DUPLICATE', 'a permanent comment already exists for this owner');
    const h = installHarness({ createError: duplicate, existing: undefined });

    await assert.rejects(
      () => createOrAdoptPermanentComment(OWNER, 'текст'),
      (err: unknown) => err === duplicate,
      'выдуманной ошибки нет — проброшен отказ сервера',
    );
    assert.deepEqual(h.calls, ['create', 'list'], 'update не начат');
  });

  it('ошибки не про DUPLICATE не перехватываются', async () => {
    const locked = new EtnError('LOCKED', 'the object is locked');
    const h = installHarness({ createError: locked });

    await assert.rejects(
      () => createOrAdoptPermanentComment(OWNER, 'текст'),
      (err: unknown) => err === locked,
    );
    assert.deepEqual(h.calls, ['create'], 'ни чтения, ни записи');
  });

  it('findPermanentComment отдаёт постоянный комментарий владельца или null', async () => {
    installHarness({ existing: permanentComment('есть', 2) });
    assert.equal((await findPermanentComment(OWNER))?.id, 'comment-1');

    installHarness({});
    assert.equal(await findPermanentComment(OWNER), null);
  });
});
