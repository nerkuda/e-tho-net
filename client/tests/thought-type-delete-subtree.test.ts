/**
 * Регрессия d4802371 «Ошибка удаления группы типов» (0.16.1) — клиент.
 *
 * Проверяет:
 *   * {@link planTypeDelete}: поддерево (всё, не только прямые дети) и текст
 *     подтверждения — с числом потомков; у типа-листа остаётся прежний текст;
 *   * {@link deleteThoughtTypeSubtree}: запрос уходит с `force=true`,
 *     каталог перечитывается, `notifyTypeChanged` вызывается на КАЖДЫЙ тип
 *     поддерева (раньше уведомлялся только корень).
 *
 * DOM — общий шим `./dom-shim.js` (как в `dialog-wrappers-cancel.test.ts`):
 * реальный `confirmDialog` из `lib/dialog.ts`, нажимаем его кнопку.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ThoughtType } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

function installShim(): void {
  windowListeners.length = 0;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type: string, listener: (event: any) => void) => {
      windowListeners.push({ type, listener });
    },
    removeEventListener: (type: string, listener: (event: any) => void) => {
      const index = windowListeners.findIndex((l) => l.type === type && l.listener === listener);
      if (index >= 0) windowListeners.splice(index, 1);
    },
  };
}

installShim();

const { planTypeDelete, deleteThoughtTypeSubtree } =
  await import('../src/renderer/screens/type-manager.js');
const { onTypeChanged } = await import('../src/renderer/lib/type-definitions.js');
const { store } = await import('../src/renderer/state.js');
const { t } = await import('../src/renderer/lib/i18n.js');

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Каталог: корень → A → B → C и сосед D. */
function catalogue(): ThoughtType[] {
  const base = {
    is_root: false,
    icon: null,
    icon_kind: 'emoji',
    icon_color: null,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    comment_template_md: null,
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    created_by: 'u',
    updated_by: 'u',
    created_at_ms: 1,
    updated_at_ms: 1,
  } as const;
  const type = (id: string, name: string, parentId: string | null): ThoughtType => ({
    ...base,
    id,
    name,
    parent_id: parentId,
  });
  return [
    { ...type('root', 'основной тип', null), is_root: true },
    type('a', 'A', 'root'),
    type('b', 'B', 'a'),
    type('c', 'C', 'b'),
    type('d', 'D', 'root'),
  ];
}

/** Открытый диалог подтверждения. */
function backdrop(): ShimElement {
  const found = body().children.find((child) => child.classList.contains('dialog-backdrop'));
  assert.ok(found !== undefined, 'диалог подтверждения открыт');
  return found;
}

/** Текст подтверждения в открытом диалоге. */
function dialogText(): string {
  const node = backdrop().querySelector('.dialog-text');
  assert.ok(node !== null, 'текст подтверждения найден');
  return node!.textContent;
}

/** Нажать кнопку подтверждения (`actions.confirm`). */
function confirm(): void {
  const btn = backdrop()
    .querySelectorAll('button')
    .find((b) => b.textContent === t('actions.confirm'));
  assert.ok(btn !== undefined, 'кнопка подтверждения есть');
  btn!.emit('click');
}

describe('planTypeDelete: поддерево и текст подтверждения (d4802371)', () => {
  it('считает ВСЁ поддерево и упоминает дочерние типы с их числом', () => {
    const types = catalogue();
    const plan = planTypeDelete(types, types[1]!); // A → B → C
    assert.deepEqual(plan.ids, ['a', 'b', 'c']);
    assert.match(plan.message, /вместе с дочерними типами \(2\)/);
    assert.match(plan.message, /A/);
    assert.match(plan.message, /станут без типа/);
  });

  it('для типа без детей оставляет прежний текст подтверждения', () => {
    const types = catalogue();
    const plan = planTypeDelete(types, types[4]!); // D — лист
    assert.deepEqual(plan.ids, ['d']);
    assert.doesNotMatch(plan.message, /дочерними типами/);
    assert.equal(plan.message, t('thoughtTypes.deleteConfirm', 'D'));
  });
});

describe('deleteThoughtTypeSubtree: force, каталог и уведомления (d4802371)', () => {
  it('шлёт force=true, перечитывает каталог и уведомляет о каждом типе поддерева', async () => {
    installShim();
    store.update({ networkId: 'net-1' });
    const types = catalogue();
    const calls: Array<{ id: string; version: number; force: boolean }> = [];
    let listed = 0;
    (globalThis as any).window.etn = {
      types: {
        removeThoughtType: async (
          _networkId: string,
          id: string,
          version: number,
          force: boolean,
        ): Promise<void> => {
          calls.push({ id, version, force });
        },
        listThoughtTypes: async (): Promise<ThoughtType[]> => {
          listed += 1;
          return [];
        },
      },
    };
    const notified: string[] = [];
    const unsubscribe = onTypeChanged((facts) => notified.push(facts.owner.ownerId));
    try {
      const pending = deleteThoughtTypeSubtree('net-1', types[1]!, types);
      assert.match(dialogText(), /дочерними типами \(2\)/);
      confirm();
      const plan = await pending;

      assert.ok(plan !== null, 'подтверждение пользователя принято');
      assert.deepEqual(plan!.ids, ['a', 'b', 'c']);
      assert.deepEqual(calls, [{ id: 'a', version: 1, force: true }], 'DELETE уходит с force=true');
      assert.equal(listed, 1, 'каталог перечитан');
      assert.deepEqual(notified, ['a', 'b', 'c'], 'уведомление на каждый тип поддерева');
    } finally {
      unsubscribe();
    }
  });

  it('отказ пользователя не шлёт запрос и не уведомляет', async () => {
    installShim();
    store.update({ networkId: 'net-1' });
    const types = catalogue();
    let called = 0;
    (globalThis as any).window.etn = {
      types: {
        removeThoughtType: async (): Promise<void> => {
          called += 1;
        },
        listThoughtTypes: async (): Promise<ThoughtType[]> => [],
      },
    };
    const notified: string[] = [];
    const unsubscribe = onTypeChanged((facts) => notified.push(facts.owner.ownerId));
    try {
      const pending = deleteThoughtTypeSubtree('net-1', types[4]!, types);
      const cancel = backdrop()
        .querySelectorAll('button')
        .find((b) => b.textContent === t('actions.cancel'));
      assert.ok(cancel !== undefined, 'кнопка отмены есть');
      cancel!.emit('click');
      assert.equal(await pending, null);
      assert.equal(called, 0);
      assert.deepEqual(notified, []);
    } finally {
      unsubscribe();
    }
  });
});
