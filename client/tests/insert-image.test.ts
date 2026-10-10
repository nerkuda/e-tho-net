/**
 * Вставка картинки в текст комментария (0.12.1, задача 87c455db, элемент
 * интерфейса d87b8f32, требование 5943e3e8, ADR d85e17b6).
 *
 * Проверяются три триггера и формат ссылки:
 *  1) Ctrl+V/Drag&Drop — файл-картинка уходит вложением на владельца, в каретку
 *     вставляется `![…](etnimg://attachment/<id>)`; текст/не-картинки — прежним
 *     путём (`[имя](etnimg://<путь>)`);
 *  2) команда диалога — эмодзи глифом, URL картинкой по адресу, существующее
 *     вложение — ссылкой по id (владелец добавляется `addOwners`), новый файл —
 *     загрузкой на владельца и ссылкой по id;
 *  3) диалог собран каркасом `createResourcePicker` без вкладки «Библиотека»
 *     (ADR 348c9f68), пункт меню поля зовёт его.
 *
 * Клиентские тесты идут без jsdom — DOM-шим (как в renderer-attachments-*).
 * `window.etn` подставляется стабом; `FileReader` — шим.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { Attachment } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');
const readText = (rel: string): string => readFileSync(resolve(RENDERER, rel), 'utf8');

const NET = '11111111-2222-3333-4444-555555555555';
const ATT = '22222222-2222-4222-8222-222222222222';

/** `FileReader`-шим: отдаёт data:-URL, собранный из типа файла. */
class FakeFileReader {
  result: string | null = null;
  private listeners = new Map<string, () => void>();
  addEventListener(type: string, cb: () => void): void {
    this.listeners.set(type, cb);
  }
  readAsDataURL(file: any): void {
    this.result = `data:${file.type || 'application/octet-stream'};base64,QUJD`;
    queueMicrotask(() => this.listeners.get('load')?.());
  }
}

function shimDom(): void {
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).FileReader = FakeFileReader;
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
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
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

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: ATT,
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

/** Файл-картинка (или иной файл) без Node-`File` — достаточно полей. */
function fakeFile(name: string, type: string): File {
  return { name, type } as unknown as File;
}

/** Редактор-стаб: собирает всё, что вставили в каретку. */
function fakeEditor(): { editor: any; inserted: string[] } {
  const inserted: string[] = [];
  return {
    inserted,
    editor: {
      dom: new ShimElement('div'),
      insertAtCaret: (text: string) => inserted.push(text),
    },
  };
}

interface Calls {
  uploads: Array<{ ownerType: string; ownerId: string; input: any }>;
  owners: Array<{ id: string; input: any }>;
}

function installEtn(calls: Calls, uploaded: Attachment): void {
  (globalThis as any).window.etn = {
    attachments: {
      uploadFile: async (
        _networkId: string,
        ownerType: string,
        ownerId: string,
        input: any,
      ) => {
        calls.uploads.push({ ownerType, ownerId, input });
        return uploaded;
      },
      addOwners: async (_networkId: string, id: string, input: any) => {
        calls.owners.push({ id, input });
        return { added: [id], skipped: [] };
      },
      search: async () => [],
      get: async () => uploaded,
      list: async () => [],
    },
    system: { readClipboard: async () => ({ text: null, imagePngDataUrl: null }) },
    realtime: {
      onStatusChange: () => undefined,
      onStale: () => undefined,
      onNetworkLost: () => undefined,
      onLayerControl: () => undefined,
      onEvent: () => undefined,
      notifyOnline: () => undefined,
    },
  };
}

let modules: any = null;
async function load(calls: Calls, uploaded: Attachment): Promise<any> {
  if (modules === null) {
    shimDom();
    const markdownField = await import('../src/renderer/editor/markdown-field.js');
    const { store } = await import('../src/renderer/state.js');
    const live = await import('../src/renderer/lib/live/index.js');
    modules = { markdownField, store, live };
  }
  installEtn(calls, uploaded);
  modules.live.resetQueryRegistry();
  modules.live.resetEventRouter();
  modules.store.update({ networkId: NET } as any);
  return modules;
}

function freshCalls(): Calls {
  return { uploads: [], owners: [] };
}

describe('формат ссылки на картинку (5943e3e8)', () => {
  it('attachmentImageRef даёт etnimg://attachment/<id> и чистит скобки', async () => {
    const { markdownField } = await load(freshCalls(), makeAttachment());
    const ref = markdownField.mdFieldInternals.attachmentImageRef(ATT, 'кар[тин]ка.png');
    assert.equal(ref, `![картинка.png](etnimg://attachment/${ATT})`);
  });
});

describe('Ctrl+V / Drag&Drop картинки (87c455db)', () => {
  it('картинка уходит вложением на владельца и вставляется ссылкой по id', async () => {
    const calls = freshCalls();
    const uploaded = makeAttachment({ id: 'att-pasted', title: 'shot.png' });
    const { markdownField } = await load(calls, uploaded);
    const { editor, inserted } = fakeEditor();

    await markdownField.mdFieldInternals.insertClipboardFiles(
      editor,
      { ownerType: 'thought', ownerId: 't1' },
      [fakeFile('shot.png', 'image/png')],
    );

    assert.deepEqual(calls.uploads, [
      {
        ownerType: 'thought',
        ownerId: 't1',
        input: { title: 'shot.png', mime_type: 'image/png', data_base64: 'QUJD' },
      },
    ]);
    assert.deepEqual(inserted, ['![shot.png](etnimg://attachment/att-pasted)']);
  });

  it('не-картинка вставляется прежним путём — ссылкой по пути', async () => {
    const calls = freshCalls();
    const uploaded = makeAttachment({
      id: 'att-txt',
      title: 'note.txt',
      file_path: 'C:/net/attachments/note.txt',
      mime_type: 'text/plain',
    });
    const { markdownField } = await load(calls, uploaded);
    const { editor, inserted } = fakeEditor();

    await markdownField.mdFieldInternals.insertClipboardFiles(
      editor,
      { ownerType: 'thought', ownerId: 't1' },
      [fakeFile('note.txt', '')],
    );

    assert.deepEqual(inserted, ['[note.txt](etnimg://c/net/attachments/note.txt)']);
  });

  it('imageFilesFrom пропускает только картинки (тип drop/вставки)', async () => {
    const { markdownField } = await load(freshCalls(), makeAttachment());
    const picked = markdownField.mdFieldInternals.imageFilesFrom([
      fakeFile('a.png', 'image/png'),
      fakeFile('b.txt', 'text/plain'),
      fakeFile('c.jpg', 'image/jpeg'),
    ]);
    assert.deepEqual(
      picked.map((f: File) => f.name),
      ['a.png', 'c.jpg'],
    );
  });

  it('поле регистрирует dragover/drop для картинок (якорь исходника)', () => {
    const source = readText('editor/markdown-field.ts');
    assert.match(source, /addEventListener\('dragover'/);
    assert.match(source, /addEventListener\('drop'/);
    assert.match(source, /imageFilesFrom\(event\.dataTransfer\?\.files/);
  });
});

describe('команда «Вставить картинку» — диалог и вставка (87c455db)', () => {
  it('эмодзи вставляется глифом', async () => {
    const { markdownField } = await load(freshCalls(), makeAttachment());
    const { editor, inserted } = fakeEditor();
    await markdownField.mdFieldInternals.insertResourceAt(
      editor,
      { ownerType: 'thought', ownerId: 't1' },
      { kind: 'emoji', glyph: '🚀' },
    );
    assert.deepEqual(inserted, ['🚀']);
  });

  it('URL вставляется картинкой по адресу', async () => {
    const { markdownField } = await load(freshCalls(), makeAttachment());
    const { editor, inserted } = fakeEditor();
    await markdownField.mdFieldInternals.insertResourceAt(
      editor,
      { ownerType: 'thought', ownerId: 't1' },
      { kind: 'url', url: 'https://e.com/a.png' },
    );
    assert.deepEqual(inserted, ['![изображение](https://e.com/a.png)']);
  });

  it('существующее вложение: addOwners вызван, вставлена ссылка по id', async () => {
    const calls = freshCalls();
    const { markdownField } = await load(calls, makeAttachment());
    const { editor, inserted } = fakeEditor();
    await markdownField.mdFieldInternals.insertResourceAt(
      editor,
      { ownerType: 'thought', ownerId: 't1' },
      { kind: 'attachment', attachment: makeAttachment({ id: 'att-shared', title: 'общая.png' }) },
    );
    assert.deepEqual(calls.owners, [
      { id: 'att-shared', input: { owner_type: 'thought', owner_ids: ['t1'] } },
    ]);
    assert.deepEqual(inserted, ['![общая.png](etnimg://attachment/att-shared)']);
  });

  it('новый файл из диалога: загрузка на владельца и ссылка по id', async () => {
    const calls = freshCalls();
    const uploaded = makeAttachment({ id: 'att-new', title: 'pic.png' });
    const { markdownField } = await load(calls, uploaded);
    const { editor, inserted } = fakeEditor();
    await markdownField.mdFieldInternals.insertResourceAt(
      editor,
      { ownerType: 'thought', ownerId: 't1' },
      { kind: 'file', source: { dataUrl: 'data:image/png;base64,QUJD', mime: 'image/png', name: 'pic.png' } },
    );
    assert.equal(calls.uploads.length, 1);
    assert.deepEqual(calls.uploads[0]!.input, {
      title: 'pic.png',
      mime_type: 'image/png',
      data_base64: 'QUJD',
    });
    assert.deepEqual(inserted, ['![pic.png](etnimg://attachment/att-new)']);
  });

  it('пункт меню зовёт диалог вставки (якорь исходника)', () => {
    const source = readText('editor/markdown-field.ts');
    assert.match(source, /t\('comment\.cmd\.insertImage'\)/);
    assert.match(source, /showInsertImageDialog\(/);
    assert.match(source, /insertResourceAt\(/);
  });

  it('диалог собран каркасом без вкладки «Библиотека» (ADR 348c9f68)', () => {
    const source = readText('editor/insert-image-dialog.ts');
    assert.match(source, /createResourcePicker\(/);
    assert.match(source, /emojiSourceTab\(/);
    assert.match(source, /attachmentPickerSourceTab\(/);
    assert.match(source, /urlSourceTab\(/);
    assert.doesNotMatch(source, /libraryIconSourceTab/, 'библиотечные значки в текст не вставляются');
  });
});
