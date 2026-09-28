/**
 * Транспорт ошибок IPC через `contextBridge` (ошибка f14962ca).
 *
 * Корень дефекта: `ipcMain.handle` сериализует брошенную ошибку только как
 * `name`/`message`/`stack`, а `contextBridge` теряет кастомные свойства —
 * `code` и `details` до renderer не доезжали. Из-за этого ветки UI, которым
 * нужны эти поля (диалог подтверждения смены родителя по `reparent_impact`,
 * `LOCKED`, `VERSION_CONFLICT`), никогда не срабатывали: показывался сырой
 * текст сервера вместо диалога.
 *
 * Решение: main резолвит вызов плоским конвертом {@link IpcErrorEnvelope},
 * renderer-фасад `lib/etn.ts` восстанавливает из него `EtnError` в СВОЁМ
 * контексте. Тест берёт настоящий фасад и поднимает фальшивый мост — как
 * настоящий `contextBridge`, только plain-объекты и без прототипов классов.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import { toIpcErrorEnvelope } from '../src/main/ipc/contract.js';
import { etn } from '../src/renderer/lib/etn.js';

/** Модель `contextBridge`-копирования: plain-объекты обходятся рекурсивно. */
function bridgeClone(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(bridgeClone);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) out[key] = bridgeClone(v);
  return out;
}

function installFakeBridge(bridge: Record<string, unknown>): void {
  (globalThis as any).window = { etn: bridgeClone(bridge) as Record<string, unknown> };
}

describe('Восстановление EtnError из конверта IPC (ошибка f14962ca)', () => {
  it('toIpcErrorEnvelope сохраняет code/details/request_id у EtnError', () => {
    const envelope = toIpcErrorEnvelope(
      new EtnError('VALIDATION_ERROR', 'смена родителя', {
        kind: 'reparent_impact',
        thoughts_count: 12,
      }, 'req-1'),
    );
    assert.equal(envelope.__etnError, true);
    assert.equal(envelope.error.code, 'VALIDATION_ERROR');
    assert.equal(envelope.error.message, 'смена родителя');
    assert.deepEqual(envelope.error.details, { kind: 'reparent_impact', thoughts_count: 12 });
    assert.equal(envelope.error.request_id, 'req-1');
  });

  it('toIpcErrorEnvelope у простой ошибки оставляет только name/message', () => {
    const envelope = toIpcErrorEnvelope(new Error('boom'));
    assert.equal(envelope.error.message, 'boom');
    assert.equal(envelope.error.code, undefined);
    assert.equal(envelope.error.details, undefined);
  });

  it('фасад превращает конверт в брошенный EtnError с details (диалог reparent)', async () => {
    installFakeBridge({
      types: {
        updateThoughtType: () =>
          Promise.resolve({
            __etnError: true,
            error: {
              name: 'EtnError',
              message: 'смена родителя повлияет на 12 живых мыслей',
              code: 'VALIDATION_ERROR',
              details: {
                kind: 'reparent_impact',
                affected_type_ids: ['t1'],
                thoughts_count: 12,
                requires_confirmation: true,
              },
            },
          }),
      },
    });

    await assert.rejects(
      () =>
        (etn as any).types.updateThoughtType('net', 'id', {}, 1),
      (err: any) => {
        assert.ok(err instanceof EtnError, 'ошибка восстановлена как EtnError в renderer');
        assert.equal(err.code, 'VALIDATION_ERROR');
        const details = err.details as { kind?: string; requires_confirmation?: boolean };
        assert.equal(details?.kind, 'reparent_impact');
        assert.equal(details?.requires_confirmation, true);
        return true;
      },
    );
  });

  it('обычный результат фасад отдаёт без изменений', async () => {
    installFakeBridge({
      types: { updateThoughtType: () => Promise.resolve({ id: 't1', version: 2 }) },
    });
    const value = await (etn as any).types.updateThoughtType('net', 't1', {}, 1);
    assert.deepEqual(value, { id: 't1', version: 2 });
  });

  it('не-EtnError конверт восстанавливается как Error с сохранённым name', async () => {
    installFakeBridge({
      types: { updateThoughtType: () => Promise.resolve({ __etnError: true, error: { name: 'TypeError', message: 'bad arg' } }) },
    });
    await assert.rejects(
      () => (etn as any).types.updateThoughtType('net', 'id', {}, 1),
      (err: any) => {
        assert.ok(!(err instanceof EtnError));
        assert.equal(err.name, 'TypeError');
        assert.equal(err.message, 'bad arg');
        return true;
      },
    );
  });
});
