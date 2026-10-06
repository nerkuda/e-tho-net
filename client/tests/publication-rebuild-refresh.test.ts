/**
 * Пересборка публикации: видимая реакция и перечитка через слой
 * (ошибка c2dec45c, 0.11.1; миграция G4 тех.проекта 269016e2).
 *
 * Дефект: кнопка «Пересобрать» исправна, но realtime-событие `publication.rebuilt`
 * не доходит до клиента-источника (сервер подавляет эхо), а перечитка документа,
 * списков и карточки висела только на realtime. Итог — «нажал, ничего не
 * произошло».
 *
 * Прежний локальный канал `lib/publication-events` снесён. Теперь источник
 * (карточка/шапка) кладёт снимок публикации в нормализованный кэш и гасит ключи
 * слоя: `pub-assembly` с локальным сигналом `publication-rebuilt` (рабочая
 * область снимает stale и перечитывает документ), `pub-card` (карточка берёт
 * свежий снимок из кэша), `publications-list` (библиотека).
 *
 * Здесь закреплено поведение источника-карточки (функционально, на DOM-шиме):
 *  - во время пересборки кнопка заблокирована и показан прелоадер;
 *  - после успеха снимок лёг в кэш, ключи `pub-card`/`publications-list` погашены;
 *  - приходит краткое подтверждение;
 *  - пересборка из шапки обновляет карточку через кэш слоя;
 *  - конфликт отложенного сохранения НЕ запускает пересборку.
 *
 * Проводка потребителей (карточка → рабочая область/списки, шапка → карточка)
 * проверяется по исходникам модулей — как принято сторожами `guard-*`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Publication, PublicationUpdateInput } from '@etn/shared';

import { ShimElement } from './dom-shim.js';
import type { MdEditor } from '../src/renderer/editor/md-editor.js';
import { store } from '../src/renderer/state.js';
import {
  commitEntity,
  invalidateQueries,
  onQueryInvalidated,
  queryKeys,
} from '../src/renderer/lib/live/index.js';
import { assemblyDateLabel } from '../src/renderer/screens/publications/model.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NETWORK_ID = 'net-1';
const ASSEMBLY = '2026-10-02T00:00:00.000Z';

interface Calls {
  updates: Array<{ id: string; changes: PublicationUpdateInput; version: number }>;
  rebuilds: string[];
  conflicts: Array<{ id: string; sent: number; server: number }>;
  gets: string[];
}

let calls: Calls;
const db = new Map<string, Publication>();
let bodyEl: ShimElement;
/** Разрешение отложенной пересборки (для проверки прелоадера в полёте). */
let pendingRebuild: ((assemblyDate: string) => void) | null = null;
/** Отложенный PATCH — для гонки «смена цели во время пересборки». */
let deferUpdate = false;
let pendingUpdate: (() => void) | null = null;

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
  calls = { updates: [], rebuilds: [], conflicts: [], gets: [] };
  db.clear();
  for (const pub of seed) db.set(pub.id, pub);
  pendingRebuild = null;
  deferUpdate = false;
  pendingUpdate = null;

  Object.defineProperty(ShimElement.prototype, 'parentElement', {
    configurable: true,
    get(this: ShimElement): ShimElement | null {
      return this.parent;
    },
  });

  bodyEl = new ShimElement('body');
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: bodyEl,
    documentElement: new ShimElement('html'),
    activeElement: bodyEl,
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
        calls.gets.push(id);
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
        if (deferUpdate) {
          return await new Promise<Publication>((resolve) => {
            pendingUpdate = () => {
              const next: Publication = { ...cur, ...changes, version: cur.version + 1 };
              db.set(id, next);
              resolve(next);
            };
          });
        }
        const next: Publication = { ...cur, ...changes, version: cur.version + 1 };
        db.set(id, next);
        return next;
      },
      // Отложенная пересборка: тест проверяет прелоадер до её завершения.
      rebuild: async (_n: string, id: string) => {
        calls.rebuilds.push(id);
        return await new Promise<Publication>((resolve) => {
          pendingRebuild = (assemblyDate: string) => {
            const next: Publication = { ...(db.get(id) as Publication), assembly_date: assemblyDate };
            db.set(id, next);
            resolve(next);
          };
        });
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

function openCard(mod: CardModule, scrollBox: ShimElement, pub: Publication): void {
  mod.showPublicationTarget({ scrollBox: scrollBox as unknown as HTMLElement }, pub.id, pub);
}

function rebuildButton(scrollBox: ShimElement): ShimElement {
  // После переработки (b02ef1cf) «Пересобрать» — пункт меню «Действия»;
  // прелоадер вешается на кнопку «Действия».
  const button = scrollBox
    .findAll((el) => el.tagName === 'button')
    .find((el) => el.flatText().includes('Действия'));
  assert.ok(button !== undefined, 'кнопка/пункт «Действия» есть');
  return button;
}

/** Запускает пересборку через тестовый шов (пункт меню в шиме не кликается). */
function triggerRebuild(mod: CardModule): void {
  mod.publicationCardInternals.rebuild();
}

/** Текст даты сборки на вкладке «Метаданные» (ленивая — активируем вкладку). */
function assemblyText(mod: CardModule, scrollBox: ShimElement): string {
  mod.publicationCardInternals.activateTab('meta');
  const value = scrollBox.querySelector('#pub-card-assembly');
  return value?.textContent ?? '<нет>';
}

function editTitle(scrollBox: ShimElement, value: string): void {
  const input = scrollBox.querySelector('#pub-card-title') as ShimElement | null;
  assert.ok(input !== null, 'поле «Название» построено');
  input.value = value;
  input.emit('input');
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('пересборка публикации из карточки (ошибка c2dec45c)', () => {
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

  it('во время пересборки есть прелоадер, после — кэш слоя и подтверждение', async () => {
    const mod = await cardModule();
    openCard(mod, scrollBox, db.get('pub-1') as Publication);
    const prefixes: string[] = [];
    const off = onQueryInvalidated((prefix) => prefixes.push(prefix));
    try {
      const button = rebuildButton(scrollBox);
      triggerRebuild(mod);
      await wait(10);

      assert.equal(button.disabled, true, 'кнопка заблокирована на время пересборки');
      assert.ok(
        scrollBox.querySelector('.ui-state-loading') !== null,
        'прелоадер пересборки виден',
      );
      assert.ok(pendingRebuild !== null, 'запрос пересборки отправлен');

      pendingRebuild!(ASSEMBLY);
      await wait(10);

      assert.equal(button.disabled, false, 'кнопка разблокирована после пересборки');
      assert.equal(
        scrollBox.querySelector('.ui-state-loading'),
        null,
        'прелоадер убран после пересборки',
      );
      assert.ok(
        prefixes.includes(queryKeys.publicationCard('pub-1')),
        'карточка погасила свой ключ слоя (pub-card)',
      );
      assert.ok(
        prefixes.includes(queryKeys.publicationAssembly('pub-1')),
        'рабочая область оповещена ключом сборки (pub-assembly)',
      );
      assert.ok(
        bodyEl.findAll('notice').some((n) => n.flatText().includes('Документ пересобран')),
        'видно подтверждение пересборки',
      );
      assert.equal(
        assemblyText(mod, scrollBox),
        assemblyDateLabel(ASSEMBLY),
        'дата сборки обновилась',
      );
    } finally {
      off();
    }
  });

  it('пересборка из шапки обновляет карточку через кэш слоя', async () => {
    const mod = await cardModule();
    openCard(mod, scrollBox, db.get('pub-1') as Publication);
    assert.equal(assemblyText(mod, scrollBox), '—', 'до пересборки дата сборки пуста');

    // Шапка рабочей области положила свежий снимок в кэш и погасила ключ карточки.
    const updated = { ...(db.get('pub-1') as Publication), assembly_date: ASSEMBLY };
    db.set('pub-1', updated);
    commitEntity('publication', 'pub-1', updated);
    invalidateQueries(queryKeys.publicationCard('pub-1'));
    await wait(10);

    assert.equal(
      assemblyText(mod, scrollBox),
      assemblyDateLabel(ASSEMBLY),
      'карточка показала новую дату сборки из кэша слоя',
    );
  });

  it('конфликт отложенного сохранения не запускает пересборку молча', async () => {
    const mod = await cardModule();
    openCard(mod, scrollBox, db.get('pub-1') as Publication);
    editTitle(scrollBox, 'Правка');
    // Публикацию изменили извне — отложенный PATCH конфликтует.
    db.set('pub-1', { ...(db.get('pub-1') as Publication), version: 99 });

    const button = rebuildButton(scrollBox);
    triggerRebuild(mod);
    await wait(30);

    assert.equal(calls.conflicts.length, 1, 'конфликт сохранения обнаружен');
    assert.deepEqual(calls.rebuilds, [], 'пересборка по устаревшему состоянию не запущена');
    assert.equal(button.disabled, false, 'прелоадер не показан — пересборки не было');
  });

  it('смена цели во время пересборки не оставляет прелоадер на новой карточке', async () => {
    const mod = await cardModule();
    const box1 = new ShimElement('div');
    const box2 = new ShimElement('div');
    db.set('pub-2', publication({ id: 'pub-2', title: 'Вторая' }));

    // Отложенный PATCH: смену цели делаем, пока он «летит».
    deferUpdate = true;
    openCard(mod, box1, db.get('pub-1') as Publication);
    editTitle(box1, 'Правка');
    const ownerButton = rebuildButton(box1);
    triggerRebuild(mod);
    await wait(10);
    assert.ok(pendingUpdate !== null, 'PATCH владельца отправлен');

    // Переключаемся на другую публикацию до ответа PATCH.
    openCard(mod, box2, db.get('pub-2') as Publication);
    pendingUpdate!();
    await wait(10);
    assert.ok(pendingRebuild !== null, 'пересборка владельца всё равно отправлена');
    pendingRebuild!(ASSEMBLY);
    await wait(20);

    const newButton = rebuildButton(box2);
    assert.equal(newButton.disabled, false, 'кнопка новой карточки не заблокирована');
    assert.equal(
      box2.querySelector('.ui-state-loading'),
      null,
      'прелоадер не залип на новой карточке',
    );
    assert.equal(ownerButton.disabled, false, 'у карточки-владельца прелоадер снят');
  });
});

// ---------------------------------------------------------------------------
// Проводка потребителей (по исходникам, как сторож)
// ---------------------------------------------------------------------------

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(CLIENT_ROOT, 'src', 'renderer');
const read = (rel: string): string => fs.readFileSync(path.join(RENDERER, rel), 'utf8');

/** Тело функции: от подписи до первого top-level `\n}` (вложенные закрыты с отступом). */
function functionBlock(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `не найдена функция ${signature}`);
  const end = source.indexOf('\n}', start);
  return end < 0 ? source.slice(start) : source.slice(start, end + 2);
}

describe('проводка перечитки после пересборки (ошибка c2dec45c, G4)', () => {
  it('карточка кладёт снимок в кэш и гасит ключ сборки с локальным сигналом', () => {
    const source = read('editor/publication-card.ts');
    const block = functionBlock(source, 'async function rebuildPublication(');
    assert.ok(
      block.includes("commitEntity('publication', publicationId, updated)"),
      'карточка кладёт снимок пересборки в кэш слоя',
    );
    assert.ok(
      block.includes("local: 'publication-rebuilt'"),
      'рабочая область оповещается локальным сигналом пересборки',
    );
    assert.ok(
      block.includes('setRebuildingOn(ownerButton, ownerFeedback, true)'),
      'карточка показывает прелоадер',
    );
    assert.ok(
      block.includes('setRebuildingOn(ownerButton, ownerFeedback, false)'),
      'прелоадер снимается у владельца',
    );
    assert.ok(
      block.includes('const owner = instance'),
      'владелец пересборки захвачен до первого await (защита от смены цели)',
    );
    assert.ok(
      /if \(!\(await flushSave\(\)\)\) return;/.test(block),
      'конфликт сохранения прерывает пересборку, а не пропускается молча',
    );
  });

  it('рабочая область шлёт кэш-путь после пересборки из шапки', () => {
    const source = read('screens/publications/workspace.ts');
    const block = functionBlock(source, 'async function rebuild(');
    assert.ok(
      block.includes("commitEntity('publication', publicationId, updated)"),
      'шапка кладёт снимок в кэш слоя',
    );
    assert.ok(block.includes('invalidateAfterMutation('), 'шапка гасит ключи слоя');
    assert.ok(block.includes('reload()'), 'шапка перечитывает документ');
    assert.ok(
      block.includes("t('publication.rebuilding')"),
      'шапка показывает прелоадер на время запроса',
    );
  });

  it('экран «Публикации» подписан на слой и перечитывает список', () => {
    const source = read('screens/publications/publications.ts');
    assert.ok(source.includes('onQueryInvalidated'), 'экран подписан на инвалидации слоя');
    assert.ok(
      source.includes('queryKeys.publicationsListAll()'),
      'библиотека гасится ключом слоя',
    );
  });
});
