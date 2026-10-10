/**
 * Вкладка «Вложения» на модели владений (0.12.1, задача 04555029, элемент
 * интерфейса d3c419a9, требования 6b524569 / fabc1231 / 0502e045).
 *
 * Проверяется поведение панели `buildAttachmentsPane` напрямую (без монтажа
 * всего редактора) под DOM-шимом:
 *  1) строка общего вложения показывает бейдж числа владельцев; единичное
 *     владение — без метки;
 *  2) переименование заголовка прямо в строке пишет `PATCH {title}` и НЕ
 *     является операцией владения;
 *  3) «Снять владение» из строки зовёт `DELETE …/owners` (`removeOwner`) с
 *     парой (owner_type, owner_id), а не `DELETE /attachments/{id}`;
 *  4) защита 409 `ATTACHMENT_OWNER_IS_ICON` — внятное сообщение, список не
 *     перечитывается впустую;
 *  5) realtime-инвалидация ключа списка владельца перечитывает список.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError, type Attachment, type Thought } from '@etn/shared';
import { ShimElement } from './dom-shim.js';
import { dispatchKeyEvent } from '../src/renderer/lib/keymap.js';

const documentListeners = new Map<string, Set<(event: any) => void>>();

class ShimCustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, init?: { detail?: unknown }) {
    this.type = type;
    this.detail = init?.detail;
  }
}

function shimDom(): void {
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).CustomEvent = ShimCustomEvent;
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as any).requestAnimationFrame = (cb: () => void): number => {
    cb();
    return 0;
  };
  (globalThis as any).getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px' });
  const body = new ShimElement('div');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: { setProperty: () => undefined, removeProperty: () => undefined } },
    body,
    addEventListener: (type: string, handler: (event: any) => void) => {
      const set = documentListeners.get(type) ?? new Set();
      set.add(handler);
      documentListeners.set(type, set);
    },
    removeEventListener: (type: string, handler: (event: any) => void) => {
      documentListeners.get(type)?.delete(handler);
    },
    dispatchEvent: (event: any): boolean => {
      for (const handler of [...(documentListeners.get(event.type) ?? [])]) handler(event);
      return true;
    },
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

function makeThought(): Thought {
  return {
    id: 't1',
    title: 'T1',
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    is_protected: false,
    is_root: false,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    synonyms: [],
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a1',
    owner_type: 'thought',
    owner_id: 't1',
    kind: 'file',
    url: null,
    file_path: 'C:/net/attachments/shot.png',
    file_size: 1234,
    mime_type: 'image/png',
    title: 'shot.png',
    icon: null,
    description: null,
    position: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u1',
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Enter через общеклиентский диспетчер (контекст правки уже на стеке). */
function pressEnter(node: ShimElement): void {
  dispatchKeyEvent({
    key: 'Enter',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    target: node,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as unknown as KeyboardEvent);
}

/** Escape через диспетчер — отмена правки заголовка. */
function pressEscape(node: ShimElement): void {
  dispatchKeyEvent({
    key: 'Escape',
    target: node,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as unknown as KeyboardEvent);
}

/** Кнопка с заданным текстом, первой найденная в поддереве. */
function buttonByText(root: ShimElement, text: string): ShimElement | undefined {
  return root
    .findAll((el) => el.tagName === 'button')
    .find((el) => el.flatText().trim() === text);
}

/** Кнопка-иконка строки по её подсказке (`title`/`aria-label`). */
function iconButtonByTitle(root: ShimElement, title: string): ShimElement | undefined {
  return root.findAll((el) => el.tagName === 'button').find((el) => el.title === title);
}

interface Harness {
  pane: ShimElement;
  calls: {
    list: number;
    rename: Array<{ id: string; input: unknown }>;
    removeOwner: Array<{ id: string; input: unknown }>;
    removeDirect: number;
  };
}

/**
 * Собирает панель вложений с подставным `window.etn`. `rows` — состояние
 * сервера, `onRemoveOwner` — реакция (успех/409) на снятие владения.
 */
async function mountPane(
  rows: Attachment[],
  onRemoveOwner?: (id: string, input: unknown) => void,
): Promise<Harness> {
  shimDom();
  const calls: Harness['calls'] = { list: 0, rename: [], removeOwner: [], removeDirect: 0 };
  (globalThis as any).window.etn = {
    ui: { getState: async () => 'attachments', setState: async () => undefined },
    attachments: {
      list: async () => {
        calls.list++;
        return rows.map((row) => ({ ...row }));
      },
      update: async (_n: string, id: string, input: unknown) => {
        calls.rename.push({ id, input });
        const row = rows.find((r) => r.id === id);
        return { ...(row ?? makeAttachment()), ...(input as object) };
      },
      removeOwner: async (_n: string, id: string, input: unknown) => {
        calls.removeOwner.push({ id, input });
        onRemoveOwner?.(id, input);
        return { removed: true, attachment_deleted: false };
      },
      remove: async () => {
        calls.removeDirect++;
      },
      add: async () => undefined,
      copy: async () => ({ added: [], skipped: [] }),
      search: async () => [],
      getContent: async () => ({ text: null, html: null, truncated: false }),
      uploadFile: async () => rows[0],
      updateContent: async () => ({ html: null }),
    },
    thoughts: { get: async () => null, focus: async () => null },
    comments: { list: async () => [], create: async () => undefined },
    properties: { get: async () => [] },
    admin: { listUsers: async () => [] },
    system: {
      openAttachmentFile: async () => '',
      openExternal: async () => '',
      pickFile: async () => ({ status: 'cancelled' }),
    },
    realtime: {
      onStatusChange: () => undefined,
      onStale: () => undefined,
      onNetworkLost: () => undefined,
      onLayerControl: () => undefined,
      onEvent: () => undefined,
      notifyOnline: () => undefined,
    },
  };

  const { store } = await import('../src/renderer/state.js');
  store.update({ networkId: 'n1' } as any);
  const { resetQueryRegistry, resetEventRouter } = await import(
    '../src/renderer/lib/live/index.js'
  );
  resetQueryRegistry();
  resetEventRouter();

  const { buildAttachmentsPane } = await import('../src/renderer/editor/attachments.js');
  const pane = buildAttachmentsPane({
    ownerType: 'thought',
    ownerId: 't1',
    thought: makeThought(),
  }) as unknown as ShimElement;
  await flush();
  return { pane, calls };
}

describe('вкладка «Вложения»: владельцы, переименование, защита снятия (04555029)', () => {
  it('общее вложение помечается бейджем числа владельцев; единичное — нет', async () => {
    const { pane } = await mountPane([
      makeAttachment({ id: 'a1', title: 'общая.png', owner_count: 3 }),
      makeAttachment({ id: 'a2', title: 'своя.png', owner_count: 1 }),
    ]);
    const badges = pane.findAll((el) => el.className.includes('ui-badge--quiet'));
    assert.equal(badges.length, 1, 'бейдж только у общего вложения');
    assert.equal(badges[0]!.textContent, '3 владельца', 'подпись числа владельцев');
  });

  it('переименование строки пишет PATCH {title} и не трогает владение', async () => {
    const { pane, calls } = await mountPane([makeAttachment({ id: 'a1', title: 'старое.png' })]);
    const renameBtn = iconButtonByTitle(pane, 'Переименовать');
    assert.ok(renameBtn !== undefined, 'в строке есть кнопка переименования');
    renameBtn!.click();
    await flush();
    const input = pane.querySelector('.att-title-input');
    assert.ok(input !== null && input !== undefined, 'заголовок заменён полем ввода');
    input!.value = 'Новое имя.png';
    pressEnter(input!);
    await flush();
    assert.deepEqual(
      calls.rename,
      [{ id: 'a1', input: { title: 'Новое имя.png' } }],
      'переименование ушло как PATCH title',
    );
    assert.equal(calls.removeOwner.length, 0, 'переименование не снимает владение');
  });

  it('Esc отменяет переименование без записи', async () => {
    const { pane, calls } = await mountPane([makeAttachment({ id: 'a1', title: 'старое.png' })]);
    iconButtonByTitle(pane, 'Переименовать')!.click();
    await flush();
    const input = pane.querySelector('.att-title-input')!;
    input.value = 'не сохранять';
    pressEscape(input);
    await flush();
    assert.equal(calls.rename.length, 0, 'Esc не пишет заголовок');
    assert.equal(pane.querySelector('.att-title-input'), null, 'поле ввода убрано');
  });

  it('снятие владения из строки зовёт removeOwner, а не удаление вложения', async () => {
    const { pane, calls } = await mountPane([makeAttachment({ id: 'a1', owner_count: 2 })]);
    iconButtonByTitle(pane, 'Снять владение')!.click();
    await flush();
    // Диалог подтверждения отрисован в document.body — подтверждаем.
    const body = (globalThis as any).document.body as ShimElement;
    const confirm = buttonByText(body, 'Подтвердить');
    assert.ok(confirm !== undefined, 'диалог снятия владения с кнопкой подтверждения');
    confirm!.click();
    await flush();
    assert.deepEqual(
      calls.removeOwner,
      [{ id: 'a1', input: { owner_type: 'thought', owner_id: 't1' } }],
      'снятие владения — DELETE /owners с парой владельца',
    );
    assert.equal(calls.removeDirect, 0, 'DELETE /attachments/{id} не вызывается');
  });

  it('запрет 409 ATTACHMENT_OWNER_IS_ICON — внятное сообщение', async () => {
    const { pane } = await mountPane([makeAttachment({ id: 'a1' })], () => {
      throw new EtnError('VALIDATION_ERROR', 'вложение — иконка объекта', {
        code: 'ATTACHMENT_OWNER_IS_ICON',
        status: 409,
      });
    });
    iconButtonByTitle(pane, 'Снять владение')!.click();
    await flush();
    const body = (globalThis as any).document.body as ShimElement;
    buttonByText(body, 'Подтвердить')!.click();
    await flush();
    const notices = body.findAll((el) => el.className.includes('notice') && el.className.includes('error'));
    const text = notices.map((n) => n.flatText()).join('|');
    assert.ok(
      text.includes('иконка') && text.includes('смените или очистите'),
      `сообщение объясняет запрет и путь решения, получено: ${text}`,
    );
  });

  it('realtime-инвалидация ключа владельца перечитывает список', async () => {
    const harness = await mountPane([makeAttachment({ id: 'a1' })]);
    const before = harness.calls.list;
    const { invalidateQueries, queryKeys } = await import('../src/renderer/lib/live/index.js');
    invalidateQueries(queryKeys.attachments('thought', 't1'));
    await flush();
    assert.ok(harness.calls.list > before, 'список перечитан по инвалидации владельца');
  });
});
