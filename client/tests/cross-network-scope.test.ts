/**
 * Unit tests for the persistent state of the «по всем сетям» toggle in the
 * entity picker (задача eb1a3f43, требование 79755f76). Покрывает:
 *
 *   - умолчание `false` (поиск по текущей сети, как требует спека);
 *   - цикл save → load с реальным `localStorage`-shim;
 *   - защита от повреждённого значения (`raw === 'garbage'` → false);
 *   - подписка `subscribeCrossNetworkScope` срабатывает на каждое
 *     `saveCrossNetworkScope` и корректно отписывается;
 *   - безопасность при отсутствии `localStorage` (Node-тесты без guard'а).
 *
 * UI-кнопка (`makeCrossNetworkScopeToggle`) живёт в `lib/entity-picker.ts`
 * и неразрывно связана с DOM-каркасом (`svgIcon`, `el`); её поведение
 * покрывается e2e-сценарием «переключатель „по всем сетям"».
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

/** Шим `Storage` поверх `Map` (как в recent-values.test.ts). */
class ShimStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

let scopeModule: typeof import('../src/renderer/lib/cross-network-scope.js') | null = null;
async function loadScope(): Promise<typeof import('../src/renderer/lib/cross-network-scope.js')> {
  if (scopeModule === null) {
    scopeModule = await import('../src/renderer/lib/cross-network-scope.js');
  }
  return scopeModule;
}

describe('cross-network-scope (persistent toggle state)', () => {
  let originalStorage: Storage | undefined;

  beforeEach(() => {
    originalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  });

  afterEach(() => {
    if (originalStorage === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
    }
  });

  it('умолчание: пустой storage → false (поиск только в текущей сети)', async () => {
    (globalThis as { localStorage?: Storage }).localStorage = new ShimStorage();
    const { loadCrossNetworkScope, isCrossNetworkScopeEnabled } = await loadScope();
    assert.equal(loadCrossNetworkScope(), false);
    assert.equal(isCrossNetworkScopeEnabled(), false);
  });

  it('save/load: цикл сохраняет значение и переживает «чтение заново»', async () => {
    const shim = new ShimStorage();
    (globalThis as { localStorage?: Storage }).localStorage = shim;
    const { saveCrossNetworkScope, loadCrossNetworkScope } = await loadScope();

    saveCrossNetworkScope(true);
    assert.equal(loadCrossNetworkScope(), true);
    assert.equal(shim.getItem('etn.crossNetworkScope'), '1');

    saveCrossNetworkScope(false);
    assert.equal(loadCrossNetworkScope(), false);
    assert.equal(shim.getItem('etn.crossNetworkScope'), '0');
  });

  it('повреждённое значение трактуется как false (защита от миграций)', async () => {
    const shim = new ShimStorage();
    shim.setItem('etn.crossNetworkScope', 'garbage');
    (globalThis as { localStorage?: Storage }).localStorage = shim;
    const { loadCrossNetworkScope } = await loadScope();
    assert.equal(loadCrossNetworkScope(), false);
  });

  it('true-строки "true" тоже принимаются (обратная совместимость)', async () => {
    const shim = new ShimStorage();
    shim.setItem('etn.crossNetworkScope', 'true');
    (globalThis as { localStorage?: Storage }).localStorage = shim;
    const { loadCrossNetworkScope } = await loadScope();
    assert.equal(loadCrossNetworkScope(), true);
  });

  it('subscribe: подписчик получает каждое save и отписывается', async () => {
    const shim = new ShimStorage();
    (globalThis as { localStorage?: Storage }).localStorage = shim;
    const { saveCrossNetworkScope, subscribeCrossNetworkScope } = await loadScope();

    const seen: boolean[] = [];
    const unsub = subscribeCrossNetworkScope((v) => seen.push(v));

    saveCrossNetworkScope(true);
    saveCrossNetworkScope(false);
    saveCrossNetworkScope(true);
    assert.deepEqual(seen, [true, false, true]);

    unsub();
    saveCrossNetworkScope(false);
    // После отписки новых событий нет.
    assert.deepEqual(seen, [true, false, true]);
  });

  it('безопасность: отсутствие localStorage не валит и не сохраняет', async () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    const { loadCrossNetworkScope, saveCrossNetworkScope } = await loadScope();
    // Просто не бросает.
    assert.equal(loadCrossNetworkScope(), false);
    saveCrossNetworkScope(true);
    assert.equal(loadCrossNetworkScope(), false);
  });
});
