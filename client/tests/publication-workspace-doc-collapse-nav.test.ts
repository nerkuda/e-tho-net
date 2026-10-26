/**
 * Ctrl+↑/↓ в теле документа публикации (задача 15236418, стандарт b6b2821d):
 * прежняя роль ←/→ «свернуть/развернуть раздел» перешла к Ctrl+↑/↓.
 *
 * Проверяется живая рабочая область на DOM-шиме (тот же приём, что в
 * `publication-workspace-reactive.test.ts`):
 *  - Ctrl+↑ на текущем разделе сворачивает его — тексты раздела уходят из
 *    документа, строка оглавления получает `pub-toc-folded`;
 *  - Ctrl+↓ разворачивает обратно;
 *  - на несворачиваемом разделе (нет текстов, детей и предисловия) оба
 *    сочетания не перехватываются — состояние документа не меняется.
 *
 * Клавиши идут через общий диспетчер `lib/keymap`: контекст списка поднимается
 * штатным `focusin` на теле документа, поэтому проверяется не только адаптер,
 * но и связка «фасад списка → навигация документа».
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { Publication, PublicationAssembly } from '@etn/shared';

import { ShimElement } from './dom-shim.js';
import { store } from '../src/renderer/state.js';
import { dispatchKeyEvent } from '../src/renderer/lib/keymap.js';

const NETWORK_ID = 'net-1';

function publication(): Publication {
  return {
    id: 'pub-1',
    title: 'Документ',
    subtitle: null,
    summary_md: null,
    authorship: null,
    cover_attachment_id: null,
    cover_url: null,
    cover_kind: 'none',
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
  };
}

/** Сборка: раздел с текстом (сворачиваемый) и пустой раздел (лист). */
function assembly(): PublicationAssembly {
  return {
    publication: {
      title: 'Документ',
      subtitle: null,
      authorship: null,
      assembly_date: null,
      summary_html: '',
      cover: { kind: 'placeholder', ref: null },
      new_candidates: 0,
    },
    sections: [
      {
        thought_id: 'sec-1',
        node_key: 'sec-1',
        anchor: 'pub-sec-1',
        level: 1,
        heading: 'Раздел с текстом',
        preamble_html: '<p>Начало</p>',
        texts: [
          {
            thought_id: 'txt-1',
            anchor: 'pub-txt-1',
            edge_id: 'e-txt-1',
            body_html: '<p>Текст</p>',
            body_md: 'Текст',
          },
        ],
        extra: [],
        flags: { repeat_of: null, cycle_cut: false },
        children: [],
      },
      {
        thought_id: 'sec-2',
        node_key: 'sec-2',
        anchor: 'pub-sec-2',
        level: 1,
        heading: 'Пустой раздел',
        preamble_html: '',
        texts: [],
        extra: [],
        flags: { repeat_of: null, cycle_cut: false },
        children: [],
      },
    ],
    excluded: [],
    warnings: [],
    meta: { page: 1, per_page: 20, total_roots: 2, has_more: false },
  };
}

function installShim(): void {
  const body = new ShimElement('body');
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
    etn: {
      ui: { getState: async () => null, setState: async () => undefined },
      publications: {
        get: async () => publication(),
        assembly: async () => assembly(),
        rebuild: async () => publication(),
        candidates: async () => ({ items: [], total: 0, limit: 50, offset: 0, has_more: false }),
      },
      attachments: { get: async () => null },
      linkTypes: { list: async () => [] },
      admin: { listUsers: async () => [] },
    },
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle: any) => globalThis.clearTimeout(handle),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
}

type WsModule = typeof import('../src/renderer/screens/publications/workspace.js');

async function mount(): Promise<{
  handle: ReturnType<WsModule['mountPublicationWorkspace']>;
  root: ShimElement;
}> {
  installShim();
  store.update({ networkId: NETWORK_ID });
  const host = new ShimElement('div');
  const mod = await import('../src/renderer/screens/publications/workspace.js');
  const handle = mod.mountPublicationWorkspace(host as unknown as HTMLElement, {
    onClose: () => undefined,
    onOpenCard: () => undefined,
    onExport: () => undefined,
    getTextWidth: () => 100,
    onTextWidthInput: () => undefined,
    onTextWidthChange: () => undefined,
  });
  await handle.open('pub-1');
  return { handle, root: host };
}

/** Нажатие через общий диспетчер: контекст списка уже поднят `focusin`. */
function press(
  target: ShimElement,
  key: string,
  mods: { ctrlKey?: boolean } = {},
): boolean {
  return dispatchKeyEvent({
    key,
    ctrlKey: mods.ctrlKey === true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    target,
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent);
}

const textCount = (root: ShimElement): number =>
  root.findAll((el) => el.classList.contains('pub-doc-text')).length;

const sectionNode = (root: ShimElement, thoughtId: string): ShimElement | undefined =>
  root
    .findAll((el) => el.classList.contains('pub-doc-section'))
    .find((el) => el.dataset['thoughtId'] === thoughtId);

const tocLine = (root: ShimElement, thoughtId: string): ShimElement | undefined =>
  root
    .findAll((el) => el.classList.contains('pub-toc-line'))
    .find((el) => el.dataset['thoughtId'] === thoughtId);

describe('публикация: Ctrl+↑/↓ сворачивает раздел документа (15236418)', () => {
  let active: { destroy(): void } | null = null;
  afterEach(() => {
    active?.destroy();
    active = null;
  });

  it('Ctrl+↑ сворачивает раздел, Ctrl+↓ разворачивает; лист — no-op', async () => {
    const { handle, root } = await mount();
    active = handle;
    const docHost = root.querySelector('.pub-doc') as ShimElement | null;
    assert.ok(docHost !== null, 'тело документа отрисовано');
    // Контекст клавиатуры списка поднимается штатным focusin (как в живом клиенте).
    docHost.emit('focusin', { target: docHost });

    assert.equal(textCount(root), 1, 'текст раздела виден до сворачивания');
    assert.equal(press(docHost, 'ArrowDown'), true, '↓ ставит текущим первый раздел');
    assert.equal(
      sectionNode(root, 'sec-1')?.classList.contains('pub-doc-current'),
      true,
      'текущий блок — раздел sec-1',
    );

    assert.equal(press(docHost, 'ArrowUp', { ctrlKey: true }), true, 'Ctrl+↑ перехвачен');
    assert.equal(textCount(root), 0, 'текст свёрнутого раздела ушёл из документа');
    assert.equal(
      tocLine(root, 'sec-1')?.classList.contains('pub-toc-folded'),
      true,
      'строка оглавления помечена свёрнутой',
    );

    assert.equal(press(docHost, 'ArrowDown', { ctrlKey: true }), true, 'Ctrl+↓ перехвачен');
    assert.equal(textCount(root), 1, 'раздел развёрнут — текст вернулся');
    assert.equal(
      tocLine(root, 'sec-1')?.classList.contains('pub-toc-folded'),
      false,
      'пометка свёрнутости снята',
    );

    // Последний видимый блок — пустой раздел sec-2 (End, чтобы не шагать
    // через вернувшийся текстовый блок txt-1).
    assert.equal(press(docHost, 'End'), true, 'End переводит текущий на последний блок');
    assert.equal(
      sectionNode(root, 'sec-2')?.classList.contains('pub-doc-current'),
      true,
      'текущий блок — раздел sec-2',
    );
    assert.equal(
      press(docHost, 'ArrowUp', { ctrlKey: true }),
      false,
      'несворачиваемый раздел не перехватывает Ctrl+↑',
    );
    assert.equal(textCount(root), 1, 'состояние документа не изменилось');
    assert.equal(
      tocLine(root, 'sec-2')?.classList.contains('pub-toc-folded'),
      false,
      'у листа нет пометки свёрнутости',
    );
    assert.equal(
      press(docHost, 'ArrowDown', { ctrlKey: true }),
      false,
      'Ctrl+↓ на листе тоже не перехватывается',
    );
  });
});
