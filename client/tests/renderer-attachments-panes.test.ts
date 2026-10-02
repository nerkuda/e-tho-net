/**
 * Regression test for ETN error 05bd8809 «Вкладка "Вложения" не показывает
 * вложение сразу после вставки картинки в комментарий».
 *
 * Симптом: в редакторе мысли на вкладке «Комментарий» вставляют картинку из
 * буфера — картинка появляется в тексте, счётчик вкладки «Вложения» растёт на
 * 1, но список вкладки нового вложения не показывает до переоткрытия мысли.
 *
 * Причина: вкладка «Вложения» кэшируется в `builtPanes` и переживает переход на
 * «Комментарий». При показе другой вкладки её DOM отключается, и её собственный
 * слушатель `etn:attachments-changed` самоотписывается (защита от утечки,
 * attachments.ts), список не перечитывая. Счётчик обновлял отдельный документный
 * слушатель в editor.ts — отсюда расхождение счётчика и списка.
 *
 * Здесь проверяется реальный путь под DOM-шимом (как в
 * `renderer-property-definition-panes.test.ts`): событие о владельце показанной
 * сущности (1) у показанной вкладки перечитывает список на месте и НЕ
 * пересобирает её (во встроенном просмотрщике текстового вложения живёт
 * CodeMirror с несохранённой правкой), (2) у скрытой вкладки сбрасывает кэш —
 * возврат на «Вложения» собирает вкладку заново и читает список с сервера.
 * «Комментарий» (CodeMirror постоянного комментария) при этом не пересобирается.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { Attachment, Thought } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

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

describe('вложения открытого редактора (ошибка 05bd8809)', () => {
  it('событие о владельце обновляет список и счётчик, скрытую вкладку сбрасывает', async () => {
    const initialTab = 'attachments';
    shimDom();

    /** Строки, которые вернёт `etn.attachments.list` (сервер-состояние). */
    let attachmentRows: Attachment[] = [makeAttachment({ id: 'a1', title: 'старое.png' })];
    let listCalls = 0;
    (globalThis as any).window.etn = {
      ui: { getState: async () => initialTab, setState: async () => undefined },
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
      // Вкладка «Метаданные» (промежуточная вторая вкладка в сценарии) резолвит
      // автора/редактора через список пользователей.
      admin: { listUsers: async () => [] },
      realtime: {
        onStatusChange: () => undefined,
        onStale: () => undefined,
        onNetworkLost: () => undefined,
        onLayerControl: () => undefined,
        onEvent: () => undefined,
        notifyOnline: () => undefined,
      },
    };

    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');

    // Первый показ — вкладка «Вложения» (как после переоткрытия мысли).
    store.update({
      networkId: 'n1',
      editorTarget: { kind: 'thought', id: 't1', thought: makeThought() },
      collapsedGroups: {},
    } as any);

    const host = new ShimElement('div');
    mountEditor(host as any);
    await flush();

    const builds = (): number => editorInternals.paneBuildCount('attachments');
    // При полной пересборке редактор сначала показывает «Комментарий» (вкладка
    // ещё не восстановлена из L4), затем — сохранённую. Дальше «Комментарий» не
    // должен пересобираться ни разу: в нём живёт CodeMirror постоянного
    // комментария.
    const mainBuildsAfterMount = editorInternals.paneBuildCount('main');
    assert.equal(builds(), 1, 'вкладка «Вложения» построена при первом показе');
    assert.ok(listCalls > 0, 'список прочитан с сервера');
    assert.equal(
      findByClass(host, 'att-title').map((n) => n.textContent).join('|'),
      'старое.png',
      'в списке показано прежнее вложение',
    );

    const notify = (ownerId: string): void => {
      (globalThis as any).document.dispatchEvent(
        new (globalThis as any).CustomEvent('etn:attachments-changed', {
          detail: { ownerType: 'thought', ownerId },
        }),
      );
    };

    // 1. Вставка картинки в комментарий, вкладка «Вложения» видна: список
    //    перечитывается на месте, вкладка НЕ пересобирается — во встроенном
    //    просмотрщике текстового вложения живёт CodeMirror с несохранённой
    //    правкой, а пересборка его уничтожила бы.
    attachmentRows = [
      makeAttachment({ id: 'a1', title: 'старое.png' }),
      makeAttachment({ id: 'a2', title: 'новое.png' }),
    ];
    const callsBefore = listCalls;
    notify('t1');
    await flush();
    assert.equal(builds(), 1, 'показанная вкладка не пересобирается');
    assert.ok(listCalls > callsBefore, 'показанная вкладка перечитывает список на месте');
    assert.ok(
      findByClass(host, 'att-title').some((n) => n.textContent === 'новое.png'),
      'новое вложение видно в списке сразу',
    );

    // 2. Событие о ЧУЖОМ владельце: набор вложений показанной сущности не менялся.
    const callsForeign = listCalls;
    const buildsForeign = builds();
    notify('t9');
    await flush();
    assert.equal(builds(), buildsForeign, 'чужой владелец вкладку не пересобирает');
    assert.equal(listCalls, callsForeign, 'чужой владелец список не перечитывает');

    // 3. Уходим на другую вкладку — «Вложения» остаётся в кэше, но отключена от
    //    DOM. Событие о своём владельце обязано сбросить кэш (именно здесь
    //    список раньше оставался прежним).
    editorInternals.activateTab('metadata');
    await flush();
    notify('t1');
    await flush();
    editorInternals.activateTab('attachments');
    await flush();
    assert.equal(builds(), 2, 'скрытая вкладка пересобрана после сброса кэша');
    assert.ok(
      findByClass(host, 'att-title').some((n) => n.textContent === 'новое.png'),
      'после возврата на вкладку вложение из вставки в списке (без переоткрытия мысли)',
    );

    // 4. «Комментарий» со своим CodeMirror не пересобирался ни разу.
    assert.equal(
      editorInternals.paneBuildCount('main'),
      mainBuildsAfterMount,
      '«Комментарий» не пересобирался — CodeMirror постоянного комментария цел',
    );
  });
});

// ---------------------------------------------------------------------------
// Проводка путей вложения: добавление и удаление обновляют список и счётчик
// ---------------------------------------------------------------------------

describe('проводка обновления списка вложений (ошибка 05bd8809)', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, '..', 'src', 'renderer', rel), 'utf8');

  it('удаление/перенос на вкладке и перечитывание списка обновляют счётчик', () => {
    const attachments = read('editor/attachments.ts');
    // Удаление на вкладке: строка убирается, 📎-индикатор холста сбрасывается,
    // список и счётчик перечитываются тем же reload().
    assert.ok(
      /await etn\.attachments\.remove\(networkId, attachment\.id\);[\s\S]{0,400}?invalidateIndicators\(attachment\.owner_id\);[\s\S]{0,400}?await reload\(\)/.test(
        attachments,
      ),
      'удаление вложения перечитывает список',
    );
    // Список и счётчик неразделимы: reload() обновляет и бейдж (через колбэк
    // владельца панели; для вкладки мысли это refreshTabCount('attachments')).
    assert.ok(
      /async function reload\(\): Promise<void> \{[\s\S]{0,900}?onCountChange\?\.\(\)/.test(
        attachments,
      ),
      'reload() обновляет счётчик вкладки',
    );
    assert.ok(
      /onCountChange: \(\) => refreshTabCount\('attachments'\)/.test(attachments),
      'вкладка мысли подключает к панели обновление бейджа',
    );
    // Слушатель события для скрытой вкладки самоотписывается (защита от
    // утечки) — поэтому кэш скрытой вкладки сбрасывает редактор.
    assert.ok(
      /if \(!root\.isConnected\) \{\s*document\.removeEventListener\('etn:attachments-changed', onExternalChange\);/.test(
        attachments,
      ),
      'слушатель вкладки самоотписывается, список скрытой вкладки живёт в кэше',
    );
  });

  it('редактор сбрасывает кэш только вкладки «Вложения»', () => {
    const editor = read('editor/editor.ts');
    assert.ok(
      /function invalidateAttachmentsPanes\(\): void \{\s*if \(shownTab === 'attachments'\) return;\s*invalidatePanes\(\['attachments'\]\);/.test(
        editor,
      ),
      'сбрасывается кэш ровно одной вкладки, показанная не пересобирается',
    );
    assert.ok(
      /refreshTabCount\('attachments'\);\s*invalidateAttachmentsPanes\(\);/.test(editor),
      'событие обновляет и счётчик, и список',
    );
  });
});
