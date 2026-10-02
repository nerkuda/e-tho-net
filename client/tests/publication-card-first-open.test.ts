/**
 * Первое открытие карточки публикации: данные применяются сразу, ленивые
 * вкладки наполняются тем же механизмом (ошибка ecad219b, 0.11.1, задача
 * b02ef1cf).
 *
 * После переработки шапка карточки — три строки (заголовок/подзаголовок в
 * полях ввода), а первой активной вкладкой стала «Резюме» (markdown-редактор).
 * Здесь проверяется, что после `showPublicationTarget` с уже пришедшими данными
 * шапка и активная вкладка заполнены СИНХРОННО, без переключения вкладок, а
 * лениво открытая вкладка «Метаданные» наполняется тем же механизмом.
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

/** Значение поля контрола по id. */
function inputValue(root: ShimElement, id: string): string {
  return root.querySelector(`#${id}`)?.value ?? '<нет поля>';
}

describe('карточка публикации: первое открытие (ошибка ecad219b, b02ef1cf)', () => {
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

  it('шапка и активная вкладка «Резюме» заполнены сразу после открытия', async () => {
    const mod = await cardModule();
    let md: MdEditor | null = null;
    mod.publicationCardInternals.createMdEditor = (initial: string) => {
      md = fakeMdEditor(initial);
      return md as never;
    };

    const pub = publication();
    mod.showPublicationTarget({ scrollBox: scrollBox as unknown as HTMLElement }, pub.id, pub);

    // Анимации/промисов не ждём: данные уже пришли вместе с целью.
    assert.equal(inputValue(scrollBox, 'pub-card-title'), 'Руководство КТ4', 'заголовок');
    assert.equal(inputValue(scrollBox, 'pub-card-subtitle'), 'Подзаголовок', 'подзаголовок');
    assert.equal(md!.getValue(), 'Резюме', 'активная вкладка «Резюме» наполнена');
  });

  it('лениво открытая вкладка «Метаданные» тоже наполняется данными', async () => {
    const mod = await cardModule();
    mod.publicationCardInternals.createMdEditor = (initial: string) => fakeMdEditor(initial) as never;

    const pub = publication();
    mod.showPublicationTarget({ scrollBox: scrollBox as unknown as HTMLElement }, pub.id, pub);

    // Вкладка «Метаданные» не строилась при открытии — открываем её.
    mod.publicationCardInternals.activateTab('meta');
    const text = scrollBox.findAll((el) => el.className.includes('metadata')).map((n) => n.flatText()).join('\n');
    assert.ok(text.includes('pub-1'), 'ID публикации показан');
  });

  it('лениво открытая позже вкладка «Рецепт» наполняется данными', async () => {
    const mod = await cardModule();
    mod.publicationCardInternals.createMdEditor = (initial: string) => fakeMdEditor(initial) as never;

    const pub = publication();
    mod.showPublicationTarget({ scrollBox: scrollBox as unknown as HTMLElement }, pub.id, pub);

    const recipeTab = scrollBox
      .findAll((el) => el.className.includes('ui-tab') && el.textContent !== '')
      .find((el) => el.textContent === 'Рецепт');
    assert.ok(recipeTab !== undefined, 'вкладка «Рецепт» есть в полосе вкладок');
    recipeTab.click();
    // Дать осесть асинхронной загрузке реестра свойств (пикер текстов).
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(inputValue(scrollBox, 'pub-card-num-from'), '3', 'нумерация «с»');
    assert.equal(inputValue(scrollBox, 'pub-card-num-to'), '5', 'нумерация «по»');
  });
});

describe('карточка публикации: перечитывание резюме при apply (ошибка 6f013e67)', () => {
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

  /**
   * Открывает карточку с подменённой фабрикой и возвращает модуль вместе с
   * захваченным экземпляром редактора резюме. Realtime-обновление применяется
   * через тестовый шов `apply` — ветка «та же цель — apply на месте» в
   * `showPublicationTarget` в DOM-шиме недостижима (у шима нет `parentElement`).
   */
  async function openCard(summary: string): Promise<{ mod: CardModule; md: MdEditor }> {
    const mod = await cardModule();
    let captured: MdEditor | null = null;
    mod.publicationCardInternals.createMdEditor = (initial: string) => {
      captured = fakeMdEditor(initial);
      return captured as never;
    };
    const host = { scrollBox: scrollBox as unknown as HTMLElement };
    mod.showPublicationTarget(host, 'pub-1', publication({ summary_md: summary }));
    const md = captured as MdEditor | null;
    assert.ok(md !== null, 'markdown-редактор резюме создан');
    return { mod, md };
  }

  it('apply с изменившимся summary_md перечитывает редактор', async () => {
    const { mod, md } = await openCard('Старое резюме');
    assert.equal(md.getValue(), 'Старое резюме');

    mod.publicationCardInternals.apply(publication({ summary_md: 'Новое резюме' }));
    assert.equal(md.getValue(), 'Новое резюме', 'резюме перечитано');
  });

  it('apply не затирает расходящийся пользовательский ввод', async () => {
    const { mod, md } = await openCard('Серверное');

    md.setValue('Незавершённый ввод');
    mod.publicationCardInternals.apply(publication({ summary_md: 'Правка другой сессии' }));
    assert.equal(md.getValue(), 'Незавершённый ввод', 'пользовательский ввод сохранён');
  });

  it('эхо собственного сохранения синхронизирует baseline, не ломая дальнейший apply', async () => {
    const { mod, md } = await openCard('Серверное');

    md.setValue('Мой текст');
    mod.publicationCardInternals.apply(publication({ summary_md: 'Мой текст' }));
    assert.equal(md.getValue(), 'Мой текст', 'эхо не перезаписывает');

    mod.publicationCardInternals.apply(publication({ summary_md: 'Изменено извне' }));
    assert.equal(md.getValue(), 'Изменено извне', 'реальная правка перечитана');
  });
});
