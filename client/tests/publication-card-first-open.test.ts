/**
 * Первое открытие карточки публикации: активная вкладка наполняется сразу
 * (ошибка ecad219b, 0.11.1).
 *
 * Дефект: вкладки `lib/ui/tabs` строят содержимое ЛЕНИВО, и активная
 * («Метаданные») собирается ещё внутри `buildCard`, пока `instance` равен
 * `null`; поэтому `apply`, вызванный до регистрации `instance`, был no-op, и
 * поля оставались пустыми до переключения вкладок (риск перезаписи реального
 * «Названия» пустым значением). Здесь проверяется, что после `showPublicationTarget`
 * с уже пришедшими данными поля заполнены СИНХРОННО, без переключения вкладок,
 * и что лениво открытая позже вкладка наполняется тем же механизмом.
 *
 * DOM-шим — общий (`dom-shim.ts`); CodeMirror в шиме не поднимается, поэтому
 * фабрика markdown-редактора подменяется заглушкой через тестовый шов
 * `publicationCardInternals` (прецедент — `mdEditorInternals` в `md-editor.ts`).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Publication } from '@etn/shared';

import { ShimElement } from './dom-shim.js';
import type { MdEditor } from '../src/renderer/editor/md-editor.js';
import { store } from '../src/renderer/state.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NETWORK_ID = 'net-1';

function installShim(): ShimElement {
  const body = new ShimElement('body');
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body,
    documentElement: new ShimElement('html'),
    activeElement: body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.etn = {
    ui: { getState: async () => null, setState: async () => undefined },
    publications: { listShelves: async () => [] },
    propertyRegistry: { list: async () => [] },
    linkTypes: { list: async () => [] },
    admin: { listUsers: async () => [] },
  };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
  return body;
}

/** Заглушка markdown-редактора: CodeMirror в DOM-шиме не исполняется. */
function fakeMdEditor(initial: string): MdEditor {
  let value = initial;
  return {
    dom: new ShimElement('div') as unknown as HTMLElement,
    getValue: () => value,
    setValue: (md: string) => {
      value = md;
    },
    insertAtCaret: () => undefined,
    focus: () => undefined,
    focusToEnd: () => undefined,
    blur: () => undefined,
    destroy: () => undefined,
  };
}

function publication(overrides: Partial<Publication> = {}): Publication {
  return {
    id: 'pub-1',
    title: 'Руководство КТ4',
    subtitle: 'Подзаголовок',
    summary_md: 'Резюме',
    authorship: 'Ирина',
    cover_attachment_id: null,
    cover_url: 'https://example.test/cover.png',
    cover_kind: 'url',
    assembly_date: '2026-09-30T00:00:00.000Z',
    title_recipe: null,
    text_sources: [],
    extra_properties: [],
    numbering_from: 3,
    numbering_to: 5,
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

type CardModule = typeof import('../src/renderer/editor/publication-card.js');

async function cardModule(): Promise<CardModule> {
  return import('../src/renderer/editor/publication-card.js');
}

/** Значение поля контрола по id (панель Meta строится полем-фасадом). */
function inputValue(root: ShimElement, id: string): string {
  return root.querySelector(`#${id}`)?.value ?? '<нет поля>';
}

describe('карточка публикации: первое открытие (ошибка ecad219b)', () => {
  let scrollBox: ShimElement;

  beforeEach(() => {
    installShim();
    scrollBox = new ShimElement('div');
    store.update({ networkId: NETWORK_ID });
  });

  afterEach(async () => {
    const mod = await cardModule();
    mod.disposePublicationCard();
  });

  it('поля вкладки «Метаданные» заполнены сразу после открытия, без переключения вкладок', async () => {
    const mod = await cardModule();
    mod.publicationCardInternals.createMdEditor = (initial: string) => fakeMdEditor(initial) as never;

    const pub = publication();
    mod.showPublicationTarget({ scrollBox: scrollBox as unknown as HTMLElement }, pub.id, pub);

    // Анимации/промисов не ждём: данные уже пришли вместе с целью.
    assert.equal(inputValue(scrollBox, 'pub-card-title'), 'Руководство КТ4', 'название');
    assert.equal(inputValue(scrollBox, 'pub-card-subtitle'), 'Подзаголовок', 'подзаголовок');
    assert.equal(inputValue(scrollBox, 'pub-card-author'), 'Ирина', 'автор');
    assert.equal(inputValue(scrollBox, 'pub-card-cover-url'), 'https://example.test/cover.png', 'обложка');
    assert.notEqual(inputValue(scrollBox, 'pub-card-assembly'), '', 'дата сборки');

    const head = scrollBox.querySelector('.pub-card-editor-title');
    assert.equal(head?.textContent, 'Руководство КТ4', 'заголовок карточки');
  });

  it('лениво открытая позже вкладка «Рецепты» тоже наполняется данными', async () => {
    const mod = await cardModule();
    mod.publicationCardInternals.createMdEditor = (initial: string) => fakeMdEditor(initial) as never;

    const pub = publication();
    mod.showPublicationTarget({ scrollBox: scrollBox as unknown as HTMLElement }, pub.id, pub);

    // Вкладка «Рецепты» не строилась при открытии — открываем её кликом.
    const recipeTab = scrollBox.findAll(
      (el) => el.className.includes('ui-tab') && el.textContent !== '',
    ).find((el) => el.textContent === 'Рецепты');
    assert.ok(recipeTab !== undefined, 'вкладка «Рецепты» есть в полосе вкладок');
    recipeTab.click();
    // Дать осесть асинхронной загрузке реестра свойств (пикер текстов).
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(inputValue(scrollBox, 'pub-card-num-from'), '3', 'нумерация «с»');
    assert.equal(inputValue(scrollBox, 'pub-card-num-to'), '5', 'нумерация «по»');
  });
});
