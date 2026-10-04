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
 * фабрика поля резюме и запись в него подменяются заглушками через тестовые швы
 * `publicationCardInternals.createSummaryField`/`setSummaryField` (прецедент —
 * `mdEditorInternals` в `md-editor.ts`).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Publication } from '@etn/shared';

import { ShimElement } from './dom-shim.js';
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
    dispatchEvent: () => undefined,
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

/** Опции, с которыми карточка построила поле резюме (для проверок режима). */
interface SummaryFieldProbe {
  md: string;
  root: HTMLElement;
  options: { onEditChange?: (editing: boolean) => void } | null;
}

/**
 * Подменяет фабрику/запись поля резюме заглушками: CodeMirror в DOM-шиме не
 * исполняется, а нам нужно видеть, какое значение карточка положила в поле.
 */
function stubSummaryField(mod: CardModule): SummaryFieldProbe {
  const probe: SummaryFieldProbe = { md: '', root: new ShimElement('div') as unknown as HTMLElement, options: null };
  mod.publicationCardInternals.createSummaryField = ((opts: {
    md: string;
    onEditChange?: (editing: boolean) => void;
  }) => {
    probe.md = opts.md;
    probe.options = opts;
    return probe.root;
  }) as never;
  mod.publicationCardInternals.setSummaryField = ((_field: HTMLElement, md: string) => {
    probe.md = md;
  }) as never;
  return probe;
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

/** Подпись активной вкладки карточки. */
function activeTabLabel(root: ShimElement): string {
  const tab = root
    .findAll((el) => el.className.includes('ui-tab') && el.classList.contains('active'))
    .find((el) => el.tagName === 'button');
  return tab?.flatText() ?? '<нет активной вкладки>';
}

describe('карточка публикации: первое открытие (ошибка ecad219b, b02ef1cf)', () => {
  let scrollBox: ShimElement;

  beforeEach(async () => {
    installShim();
    scrollBox = new ShimElement('div');
    store.update({ networkId: NETWORK_ID });
    // Сеансовая вкладка карточки живёт в модуле — сбрасываем между тестами.
    (await cardModule()).publicationCardInternals.resetTab();
  });

  afterEach(async () => {
    const mod = await cardModule();
    mod.disposePublicationCard();
  });

  it('шапка и активная вкладка «Резюме» заполнены сразу после открытия', async () => {
    const mod = await cardModule();
    const summary = stubSummaryField(mod);

    const pub = publication();
    mod.showPublicationTarget({ scrollBox: scrollBox as unknown as HTMLElement }, pub.id, pub);

    // Анимации/промисов не ждём: данные уже пришли вместе с целью.
    assert.equal(inputValue(scrollBox, 'pub-card-title'), 'Руководство КТ4', 'заголовок');
    assert.equal(inputValue(scrollBox, 'pub-card-subtitle'), 'Подзаголовок', 'подзаголовок');
    assert.equal(summary.md, 'Резюме', 'активная вкладка «Резюме» наполнена');
  });

  it('лениво открытая вкладка «Метаданные» тоже наполняется данными', async () => {
    const mod = await cardModule();
    stubSummaryField(mod);

    const pub = publication();
    mod.showPublicationTarget({ scrollBox: scrollBox as unknown as HTMLElement }, pub.id, pub);

    // Вкладка «Метаданные» не строилась при открытии — открываем её.
    mod.publicationCardInternals.activateTab('meta');
    const text = scrollBox.findAll((el) => el.className.includes('metadata')).map((n) => n.flatText()).join('\n');
    assert.ok(text.includes('pub-1'), 'ID публикации показан');
  });

  it('лениво открытая позже вкладка «Рецепт» наполняется данными', async () => {
    const mod = await cardModule();
    stubSummaryField(mod);

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

  it('выбранная вкладка переживает переключение публикаций (замечание Г)', async () => {
    const mod = await cardModule();
    stubSummaryField(mod);
    const host = { scrollBox: scrollBox as unknown as HTMLElement };

    mod.showPublicationTarget(host, 'pub-1', publication());
    // Выбираем вкладку «Метаданные» (как пользователь).
    mod.publicationCardInternals.activateTab('meta');
    assert.equal(activeTabLabel(scrollBox), 'Метаданные', 'вкладка выбрана');

    // Переключение на ДРУГУЮ публикацию пересобирает карточку — вкладка остаётся.
    mod.showPublicationTarget(host, 'pub-2', publication({ id: 'pub-2' }));
    assert.equal(activeTabLabel(scrollBox), 'Метаданные', 'вкладка пережила переключение');

    // Сброс сеансового состояния (тестовый шов) возвращает первую вкладку.
    // Свежий контейнер — предыдущие карточки не убираются dispose'ом.
    mod.publicationCardInternals.resetTab();
    const fresh = new ShimElement('div');
    mod.showPublicationTarget(
      { scrollBox: fresh as unknown as HTMLElement },
      'pub-3',
      publication({ id: 'pub-3' }),
    );
    assert.equal(activeTabLabel(fresh), 'Резюме', 'после сброса — первая вкладка');
  });
});

describe('карточка публикации: перечитывание резюме при apply (ошибка 6f013e67)', () => {
  let scrollBox: ShimElement;

  beforeEach(async () => {
    installShim();
    scrollBox = new ShimElement('div');
    store.update({ networkId: NETWORK_ID });
    // Сеансовая вкладка карточки живёт в модуле — сбрасываем между тестами.
    (await cardModule()).publicationCardInternals.resetTab();
  });

  afterEach(async () => {
    const mod = await cardModule();
    mod.disposePublicationCard();
  });

  /**
   * Открывает карточку с подменённым полем резюме и возвращает модуль вместе с
   * зондом поля. Realtime-обновление применяется через тестовый шов `apply` —
   * ветка «та же цель — apply на месте» в `showPublicationTarget` в DOM-шиме
   * недостижима (у шима нет `parentElement`).
   */
  async function openCard(summary: string): Promise<{ mod: CardModule; probe: SummaryFieldProbe }> {
    const mod = await cardModule();
    const probe = stubSummaryField(mod);
    const host = { scrollBox: scrollBox as unknown as HTMLElement };
    mod.showPublicationTarget(host, 'pub-1', publication({ summary_md: summary }));
    assert.ok(probe.options !== null, 'поле резюме построено');
    return { mod, probe };
  }

  it('apply с изменившимся summary_md перечитывает поле', async () => {
    const { mod, probe } = await openCard('Старое резюме');
    assert.equal(probe.md, 'Старое резюме');

    mod.publicationCardInternals.apply(publication({ summary_md: 'Новое резюме' }));
    assert.equal(probe.md, 'Новое резюме', 'резюме перечитано');
  });

  it('apply не затирает расходящийся пользовательский ввод', async () => {
    const { mod, probe } = await openCard('Серверное');

    // Вход в правку: незавершённый ввод (ошибка 6f013e67).
    probe.options!.onEditChange?.(true);
    probe.md = 'Незавершённый ввод';
    mod.publicationCardInternals.apply(publication({ summary_md: 'Правка другой сессии' }));
    assert.equal(probe.md, 'Незавершённый ввод', 'пользовательский ввод сохранён');

    probe.options!.onEditChange?.(false);
    mod.publicationCardInternals.apply(publication({ summary_md: 'Правка другой сессии' }));
    assert.equal(probe.md, 'Правка другой сессии', 'после выхода из правки перечитано');
  });

  it('эхо собственного сохранения синхронизирует baseline, не ломая дальнейший apply', async () => {
    const { mod, probe } = await openCard('Серверное');

    probe.options!.onEditChange?.(true);
    probe.options!.onEditChange?.(false);
    mod.publicationCardInternals.apply(publication({ summary_md: 'Мой текст' }));
    assert.equal(probe.md, 'Мой текст', 'эхо не перезаписывает расходящееся');

    mod.publicationCardInternals.apply(publication({ summary_md: 'Изменено извне' }));
    assert.equal(probe.md, 'Изменено извне', 'реальная правка перечитана');
  });
});
