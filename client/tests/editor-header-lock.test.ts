/**
 * Регресс-тест ошибки 201233ba: «После снятия чужого захвата открытая мысль
 * остаётся readOnly до смены фокуса».
 *
 * Заголовок мысли/связи синхронизирует `readOnly` с кэшем захватов
 * (`foreignLockHeld`). До исправления пересчёт шёл только при сборке шапки,
 * перепривязке и входе в поле: снятие захвата другим клиентом приходило
 * realtime-событием `edit.released`, кэш менялся, а поля оставались
 * заблокированными до смены фокуса.
 *
 * Тест проверяет механизм без сборки полной шапки (её конструктор приватный):
 * привязанный пересчёт обязан вызываться на каждый переход кэша, повторная
 * привязка заменяет прежнюю подписку, а `releaseHeaderLockSync` (демонтаж или
 * пересборка шапки) — снимает её. DOM-шим нужен только для импорта editor.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Минимальный шим для импорта editor.ts (CodeMirror probing на импорте). */
function installShim(): void {
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
    body: new ShimElement('body'),
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.etn = { ui: { setState: async () => undefined, getState: async () => 'main' } };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

/** Строка чужого захвата для кэша. */
const FOREIGN_LOCK = {
  id: 'lock-201233ba',
  entity_type: 'thought',
  entity_id: 't-201233ba',
  user_id: 'user-other',
  client_id: null,
  acquired_at_ms: 1,
};

describe('шапка редактора: блокировка пересчитывается по кэшу захватов (201233ba)', () => {
  it('снятие захвата вызывает пересчёт без смены фокуса; отписка прекращает вызовы', async () => {
    installShim();
    const { editorInternals } = await import('../src/renderer/editor/editor.js');
    const locks = await import('../src/renderer/lib/lock-cache.js');

    try {
      let calls = 0;
      editorInternals.bindHeaderLockSync(() => {
        calls += 1;
      });

      // Захват появился (другой клиент) — переход кэша.
      locks.__setForTests([FOREIGN_LOCK]);
      assert.equal(calls, 1, 'появление чужого захвата пересчитывает шапку');

      // Захват снят — именно этот переход до фикса не доходил до шапки.
      locks.__setForTests([]);
      assert.equal(calls, 2, 'снятие захвата пересчитывает шапку без фокуса');

      // Демонтаж/пересборка шапки: подписка снята, вызовов больше нет.
      editorInternals.releaseHeaderLockSync();
      locks.__setForTests([FOREIGN_LOCK]);
      assert.equal(calls, 2, 'после releaseHeaderLockSync пересчёта нет');
    } finally {
      editorInternals.releaseHeaderLockSync();
      locks.__resetForTests();
    }
  });

  it('повторная привязка заменяет подписку, а не добавляет вторую', async () => {
    installShim();
    const { editorInternals } = await import('../src/renderer/editor/editor.js');
    const locks = await import('../src/renderer/lib/lock-cache.js');

    try {
      let first = 0;
      let second = 0;
      editorInternals.bindHeaderLockSync(() => {
        first += 1;
      });
      // Перепривязка шапки к другой мысли того же типа: старый пересчёт
      // не должен жить вместе с новым (иначе — утечка отсоединённого DOM).
      editorInternals.bindHeaderLockSync(() => {
        second += 1;
      });
      locks.__setForTests([FOREIGN_LOCK]);
      assert.equal(first, 0, 'прежняя подписка заменена');
      assert.equal(second, 1, 'действует только новая подписка');
    } finally {
      editorInternals.releaseHeaderLockSync();
      locks.__resetForTests();
    }
  });
});
