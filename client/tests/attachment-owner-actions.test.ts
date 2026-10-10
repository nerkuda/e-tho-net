/**
 * 0.12.1, задача d4c528d2 / тех.проект f9b8917c (общие вложения).
 *
 * Проверяется клиентская сторона модели владений:
 *   1. В списке выбора вложения (общий компонент `attachment-picker`) доступно
 *      ПЕРЕИМЕНОВАНИЕ самогó вложения — кнопка-карандаш в строке, запись через
 *      `PATCH /attachments/{id} {title}` (требование fabc1231).
 *   2. Диалог выбора иконки: выбор ЧУЖОГО вложения добавляет объект владельцем
 *      (`POST /attachments/{id}/owners`) и применяет его (`attachmentId`);
 *      применение СВОЕГО текущего вложения владельца не добавляет (ошибка
 *      c37981b7 + путь переиспользования 846c426a).
 *   3. Диалог обложки публикации: выбор чужого вложения добавляет публикацию
 *      владельцем, а не копирует вложение.
 *   4. Снятие обложки публикации — `DELETE /attachments/{id}/owners`
 *      (`removeOwner`), а не снятый `DELETE /attachments/{id}` (ошибка 8f9768c9).
 *
 * jsdom в проекте нет — минимальный DOM-шим (конвенция `icon-dialog-restore.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Attachment, Publication } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

const NET = 'net-1';

class ShimStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/** Минимальный FileReader (в Node нет web-API) — читает Blob в `data:` URL. */
class ShimFileReader {
  result: string | null = null;
  private readonly listeners: Record<string, Array<(event: unknown) => void>> = {};
  addEventListener(type: string, fn: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`;
      for (const fn of this.listeners['load'] ?? []) fn({});
    });
  }
}

function installShim(): void {
  const body = new ShimElement('body');
  (globalThis as any).localStorage = new ShimStorage();
  (globalThis as any).FileReader = ShimFileReader;
  // Картинка-вложение читается через `fetch(etnimg:…)` — отдаём Blob.
  (globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
  });
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
    activeElement: body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    etn: {},
    setTimeout: (fn: () => void, ms?: number) => (globalThis as any).setTimeout(fn, ms),
    clearTimeout: (handle: any) => (globalThis as any).clearTimeout(handle),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

installShim();

const { attachmentPickerSourceTab } = await import('../src/renderer/editor/attachment-picker.js');
const { showIconDialog } = await import('../src/renderer/editor/icon-dialog.js');
const { t } = await import('../src/renderer/lib/i18n.js');
const { store } = await import('../src/renderer/state.js');

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Последний открытый диалог (стопкой — верхний в конце). */
function lastBox(): ShimElement {
  const backdrops = body().children.filter((c) => c.classList.contains('dialog-backdrop'));
  const backdrop = backdrops[backdrops.length - 1];
  assert.ok(backdrop !== undefined, 'диалог открыт');
  return backdrop.querySelector('.dialog-box') as ShimElement;
}

function findByTag(root: ShimElement, tag: string): ShimElement[] {
  const wanted = tag.toUpperCase();
  const hits: ShimElement[] = [];
  const walk = (node: ShimElement): void => {
    for (const child of node.children) {
      if ((child.tagName ?? '').toUpperCase() === wanted) hits.push(child);
      walk(child);
    }
  };
  walk(root);
  return hits;
}

/** Кнопка футера диалога по подписи. */
function footerBtn(label: string): ShimElement {
  const footer = lastBox().querySelector('.dialog-footer');
  assert.ok(footer !== null, 'футер диалога построен');
  const btn = findByTag(footer as ShimElement, 'BUTTON').find((b) => b.textContent === label);
  assert.ok(btn !== undefined, `кнопка «${label}» в футере`);
  return btn;
}

/** Переключает диалог на вкладку по подписи. */
function switchTab(label: string): void {
  const tab = lastBox().querySelectorAll('.ui-tab').find((b) => b.textContent === label);
  assert.ok(tab !== undefined, `вкладка «${label}» есть`);
  tab.emit('click');
}

/** Выделяет первую строку списка выбора вложения (делегированный клик). */
function selectFirstAttachmentRow(): void {
  const list = lastBox().querySelector('.att-pick-list');
  assert.ok(list !== null, 'список вложений построен');
  const row = list.querySelector('.att-pick-item');
  assert.ok(row !== null, 'в списке есть строка вложения');
  // Шим не эмулирует всплытие/parentElement — делегированный обработчик
  // компонента ищет строку по parentElement; подставляем родителя явно.
  Object.defineProperty(row, 'parentElement', { get: () => list, configurable: true });
  list.emit('click', { target: row });
}

function imageAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-x',
    owner_type: 'thought',
    owner_id: 'th-A',
    kind: 'file',
    url: null,
    file_path: 'C:/pics/att-x.png',
    file_size: null,
    mime_type: 'image/png',
    title: 'att-x',
    icon: null,
    description: null,
    position: 0,
    created_at: '2026-10-01T00:00:00.000Z',
    created_by: 'u',
    owners: [{ owner_type: 'thought', owner_id: 'th-A', title: 'Мысль A' }],
    owner_count: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Переименование в списке выбора вложения (fabc1231)
// ---------------------------------------------------------------------------

describe('список выбора вложения: переименование в строке (fabc1231)', () => {
  beforeEach(() => installShim());

  it('карандаш в строке пишет заголовок через PATCH и перечитывает список', async () => {
    store.update({ networkId: NET });
    const updates: Array<{ id: string; title?: string | null }> = [];
    let searchCalls = 0;
    (globalThis as any).window.etn = {
      attachments: {
        search: async () => {
          searchCalls += 1;
          return [imageAttachment({ id: 'att-1', title: 'Старое имя' })];
        },
        update: async (_n: string, id: string, patch: { title?: string | null }) => {
          updates.push({ id, title: patch.title });
          return imageAttachment({ id, title: patch.title ?? null });
        },
        getUsage: async () => ({ owners: [] }),
      },
    };

    const tab = attachmentPickerSourceTab({ label: 'Вложения', onPick: () => undefined });
    const root = tab.build({ close: () => undefined, setReady: () => undefined } as any) as
      unknown as ShimElement;
    await flush();
    assert.equal(searchCalls, 1, 'список загружен');

    const head = root.querySelector('.att-pick-item-head');
    assert.ok(head !== null, 'строка несёт заголовок с действием');
    const pencil = head.findAll((el) => (el.tagName ?? '').toUpperCase() === 'BUTTON')[0];
    assert.ok(pencil !== undefined, 'кнопка переименования в строке');
    pencil.emit('click', { stopPropagation: () => undefined });

    const input = head.findAll((el) => (el.tagName ?? '').toUpperCase() === 'INPUT')[0];
    assert.ok(input !== undefined, 'заголовок заменён полем правки');
    assert.equal(input.value, 'Старое имя', 'поле заполнено текущим заголовком');

    input.value = 'Новое имя';
    input.emit('blur');
    await flush();

    assert.deepEqual(updates, [{ id: 'att-1', title: 'Новое имя' }], 'PATCH заголовка выполнен');
    assert.equal(searchCalls, 2, 'список перечитан после переименования');
  });
});

// ---------------------------------------------------------------------------
// 2. Диалог выбора иконки: чужое вложение добавляет владельца (c37981b7)
// ---------------------------------------------------------------------------

describe('диалог иконки: выбор чужого вложения добавляет владельца (c37981b7)', () => {
  beforeEach(() => installShim());

  it('чужое вложение: addOwners для мысли + onPick с её attachmentId', async () => {
    store.update({ networkId: NET });
    const addOwners: Array<{ id: string; input: unknown }> = [];
    const results: any[] = [];
    const att = imageAttachment({ id: 'att-foreign', owners: [{ owner_type: 'thought', owner_id: 'th-A', title: 'Мысль A' }] });
    (globalThis as any).window.etn = {
      system: { readClipboard: async () => ({ text: null, imagePngDataUrl: null }) },
      attachments: {
        search: async () => [att],
        getUsage: async () => ({ owners: att.owners ?? [] }),
        get: async () => att,
        addOwners: async (_n: string, id: string, input: unknown) => {
          addOwners.push({ id, input });
          return { added: [], skipped: [] };
        },
        update: async () => att,
      },
    };

    showIconDialog({
      current: { icon: '😀', kind: 'emoji', color: null },
      owner: { type: 'thought', id: 'th-B' },
      onPick: (result) => {
        results.push(result);
        return Promise.resolve(true);
      },
    });
    switchTab('Вложения');
    await flush();
    selectFirstAttachmentRow();
    await flush();
    footerBtn(t('actions.apply')).emit('click');
    await flush();
    await flush();

    assert.deepEqual(
      addOwners,
      [{ id: 'att-foreign', input: { owner_type: 'thought', owner_ids: ['th-B'] } }],
      'чужое вложение привязано к текущей мысли',
    );
    assert.equal(results.length, 1, 'выбор применён');
    assert.equal(results[0].attachmentId, 'att-foreign', 'onPick несёт id вложения');
    assert.equal(results[0].kind, 'image', 'вид иконки — картинка');
  });

  it('своё текущее вложение: владелец НЕ добавляется (846c426a)', async () => {
    store.update({ networkId: NET });
    const addOwners: unknown[] = [];
    const results: any[] = [];
    const att = imageAttachment({ id: 'att-own', owners: [{ owner_type: 'thought', owner_id: 'th-B', title: 'Мысль B' }] });
    (globalThis as any).window.etn = {
      system: { readClipboard: async () => ({ text: null, imagePngDataUrl: null }) },
      attachments: {
        search: async () => [att],
        getUsage: async () => ({ owners: att.owners ?? [] }),
        get: async () => att,
        addOwners: async (...args: unknown[]) => {
          addOwners.push(args);
          return { added: [], skipped: [] };
        },
        update: async () => att,
      },
    };

    showIconDialog({
      current: { icon: 'data:image/png;base64,AAAA', kind: 'image', color: null, attachmentId: 'att-own' },
      owner: { type: 'thought', id: 'th-B' },
      onPick: (result) => {
        results.push(result);
        return Promise.resolve(true);
      },
    });
    await flush();
    await flush();
    footerBtn(t('actions.apply')).emit('click');
    await flush();

    assert.deepEqual(addOwners, [], 'своё текущее вложение не требует addOwners');
    assert.equal(results[0]?.attachmentId, 'att-own', 'сохранён тот же attachmentId');
  });
});

// ---------------------------------------------------------------------------
// 3-4. Диалог обложки публикации (общие вложения + дефект 8f9768c9)
// ---------------------------------------------------------------------------

describe('диалог обложки публикации: владельцы и снятие (f9b8917c, 8f9768c9)', () => {
  let scrollBox: ShimElement;

  function publication(overrides: Partial<Publication> = {}): Publication {
    return {
      id: 'pub-1',
      title: 'Публикация',
      subtitle: null,
      summary_md: '',
      authorship: null,
      cover_attachment_id: null,
      cover_url: 'https://example.test/cover.png',
      cover_kind: 'url',
      assembly_date: null,
      title_recipe: null,
      text_sources: [],
      extra_properties: [],
      numbering_from: null,
      numbering_to: null,
      active: true,
      marked_for_deletion: false,
      marked_for_deletion_at: null,
      marked_for_deletion_by: null,
      version: 1,
      created_at: '2026-10-01T00:00:00.000Z',
      created_by: 'u',
      updated_at: '2026-10-01T00:00:00.000Z',
      updated_by: 'u',
      ...overrides,
    };
  }

  function installCardShim(etnAttachments: unknown): void {
    installShim();
    (globalThis as any).window.etn = {
      ui: { getState: async () => null, setState: async () => undefined },
      publications: {
        listShelves: async () => [],
        update: async (_n: string, _id: string, _ch: unknown, _v: number) => publication(),
      },
      propertyRegistry: { list: async () => [] },
      linkTypes: { list: async () => [] },
      admin: { listUsers: async () => [] },
      thoughts: { resolve: async () => [] },
      attachments: etnAttachments,
    };
  }

  afterEach(async () => {
    const mod = await import('../src/renderer/editor/publication-card.js');
    mod.disposePublicationCard();
  });

  it('выбор чужого вложения делает публикацию владельцем, а не копирует его', async () => {
    const addOwners: Array<{ id: string; input: unknown }> = [];
    const foreign = imageAttachment({
      id: 'att-foreign',
      owner_type: 'thought',
      owner_id: 'th-A',
      owners: [{ owner_type: 'thought', owner_id: 'th-A', title: 'Мысль A' }],
    });
    installCardShim({
      search: async () => [foreign],
      getUsage: async () => ({ owners: foreign.owners ?? [] }),
      get: async () => foreign,
      addOwners: async (_n: string, id: string, input: unknown) => {
        addOwners.push({ id, input });
        return { added: [], skipped: [] };
      },
      add: async () => {
        throw new Error('копирование вложения запрещено моделью владений');
      },
    });
    store.update({ networkId: NET });
    const mod = await import('../src/renderer/editor/publication-card.js');
    mod.publicationCardInternals.resetTab();
    scrollBox = new ShimElement('div');
    mod.showPublicationTarget(
      { scrollBox: scrollBox as unknown as HTMLElement },
      'pub-1',
      publication(),
    );
    mod.publicationCardInternals.openCoverDialog();
    await flush();
    await flush();

    footerBtn(t('publication.cover.apply')).emit('click');
    await flush();

    assert.deepEqual(
      addOwners,
      [{ id: 'att-foreign', input: { owner_type: 'publication', owner_ids: ['pub-1'] } }],
      'публикация добавлена владельцем чужого вложения',
    );
  });

  it('снятие владельца-публикации идёт через removeOwner, а не DELETE вложения (8f9768c9)', async () => {
    const removed: Array<{ id: string; input: unknown }> = [];
    let deleteCalled = false;
    const cover = imageAttachment({
      id: 'att-1',
      owner_type: 'publication',
      owner_id: 'pub-1',
      owners: [
        { owner_type: 'publication', owner_id: 'pub-1', title: 'Публикация' },
        { owner_type: 'thought', owner_id: 'th-A', title: 'Мысль A' },
      ],
      owner_count: 2,
    });
    installCardShim({
      search: async () => [cover],
      getUsage: async () => ({ owners: cover.owners ?? [], usages: [] }),
      get: async () => cover,
      removeOwner: async (_n: string, id: string, input: unknown) => {
        removed.push({ id, input });
        return { removed: true, attachment_deleted: false };
      },
      remove: async () => {
        deleteCalled = true;
        throw new Error('DELETE /attachments/{id} убран из публичного API');
      },
    });
    store.update({ networkId: NET });
    const mod = await import('../src/renderer/editor/publication-card.js');
    mod.publicationCardInternals.resetTab();
    scrollBox = new ShimElement('div');
    mod.showPublicationTarget(
      { scrollBox: scrollBox as unknown as HTMLElement },
      'pub-1',
      publication({ cover_kind: 'attachment', cover_attachment_id: 'att-1', cover_url: null }),
    );
    mod.publicationCardInternals.openCoverDialog();
    await flush();
    await flush();

    const removeBtn = lastBox().querySelector('.ui-pub-cloud-remove');
    assert.ok(removeBtn !== null, 'кнопка снятия владельца-публикации построена');
    removeBtn.click();
    await flush();

    assert.equal(deleteCalled, false, 'DELETE /attachments/{id} не вызывается');
    assert.deepEqual(
      removed,
      [{ id: 'att-1', input: { owner_type: 'publication', owner_id: 'pub-1' } }],
      'снятие владения — через DELETE /attachments/{id}/owners',
    );
  });
});
