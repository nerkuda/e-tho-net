/**
 * Regression test for ETN error abd25adb «Вкладка "Вложения" не обновляется при
 * изменении вложений другим клиентом (real-time)».
 *
 * Симптом: в клиенте A открыта мысль (видна вкладка «Вложения» со счётчиком);
 * клиент B (или MCP) добавляет / изменяет / удаляет вложение той же мысли —
 * счётчик и список у A не меняются до переоткрытия мысли.
 *
 * Причина (диагноз из 05bd8809): realtime-путь вложений не доходил до открытого
 * редактора. `realtime-ui.ts` для `attachment.updated`/`deleted` лишь сбрасывал
 * кэш индикаторов холста, а гейт редактора («владелец + слой + версия мысли»)
 * такие события не пропускает — версия мысли не меняется; своего обработчика
 * `attachment.*` у редактора не было (комментарий про «realtime hook
 * (attachments.ts)» был неверен).
 *
 * Здесь проверяется:
 *  1) реальный путь события через `initRealtime` + `mountEditor` под DOM-шимом
 *     (как в `renderer-property-definition-panes.test.ts`): `attachment.created`
 *     для показанной мысли обновляет список и счётчик без пересборки вкладки;
 *     `updated`/`deleted` (в событии только id) находят владельца по индексу
 *     показанных вложений; скрытая вкладка сбрасывает кэш и пересобирается при
 *     возврате; «Комментарий» (CodeMirror) не пересобирается;
 *  2) чужая мысль и чужая сеть — игнор;
 *  3) одно событие обрабатывается ровно один раз (гейт переиспускает локальный
 *     канал `etn:attachments-changed`, а не обрабатывает изменение сам);
 *     собственное эхо до рендерера не доходит (G8-applier главного процесса) —
 *     realtime-путь и локальный путь не пересекаются.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { Attachment, Thought } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Чистый гейт: индекс показанных вложений и факты события
// ---------------------------------------------------------------------------

describe('гейт изменения вложений (ошибка abd25adb)', () => {
  it('индекс показанных вложений отвечает владельцем, удаление/перенос снимают id', async () => {
    const {
      forgetShownAttachment,
      rememberShownAttachments,
      sameAttachmentOwner,
      shownAttachmentOwner,
    } = await import('../src/renderer/lib/attachment-events.js');

    rememberShownAttachments([
      { id: 'a1', owner_type: 'thought', owner_id: 't1' },
      { id: 'a2', owner_type: 'link', owner_id: 'l1' },
    ]);
    assert.deepEqual(shownAttachmentOwner('a1'), { ownerType: 'thought', ownerId: 't1' });
    assert.deepEqual(shownAttachmentOwner('a2'), { ownerType: 'link', ownerId: 'l1' });
    assert.equal(shownAttachmentOwner('a9'), null, 'чужого вложения в индексе нет');
    assert.equal(
      sameAttachmentOwner({ ownerType: 'thought', ownerId: 't1' }, { ownerType: 'thought', ownerId: 't1' }),
      true,
    );
    assert.equal(
      sameAttachmentOwner({ ownerType: 'thought', ownerId: 't1' }, { ownerType: 'link', ownerId: 't1' }),
      false,
      'тип владельца — часть идентичности',
    );

    forgetShownAttachment('a1');
    assert.equal(shownAttachmentOwner('a1'), null, 'удалённое/перенесённое вложение снято с индекса');

    // Индекс заменяется целиком: сверяться нужно с текущим списком.
    rememberShownAttachments([{ id: 'a3', owner_type: 'thought', owner_id: 't3' }]);
    assert.equal(shownAttachmentOwner('a2'), null, 'прежний список заменён');
    assert.deepEqual(shownAttachmentOwner('a3'), { ownerType: 'thought', ownerId: 't3' });
  });

  it('факты события: created несёт владельца, updated — только id (owner лишь в changes), deleted — только id', async () => {
    const { attachmentChangeFacts, isAttachmentEventType } = await import(
      '../src/renderer/lib/attachment-events.js'
    );

    const created = attachmentChangeFacts('attachment.created', {
      attachment: { id: 'a1', owner_type: 'thought', owner_id: 't1' },
    });
    assert.deepEqual(created, { attachmentId: 'a1', ownerId: 't1', ownerType: 'thought' });

    const renamed = attachmentChangeFacts('attachment.updated', {
      id: 'a1',
      changes: { title: 'renamed.png' },
    });
    assert.deepEqual(renamed, { attachmentId: 'a1', ownerId: null, ownerType: null });

    const moved = attachmentChangeFacts('attachment.updated', {
      id: 'a1',
      changes: { owner_type: 'thought', owner_id: 't2' },
    });
    assert.deepEqual(moved, { attachmentId: 'a1', ownerId: 't2', ownerType: 'thought' });

    const movedOwnerIdOnly = attachmentChangeFacts('attachment.updated', {
      id: 'a1',
      changes: { owner_id: 't2' },
    });
    assert.deepEqual(
      movedOwnerIdOnly,
      { attachmentId: 'a1', ownerId: 't2', ownerType: null },
      'owner_type не менялся — сравнение берёт показанный тип',
    );

    assert.deepEqual(attachmentChangeFacts('attachment.deleted', { id: 'a1' }), {
      attachmentId: 'a1',
      ownerId: null,
      ownerType: null,
    });

    assert.equal(isAttachmentEventType('attachment.created'), true);
    assert.equal(isAttachmentEventType('attachment.updated'), true);
    assert.equal(isAttachmentEventType('attachment.deleted'), true);
    assert.equal(isAttachmentEventType('comment.created'), false);
  });
});

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

/** Сколько раз редактор/производители переиспустили локальный канал вложений. */
let attachmentsChangedDispatches = 0;

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
      if (event.type === 'etn:attachments-changed') attachmentsChangedDispatches++;
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

describe('realtime-вложения открытого редактора (ошибка abd25adb)', () => {
  it('created/updated/deleted показанной мысли обновляют список и счётчик; чужая мысль/сеть — игнор', async () => {
    shimDom();
    attachmentsChangedDispatches = 0;

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

    const realtimeEvent = (type: string, networkId: string, data: unknown) => ({
      type,
      seq: 1,
      ts: '2026-01-01T00:00:00.000Z',
      actor: { user_id: 'u2', client_id: 'c2' },
      network_id: networkId,
      audience: 'network',
      layer_id: '00000000-0000-4000-8000-000000000001',
      data,
    });
    const feed = async (evt: Record<string, unknown>): Promise<void> => {
      realtimeHandler!(evt);
      await flush();
    };

    // 1. ЧУЖАЯ мысль: вложение чужого владельца вкладку показанной не трогает.
    const callsForeign = listCalls;
    const dispatchesForeign = attachmentsChangedDispatches;
    await feed(
      realtimeEvent('attachment.created', 'n1', {
        attachment: makeAttachment({ id: 'a9', owner_id: 't9', title: 'чужое.png' }),
      }),
    );
    assert.equal(listCalls, callsForeign, 'чужой владелец список не перечитывает');
    assert.equal(
      attachmentsChangedDispatches,
      dispatchesForeign,
      'чужой владелец локальный канал не переиспускает',
    );
    assert.equal(builds(), 1, 'чужой владелец вкладку не пересобирает');

    // 2. ЧУЖАЯ сеть: событие соседней вкладки к показанной сущности не относится.
    const callsOtherNet = listCalls;
    await feed(
      realtimeEvent('attachment.created', 'n2', {
        attachment: makeAttachment({ id: 'a8', owner_id: 't1', title: 'другая сеть.png' }),
      }),
    );
    assert.equal(listCalls, callsOtherNet, 'событие соседней сети игнорируется');

    // 3. `created` показанной мысли: список перечитывается на месте, вкладка НЕ
    //    пересобирается (во встроенном просмотрщике живёт CodeMirror), ровно одно
    //    переиспускание локального канала — одно изменение обрабатывается один раз.
    attachmentRows = [...attachmentRows, makeAttachment({ id: 'a3', title: 'новое.png' })];
    const callsBeforeCreate = listCalls;
    const dispatchesBeforeCreate = attachmentsChangedDispatches;
    await feed(
      realtimeEvent('attachment.created', 'n1', {
        attachment: makeAttachment({ id: 'a3', title: 'новое.png' }),
      }),
    );
    assert.equal(builds(), 1, 'показанная вкладка не пересобирается');
    assert.ok(listCalls > callsBeforeCreate, 'список перечитан на месте');
    assert.equal(
      attachmentsChangedDispatches,
      dispatchesBeforeCreate + 1,
      'ровно одно переиспускание локального канала на событие (без дублей)',
    );
    assert.ok(titles().includes('новое.png'), 'новое вложение видно сразу');

    // 4. `updated` без владельца (в событии только id): владельца находит индекс
    //    показанных вложений — заголовок строки обновляется.
    attachmentRows = attachmentRows.map((row) =>
      row.id === 'a1' ? { ...row, title: 'переименовано.png' } : row,
    );
    await feed(
      realtimeEvent('attachment.updated', 'n1', { id: 'a1', changes: { title: 'переименовано.png' } }),
    );
    assert.equal(builds(), 1, '`updated` показанного вложения не пересобирает вкладку');
    assert.ok(titles().includes('переименовано.png'), 'правка вложения видна в списке');

    // 5. `deleted` (в событии только id): строка исчезает, id снимается с индекса.
    attachmentRows = attachmentRows.filter((row) => row.id !== 'a3');
    await feed(realtimeEvent('attachment.deleted', 'n1', { id: 'a3' }));
    assert.equal(builds(), 1, '`deleted` не пересобирает показанную вкладку');
    assert.ok(!titles().includes('новое.png'), 'удалённое вложение исчезло из списка');

    // 6. Скрытая вкладка: событие о своём владельце сбрасывает кэш — возврат на
    //    «Вложения» пересобирает её и читает список с сервера (именно здесь список
    //    раньше оставался прежним до переоткрытия мысли).
    editorInternals.activateTab('metadata');
    await flush();
    await feed(
      realtimeEvent('attachment.updated', 'n1', { id: 'a1', changes: { title: 'ещё раз.png' } }),
    );
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
// Проводка путей: индекс вкладки, гейт редактора, отсутствие дублей
// ---------------------------------------------------------------------------

describe('проводка realtime-вложений (ошибка abd25adb)', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, '..', 'src', 'renderer', rel), 'utf8');

  it('вкладка ведёт индекс показанных вложений, редактор — гейт и локальный канал', () => {
    const attachments = read('editor/attachments.ts');
    assert.ok(
      /registerTabCount\('attachments', async \(ctx\) => \{[\s\S]{0,400}?rememberShownAttachments\(items\)/.test(
        attachments,
      ),
      'счётчик вкладки наполняет индекс показанных вложений',
    );
    assert.ok(
      /attachments = await etn\.attachments\.list[\s\S]{0,400}?rememberShownAttachments\(attachments\)/.test(
        attachments,
      ),
      'список вкладки наполняет индекс показанных вложений',
    );

    const editor = read('editor/editor.ts');
    assert.ok(
      /if \(isAttachmentEventType\(evt\.type\)\) \{\s*applyAttachmentRealtime\(evt\.type, evt\.data\);/.test(
        editor,
      ),
      'realtime-подписка на attachment.* на месте',
    );
    // Применение — тот же локальный канал, что и у собственных правок: обработка
    // не дублируется (одна точка применения), показанная вкладка перечитывает
    // список на месте, скрытая — сбрасывает кэш (invalidateAttachmentsPanes).
    assert.ok(
      /function applyAttachmentRealtime\([\s\S]*?document\.dispatchEvent\(\s*new CustomEvent\('etn:attachments-changed'/.test(
        editor,
      ),
      'realtime-гейт переиспускает локальный канал вложений',
    );
    assert.ok(
      /function invalidateAttachmentsPanes\(\): void \{\s*if \(shownTab === 'attachments'\) return;\s*invalidatePanes\(\['attachments'\]\);/.test(
        editor,
      ),
      'кэш сбрасывает только скрытая вкладка «Вложения»',
    );
  });

  it('чужие сети отсекаются, а собственное realtime-эхо отбрасывает G8-applier', () => {
    const editor = read('editor/editor.ts');
    assert.ok(
      /onRealtimeEvent\(\(evt\) => \{[\s\S]{0,200}?if \(evt\.network_id !== store\.state\.networkId\) return;/.test(
        editor,
      ),
      'гейт редактора отсекает события чужой сети',
    );
    // Собственное эхо до рендерера не доходит — значит local-канал (свои правки)
    // и realtime-канал (чужие правки) не пересекаются: дублей быть не может.
    const applier = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'main', 'realtime', 'applier.ts'),
      'utf8',
    );
    assert.ok(
      /event\.actor\.client_id === hooks\.getClientId\(\)/.test(applier),
      'G8-applier отбрасывает собственные записи до рендерера',
    );
  });
});
