/**
 * Regression test for ETN error abd25adb «Вкладка "Вложения" не обновляется при
 * изменении вложений другим клиентом (real-time)».
 *
 * Симптом: в клиенте A открыта мысль (видна вкладка «Вложения» со счётчиком);
 * клиент B (или MCP) добавляет / изменяет / удаляет вложение той же мысли —
 * счётчик и список у A не меняются до переоткрытия мысли.
 *
 * Прежний гейт («индекс показанных вложений» в `lib/attachment-events`, локальный
 * канал `etn:attachments-changed`) снесён вместе с G4 тех.проекта 269016e2.
 * Теперь владельца событий `attachment.updated/deleted` (в них только id)
 * разрешает СЛОЙ: роутер читает запись вложения из нормализованного кэша и гасит
 * точный ключ `attachments:@owner`. Вкладка редактора подписана на этот ключ.
 *
 * Здесь проверяется:
 *  1) разрешение владельца роутером из нормализованного кэша (точный ключ);
 *  2) реальный путь события через `initRealtime` + `mountEditor` под DOM-шимом:
 *     `attachment.created` показанной мысли обновляет список и счётчик без
 *     пересборки вкладки; `updated`/`deleted` (только id) находят владельца по
 *     кэшу; скрытая вкладка сбрасывает кэш и пересобирается при возврате;
 *     «Комментарий» (CodeMirror) не пересобирается; чужая мысль и чужая сеть —
 *     игнор.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { Attachment, Thought, AnyRealtimeEvent } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Роутер: владелец вложения разрешается из нормализованного кэша
// ---------------------------------------------------------------------------

describe('роутер разрешает владельца вложения из кэша (ошибка abd25adb, G4)', () => {
  it('updated/deleted без владельца в payload гасят точный ключ из кэша', async () => {
    const {
      commitEntity,
      registerQuery,
      resetQueryRegistry,
      resetEventRouter,
      routeRealtimeEvent,
      queryKeys,
    } = await import('../src/renderer/lib/live/index.js');

    resetQueryRegistry();
    resetEventRouter();
    commitEntity('attachment', 'a1', {
      id: 'a1',
      owner_type: 'thought',
      owner_id: 't1',
      title: 'старое.png',
    });
    registerQuery(queryKeys.attachments('thought', 't1'), null);

    const updated = routeRealtimeEvent(
      realtimeEvent('attachment.updated', 'n1', { id: 'a1', changes: { title: 'новое.png' } }, 1),
    );
    assert.ok(
      updated.invalidated.includes(queryKeys.attachments('thought', 't1')),
      'updated гасит точный ключ владельца из кэша',
    );

    resetEventRouter();
    const deleted = routeRealtimeEvent(
      realtimeEvent('attachment.deleted', 'n1', { id: 'a1' }, 1),
    );
    assert.ok(
      deleted.invalidated.includes(queryKeys.attachments('thought', 't1')),
      'deleted разрешает владельца ДО удаления записи',
    );
  });

  it('неизвестное вложение (нет записи в кэше) гасит все списки вложений', async () => {
    const { registerQuery, resetQueryRegistry, resetEventRouter, routeRealtimeEvent, queryKeys } =
      await import('../src/renderer/lib/live/index.js');
    resetQueryRegistry();
    resetEventRouter();
    registerQuery(queryKeys.attachmentsAll(), null);
    const result = routeRealtimeEvent(
      realtimeEvent('attachment.deleted', 'n1', { id: 'unknown' }, 1),
    );
    assert.ok(
      result.invalidated.includes(queryKeys.attachmentsAll()),
      'владелец не разрешён — широковещательная инвалидация',
    );
  });
});

/** Фабрика realtime-события (seq растёт — иначе роутер отбросит как опоздавшее). */
function realtimeEvent(
  type: string,
  networkId: string,
  data: unknown,
  seq = 1,
): AnyRealtimeEvent {
  return {
    type,
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    actor: { user_id: 'u2', client_id: 'c2' },
    network_id: networkId,
    audience: 'network',
    layer_id: '00000000-0000-4000-8000-000000000001',
    data,
  } as unknown as AnyRealtimeEvent;
}

// ---------------------------------------------------------------------------
// Реальный путь: realtime-событие до открытого редактора под DOM-шимом
// ---------------------------------------------------------------------------

/** Document-level listeners, keyed by event type — the editor listener lives here. */
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
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: { setProperty: () => undefined, removeProperty: () => undefined } },
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
    ...overrides,
  };
}

/** All elements with the given class inside `root` (depth-first). */
function findByClass(root: ShimElement, className: string): ShimElement[] {
  const out: ShimElement[] = [];
  const walk = (node: ShimElement): void => {
    if (node.className.split(/\s+/).includes(className)) out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

/** Waits for the editor's own async chains (render, tab pane builds, reloads). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('realtime-вложения открытого редактора (ошибка abd25adb, G4)', () => {
  it('created/updated/deleted показанной мысли обновляют список и счётчик; чужая мысль/сеть — игнор', async () => {
    shimDom();

    /** Строки, которые вернёт `etn.attachments.list` (сервер-состояние). */
    let attachmentRows: Attachment[] = [
      makeAttachment({ id: 'a1', title: 'старое.png' }),
      makeAttachment({ id: 'a2', title: 'картинка.png' }),
    ];
    let listCalls = 0;
    let realtimeHandler: ((raw: unknown) => void) | null = null;

    (globalThis as any).window.etn = {
      ui: { getState: async () => 'attachments', setState: async () => undefined },
      attachments: {
        list: async () => {
          listCalls++;
          return attachmentRows.map((row) => ({ ...row }));
        },
        remove: async () => undefined,
        add: async () => undefined,
        update: async () => undefined,
        copy: async () => ({ created: [], skipped: [] }),
        search: async () => [],
        getContent: async () => ({ text: null, html: null, truncated: false }),
        uploadFile: async () => attachmentRows[0],
        updateContent: async () => ({ html: null }),
      },
      thoughts: { get: async () => null, focus: async () => null },
      comments: { list: async () => [], create: async () => undefined },
      properties: { get: async () => [] },
      admin: { listUsers: async () => [] },
      realtime: {
        onStatusChange: () => undefined,
        onStale: () => undefined,
        onNetworkLost: () => undefined,
        onLayerControl: () => undefined,
        onEvent: (handler: (raw: unknown) => void) => {
          realtimeHandler = handler;
        },
        notifyOnline: () => undefined,
      },
    };

    const { resetEventRouter } = await import('../src/renderer/lib/live/index.js');
    resetEventRouter();
    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    const { initRealtime } = await import('../src/renderer/realtime.js');

    store.update({
      networkId: 'n1',
      editorTarget: { kind: 'thought', id: 't1', thought: makeThought() },
      collapsedGroups: {},
    } as any);

    initRealtime();
    const host = new ShimElement('div');
    mountEditor(host as any);
    await flush();
    assert.notEqual(realtimeHandler, null, 'realtime-мост подписан');

    const builds = (): number => editorInternals.paneBuildCount('attachments');
    assert.equal(builds(), 1, 'вкладка «Вложения» построена при монтировании');
    assert.ok(listCalls > 0, 'список прочитан с сервера');
    const titles = (): string => findByClass(host, 'att-title').map((n) => n.textContent).join('|');
    assert.equal(titles(), 'старое.png|картинка.png', 'показан исходный список');
    // Вкладка «Комментарий» с CodeMirror не должна пересобираться ни разу — её
    // счётчик сборок фиксируем сразу после монтирования.
    const mainBuilds = editorInternals.paneBuildCount('main');

    let seq = 0;
    const feed = async (type: string, networkId: string, data: unknown): Promise<void> => {
      seq += 1;
      realtimeHandler!(realtimeEvent(type, networkId, data, seq));
      await flush();
    };

    // 1. ЧУЖАЯ мысль: вложение чужого владельца вкладку показанной не трогает.
    const callsForeign = listCalls;
    await feed('attachment.created', 'n1', {
      attachment: makeAttachment({ id: 'a9', owner_id: 't9', title: 'чужое.png' }),
    });
    assert.equal(listCalls, callsForeign, 'чужой владелец список не перечитывает');
    assert.equal(builds(), 1, 'чужой владелец вкладку не пересобирает');

    // 2. ЧУЖАЯ сеть: событие соседней вкладки к показанной сущности не относится.
    const callsOtherNet = listCalls;
    await feed('attachment.created', 'n2', {
      attachment: makeAttachment({ id: 'a8', owner_id: 't1', title: 'другая сеть.png' }),
    });
    assert.equal(listCalls, callsOtherNet, 'событие соседней сети игнорируется');

    // 3. `created` показанной мысли: список перечитывается на месте, вкладка НЕ
    //    пересобирается (во встроенном просмотрщике живёт CodeMirror).
    attachmentRows = [...attachmentRows, makeAttachment({ id: 'a3', title: 'новое.png' })];
    const callsBeforeCreate = listCalls;
    await feed('attachment.created', 'n1', {
      attachment: makeAttachment({ id: 'a3', title: 'новое.png' }),
    });
    assert.equal(builds(), 1, 'показанная вкладка не пересобирается');
    assert.ok(listCalls > callsBeforeCreate, 'список перечитан на месте');
    assert.ok(titles().includes('новое.png'), 'новое вложение видно сразу');

    // 4. `updated` без владельца (в событии только id): владельца находит кэш слоя.
    attachmentRows = attachmentRows.map((row) =>
      row.id === 'a1' ? { ...row, title: 'переименовано.png' } : row,
    );
    await feed('attachment.updated', 'n1', { id: 'a1', changes: { title: 'переименовано.png' } });
    assert.equal(builds(), 1, '`updated` показанного вложения не пересобирает вкладку');
    assert.ok(titles().includes('переименовано.png'), 'правка вложения видна в списке');

    // 5. `deleted` (в событии только id): строка исчезает.
    attachmentRows = attachmentRows.filter((row) => row.id !== 'a3');
    await feed('attachment.deleted', 'n1', { id: 'a3' });
    assert.equal(builds(), 1, '`deleted` не пересобирает показанную вкладку');
    assert.ok(!titles().includes('новое.png'), 'удалённое вложение исчезло из списка');

    // 6. Скрытая вкладка: событие о своём владельце сбрасывает кэш — возврат на
    //    «Вложения» пересобирает её и читает список с сервера.
    editorInternals.activateTab('metadata');
    await flush();
    await feed('attachment.updated', 'n1', { id: 'a1', changes: { title: 'ещё раз.png' } });
    assert.equal(builds(), 1, 'кэш сброшен, но скрытая вкладка ещё не пересобрана');
    editorInternals.activateTab('attachments');
    await flush();
    assert.equal(builds(), 2, 'скрытая вкладка пересобрана после сброса кэша');

    // 7. «Комментарий» со своим CodeMirror не пересобирался ни разу.
    assert.equal(
      editorInternals.paneBuildCount('main'),
      mainBuilds,
      'вкладка «Комментарий» не пересобиралась',
    );
  });
});

// ---------------------------------------------------------------------------
// Проводка путей: ключ вкладки, гейт редактора, отсутствие локального канала
// ---------------------------------------------------------------------------

describe('проводка realtime-вложений (ошибка abd25adb, G4)', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, '..', 'src', 'renderer', rel), 'utf8');

  it('вкладка и редактор слушают ключ слоя attachments, локального канала нет', () => {
    const attachments = read('editor/attachments.ts');
    assert.ok(attachments.includes('onQueryInvalidated('), 'панель подписана на инвалидации слоя');
    assert.ok(
      attachments.includes("queryKeys.attachments(ownerType, ownerId)"),
      'панель слушает свой ключ вложений',
    );
    assert.ok(
      attachments.includes("commitEntity('attachment'"),
      'панель кладёт записи вложений в нормализованный кэш',
    );
    assert.ok(
      !attachments.includes('etn:attachments-changed'),
      'локальный канал вложений снесён',
    );

    const editor = read('editor/editor.ts');
    assert.ok(
      /onQueryInvalidated\(\(prefix\) => \{[\s\S]{0,700}?invalidateAttachmentsPanes\(\)/.test(editor),
      'редактор слушает ключ вложений и сбрасывает кэш вкладки',
    );
    assert.ok(
      /function invalidateAttachmentsPanes\(\): void \{\s*if \(shownTab === 'attachments'\) return;\s*invalidatePanes\(\['attachments'\]\);/.test(
        editor,
      ),
      'кэш сбрасывает только скрытая вкладка «Вложения»',
    );
  });

  it('чужие сети отсекаются роутером слоя', () => {
    const router = read('lib/live/event-router.ts');
    assert.ok(
      /evt\.network_id !== ctx\.networkId/.test(router),
      'роутер отсекает события чужой сети',
    );
  });
});
