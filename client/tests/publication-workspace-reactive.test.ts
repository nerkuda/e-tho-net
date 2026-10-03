/**
 * Поведение реактивности документа публикации (замечания 1/2/7 приёмки
 * b02ef1cf): подсветка «Пересобрать» зажигается от изменения мысли, ВХОДЯЩЕЙ в
 * текущую сборку, и не зажигается от посторонней; внешняя правка рецепта даёт
 * stale БЕЗ перечитывания состава; контентная правка обновляет шапку/титул без
 * чтения сборки.
 *
 * Дожим (замечания-блокеры 1/2 приёмки b02ef1cf): пока текст устарел, правка
 * раздела правит блок из payload события, НЕ перечитывая сборку (иначе
 * материализуется отложенный рецепт и порядок разделов сдвигается); смешанный
 * PATCH `{title, title_recipe}` применяет обе ветки.
 *
 * Живая рабочая область в DOM-шиме с подставным `window.etn` (считаем запросы
 * `publications.assembly`; при флаге `nextRecipe` сборка отдаёт разделы в
 * «новом» порядке — так наблюдается материализация отложенного рецепта).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { Publication, PublicationAssembly } from '@etn/shared';

import { ShimElement } from './dom-shim.js';
import { store } from '../src/renderer/state.js';
import { routePublicationUpdate } from '../src/renderer/screens/publications/update-routing.js';
import {
  invalidateQueries,
  queryKeys,
  resetEventRouter,
  routeRealtimeEvent,
  signalPermanentCommentSaved,
  signalPublicationCompositionChanged,
  signalThoughtSaved,
} from '../src/renderer/lib/live/index.js';

const NETWORK_ID = 'net-1';

/** Realtime-событие публикации через РЕАЛЬНЫЙ роутер слоя (не прямой вызов). */
function publicationEvent(type: string, data: Record<string, unknown>, seq: number): any {
  return {
    type,
    seq,
    ts: '2026-10-03T00:00:00.000Z',
    actor: { user_id: 'u2', client_id: 'c2' },
    audience: 'network',
    network_id: NETWORK_ID,
    layer_id: 'base',
    data,
    meta: { version: 1 },
  };
}

function publication(overrides: Partial<Publication> = {}): Publication {
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
    ...overrides,
  };
}

function section(
  thoughtId: string,
  heading: string,
  preambleHtml: string,
): PublicationAssembly['sections'][number] {
  return {
    thought_id: thoughtId,
    node_key: thoughtId,
    anchor: `pub-${thoughtId}`,
    level: 1,
    heading,
    preamble_html: preambleHtml,
    texts: [],
    extra: [],
    flags: { repeat_of: null, cycle_cut: false },
    children: [],
  };
}

/** Флаг «на сервере уже новый рецепт»: меняет порядок разделов в сборке. */
let nextRecipe = false;

function assembly(): PublicationAssembly {
  const sections = [section('sec-1', 'Раздел', '<p>Начало</p>'), section('sec-2', 'Второй', '<p>Ещё</p>')];
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
    sections: nextRecipe ? [...sections].reverse() : sections,
    excluded: [],
    warnings: [],
    meta: { page: 1, per_page: 20, total_roots: 2, has_more: false },
  };
}

let assemblyFetches = 0;

function installShim(): void {
  assemblyFetches = 0;
  nextRecipe = false;
  const body = new ShimElement('body');
  const docListeners = new Map<string, Array<(event: any) => void>>();
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
    activeElement: body,
    addEventListener: (type: string, listener: (event: any) => void) => {
      const list = docListeners.get(type) ?? [];
      list.push(listener);
      docListeners.set(type, list);
    },
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  const win: Record<string, unknown> = {
    innerWidth: 1200,
    innerHeight: 800,
    etn: {
      ui: { getState: async () => null, setState: async () => undefined },
      publications: {
        get: async () => publication(),
        assembly: async () => {
          assemblyFetches += 1;
          return assembly();
        },
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
  (globalThis as any).window = win;
}

type WsModule = typeof import('../src/renderer/screens/publications/workspace.js');

async function mount(): Promise<{
  mod: WsModule;
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
  return { mod, handle, root: host };
}

const stale = (root: ShimElement): boolean =>
  root.findAll((el) => el.classList.contains('pub-ws-rebuild-stale')).length > 0;

const headerTitle = (root: ShimElement): string | null =>
  root.querySelector('.pub-ws-title')?.textContent ?? null;

/** Порядок разделов в документе (id мыслей в DOM-порядке). */
const sectionIds = (root: ShimElement): string[] =>
  root
    .findAll((el) => el.classList.contains('pub-doc-section'))
    .map((el) => el.dataset['thoughtId'] ?? '');

/** Узел блока раздела по id мысли. */
const sectionNode = (root: ShimElement, thoughtId: string): ShimElement | undefined =>
  root
    .findAll((el) => el.classList.contains('pub-doc-section'))
    .find((el) => el.dataset['thoughtId'] === thoughtId);

describe('рабочая область публикации: реактивность состава и контента (b02ef1cf)', () => {
  let active: { destroy(): void } | null = null;
  afterEach(() => {
    active?.destroy();
    active = null;
  });

  it('stale от мысли В сборке, не от посторонней', async () => {
    const { handle, root } = await mount();
    active = handle;
    const fetchesAfterOpen = assemblyFetches;
    assert.equal(stale(root), false, 'свежее открытие без подсветки');

    // Посторонняя мысль — ничего.
    handle.applyThoughtRealtime('stranger');
    assert.equal(stale(root), false, 'посторонняя мысль не зажигает stale');
    assert.equal(assemblyFetches, fetchesAfterOpen, 'посторонняя мысль не перечитывает сборку');

    // Мысль раздела — stale и точечное перечитывание (дебаунс reload 200 мс).
    handle.applyThoughtRealtime('sec-1');
    assert.equal(stale(root), true, 'мысль в сборке зажигает stale');
    await new Promise((resolve) => setTimeout(resolve, 280));
    assert.ok(assemblyFetches > fetchesAfterOpen, 'мысль в сборке перечитывает документ');
  });

  it('внешняя правка рецепта → stale БЕЗ перечитывания состава', async () => {
    const { handle, root } = await mount();
    active = handle;
    const before = assemblyFetches;
    handle.applyPublicationPatch({ title_recipe: { parent_ids: ['x'], sort: 'updated', order: 'asc' } });
    assert.equal(stale(root), true, 'смена рецепта зажигает stale');
    assert.equal(assemblyFetches, before, 'состав НЕ перечитывается на лету');
  });

  it('контентная правка обновляет шапку без чтения сборки', async () => {
    const { handle, root } = await mount();
    active = handle;
    const before = assemblyFetches;
    handle.applyPublicationPatch({ title: 'Новое имя' });
    assert.equal(headerTitle(root), 'Новое имя', 'шапка обновлена точечно');
    assert.equal(stale(root), false, 'контентная правка не зажигает stale');
    assert.equal(assemblyFetches, before, 'контентная правка не читает сборку');
  });

  // --- Дожим: блокеры 1 и 2 приёмки b02ef1cf -------------------------------

  it('при active stale правка раздела обновляет блок БЕЗ чтения сборки и не меняет порядок', async () => {
    const { handle, root } = await mount();
    active = handle;
    assert.deepEqual(sectionIds(root), ['sec-1', 'sec-2'], 'исходный порядок разделов');

    // Рецепт уже изменён на сервере, но документ заморожен (stale).
    handle.markRebuildStale();
    nextRecipe = true;
    const before = assemblyFetches;

    handle.applyCommentRealtime('sec-1', 'Обновлённый текст', 'permanent');

    assert.equal(assemblyFetches, before, 'под stale сборка НЕ перечитывается');
    assert.deepEqual(
      sectionIds(root),
      ['sec-1', 'sec-2'],
      'порядок разделов не изменился (отложенный рецепт не материализовался)',
    );
    assert.ok(
      sectionNode(root, 'sec-1')?.querySelector('.pub-doc-preamble')?.innerHTML.includes('Обновлённый текст'),
      'текст блока обновлён из payload события',
    );
    assert.equal(stale(root), true, 'подсветка «Пересобрать» остаётся');
  });

  it('при active stale заголовок раздела правится из payload, без чтения сборки', async () => {
    const { handle, root } = await mount();
    active = handle;
    handle.markRebuildStale();
    const before = assemblyFetches;

    handle.applyThoughtRealtime('sec-1', { title: 'Новое имя раздела' });

    assert.equal(assemblyFetches, before, 'под stale сборка не перечитывается');
    assert.equal(
      sectionNode(root, 'sec-1')?.querySelector('.pub-doc-heading-text')?.textContent,
      'Новое имя раздела',
      'заголовок раздела обновлён из payload события',
    );
    assert.equal(stale(root), true, 'подсветка остаётся');
  });

  it('смешанный PATCH: подсветка stale И контентное поле применяются вместе', async () => {
    const recipe = {
      parent_ids: ['x'],
      sort: 'updated',
      order: 'asc',
    } satisfies NonNullable<Publication['title_recipe']>;
    const changes: Partial<Publication> = { title: 'Смешанный заголовок', title_recipe: recipe };
    const routing = routePublicationUpdate(changes);
    assert.equal(routing.markStale, true, 'ветка состава помечает stale');
    assert.equal(routing.patch?.title, 'Смешанный заголовок', 'контентное поле не теряется');

    // Одиночные ветки.
    assert.deepEqual(
      routePublicationUpdate({ title_recipe: recipe }),
      { markStale: true, patch: null },
      'только состав — только пометка',
    );
    assert.deepEqual(
      routePublicationUpdate({ title: 'Т' }),
      { markStale: false, patch: { title: 'Т' } },
      'только контент — только точечная правка',
    );

    const { handle, root } = await mount();
    active = handle;
    handle.applyPublicationPatch(changes);
    assert.equal(stale(root), true, 'рабочая область подсвечивает stale');
    assert.equal(headerTitle(root), 'Смешанный заголовок', 'и применяет заголовок');
  });

  it('внешняя пересборка снимает stale и перечитывает документ по новой сборке (29fd0587)', async () => {
    const { handle, root } = await mount();
    active = handle;
    handle.markRebuildStale();
    assert.equal(stale(root), true, 'подсветка зажжена');
    // На сервере уже новая сборка (другой порядок разделов).
    nextRecipe = true;

    handle.applyRebuildRealtime();

    assert.equal(stale(root), false, 'внешняя пересборка гасит подсветку сразу');
    await new Promise((resolve) => setTimeout(resolve, 280));
    assert.deepEqual(
      sectionIds(root),
      ['sec-2', 'sec-1'],
      'документ перечитан по новой сборке',
    );
  });

  it('РЕАЛЬНЫЙ путь: external publication.rebuilt через роутер гасит stale (29fd0587)', async () => {
    // Регресс к переписыванию G4: событие идёт не прямым вызовом
    // applyRebuildRealtime, а таблицей роутера (`publication.rebuilt` →
    // `pub-assembly:@id`) — если маршрут или ключ разойдутся, подсветка
    // «Пересобрать» останется гореть (симптом карточки).
    resetEventRouter();
    const { handle, root } = await mount();
    active = handle;

    // Шаг 1 (как в карточке): внешний PATCH рецепта зажигает «Пересобрать».
    routeRealtimeEvent(
      publicationEvent(
        'publication.updated',
        {
          id: 'pub-1',
          changes: { title_recipe: { parent_ids: ['x'], sort: 'updated', order: 'asc' } },
          version: 2,
        },
        9000,
      ),
      { networkId: NETWORK_ID },
    );
    assert.equal(stale(root), true, 'внешний PATCH рецепта зажёг подсветку');

    // Шаг 2 (как в карточке): внешний rebuild снимает подсветку и перечитывает.
    nextRecipe = true;
    routeRealtimeEvent(
      publicationEvent(
        'publication.rebuilt',
        { publication_id: 'pub-1', assembly_date: '2026-10-03T00:00:00.000Z' },
        9001,
      ),
      { networkId: NETWORK_ID },
    );

    assert.equal(stale(root), false, 'роутер publication.rebuilt гасит подсветку сразу');
    await new Promise((resolve) => setTimeout(resolve, 280));
    assert.deepEqual(
      sectionIds(root),
      ['sec-2', 'sec-1'],
      'документ перечитан по новой сборке через реальный маршрут',
    );
  });

  it('под stale правка ХРОНО-комментария не подменяет блок (блокер b02ef1cf)', async () => {
    const { handle, root } = await mount();
    active = handle;
    handle.markRebuildStale();
    const before = assemblyFetches;

    handle.applyCommentRealtime('sec-1', 'ХРОНО-2 ПРОСОЧИЛСЯ', 'chronological');

    assert.equal(assemblyFetches, before, 'сборка не читается');
    assert.ok(
      sectionNode(root, 'sec-1')?.querySelector('.pub-doc-preamble')?.innerHTML.includes('Начало'),
      'хроно-комментарий блок не подменил',
    );
    assert.equal(stale(root), true, 'подсветка остаётся');
  });

  it('выход из stale принудительно приводит DOM к серверной сборке (блокер b02ef1cf)', async () => {
    const { handle, root } = await mount();
    active = handle;
    handle.markRebuildStale();
    // Имитируем «просочившуюся» под stale правку DOM в обход модели
    // (как это делала правка хроно-комментария до фикса).
    const preamble = sectionNode(root, 'sec-1')?.querySelector('.pub-doc-preamble') as ShimElement | null;
    assert.ok(preamble !== null, 'предисловие раздела построено');
    preamble.innerHTML = '<p>ПРОСОЧИЛОСЬ</p>';

    handle.applyRebuildRealtime();
    await new Promise((resolve) => setTimeout(resolve, 280));

    assert.equal(
      sectionNode(root, 'sec-1')?.querySelector('.pub-doc-preamble')?.innerHTML,
      '<p>Начало</p>',
      'принудительный рендер после stale вернул серверный текст',
    );
  });
});

// ---------------------------------------------------------------------------
// Own-путь (блокер G4): свои правки из редактора идут сигналами слоя
// ---------------------------------------------------------------------------

describe('рабочая область публикации: свой путь (блокер G4, до B1)', () => {
  let active: { destroy(): void } | null = null;
  afterEach(() => {
    active?.destroy();
    active = null;
  });

  it('своя правка комментария раздела под stale правит блок из сигнала, без GET сборки', async () => {
    const { handle, root } = await mount();
    active = handle;
    handle.markRebuildStale();
    const before = assemblyFetches;

    signalPermanentCommentSaved('sec-1', 'СВОЙ ТЕКСТ БЛОКА');

    assert.equal(assemblyFetches, before, 'под stale сборка НЕ перечитывается');
    assert.ok(
      sectionNode(root, 'sec-1')?.querySelector('.pub-doc-preamble')?.innerHTML.includes('СВОЙ ТЕКСТ БЛОКА'),
      'блок обновлён из сигнала своей правки',
    );
    assert.equal(stale(root), true, 'подсветка остаётся');
  });

  it('своя правка комментария раздела на свежем тексте перечитывает документ', async () => {
    const { root } = await mount();
    // `handle` сохраняем для teardown.
    const before = assemblyFetches;
    signalPermanentCommentSaved('sec-1', 'НОВЫЙ ТЕКСТ');
    await new Promise((resolve) => setTimeout(resolve, 280));
    assert.ok(assemblyFetches > before, 'свежий текст перечитывает сборку (сигнал дошёл)');
    assert.equal(stale(root), false, 'контентная правка комментария stale не зажигает');
  });

  it('своя правка заголовка мысли зажигает stale; под stale — точечно, без GET', async () => {
    const { handle, root } = await mount();
    active = handle;
    const before = assemblyFetches;

    signalThoughtSaved('sec-1', { title: 'СВОЙ ЗАГОЛОВОК' });
    assert.equal(stale(root), true, 'своя правка заголовка зажигает stale');
    await new Promise((resolve) => setTimeout(resolve, 280));
    assert.ok(assemblyFetches > before, 'на свежем тексте документ перечитан');

    // Под stale заголовок правится из сигнала, сборка не читается.
    const beforeStale = assemblyFetches;
    signalThoughtSaved('sec-1', { title: 'ЕЩЁ ЗАГОЛОВОК' });
    assert.equal(assemblyFetches, beforeStale, 'под stale сборка не перечитывается');
    assert.equal(
      sectionNode(root, 'sec-1')?.querySelector('.pub-doc-heading-text')?.textContent,
      'ЕЩЁ ЗАГОЛОВОК',
      'заголовок блока обновлён из сигнала',
    );
  });

  it('своя правка состава (связь/свойство) зажигает stale БЕЗ чтения сборки', async () => {
    const { root } = await mount();
    const before = assemblyFetches;
    const ids = sectionIds(root);

    signalPublicationCompositionChanged();

    assert.equal(stale(root), true, 'своё изменение состава зажигает «Пересобрать»');
    assert.equal(assemblyFetches, before, 'состав не перечитывается на лету');
    assert.deepEqual(sectionIds(root), ids, 'состав документа не изменился');
  });

  it('сигнал с чужим владельцем не зажигает stale (мысль вне сборки)', async () => {
    const { root } = await mount();
    signalThoughtSaved('stranger', { title: 'X' });
    assert.equal(stale(root), false, 'посторонняя мысль stale не зажигает');
  });

  it('ужесточение G5 (8a039ea3): сигнал состава с мыслью ВНЕ сборки stale не зажигает', async () => {
    const { root } = await mount();
    // Посторонняя мысль: ни раздела, ни текста в сборке — состав не затронут.
    signalPublicationCompositionChanged(['stranger']);
    assert.equal(stale(root), false, 'постороннее свойство/связь не зажигают stale');
    // Мысль раздела — зажигает (контрольная половина).
    const ids = sectionIds(root);
    assert.ok(ids.length > 0, 'в сборке есть раздел');
    signalPublicationCompositionChanged([ids[0]!]);
    assert.equal(stale(root), true, 'мысль в сборке зажигает stale');
  });

  it('передача G6/B1: mayChangeComposition зажигает stale даже для мысли ВНЕ сборки (вход в рецепт)', async () => {
    const { root } = await mount();
    // Значение свойства-критерия рецепта может ВВЕСТИ постороннюю мысль в
    // сборку — проверки членства недостаточно, stale зажигается безусловно.
    signalPublicationCompositionChanged(['stranger'], { mayChangeComposition: true });
    assert.equal(stale(root), true, 'правка свойства-критерия зажигает «Пересобрать»');
  });

  it('публикационная инвалидация без причины безопасно перечитывает документ', async () => {
    const { root } = await mount();
    const before = assemblyFetches;
    invalidateQueries(queryKeys.publicationAssembly('pub-1'));
    await new Promise((resolve) => setTimeout(resolve, 280));
    assert.ok(assemblyFetches > before, 'неизвестная причина → перечитывание');
    assert.equal(stale(root), false, 'stale не зажигается');
  });
});
