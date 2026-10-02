/**
 * Карточка публикации: отбор («Рецепты») сохраняется, «Пересобрать» ждёт
 * отложенного автосейва (ошибка 82aada28, 0.11.1).
 *
 * Дефект: конструктор рецепта не уведомлял карточку о правках, поэтому
 * `title_recipe` не сохранялся никогда; `rebuildPublication` не дожидался
 * дебаунса `queueSave` (400 мс) и пересобирал документ по старой строке, а
 * ответ затирал поля UI. Здесь проверяется:
 *
 *  1. правка формы рецепта кладёт `title_recipe` в PATCH публикации;
 *  2. «Пересобрать» сначала досылает отложенный отбор, затем вызывает rebuild.
 *
 * DOM-шим — общий (`dom-shim.ts`); фабрика markdown-редактора подменяется
 * заглушкой через тестовый шов `publicationCardInternals` (CodeMirror в шиме
 * не исполняется).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Publication, PublicationUpdateInput } from '@etn/shared';

import { ShimElement } from './dom-shim.js';
import type { MdEditor } from '../src/renderer/editor/md-editor.js';
import { store } from '../src/renderer/state.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NETWORK_ID = 'net-1';

interface Calls {
  updates: Array<{ id: string; changes: PublicationUpdateInput }>;
  rebuilds: string[];
  order: string[];
}

let calls: Calls;

function publication(overrides: Partial<Publication> = {}): Publication {
  return {
    id: 'pub-1',
    title: 'Руководство КТ4',
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
    ...overrides,
  };
}

let current: Publication;

function installShim(): void {
  calls = { updates: [], rebuilds: [], order: [] };
  current = publication();
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
    publications: {
      listShelves: async () => [],
      get: async () => current,
      update: async (_n: string, id: string, changes: PublicationUpdateInput) => {
        calls.updates.push({ id, changes });
        calls.order.push('update');
        current = { ...current, ...changes, version: current.version + 1 };
        return current;
      },
      rebuild: async (_n: string, id: string) => {
        calls.rebuilds.push(id);
        calls.order.push('rebuild');
        current = { ...current, assembly_date: '2026-10-02T00:00:00.000Z' };
        return current;
      },
    },
    propertyRegistry: { list: async () => [] },
    linkTypes: { list: async () => [] },
    admin: { listUsers: async () => [] },
  };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
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

type CardModule = typeof import('../src/renderer/editor/publication-card.js');

async function openRecipeTab(scrollBox: ShimElement): Promise<CardModule> {
  const mod = await import('../src/renderer/editor/publication-card.js');
  mod.publicationCardInternals.createMdEditor = (initial: string) => fakeMdEditor(initial) as never;
  const pub = publication();
  current = pub;
  mod.showPublicationTarget({ scrollBox: scrollBox as unknown as HTMLElement }, pub.id, pub);

  const recipeTab = scrollBox
    .findAll((el) => el.className.includes('ui-tab') && el.textContent !== '')
    .find((el) => el.textContent === 'Рецепты');
  assert.ok(recipeTab !== undefined, 'вкладка «Рецепты» есть в полосе вкладок');
  recipeTab.click();
  // Асинхронная загрузка реестра свойств (пикер текстов) + построение рецепта.
  await new Promise((resolve) => setImmediate(resolve));
  return mod;
}

/** Правка формы рецепта: ввод ключевых слов (единственная `touch`-точка здесь). */
function editRecipeKeywords(scrollBox: ShimElement, value: string): void {
  const keywords = scrollBox.querySelector('.st-f-keywords') as ShimElement | null;
  assert.ok(keywords !== null, 'поле «Ключевые слова» рецепта построено');
  keywords.value = value;
  keywords.emit('input');
}

describe('карточка публикации: сохранение рецепта (ошибка 82aada28)', () => {
  let scrollBox: ShimElement;

  beforeEach(() => {
    installShim();
    scrollBox = new ShimElement('div');
    store.update({ networkId: NETWORK_ID });
  });

  afterEach(async () => {
    const mod = await import('../src/renderer/editor/publication-card.js');
    mod.disposePublicationCard();
  });

  it('правка рецепта сохраняется PATCH-ом в title_recipe', async () => {
    const mod = await openRecipeTab(scrollBox);
    mod.publicationCardInternals.createMdEditor = (initial: string) => fakeMdEditor(initial) as never;

    editRecipeKeywords(scrollBox, 'тест');
    await new Promise((resolve) => setTimeout(resolve, 450));

    assert.equal(calls.updates.length, 1, 'PATCH публикации выполнен один раз');
    const changes = calls.updates[0]!.changes;
    assert.ok('title_recipe' in changes, 'PATCH несёт title_recipe');
    assert.match(JSON.stringify(changes.title_recipe), /тест/, 'отбор содержит правку');
    assert.equal(calls.updates[0]!.id, 'pub-1');
  });

  it('«Пересобрать» сначала досылает отложенный отбор, затем пересобирает', async () => {
    await openRecipeTab(scrollBox);

    editRecipeKeywords(scrollBox, 'порядок');
    // Не ждём дебаунс — жмём «Пересобрать» сразу.
    const rebuildButton = scrollBox
      .findAll((el) => el.tagName === 'button')
      .find((el) => el.textContent === 'Пересобрать');
    assert.ok(rebuildButton !== undefined, 'кнопка «Пересобрать» есть');
    rebuildButton.click();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(calls.order, ['update', 'rebuild'], 'сначала сохранение, затем пересборка');
    assert.match(JSON.stringify(calls.updates[0]!.changes.title_recipe), /порядок/);
    assert.deepEqual(calls.rebuilds, ['pub-1']);
  });

  it('переоткрытие карточки показывает сохранённый отбор (сценарий бага)', async () => {
    const mod = await openRecipeTab(scrollBox);

    editRecipeKeywords(scrollBox, 'сохранённый');
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(calls.updates.length, 1, 'отбор сохранён в публикацию');
    const saved = current;
    assert.match(JSON.stringify(saved.title_recipe), /сохранённый/);

    // Переоткрытие: сброс и повторный показ карточки с серверными данными.
    mod.disposePublicationCard();
    const reopened = new ShimElement('div');
    mod.showPublicationTarget({ scrollBox: reopened as unknown as HTMLElement }, saved.id, saved);
    const recipeTab = reopened
      .findAll((el) => el.className.includes('ui-tab') && el.textContent !== '')
      .find((el) => el.textContent === 'Рецепты');
    assert.ok(recipeTab !== undefined);
    recipeTab.click();
    await new Promise((resolve) => setImmediate(resolve));

    const keywords = reopened.querySelector('.st-f-keywords') as ShimElement | null;
    assert.ok(keywords !== null, 'поле рецепта построено после переоткрытия');
    assert.equal(keywords.value, 'сохранённый', 'отбор восстановлен из сохранённой публикации');
  });
});
