/**
 * Поведение списка диалога выбора обложки публикации (блокер приёмки b02ef1cf).
 *
 * Претензия верификатора: стрелки двигали ПОДСВЕТКУ, но не `selected` (адаптер
 * `createListNav` не задавал `onSelectionChange`), поэтому Ctrl+Enter и кнопка
 * «Применить и закрыть» применяли РАНЕЕ выбранную строку. Здесь это проверяется
 * ПОВЕДЕНЧЕСКИ на живой карточке и живом диалоге в DOM-шиме: поднимаем карточку,
 * открываем диалог, жмём ↓ и убеждаемся, что применена ПОДСВЕЧЕННАЯ строка
 * (её id ушёл в `publications.update`) — и по Ctrl+Enter, и по кнопке.
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.ts`) с учётом
 * `document.activeElement` (как в `dialog-focus-stack.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Attachment, Publication } from '@etn/shared';

import { ShimElement } from './dom-shim.js';
import * as keymap from '../src/renderer/lib/keymap.js';
import { store } from '../src/renderer/state.js';
import { invalidateQueries, queryKeys } from '../src/renderer/lib/live/index.js';

const NETWORK_ID = 'net-1';

/** Активные сохранения: `publications.update` диалога/карточки. */
interface Saved {
  id: string;
  changes: Record<string, unknown>;
}

let saved: Saved[] = [];

/** Элемент, чей `focus()` ведёт `document.activeElement` (как браузер). */
class ActiveTrackingElement extends ShimElement {
  override focus(): void {
    super.focus();
    doc().activeElement = this;
  }
}

function doc(): any {
  return (globalThis as any).document;
}

function publication(overrides: Partial<Publication> = {}): Publication {
  return {
    id: 'pub-1',
    title: 'Руководство',
    subtitle: null,
    summary_md: 'Резюме',
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

function attachment(id: string, filePath: string): Attachment {
  return {
    id,
    owner_type: 'publication',
    owner_id: 'pub-1',
    kind: 'file',
    url: null,
    file_path: filePath,
    file_size: null,
    mime_type: 'image/png',
    title: id,
    icon: null,
    description: null,
    position: 0,
    created_at: '2026-10-01T00:00:00.000Z',
    created_by: 'u',
  };
}

/** Два вложения-картинки — строки диалога обложки. */
const ATTACHMENTS: Attachment[] = [
  attachment('att-1', 'C:/pics/first.png'),
  attachment('att-2', 'C:/pics/second.png'),
];

function installShim(): void {
  saved = [];
  const body = new ActiveTrackingElement('body');
  const docListeners = new Map<string, Array<(event: any) => void>>();
  (globalThis as any).document = {
    createElement: (tag: string) => new ActiveTrackingElement(tag),
    createElementNS: (_ns: string, tag: string) => new ActiveTrackingElement(tag),
    documentElement: new ActiveTrackingElement('html'),
    body,
    activeElement: body,
    addEventListener: (type: string, listener: (event: any) => void) => {
      const list = docListeners.get(type) ?? [];
      list.push(listener);
      docListeners.set(type, list);
    },
    removeEventListener: (type: string, listener: (event: any) => void) => {
      const list = docListeners.get(type) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
    dispatchEvent: (event: any) => {
      for (const listener of docListeners.get(event?.type ?? '') ?? []) listener(event);
      return true;
    },
  };

  const win: Record<string, unknown> = {
    innerWidth: 1200,
    innerHeight: 800,
    etn: {
      ui: { getState: async () => null, setState: async () => undefined },
      publications: {
        get: async () => publication(),
        listShelves: async () => [],
        update: async (_networkId: string, id: string, changes: Record<string, unknown>) => {
          saved.push({ id, changes });
          return publication({ ...changes, version: 2 } as Partial<Publication>);
        },
      },
      attachments: {
        list: async () => ATTACHMENTS,
        search: async () => ATTACHMENTS,
        getUsage: async () => ({ owners: [] }),
        get: async (_n: string, id: string) => ATTACHMENTS.find((a) => a.id === id) ?? null,
      },
      propertyRegistry: { list: async () => [] },
      linkTypes: { list: async () => [] },
      admin: { listUsers: async () => [] },
    },
    // Тост живёт 4 с — в тесте он не нужен, а таймер задержал бы выход.
    setTimeout: (fn: () => void, ms?: number) =>
      ms !== undefined && ms >= 4000 ? 0 : (globalThis as any).setTimeout(fn, ms),
    clearTimeout: (handle: any) => (globalThis as any).clearTimeout(handle),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  (globalThis as any).window = win;
}

type CardModule = typeof import('../src/renderer/editor/publication-card.js');

async function openDialog(): Promise<{
  mod: CardModule;
  list: ShimElement;
  currentKey: () => string | null;
}> {
  installShim();
  store.update({ networkId: NETWORK_ID });
  const scrollBox = new ShimElement('div');
  const mod = await import('../src/renderer/editor/publication-card.js');
  // CodeMirror в шиме не поднимается — поле резюме подменяем заглушкой.
  mod.publicationCardInternals.createSummaryField = (() =>
    new ShimElement('div') as unknown as HTMLElement) as never;
  mod.publicationCardInternals.setSummaryField = (() => undefined) as never;

  mod.showPublicationTarget(
    { scrollBox: scrollBox as unknown as HTMLElement },
    'pub-1',
    publication(),
  );
  mod.publicationCardInternals.openCoverDialog();
  // Дать осесть асинхронному поиску вложений (runSearch).
  await new Promise((resolve) => setImmediate(resolve));

  const list = body().querySelector('.att-pick-list');
  assert.ok(list !== null, 'список вложений диалога построен');
  const currentKey = (): string | null => {
    const row = list
      .querySelectorAll('.att-pick-item')
      .find((el) => el.classList.contains('att-pick-item-current'));
    // Ключ строки — носитель (kind+путь), заголовок строки — title вложения,
    // которым в фикстурах служит id ('att-1'/'att-2').
    return row?.querySelector('.att-pick-item-title')?.textContent ?? null;
  };
  return { mod, list, currentKey };
}

function body(): ShimElement {
  return doc().body as ShimElement;
}

/** Адрес картинки препросмотра (свойство `src`; в шиме атрибут не ведётся). */
function previewSrc(): string {
  const img = body().querySelector('.att-pick-preview-img') as unknown as
    | { src?: string }
    | null;
  return img?.src ?? '';
}

function pressList(list: ShimElement, key: string, ctrl = false): void {
  // Фокус внутри списка кладёт его контекст на вершину стека диспетчера.
  list.emit('focusin', {});
  keymap.dispatchKeyEvent({
    key,
    ctrlKey: ctrl,
    target: list,
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent);
  list.emit('focusout', {});
}

/** Ждёт срабатывания debounce сохранения карточки (400 мс). */
function waitSave(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 460));
}

/** Поднимает карточку публикации без диалога (для счётчика вкладки). */
async function openCard(): Promise<{ mod: CardModule; scrollBox: ShimElement }> {
  installShim();
  store.update({ networkId: NETWORK_ID });
  const scrollBox = new ShimElement('div');
  const mod = await import('../src/renderer/editor/publication-card.js');
  mod.publicationCardInternals.createSummaryField = (() =>
    new ShimElement('div') as unknown as HTMLElement) as never;
  mod.publicationCardInternals.setSummaryField = (() => undefined) as never;
  mod.showPublicationTarget(
    { scrollBox: scrollBox as unknown as HTMLElement },
    'pub-1',
    publication(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  return { mod, scrollBox };
}

/** Бейдж `(N)` вкладки «Вложения» карточки. */
function attachmentsBadge(scrollBox: ShimElement): string {
  const tab = scrollBox
    .findAll((el) => el.className.includes('ui-tab') && el.flatText().startsWith('Вложения'))
    .find((el) => el.tagName === 'button');
  return tab?.querySelector('.ui-tab-count')?.flatText() ?? '<нет бейджа>';
}

describe('счётчик вкладки «Вложения» публикации (замечание 2 приёмки b02ef1cf)', () => {
  let mod: CardModule | null = null;

  afterEach(() => {
    mod?.disposePublicationCard();
    mod = null;
  });

  it('бейдж (N) показан по числу вложений и обновляется локальным каналом', async () => {
    const opened = await openCard();
    mod = opened.mod;
    assert.equal(attachmentsBadge(opened.scrollBox), '(2)', 'бейдж по числу вложений (2)');

    // Кэш-путь слоя (G4): диалог обложки создал третье вложение — сервер отдаёт
    // три записи, источник гасит ключ списка вложений публикации; бейдж
    // перечитывается подписчиком слоя.
    (globalThis as any).window.etn.attachments.list = async () => [
      ...ATTACHMENTS,
      attachment('att-3', 'C:/pics/third.png'),
    ];
    invalidateQueries(queryKeys.attachments('publication', 'pub-1'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attachmentsBadge(opened.scrollBox), '(3)', 'бейдж перечитан инвалидацией слоя');
  });
});

describe('диалог обложки: навигация синхронизирует выбор (блокер b02ef1cf)', () => {
  let mod: CardModule | null = null;

  beforeEach(() => {
    mod = null;
    keymap.keymapInternals.reset();
  });

  afterEach(async () => {
    if (mod !== null) mod.disposePublicationCard();
  });

  it('↓ двигает и подсветку, и препросмотр (единый источник выбора)', async () => {
    const opened = await openDialog();
    mod = opened.mod;
    assert.equal(opened.currentKey(), 'att-1', 'первая строка текущая при открытии');

    const previewBefore = previewSrc();
    pressList(opened.list, 'ArrowDown');

    assert.equal(opened.currentKey(), 'att-2', '↓ подсветила вторую строку');
    const previewAfter = previewSrc();
    assert.notEqual(previewAfter, previewBefore, 'препросмотр сменился на подсвеченную строку');
    assert.ok(previewAfter.includes('second.png'), 'препросмотр — картинка подсвеченной строки');
  });

  it('Ctrl+Enter применяет ПОДСВЕЧЕННУЮ строку, а не прежнюю', async () => {
    const opened = await openDialog();
    mod = opened.mod;
    assert.equal(opened.currentKey(), 'att-1');

    pressList(opened.list, 'ArrowDown');
    assert.equal(opened.currentKey(), 'att-2');
    pressList(opened.list, 'Enter', true);
    await waitSave();

    assert.equal(saved.length, 1, 'сохранение выполнено');
    assert.equal(saved[0]?.changes['cover_attachment_id'], 'att-2', 'применена подсвеченная строка');
  });

  it('кнопка «Применить и закрыть» применяет ПОДСВЕЧЕННУЮ строку', async () => {
    const opened = await openDialog();
    mod = opened.mod;

    pressList(opened.list, 'ArrowDown');
    assert.equal(opened.currentKey(), 'att-2');

    const applyButton = body()
      .findAll((el) => el.tagName === 'button' && el.flatText() === 'Применить и закрыть')
      .find((el) => el.isConnected);
    assert.ok(applyButton !== undefined, 'кнопка «Применить и закрыть» в диалоге');
    applyButton.click();
    await waitSave();

    assert.equal(saved.length, 1, 'сохранение выполнено');
    assert.equal(saved[0]?.changes['cover_attachment_id'], 'att-2', 'применена подсвеченная строка');
  });
});
