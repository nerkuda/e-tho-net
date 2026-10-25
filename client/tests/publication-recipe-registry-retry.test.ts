/**
 * Карточка публикации: рецепт заголовков не строится с пустым реестром свойств
 * (ошибка 3bf62fd7; класс закрыт в 77f18626/6400d261).
 *
 * Две половины симптома карточки:
 *   1. при отказе `GET /properties` рецепт разбирался пустым реестром и терял
 *      условия по свойствам — кейс 1 проверяет, что рецепт НЕ строится, причина
 *      видна, а ложной диагностики «свойства больше нет в сети» нет (мутация
 *      «подставить пустой реестр при отказе» краснит тест);
 *   2. перечитывания не было — только перезакрытие карточки. Кейс 2: тик store
 *      повторяет чтение, и рецепт пересобирается с настоящим реестром — строка
 *      свойства возвращается (мутация «не подписываться на тик store» краснит
 *      тест).
 *
 * Карточка монтируется по-настоящему под общим DOM-шимом (приём
 * `publication-card-recipe-save.test.ts`); фабрика markdown-редактора
 * подменяется заглушкой через тестовый шов `publicationCardInternals`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { NetworkProperty, Publication, PublicationUpdateInput } from '@etn/shared';

import { ShimElement } from './dom-shim.js';
import { store } from '../src/renderer/state.js';

const NETWORK_ID = 'net-1';
const PROPERTY_ID = '00000000-0000-4000-8000-0000000000bb';

/** Строка реестра: текстовое свойство «Версия». */
const PROPERTY_ROW: NetworkProperty = {
  id: PROPERTY_ID,
  name: 'Версия',
  value_type: 'text',
  config: null,
  description: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

/** Сколько раз карточка прочитала реестр свойств (включая отказные). */
let registryCalls = 0;
/** Поведение чтения реестра по номеру вызова (1-based): можно разрешить отказ. */
let registryImpl: (call: number) => Promise<NetworkProperty[]> = async () => [PROPERTY_ROW];

/** Сохранения публикации — журнал (потеря рецепта была бы записью сюда). */
const updates: PublicationUpdateInput[] = [];

/** Публикация с ПРЕЖНИМ плоским рецептом: условие по свойству внутри отбора. */
function publication(): Publication {
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
    // Условие по свойству: без реестра конвертер его выбрасывает и сообщает
    // «свойства больше нет в сети» — ложная диагностика отказа связи.
    title_recipe: {
      properties: [{ property_id: PROPERTY_ID, op: 'eq', value: '2.0' }],
      sort: 'created',
      order: 'asc',
    } as any,
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

function installShim(pub: Publication): void {
  registryCalls = 0;
  updates.length = 0;
  Object.defineProperty(ShimElement.prototype, 'parentElement', {
    configurable: true,
    get(this: ShimElement): ShimElement | null {
      return this.parent;
    },
  });
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
      get: async () => pub,
      update: async (_n: string, _id: string, changes: PublicationUpdateInput) => {
        updates.push(changes);
        return { ...pub, ...changes, version: pub.version + 1 };
      },
    },
    // Единственный вход, который проверяют кейсы: чтение реестра свойств.
    propertyRegistry: {
      list: async (): Promise<NetworkProperty[]> => {
        registryCalls += 1;
        return registryImpl(registryCalls);
      },
    },
    linkTypes: { list: async () => [] },
    thoughts: { resolve: async () => [] },
    admin: { listUsers: async () => [] },
  };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
}

/** Заглушка markdown-редактора: CodeMirror в DOM-шиме не исполняется. */
function fakeMdEditor(initial: string): any {
  let value = initial;
  return {
    dom: new ShimElement('div'),
    getValue: () => value,
    setValue: (md: string) => {
      value = md;
    },
    insertAtCaret: () => undefined,
    setCaret: () => undefined,
    setSelection: () => undefined,
    enterBlockAt: () => undefined,
    focus: () => undefined,
    focusToEnd: () => undefined,
    blur: () => undefined,
    snapshot: () => ({ text: value, from: value.length, to: value.length }),
    applyEdit: () => undefined,
    subscribe: () => () => undefined,
    setSearchHighlight: () => undefined,
    selectMatch: () => undefined,
    toggleCollapseAtCaret: () => false,
    destroy: () => undefined,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Открыть карточку и вкладку «Рецепт», дождаться чтения реестра. */
async function openRecipeTab(): Promise<ShimElement> {
  const pub = publication();
  store.update({ networkId: NETWORK_ID, editorTarget: null });
  installShim(pub);
  const mod = await import('../src/renderer/editor/publication-card.js');
  mod.publicationCardInternals.createMdEditor = (initial: string) => fakeMdEditor(initial) as never;
  const scrollBox = new ShimElement('div');
  mod.showPublicationTarget(
    { scrollBox: scrollBox as unknown as HTMLElement },
    pub.id,
    pub,
  );
  const recipeTab = scrollBox
    .findAll((el) => el.className.includes('ui-tab') && el.textContent !== '')
    .find((el) => el.textContent === 'Рецепт');
  assert.ok(recipeTab !== undefined, 'вкладка «Рецепт» есть в полосе вкладок');
  recipeTab.click();
  await flush();
  return scrollBox;
}

/** Весь текст карточки и её тултипов — диагностика видна и там, и там. */
function cardText(root: ShimElement): string {
  let out = root.flatText();
  for (const el of root.findAll(() => true)) {
    for (const value of Object.values(el.attributes)) out += ` ${value}`;
    if (el.title !== '') out += ` ${el.title}`;
  }
  return out;
}

afterEach(() => {
  const mod = (globalThis as any).__pubCardMod as typeof import('../src/renderer/editor/publication-card.js') | undefined;
  mod?.disposePublicationCard();
});

describe('рецепт публикации: отказ чтения реестра свойств (3bf62fd7)', () => {
  it('1. отказ: рецепт не строится, причина видна, ложного «свойства нет» нет', async () => {
    registryImpl = async () => {
      throw new Error('сеть недоступна');
    };
    const scrollBox = await openRecipeTab();
    (globalThis as any).__pubCardMod = await import(
      '../src/renderer/editor/publication-card.js'
    );
    assert.equal(registryCalls, 1, 'карточка прочитала реестр (и получила отказ)');

    const text = cardText(scrollBox);
    assert.ok(
      text.includes('Реестр свойств сети не прочитан'),
      `ожидалась видимая причина отказа: ${text}`,
    );
    assert.ok(
      !text.includes('свойства больше нет в сети'),
      'ложная диагностика удалённого свойства при отказе связи не показывается',
    );
    assert.ok(
      !text.includes('Версия'),
      'рецепт с пустым реестром не собран — условие по свойству не «потеряно» молча',
    );
    assert.equal(updates.length, 0, 'рецепт не сохраняется, пока реестр не прочитан');
  });

  it('2. тик store перечитывает реестр — рецепт пересобирается с условием по свойству', async () => {
    registryImpl = async (call) => {
      if (call === 1) throw new Error('сеть недоступна');
      return [PROPERTY_ROW];
    };
    const scrollBox = await openRecipeTab();
    (globalThis as any).__pubCardMod = await import(
      '../src/renderer/editor/publication-card.js'
    );
    assert.equal(registryCalls, 1, 'первое чтение получило отказ');

    // Штатный тик store (в т.ч. переход в `connected`) — повтор чтения.
    store.update({});
    await flush();

    assert.equal(registryCalls, 2, 'отказ не признан отработанным — чтение повторено');
    const text = cardText(scrollBox);
    assert.ok(!text.includes('Реестр свойств сети не прочитан'), 'причина отказа снята');
    assert.ok(
      text.includes('Версия'),
      `условие по свойству вернулось в редактор рецепта: ${text}`,
    );
    assert.ok(
      !text.includes('свойства больше нет в сети'),
      'ложной диагностики удалённого свойства нет',
    );
  });
});
