/**
 * Регрессия 5bcfa04b — «Конфликт версий типа после создания свойства с
 * привязкой из редактора типа».
 *
 * Сценарий: пользователь создаёт новый тип мысли («Сохранить»), открывает
 * вложенный диалог «Добавить свойство…» → «Создать свойство» с указанием
 * редактируемого типа в «Типах источников». Сервер при сохранении свойства
 * через `applyTypeRows` вызывает `attach` (touchType → version+1) и
 * `updateNetworkProperty` для записи `allowed_source_type_ids` (тоже
 * поднимает версию через `touchType`). К моменту возврата в редактор
 * черновик хранит `current.version = 1`, а на сервере уже 3. Следующее
 * «Применить и закрыть» шлёт PATCH с `If-Match: 1` → 409 VERSION_CONFLICT
 * «thought type version mismatch» (expected: 1, current: 3).
 *
 * Прецедент 33fdffb (link_type parent, e7c077e4) уже сделал то же самое
 * для `syncLinkTypeParent` в property-manager: GET перед PATCH, снимок —
 * запасной источник. Здесь — симметричный хелпер для редактора типа мысли
 * (`readFreshTypeVersion` / `readFreshTypeSnapshot`). Конфликт остаётся
 * только для реальной конкурентной правки полей извне между чтением и
 * записью.
 *
 * Юнит-тест проверяет сами хелперы (модуль-уровень): они обязаны читать
 * свежую версию у сервера и не маскировать сетевую ошибку как «0» (то есть
 * — отдавать `fallback` только при исключении, не при `version: 0`).
 * Полный пользовательский сценарий покрыт серверной интеграционной
 * регрессией `server/tests/routes-thought-type-version-conflict.test.ts`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { ThoughtType } from '@etn/shared';

import {
  readFreshTypeSnapshot,
  readFreshTypeVersion,
} from '../src/renderer/screens/type-manager.js';

interface GetThoughtTypeCall {
  id: string;
}

function installEtnMocks(opts: {
  getThoughtType?: (id: string) => Promise<unknown>;
  failGet?: boolean;
}): { calls: GetThoughtTypeCall[] } {
  const calls: GetThoughtTypeCall[] = [];
  const api = {
    types: {
      getThoughtType: async (networkId: string, id: string): Promise<unknown> => {
        calls.push({ id });
        if (opts.failGet === true) throw new Error('network down');
        if (opts.getThoughtType !== undefined) return opts.getThoughtType(id);
        throw new Error('getThoughtType не задан');
      },
    },
  };
  (globalThis as { window?: unknown }).window = { etn: api };
  return { calls };
}

function makeThoughtType(id: string, version: number): ThoughtType {
  return {
    id,
    name: 'some-type',
    parent_id: null,
    is_root: false,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    comment_template_md: null,
    version,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u1',
    updated_by: 'u1',
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('readFreshTypeVersion — получение свежей версии перед PATCH (5bcfa04b)', () => {
  it('GET вернул свежую версию — PATCH шлёт её, а не устаревший снимок', async () => {
    // Снимок `current.version` = 1 (после создания), сервер уже на 3
    // (touchType поднял на attach свойства и на апдейт реестра).
    const { calls } = installEtnMocks({
      getThoughtType: () => Promise.resolve(makeThoughtType('tt-1', 3)),
    });
    const version = await readFreshTypeVersion('n1', 'tt-1', 1);
    assert.equal(version, 3, 'берём свежую версию с сервера');
    assert.deepEqual(calls, [{ id: 'tt-1' }]);
  });

  it('GET упал (сеть/race) — используем fallback, не маскируем нулевой версией', async () => {
    const { calls } = installEtnMocks({ failGet: true });
    const version = await readFreshTypeVersion('n1', 'tt-1', 1);
    assert.equal(version, 1, 'fallback применён при сетевой ошибке');
    assert.deepEqual(calls, [{ id: 'tt-1' }]);
  });

  it('GET вернул 0 (например, нештатный снимок) — отдаём 0, а не fallback', async () => {
    // На случай если в БД окажется version=0 (теоретически не должно, но
    // проверяем, что хелпер не «лечит» 0 в fallback): иначе мы бы
    // замаскировали реальный серверный ответ.
    const { calls } = installEtnMocks({
      getThoughtType: () => Promise.resolve(makeThoughtType('tt-1', 0)),
    });
    const version = await readFreshTypeVersion('n1', 'tt-1', 1);
    assert.equal(version, 0, '0 отдан как есть (не fallback)');
    assert.deepEqual(calls, [{ id: 'tt-1' }]);
  });
});

describe('readFreshTypeSnapshot — обновление снимка после applyChanges (5bcfa04b)', () => {
  it('GET вернул свежий снимок — заменяем устаревший current целиком', async () => {
    const { calls } = installEtnMocks({
      getThoughtType: () => Promise.resolve(makeThoughtType('tt-1', 3)),
    });
    const previous = makeThoughtType('tt-1', 1);
    const snapshot = await readFreshTypeSnapshot('n1', previous);
    assert.equal(snapshot.version, 3);
    assert.deepEqual(calls, [{ id: 'tt-1' }]);
  });

  it('GET упал — возвращаем прежний снимок, следующий apply прочитает версию снова', async () => {
    const { calls } = installEtnMocks({ failGet: true });
    const previous = makeThoughtType('tt-1', 1);
    const snapshot = await readFreshTypeSnapshot('n1', previous);
    assert.equal(snapshot, previous, 'на сбое сети возвращаем прежний снимок');
    assert.deepEqual(calls, [{ id: 'tt-1' }]);
  });
});
