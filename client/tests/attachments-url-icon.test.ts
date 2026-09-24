/**
 * Тесты задачи 2fd41d3a «Иконку мысли — из ссылки во вложении» (0.8.3).
 *
 * В контекстном меню url-вложения появляется пункт «Назначить иконкой мысли»,
 * когда у ссылки извлечена иконка (favicon), и назначение ставит мысли
 * `icon_kind = 'image'` из того же источника, что drag-and-drop интернет-ссылки
 * в зону карты (canvas/add-dialog.ts). Доменая логика из attachments.ts вынесена
 * в чистые/экспортируемые функции, чтобы её можно было проверить без DOM:
 * `urlAttachmentIcon`, `canAssignAsThoughtIcon`, `assignDataIconToThought`.
 *
 * Идут под Node с минимальным `window`-шимом (как renderer-icon-reflect.test.ts):
 * `assignDataIconToThought` дёргает `etn.thoughts.update` и `reflectThoughtUpdate`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Attachment, FocusResponse, Thought } from '@etn/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DATA_ICON = 'data:image/png;base64,AAA';

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a1',
    owner_type: 'thought',
    owner_id: 't1',
    kind: 'url',
    url: 'https://example.com',
    file_path: null,
    file_size: null,
    mime_type: null,
    title: 'Example',
    icon: null,
    description: null,
    position: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u1',
    ...overrides,
  };
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
    version: 3,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeFocus(focused: Thought): FocusResponse {
  return {
    focused,
    parents: [],
    siblings: [],
    children: [],
    edges: [],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

describe('urlAttachmentIcon / canAssignAsThoughtIcon — видимость пункта меню', () => {
  it('url-вложение с извлечённой иконкой → пункт доступен, источник — favicon', async () => {
    const { canAssignAsThoughtIcon, urlAttachmentIcon } = await import(
      '../src/renderer/editor/attachments.js'
    );
    const a = makeAttachment({ icon: DATA_ICON });
    assert.equal(urlAttachmentIcon(a), DATA_ICON);
    assert.equal(canAssignAsThoughtIcon(a), true);
  });

  it('url-вложение без извлечённой иконки → пункта нет', async () => {
    const { canAssignAsThoughtIcon, urlAttachmentIcon } = await import(
      '../src/renderer/editor/attachments.js'
    );
    const a = makeAttachment({ icon: null });
    assert.equal(urlAttachmentIcon(a), null);
    assert.equal(canAssignAsThoughtIcon(a), false);
  });

  it('url-вложение с не-data иконкой (битой) не проходит', async () => {
    const { canAssignAsThoughtIcon, urlAttachmentIcon } = await import(
      '../src/renderer/editor/attachments.js'
    );
    const a = makeAttachment({ icon: 'etnimg:C:/tmp/fav.ico' });
    assert.equal(urlAttachmentIcon(a), null);
    assert.equal(canAssignAsThoughtIcon(a), false);
  });

  it('file-вложение-картинка → пункт доступен (прежнее поведение сохранено)', async () => {
    const { canAssignAsThoughtIcon, urlAttachmentIcon } = await import(
      '../src/renderer/editor/attachments.js'
    );
    const a = makeAttachment({ kind: 'file', url: null, file_path: 'C:/a.png', mime_type: 'image/png' });
    assert.equal(urlAttachmentIcon(a), null, 'у file-вложения favicon не берётся');
    assert.equal(canAssignAsThoughtIcon(a), true);
  });

  it('file-вложение не-картинка → пункта нет', async () => {
    const { canAssignAsThoughtIcon } = await import('../src/renderer/editor/attachments.js');
    const a = makeAttachment({
      kind: 'file',
      url: null,
      file_path: 'C:/doc.pdf',
      mime_type: 'application/pdf',
    });
    assert.equal(canAssignAsThoughtIcon(a), false);
  });
});

describe('assignDataIconToThought — назначение иконки', () => {
  it('пишет icon/icon_kind=image и без attachment_id для favicon, отражая UI', async () => {
    const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
      string,
      unknown
    >;
    win.setTimeout = setTimeout;
    win.clearTimeout = clearTimeout;

    const thought = makeThought();
    const updated = makeThought({ icon: DATA_ICON, icon_kind: 'image', version: 4 });
    const calls: Array<{ id: string; patch: unknown; version: number }> = [];
    win.etn = {
      thoughts: {
        update: async (_n: string, id: string, patch: unknown, version: number) => {
          calls.push({ id, patch, version });
          return updated;
        },
        focus: async () => null,
      },
    };

    const { store } = await import('../src/renderer/state.js');
    store.update({ focus: makeFocus(thought), editorTarget: null });

    const { assignDataIconToThought } = await import('../src/renderer/editor/attachments.js');
    const result = await assignDataIconToThought('n1', thought, DATA_ICON, null);

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.deepEqual(call.patch, { icon: DATA_ICON, icon_kind: 'image' });
    assert.equal(call.version, thought.version, 'оптимистичная блокировка по версии мысли');
    assert.equal(result, updated);
    assert.equal(store.state.focus?.focused.icon, DATA_ICON, 'карта/карточка обновляются сразу');
    assert.equal(store.state.focus?.focused.icon_kind, 'image');
  });

  it('прокидывает attachment_id, когда иконка из файла-вложения (Ctrl-hover)', async () => {
    const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
      string,
      unknown
    >;
    win.setTimeout = setTimeout;
    win.clearTimeout = clearTimeout;

    const thought = makeThought();
    let captured: unknown = null;
    win.etn = {
      thoughts: {
        update: async (_n: string, _id: string, patch: unknown) => {
          captured = patch;
          return makeThought({ icon: DATA_ICON, icon_kind: 'image', icon_attachment_id: 'a1' });
        },
        focus: async () => null,
      },
    };

    const { store } = await import('../src/renderer/state.js');
    store.update({ focus: makeFocus(thought), editorTarget: null });

    const { assignDataIconToThought } = await import('../src/renderer/editor/attachments.js');
    await assignDataIconToThought('n1', thought, DATA_ICON, 'a1');

    assert.deepEqual(captured, {
      icon: DATA_ICON,
      icon_kind: 'image',
      icon_attachment_id: 'a1',
    });
  });
});
