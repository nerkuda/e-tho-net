/**
 * Контекстное меню строки вложения на операциях владения (0.12.1, задача
 * 2f38cd51, тех.проект f9b8917c, элемент интерфейса d3c419a9).
 *
 * Проверяется реальный путь панели `buildAttachmentsPane` под DOM-шимом:
 *  1. «Перенести в мысль…» — ОДНА операция из двух шагов: сначала
 *     `addOwners` (новый владелец), затем `removeOwner` (своё владение).
 *     Отказ `addOwners` — своё владение НЕ снимается.
 *  2. «Перенести» при 409 `ATTACHMENT_OWNER_IS_ICON` на снятии — внятное
 *     сообщение; добавление новому владельцу уже состоялось.
 *  3. «Скопировать в мысли…» — один `addOwners` на весь мультивыбор,
 *     а не `POST /copy`.
 *  4. Клиент НЕ зовёт `PATCH owner` (`attachments.update` с `owner_id`) и
 *     `POST /copy` (`attachments.copy`).
 *
 * jsdom в проекте нет — общий DOM-шим `dom-shim.ts`; каркас диалога выбора
 * мысли (`canvas/add-dialog.ts`) прогоняется как в `add-dialog.test.ts`
 * (синхронный `window.setTimeout` снимает debounce поиска кандидатов).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { EtnError, type Attachment, type DuplicateHit, type Thought } from '@etn/shared';
import { ShimElement } from './dom-shim.js';
import * as keymap from '../src/renderer/lib/keymap.js';

const NET = 'net-1';

const documentListeners = new Map<string, Set<(event: any) => void>>();

class ShimCustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, init?: { detail?: unknown }) {
    this.type = type;
    this.detail = init?.detail;
  }
}

/** Устанавливает DOM/window под тест: `window.setTimeout` — синхронный. */
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
  const body = new ShimElement('body');
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
  // Реальный setTimeout: debounce поиска кандидатов (200 мс) отрабатывает по
  // таймеру, а TTL тостов notice (4 с) не успевает снять сообщение до проверки.
  win.setTimeout = (fn: () => void, ms?: number) => setTimeout(fn, ms);
  win.clearTimeout = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>);
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

function makeThought(overrides: Partial<Thought> = {}): Thought {
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
    ...overrides,
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
    owner_count: 1,
    ...overrides,
  };
}

/** Кандидат поиска мысли для диалога выбора (форма `DuplicateHit`). */
function hit(id: string, title: string): DuplicateHit {
  return {
    id,
    title,
    synonyms: [],
    matched_on: 'title',
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    parent_title: null,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
}

/** Тик ожидания: debounce поиска кандидатов (200 мс) плюс микрозадачи отрисовки. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 260));
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

interface Calls {
  list: number;
  addOwners: Array<{ id: string; input: unknown }>;
  removeOwner: Array<{ id: string; input: unknown }>;
  /** Все вызовы `attachments.update` (PATCH вложения) — смена владельца запрещена. */
  patch: Array<{ id: string; input: unknown }>;
  copy: number;
  remove: number;
  order: string[];
}

interface Harness {
  pane: ShimElement;
  calls: Calls;
}

/** Собирает панель вложений с подставным `window.etn`. */
async function mountPane(
  rows: Attachment[],
  opts: {
    candidates?: DuplicateHit[];
    onAddOwners?: (id: string, input: unknown) => void;
    onRemoveOwner?: (id: string, input: unknown) => void;
  } = {},
): Promise<Harness> {
  shimDom();
  keymap.keymapInternals.reset();
  const calls: Calls = {
    list: 0,
    addOwners: [],
    removeOwner: [],
    patch: [],
    copy: 0,
    remove: 0,
    order: [],
  };
  (globalThis as any).window.etn = {
    ui: { getState: async () => 'attachments', setState: async () => undefined },
    attachments: {
      list: async () => {
        calls.list++;
        return rows.map((row) => ({ ...row }));
      },
      update: async (_n: string, id: string, input: unknown) => {
        calls.patch.push({ id, input });
        const row = rows.find((r) => r.id === id);
        return { ...(row ?? makeAttachment()), ...(input as object) };
      },
      addOwners: async (_n: string, id: string, input: unknown) => {
        calls.addOwners.push({ id, input });
        calls.order.push('addOwners');
        opts.onAddOwners?.(id, input);
        const ids = (input as { owner_ids: string[] }).owner_ids;
        return { added: ids.map((oid) => ({ owner_type: 'thought', owner_id: oid })), skipped: [] };
      },
      removeOwner: async (_n: string, id: string, input: unknown) => {
        calls.removeOwner.push({ id, input });
        calls.order.push('removeOwner');
        opts.onRemoveOwner?.(id, input);
        return { removed: true, attachment_deleted: false };
      },
      copy: async () => {
        calls.copy++;
        throw new Error('POST /attachments/{id}/copy клиентом не вызывается');
      },
      remove: async () => {
        calls.remove++;
        throw new Error('DELETE /attachments/{id} клиентом не вызывается');
      },
      add: async () => undefined,
      search: async () => [],
      getContent: async () => ({ text: null, html: null, truncated: false }),
      uploadFile: async () => rows[0],
      updateContent: async () => ({ html: null }),
    },
    thoughts: {
      get: async () => null,
      focus: async () => null,
      // Поиск кандидатов фильтруется по подстроке — каждый запрос диалога
      // получает ровно ту мысль, которую выбирает тест.
      findDuplicates: async (_n: string, title: string) =>
        (opts.candidates ?? []).filter((c) =>
          c.title.toLowerCase().includes(title.toLowerCase()),
        ),
      resolve: async () => [],
    },
    comments: { list: async () => [], create: async () => undefined },
    properties: { get: async () => [] },
    admin: { listUsers: async () => [] },
    networks: { list: async () => [] },
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
  store.update({ networkId: NET } as any);
  const { resetQueryRegistry, resetEventRouter } = await import('../src/renderer/lib/live/index.js');
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

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Верхний (последний) смонтированный диалог. */
function lastDialog(): ShimElement {
  const backdrops = body().children.filter((c) => c.className.includes('dialog-backdrop'));
  const backdrop = backdrops[backdrops.length - 1];
  assert.ok(backdrop !== undefined, 'диалог открыт');
  return backdrop.children[0] as ShimElement;
}

/** Кликает пункт контекстного меню строки вложения по подписи. */
function clickRowMenuItem(pane: ShimElement, label: string): void {
  const item = pane.findAll((el) => el.className.split(/\s+/).includes('attachment-item'))[0];
  assert.ok(item !== undefined, 'строка вложения построена');
  item.dispatchContextMenu(10, 20);
  const menu = body().children.find((c) => c.className.split(/\s+/).includes('menu'));
  assert.ok(menu !== undefined, 'контекстное меню открыто');
  const entry = menu
    .findAll((el) => el.tagName === 'button' && el.className.split(/\s+/).includes('menu-item'))
    .find((el) => el.flatText().trim() === label);
  assert.ok(entry !== undefined, `пункт «${label}» в меню`);
  entry.click();
}

/** Вводит запрос в диалоге выбора и возвращает строки-кандидаты. */
async function searchCandidates(query: string): Promise<ShimElement[]> {
  const box = lastDialog();
  const input = box.querySelector('textarea');
  assert.ok(input !== null, 'поле поиска мысли в диалоге');
  input!.value = query;
  input!.emit('input');
  await settle();
  const list = box.querySelector('.add-candidates');
  assert.ok(list !== null, 'список кандидатов построен');
  return list!.findAll((el) => el.className.split(/\s+/).includes('type-combo-item'));
}

/** Выбор одной мысли в диалоге (одиночный режим): клик по кандидату закрывает. */
async function pickOneThought(query: string): Promise<void> {
  const rows = await searchCandidates(query);
  assert.ok(rows.length > 0, 'есть кандидат для выбора');
  rows[0]!.click();
  await settle();
}

/** Мультивыбор: переключить режим, набрать несколько мыслей, применить. */
async function pickManyThoughts(queries: string[]): Promise<void> {
  const box = lastDialog();
  const modeRow = box.findAll((el) => el.className === 'add-mode-row')[0];
  assert.ok(modeRow !== undefined, 'переключатель режима диалога');
  const multiRadio = modeRow!.children[1]?.children[0] as ShimElement;
  multiRadio.checked = true;
  multiRadio.emit('change');
  for (const query of queries) {
    const rows = await searchCandidates(query);
    assert.ok(rows.length > 0, `кандидат «${query}» найден`);
    rows[0]!.click();
    await settle();
  }
  const footer = box.querySelector('.dialog-footer');
  assert.ok(footer !== null, 'футер диалога');
  const applyBtn = footer!
    .findAll((el) => el.className.split(/\s+/).includes('ui-btn--primary'))
    .find((el) => el.tagName === 'button');
  assert.ok(applyBtn !== undefined, 'кнопка применения диалога');
  applyBtn!.click();
  await settle();
}

/** Тексты notice-сообщений (все — во всех контейнерах уведомлений). */
function noticeText(): string {
  return body()
    .findAll((el) => el.className.includes('notice'))
    .map((n) => n.flatText())
    .join('|');
}

afterEach(async () => {
  const mod = await import('../src/renderer/lib/menu.js');
  mod.closeMenu();
});

describe('контекстное меню вложения — операции владения (2f38cd51)', () => {
  beforeEach(() => keymap.keymapInternals.reset());

  it('«Перенести в мысль…»: addOwners, затем removeOwner — именно в этом порядке', async () => {
    const { pane, calls } = await mountPane([makeAttachment({ id: 'a1', owner_id: 't1' })], {
      candidates: [hit('t2', 'Цель')],
    });
    clickRowMenuItem(pane, 'Перенести в мысль…');
    await settle();
    await pickOneThought('Цель');
    await flush();

    assert.deepEqual(
      calls.order,
      ['addOwners', 'removeOwner'],
      'сначала добавление нового владельца, затем снятие своего',
    );
    assert.deepEqual(
      calls.addOwners,
      [{ id: 'a1', input: { owner_type: 'thought', owner_ids: ['t2'] } }],
      'новый владелец добавлен через POST /attachments/{id}/owners',
    );
    assert.deepEqual(
      calls.removeOwner,
      [{ id: 'a1', input: { owner_type: 'thought', owner_id: 't1' } }],
      'своё владение снято через DELETE /attachments/{id}/owners',
    );
  });

  it('«Перенести»: отказ addOwners — своё владение НЕ снимается', async () => {
    const { pane, calls } = await mountPane([makeAttachment({ id: 'a1', owner_id: 't1' })], {
      candidates: [hit('t2', 'Цель')],
      onAddOwners: () => {
        throw new EtnError('VALIDATION_ERROR', 'владелец не существует');
      },
    });
    clickRowMenuItem(pane, 'Перенести в мысль…');
    await settle();
    await pickOneThought('Цель');
    await flush();

    assert.equal(calls.addOwners.length, 1, 'попытка добавления была');
    assert.equal(calls.removeOwner.length, 0, 'при отказе добавления владение не снято');
    assert.ok(noticeText().includes('Не удалось перенести'), 'показана ошибка переноса');
  });

  it('«Перенести»: 409 на снятии — внятное сообщение, владение у цели осталось', async () => {
    const { pane, calls } = await mountPane([makeAttachment({ id: 'a1', owner_id: 't1' })], {
      candidates: [hit('t2', 'Цель')],
      onRemoveOwner: () => {
        throw new EtnError('VALIDATION_ERROR', 'вложение — иконка объекта', {
          code: 'ATTACHMENT_OWNER_IS_ICON',
          status: 409,
        });
      },
    });
    clickRowMenuItem(pane, 'Перенести в мысль…');
    await settle();
    await pickOneThought('Цель');
    await flush();

    assert.equal(calls.addOwners.length, 1, 'новому владельцу вложение добавлено');
    assert.equal(calls.removeOwner.length, 1, 'снятие своего владения предпринято');
    const text = noticeText();
    assert.ok(
      text.includes('иконка') && text.includes('не снято'),
      `сообщение объясняет запрет и что владение у цели осталось: ${text}`,
    );
  });

  it('«Скопировать в мысли…»: один addOwners на весь мультивыбор (не POST /copy)', async () => {
    const { pane, calls } = await mountPane([makeAttachment({ id: 'a1', owner_id: 't1' })], {
      candidates: [hit('t2', 'Цель Б'), hit('t3', 'Цель В')],
    });
    clickRowMenuItem(pane, 'Скопировать в мысли…');
    await settle();
    await pickManyThoughts(['Цель Б', 'Цель В']);
    await flush();

    assert.equal(calls.addOwners.length, 1, 'одна операция на весь список');
    assert.deepEqual(
      calls.addOwners[0]!.input,
      { owner_type: 'thought', owner_ids: ['t2', 't3'] },
      'addOwners получил всех выбранных владельцев сразу',
    );
    assert.equal(calls.copy, 0, 'POST /attachments/{id}/copy не вызывается');
    assert.equal(calls.removeOwner.length, 0, 'копирование владение не снимает');
  });

  it('пункты не зовут PATCH-owner: attachments.update с owner_id не выполняется', async () => {
    const { pane, calls } = await mountPane([makeAttachment({ id: 'a1', owner_id: 't1' })], {
      candidates: [hit('t2', 'Цель')],
    });
    clickRowMenuItem(pane, 'Перенести в мысль…');
    await settle();
    await pickOneThought('Цель');
    await flush();

    assert.equal(calls.patch.length, 0, 'PATCH /attachments/{id} с owner_id не вызывается');
    assert.equal(calls.remove, 0, 'DELETE /attachments/{id} не вызывается');
  });
});

describe('проводка меню (страж исходника, 2f38cd51)', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'attachments.ts'),
    'utf8',
  );

  it('меню не зовёт etn.attachments.copy и PATCH-смену владельца', () => {
    assert.ok(!/etn\.attachments\.copy\(/.test(source), 'POST /copy из меню убран');
    assert.ok(
      !/etn\.attachments\.update\(\s*networkId,\s*attachment\.id,\s*\{[^}]*owner_id/.test(source),
      'PATCH-смена владельца из меню убрана',
    );
  });

  it('перенос идёт двумя операциями владения в правильном порядке', () => {
    const move = source.slice(source.indexOf('async function moveToThought'));
    const addAt = move.indexOf('etn.attachments.addOwners');
    const removeAt = move.indexOf('etn.attachments.removeOwner');
    assert.ok(addAt >= 0 && removeAt >= 0, 'moveToThought зовёт addOwners и removeOwner');
    assert.ok(addAt < removeAt, 'addOwners вызывается раньше removeOwner');
  });
});
