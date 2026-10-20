/**
 * Сторож проброса стороны свойства-связи через мост (0.14.1, требование
 * 87039bc8, ошибка 45248206).
 *
 * Правило: если контракт `EtnApi.properties.set/remove` объявляет параметр
 * `side`, мост `client/src/preload/index.ts` обязан передать его в
 * `invoke(...)`. До правки preload вызывал `invoke('properties.set', …)` с
 * пятью аргументами — `side` молча отбрасывался, main/REST получали `null`, и
 * запись/удаление у симметричного имени адресовали сторону по живым рёбрам или
 * привязке, то есть ЧУЖУЮ сторону. Ошибка не видна ни typecheck (аргумент
 * необязательный), ни тестам main — только полному пути renderer → preload →
 * main → REST.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

function read(...parts: string[]): string {
  return readFileSync(resolve(import.meta.dirname, '..', 'src', ...parts), 'utf8');
}

describe('сторож: side свойства-связи доходит до main (45248206)', () => {
  it('preload передаёт side в invoke для set и remove', () => {
    const src = read('preload', 'index.ts');
    assert.match(
      src,
      /set: \(networkId, ownerType, ownerId, key, value, side\) =>\s*invoke\(\s*'properties\.set',\s*networkId,\s*ownerType,\s*ownerId,\s*key,\s*value,\s*side,?\s*\)/,
      'properties.set должен пробрасывать side шестым аргументом',
    );
    assert.match(
      src,
      /remove: \(networkId, ownerType, ownerId, key, side\) =>\s*invoke\(\s*'properties\.remove',\s*networkId,\s*ownerType,\s*ownerId,\s*key,\s*side,?\s*\)/,
      'properties.remove должен пробрасывать side пятым аргументом',
    );
  });

  it('контракт EtnApi объявляет side у set и remove', () => {
    const src = read('main', 'ipc', 'contract.ts');
    const blockStart = src.indexOf('  properties: {');
    assert.ok(blockStart >= 0, 'блок properties контракта найден');
    const block = src.slice(blockStart, blockStart + 3000);
    for (const method of ['set', 'remove'] as const) {
      const start = block.indexOf(`    ${method}(`);
      assert.ok(start >= 0, `контракт ${method} найден`);
      const chunk = block.slice(start, start + 1200);
      assert.match(
        chunk,
        /side\?: 'source' \| 'target' \| null/,
        `контракт ${method} объявляет side`,
      );
    }
  });
});
