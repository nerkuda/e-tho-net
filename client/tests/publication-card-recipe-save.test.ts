/**
 * Карточка публикации: сохранение отбора и устойчивость автосейва
 * (ошибка 82aada28, 0.11.1).
 *
 * Дефект: конструктор рецепта не уведомлял карточку о правках, поэтому
 * `title_recipe` не сохранялся никогда; `rebuildPublication` не дожидался
 * дебаунса `queueSave` (400 мс) и пересобирал документ по старой строке, а
 * ответ затирал поля UI. Позже приёмка выявила два регресса того же дефекта,
 * закреплённые здесь:
 *
 *  1. смена цели карточки в окне дебаунса — ответ старого PATCH применялся к
 *     новой карточке, и правка уходила в чужую публикацию;
 *  2. устаревший снимок публикации в store на любом тике откатывал поля и давал
 *     `CONFLICT` на втором сохранении (старая `version`).
 *
 * DOM-шим — общий (`dom-shim.ts`); фабрика markdown-редактора подменяется
 * заглушкой через тестовый шов `publicationCardInternals` (CodeMirror в шиме
 * не исполняется). Шим не имеет `parentElement`, а ветка «та же цель — apply на
 * месте» без него недостижима; тесты добавляют прототипу геттер `parentElement`
 * (в процессе этого файла), чтобы воспроизвести реальный путь обновления.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Publication, PublicationUpdateInput } from '@etn/shared';

import { ShimElement } from './dom-shim.js';
import type { MdEditor } from '../src/renderer/editor/md-editor.js';
import { store } from '../src/renderer/state.js';
import {
  clearEntities,
  getEntity,
  invalidateQueries,
  patchEntity,
  queryKeys,
  resetQueryRegistry,
} from '../src/renderer/lib/live/index.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NETWORK_ID = 'net-1';

interface Calls {
  updates: Array<{ id: string; changes: PublicationUpdateInput; version: number }>;
  rebuilds: string[];
  order: string[];
  conflicts: Array<{ id: string; sent: number; server: number }>;
}

let calls: Calls;
/** Серверная «база» публикаций: id → строка. */
const db = new Map<string, Publication>();

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

function installShim(seed: Publication[]): void {
  calls = { updates: [], rebuilds: [], order: [], conflicts: [] };
  db.clear();
  for (const pub of seed) db.set(pub.id, pub);

  // `parentElement` реального DOM (в шиме есть только `parent`) — без него
  // ветка «та же цель — apply на месте» недостижима, а именно она отдаёт
  // устаревший снимок store в карточку.
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
      get: async (_n: string, id: string) => {
        const pub = db.get(id);
        if (pub === undefined) throw new Error('NOT_FOUND');
        return pub;
      },
      update: async (_n: string, id: string, changes: PublicationUpdateInput, version: number) => {
        const cur = db.get(id);
        if (cur === undefined) throw new Error('NOT_FOUND');
        if (version !== cur.version) {
          calls.conflicts.push({ id, sent: version, server: cur.version });
          throw new Error('VERSION_CONFLICT');
        }
        calls.updates.push({ id, changes, version });
        calls.order.push('update');
        const next: Publication = { ...cur, ...changes, version: cur.version + 1 };
        db.set(id, next);
        return next;
      },
      rebuild: async (_n: string, id: string) => {
        calls.rebuilds.push(id);
        calls.order.push('rebuild');
        const next: Publication = {
          ...(db.get(id) as Publication),
          assembly_date: '2026-10-02T00:00:00.000Z',
        };
        db.set(id, next);
        return next;
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
    setCaret: () => undefined,
    setSelection: () => undefined,
    focus: () => undefined,
    focusToEnd: () => undefined,
    blur: () => undefined,
    snapshot: () => ({ text: value, from: value.length, to: value.length }),
    applyEdit: () => undefined,
    subscribe: () => () => undefined,
    setSearchHighlight: () => undefined,
    selectMatch: () => undefined,
    exitTransclusionEdit: () => undefined,
    saveTransclusionEdit: () => Promise.resolve(),
    destroy: () => undefined,
  };
}

type CardModule = typeof import('../src/renderer/editor/publication-card.js');

async function cardModule(): Promise<CardModule> {
  const mod = await import('../src/renderer/editor/publication-card.js');
  mod.publicationCardInternals.createMdEditor = (initial: string) => fakeMdEditor(initial) as never;
  return mod;
}

/** Открывает карточку и вкладку «Рецепты», дожидаясь загрузки реестра. */
async function openRecipeTab(scrollBox: ShimElement, pub: Publication): Promise<CardModule> {
  const mod = await cardModule();
  mod.showPublicationTarget({ scrollBox: scrollBox as unknown as HTMLElement }, pub.id, pub);
  const recipeTab = scrollBox
    .findAll((el) => el.className.includes('ui-tab') && el.textContent !== '')
    .find((el) => el.textContent === 'Рецепт');
  assert.ok(recipeTab !== undefined, 'вкладка «Рецепт» есть в полосе вкладок');
  recipeTab.click();
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

/** Правка поля «Название» вкладки «Метаданные». */
function editTitle(scrollBox: ShimElement, value: string): ShimElement {
  const input = scrollBox.querySelector('#pub-card-title') as ShimElement | null;
  assert.ok(input !== null, 'поле «Название» построено');
  input.value = value;
  input.emit('input');
  return input;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('карточка публикации: сохранение рецепта (ошибка 82aada28)', () => {
  let scrollBox: ShimElement;

  beforeEach(() => {
    installShim([publication()]);
    scrollBox = new ShimElement('div');
    store.update({ networkId: NETWORK_ID, editorTarget: null });
  });

  afterEach(async () => {
    const mod = await import('../src/renderer/editor/publication-card.js');
    mod.disposePublicationCard();
  });

  it('правка рецепта сохраняется PATCH-ом в title_recipe', async () => {
    await openRecipeTab(scrollBox, publication());

    editRecipeKeywords(scrollBox, 'тест');
    await wait(450);

    assert.equal(calls.updates.length, 1, 'PATCH публикации выполнен один раз');
    const changes = calls.updates[0]!.changes;
    assert.ok('title_recipe' in changes, 'PATCH несёт title_recipe');
    assert.match(JSON.stringify(changes.title_recipe), /тест/, 'отбор содержит правку');
    assert.equal(calls.updates[0]!.id, 'pub-1');
    assert.equal(calls.conflicts.length, 0);
  });

  it('«Пересобрать» сначала досылает отложенный отбор, затем пересобирает', async () => {
    const mod = await openRecipeTab(scrollBox, publication());

    editRecipeKeywords(scrollBox, 'порядок');
    // Не ждём дебаунс — запускаем «Пересобрать» сразу (пункт меню «Действия»).
    mod.publicationCardInternals.rebuild();
    await new Promise((resolve) => setImmediate(resolve));
    await wait(20);

    assert.deepEqual(calls.order, ['update', 'rebuild'], 'сначала сохранение, затем пересборка');
    assert.match(JSON.stringify(calls.updates[0]!.changes.title_recipe), /порядок/);
    assert.deepEqual(calls.rebuilds, ['pub-1']);
  });

  it('переоткрытие карточки показывает сохранённый отбор (сценарий бага)', async () => {
    const mod = await openRecipeTab(scrollBox, publication());

    editRecipeKeywords(scrollBox, 'сохранённый');
    await wait(450);
    assert.equal(calls.updates.length, 1, 'отбор сохранён в публикацию');
    const saved = db.get('pub-1') as Publication;
    assert.match(JSON.stringify(saved.title_recipe), /сохранённый/);

    // Переоткрытие: сброс и повторный показ карточки с серверными данными.
    mod.disposePublicationCard();
    const reopened = new ShimElement('div');
    mod.showPublicationTarget({ scrollBox: reopened as unknown as HTMLElement }, saved.id, saved);
    const recipeTab = reopened
      .findAll((el) => el.className.includes('ui-tab') && el.textContent !== '')
      .find((el) => el.textContent === 'Рецепт');
    assert.ok(recipeTab !== undefined);
    recipeTab.click();
    await new Promise((resolve) => setImmediate(resolve));

    const keywords = reopened.querySelector('.st-f-keywords') as ShimElement | null;
    assert.ok(keywords !== null, 'поле рецепта построено после переоткрытия');
    assert.equal(keywords.value, 'сохранённый', 'отбор восстановлен из сохранённой публикации');
  });
});

describe('карточка публикации: автосейв при смене цели и тиках store (ошибка 82aada28)', () => {
  beforeEach(() => {
    installShim([
      publication(),
      publication({ id: 'pub-2', title: 'НАЗВАНИЕ-pub-2' }),
    ]);
    store.update({ networkId: NETWORK_ID, editorTarget: null });
  });

  afterEach(async () => {
    const mod = await import('../src/renderer/editor/publication-card.js');
    mod.disposePublicationCard();
  });

  it('смена цели в окне дебаунса не уводит правку в чужую публикацию', async () => {
    const mod = await cardModule();
    const hostA = new ShimElement('div');
    const hostB = new ShimElement('div');
    const a = db.get('pub-1') as Publication;
    const b = db.get('pub-2') as Publication;

    mod.showPublicationTarget({ scrollBox: hostA as unknown as HTMLElement }, a.id, a);
    editTitle(hostA, 'правка-A');
    // Переключаемся на B, не дожидаясь дебаунса 400 мс.
    mod.showPublicationTarget({ scrollBox: hostB as unknown as HTMLElement }, b.id, b);
    editTitle(hostB, 'правка-B');
    await wait(450);

    assert.deepEqual(
      calls.updates.map((u) => u.id),
      ['pub-1', 'pub-2'],
      'каждая правка ушла в свою публикацию',
    );
    assert.equal(calls.updates[0]!.changes.title, 'правка-A');
    assert.equal(calls.updates[1]!.changes.title, 'правка-B');
    assert.equal((db.get('pub-1') as Publication).title, 'правка-A');
    assert.equal((db.get('pub-2') as Publication).title, 'правка-B');
    assert.deepEqual(calls.conflicts, [], 'никто не откатил карточку');
  });

  it('тик store после сохранения не откатывает поля и не даёт CONFLICT', async () => {
    const mod = await cardModule();
    const host = new ShimElement('div');
    const a = db.get('pub-1') as Publication;
    store.update({ editorTarget: { kind: 'publication', id: a.id, publication: a } });

    mod.showPublicationTarget({ scrollBox: host as unknown as HTMLElement }, a.id, a);
    const title = editTitle(host, 'Новое');
    await wait(450);
    assert.equal(calls.updates.length, 1, 'первое сохранение выполнено');
    assert.equal((db.get('pub-1') as Publication).version, 2);
    const liveTarget = store.state.editorTarget;
    assert.ok(liveTarget !== null && liveTarget.kind === 'publication');
    assert.equal(liveTarget.publication?.version, 2, 'снимок store синхронизирован');

    // Имитация тика store: editor.render отдаёт снимок store той же цели.
    mod.showPublicationTarget(
      { scrollBox: host as unknown as HTMLElement },
      a.id,
      liveTarget.publication,
    );
    assert.equal(
      (host.querySelector('#pub-card-title') as ShimElement).value,
      'Новое',
      'поле не откатилось устаревшим снимком',
    );
    assert.equal(title.value, 'Новое', 'инпут тот же — карточка не пересобрана');

    // Вторая правка обязана уйти с актуальной version (иначе CONFLICT).
    editTitle(host, 'Ещё');
    await wait(450);
    assert.deepEqual(calls.conflicts, [], 'CONFLICT не возник');
    assert.equal(calls.updates.length, 2, 'вторая правка сохранена');
    assert.equal(calls.updates[1]!.version, 2, 'вторая правка ушла с актуальной version');
  });
});

/**
 * Ошибка 4efb01bb: выбор родительской мысли в рецепте НОВОЙ публикации падал с
 * `p.text_sources is not iterable`. Живой кэш мог отдать карточке ЧАСТИЧНУЮ
 * запись публикации (патч realtime-события раньше полного снимка), у которой
 * нет `text_sources`/`extra_properties`; апдейтер панели настроек делал
 * `[...p.text_sources]`. Корень устранён на сервере (событие создания несёт
 * полный DTO, тест `routes-publications`), здесь закрепляем защиту слоя.
 */
describe('карточка публикации: устойчивость к частичной записи кэша (ошибка 4efb01bb)', () => {
  let scrollBox: ShimElement;

  beforeEach(() => {
    installShim([publication()]);
    scrollBox = new ShimElement('div');
    store.update({ networkId: NETWORK_ID, editorTarget: null });
    clearEntities();
    resetQueryRegistry();
  });

  afterEach(async () => {
    const mod = await import('../src/renderer/editor/publication-card.js');
    mod.disposePublicationCard();
    clearEntities();
    resetQueryRegistry();
  });

  it('частичная запись без text_sources не роняет апдейтер панели настроек', async () => {
    await openRecipeTab(scrollBox, publication());

    // Realtime-патч до полного снимка: в кэше появляется публикация без
    // массивов рецепта (точная форма симптома — нет `text_sources`).
    patchEntity(
      'publication',
      'pub-1',
      {
        title: 'Частичная',
        subtitle: null,
        summary_md: null,
        authorship: null,
        cover_attachment_id: null,
        cover_url: null,
        cover_kind: 'none',
        assembly_date: null,
        title_recipe: null,
        numbering_from: null,
        numbering_to: null,
        active: true,
      },
      { seq: 5, version: 2 },
    );
    const cached = getEntity<Record<string, unknown>>('publication', 'pub-1');
    assert.equal(cached?.text_sources, undefined, 'имитирован неполный объект кэша');

    // Инвалидация ключа карточки заставляет её применить запись из кэша.
    assert.doesNotThrow(() => invalidateQueries(queryKeys.publicationCard('pub-1')));

    const keywords = scrollBox.querySelector('.st-f-keywords') as ShimElement | null;
    assert.ok(keywords !== null, 'поле рецепта осталось построенным — апдейтер не упал');
  });

  it('прямая подача объекта без text_sources в апдейтер не бросает исключение', async () => {
    const mod = await cardModule();
    mod.showPublicationTarget(
      { scrollBox: scrollBox as unknown as HTMLElement },
      'pub-1',
      publication(),
    );
    const recipeTab = scrollBox
      .findAll((el) => el.className.includes('ui-tab') && el.textContent !== '')
      .find((el) => el.textContent === 'Рецепт');
    assert.ok(recipeTab !== undefined);
    recipeTab.click();
    await new Promise((resolve) => setImmediate(resolve));

    const partial = {
      id: 'pub-1',
      title: 'Без массивов',
      numbering_from: null,
      numbering_to: null,
      title_recipe: null,
    } as unknown as Publication;
    assert.doesNotThrow(() => mod.publicationCardInternals.apply(partial));
  });
});
