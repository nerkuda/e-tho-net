/**
 * Regression test for ETN error 94b28014 «Смена родителя или удаление типа не
 * перечитывает набор свойств открытого редактора».
 *
 * Симптом: realtime-события `thought-type.updated` (в т.ч. с `parent_id` —
 * наследование набора свойств сдвинулось) и `thought-type.deleted` приходят,
 * клиент перечитывает каталоги типов и обновляет фокус холста, но открытый
 * редактор показанной мысли (или потомка) остаётся с прежней таблицей
 * «Свойства»: гейт store сравнивает владелец/слой/версию МЫСЛИ, а эти правки
 * версию мысли не меняют; подписка редактора слушала только
 * `property-definition.*` (ошибка 74b94c26) и `property-registry.*` (98aa0889).
 *
 * Проверяются: гейт по цепочке типов показанной сущности и факты об изменении
 * типа (чистые функции `lib/type-definitions.ts`), путь события до пересборки
 * вкладки и шапки через `mountEditor` + `initRealtime` под DOM-шимом (как в
 * `renderer-property-definition-panes.test.ts`), и серверное «отвязывание» типа
 * у показанной мысли (удаление типа обнуляет `type_id` без бампа версии — это
 * ловит сигнатура рендера).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { FocusResponse, Thought, ThoughtType } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Чистый гейт: какие изменения типа касаются показанной сущности
// ---------------------------------------------------------------------------

describe('гейт изменений типа показанной сущности (ошибка 94b28014)', () => {
  it('смена родителя, оформление и удаление типа — что именно перечитывать', async () => {
    const {
      isTypeChangeEventType,
      typeChangeFacts,
      markTypeDeleted,
      isTypeDeleted,
    } = await import('../src/renderer/lib/type-definitions.js');

    const owner = { ownerType: 'thought_type' as const, ownerId: 'ta' };
    const updated = (changes: Record<string, unknown>) =>
      typeChangeFacts('thought-type.updated', { id: 'ta', changes, version: 2 });

    // Смена родителя сдвигает наследование — вкладка «Свойства» перечитывается,
    // шапка не трогается.
    assert.deepEqual(updated({ parent_id: 'other' }), {
      owner,
      deleted: false,
      setChanged: true,
      visualChanged: false,
    });
    // Оформление и подпись типа резолвит цепочка типов — перерисовывается шапка
    // редактора, набор свойств не меняется.
    assert.deepEqual(updated({ icon: '🅰' }), {
      owner,
      deleted: false,
      setChanged: false,
      visualChanged: true,
    });
    const visual = (changes: Record<string, unknown>): boolean | undefined =>
      updated(changes)?.visualChanged;
    assert.equal(visual({ name: 'Новое имя' }), true);
    assert.equal(visual({ fg_color: '#fff' }), true);
    assert.equal(visual({ font_bold: true }), true);
    // Описание типа в редакторе мысли не показывается — перечитывать нечего.
    assert.deepEqual(updated({ description: 'текст' }), {
      owner,
      deleted: false,
      setChanged: false,
      visualChanged: false,
    });

    assert.deepEqual(typeChangeFacts('thought-type.deleted', { id: 'ta' }), {
      owner,
      deleted: true,
      setChanged: true,
      visualChanged: true,
    });

    // Непригодное событие (нет id) — не влияет ни на что.
    assert.equal(typeChangeFacts('thought-type.updated', { changes: {} }), null);

    assert.equal(isTypeChangeEventType('thought-type.updated'), true);
    assert.equal(isTypeChangeEventType('thought-type.deleted'), true);
    assert.equal(isTypeChangeEventType('thought-type.created'), false);
    // Типы связей — симметричный случай, закрытый ошибкой 34a9ef10: редактор
    // показанной СВЯЗИ разбирает `link-type.*` тем же контрактом.
    assert.equal(isTypeChangeEventType('link-type.updated'), true);
    assert.equal(isTypeChangeEventType('link-type.deleted'), true);
    assert.equal(isTypeChangeEventType('link-type.created'), false);
    assert.equal(isTypeChangeEventType('property-definition.updated'), false);

    // Удалённый тип запоминается: каталог store перезагружается асинхронно, а
    // вкладке «Свойства» уже сейчас нельзя запрашивать набор исчезнувшего типа.
    // Id — свой (состояние модуля общее для файла): соседний тест показывает
    // мысль типа `ta`, и помечать его удалённым здесь нельзя.
    const gone = { ownerType: 'thought_type' as const, ownerId: 'gone-type' };
    assert.equal(isTypeDeleted(gone), false);
    markTypeDeleted(gone);
    assert.equal(isTypeDeleted(gone), true);
    assert.equal(isTypeDeleted({ ownerType: 'link_type', ownerId: 'gone-type' }), false);
  });
});

// ---------------------------------------------------------------------------
// Реальный путь: realtime-событие до пересборки вкладки и шапки
// ---------------------------------------------------------------------------

/** How many DOM nodes the editor created (the shim counts them). */
let createdElements = 0;

function shimDom(): void {
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).CustomEvent = class {
    detail: unknown;
    constructor(_type: string, init?: { detail?: unknown }) {
      this.detail = init?.detail;
    }
  };
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as any).requestAnimationFrame = (cb: () => void): number => {
    cb();
    return 0;
  };
  (globalThis as any).getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px' });
  const docElementStyle = {
    setProperty: () => undefined,
    removeProperty: () => undefined,
  };
  (globalThis as any).document = {
    createElement: (tag: string) => {
      createdElements++;
      return new ShimElement(tag);
    },
    createElementNS: (_ns: string, tag: string) => {
      createdElements++;
      return new ShimElement(tag);
    },
    documentElement: { style: docElementStyle },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

function makeThought(overrides: Partial<Thought> = {}): Thought {
  return {
    id: 't1',
    title: 'T1',
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    is_protected: false,
    is_root: false,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    synonyms: [],
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeType(id: string, overrides: Partial<ThoughtType> = {}): ThoughtType {
  return {
    id,
    name: id,
    parent_id: null,
    is_root: false,
    comment_template_md: null,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u1',
    ...overrides,
  };
}

function makeFocus(focused: Thought): FocusResponse {
  return {
    focused,
    parents: [],
    siblings: [],
    children: [],
    edges: [],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

/** Waits for the editor's own async chains (render, tab pane builds). */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('изменение типа перечитывает редактор показанной мысли (94b28014)', () => {
  it('смена родителя и удаление типа пересобирают «Свойства», чужой тип — нет', async () => {
    shimDom();
    /** Какие типы редактор запрашивал за определениями свойств. */
    const typePropertyQueries: string[] = [];
    let realtimeHandler: ((raw: unknown) => void) | null = null;
    (globalThis as any).window.etn = {
      ui: {
        setState: async () => undefined,
        // Пользователь смотрит на «Свойства» — пересборка должна быть видна
        // сразу, без переключения вкладки.
        getState: async () => 'properties',
      },
      types: {
        listTypeProperties: async (_n: string, _owner: string, typeId: string) => {
          typePropertyQueries.push(typeId);
          return [];
        },
      },
      properties: { get: async () => [] },
      comments: { list: async () => [], create: async () => undefined },
      thoughts: {
        get: async () => makeThought({ type_id: 'ta' }),
        focus: async () => null,
      },
      realtime: {
        onStatusChange: () => undefined,
        onStale: () => undefined,
        onNetworkLost: () => undefined,
        onLayerControl: () => undefined,
        onEvent: (handler: (raw: unknown) => void) => {
          realtimeHandler = handler;
        },
        notifyOnline: () => undefined,
      },
    };

    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    const { initRealtime } = await import('../src/renderer/realtime.js');
    const { isTypeDeleted } = await import('../src/renderer/lib/type-definitions.js');

    // Показана мысль типа «ta» (цепочка ta → root); в каталоге есть чужой «tb».
    store.update({
      networkId: 'n1',
      focus: makeFocus(makeThought({ type_id: 'ta' })),
      thoughtTypes: [
        makeType('root', { is_root: true }),
        makeType('ta', { parent_id: 'root' }),
        makeType('tb'),
      ],
      editorTarget: null,
      collapsedGroups: {},
    } as any);

    initRealtime();
    mountEditor(new ShimElement('div') as any);
    await flush();
    assert.notEqual(realtimeHandler, null, 'realtime-мост подписан');

    const feed = async (evt: Record<string, unknown>): Promise<void> => {
      realtimeHandler!(evt);
      await flush();
    };
    const realtimeEvent = (type: string, networkId: string, data: unknown) => ({
      type,
      seq: 1,
      ts: '2026-01-01T00:00:00.000Z',
      actor: { user_id: 'u2', client_id: 'c2' },
      network_id: networkId,
      audience: 'network',
      layer_id: '00000000-0000-4000-8000-000000000001',
      data,
    });
    const builds = (): number => editorInternals.paneBuildCount('properties');
    const mainBuilds = (): number => editorInternals.paneBuildCount('main');

    const buildsBefore = builds();
    const mainBefore = mainBuilds();
    assert.equal(buildsBefore, 1, 'вкладка «Свойства» построена при монтировании');
    assert.deepEqual(typePropertyQueries, ['ta'], 'набор свойств строился по типу показанной мысли');

    // 1. Чужой тип: в цепочке показанной мысли его нет.
    await feed(
      realtimeEvent('thought-type.updated', 'n1', {
        id: 'tb',
        changes: { parent_id: 'root' },
        version: 2,
      }),
    );
    assert.equal(builds(), buildsBefore, 'смена родителя чужого типа вкладку не пересобирает');
    assert.deepEqual(typePropertyQueries, ['ta'], 'набор свойств повторно не запрашивался');

    // 2. Чужая сеть: у такого события своё содержимое только у другой вкладки.
    await feed(
      realtimeEvent('thought-type.updated', 'n2', {
        id: 'ta',
        changes: { parent_id: 'other' },
        version: 2,
      }),
    );
    assert.equal(builds(), buildsBefore, 'событие соседней сети игнорируется');

    // 3. Предок показанного типа: смена родителя сдвигает наследование, набор
    //    свойств перечитывается (сервер резолвит новую цепочку по типу мысли).
    await feed(
      realtimeEvent('thought-type.updated', 'n1', {
        id: 'root',
        changes: { parent_id: 'other' },
        version: 2,
      }),
    );
    assert.equal(builds(), buildsBefore + 1, 'смена родителя предка пересобирает вкладку');
    assert.deepEqual(typePropertyQueries, ['ta', 'ta'], 'набор перечитан с сервера');

    // 4. Только оформление типа: набор свойств не меняется — пересобирается
    //    шапка редактора (значок/цвета резолвит цепочка типов).
    const elementsBefore = createdElements;
    await feed(
      realtimeEvent('thought-type.updated', 'n1', {
        id: 'root',
        changes: { icon: '🅰' },
        version: 3,
      }),
    );
    assert.equal(builds(), buildsBefore + 1, 'оформление типа вкладку «Свойства» не пересобирает');
    assert.deepEqual(typePropertyQueries, ['ta', 'ta'], 'набор свойств не перезапрашивался');
    assert.ok(createdElements > elementsBefore, 'шапка редактора перерисована');

    // 5. Удаление типа показанной мысли: тип помечается удалённым, поэтому
    //    вкладка читает набор по КОРНЕВОМУ типу, а не по исчезнувшему.
    await feed(realtimeEvent('thought-type.deleted', 'n1', { id: 'ta' }));
    assert.equal(builds(), buildsBefore + 2, 'удаление типа пересобирает вкладку «Свойства»');
    assert.deepEqual(
      typePropertyQueries.slice(-1),
      ['root'],
      'набор запрошен по корневому типу, а не по удалённому',
    );
    assert.equal(isTypeDeleted({ ownerType: 'thought_type', ownerId: 'ta' }), true);

    // 6. Удаление чужого типа — вкладку не трогает.
    await feed(realtimeEvent('thought-type.deleted', 'n1', { id: 'tb' }));
    assert.equal(builds(), buildsBefore + 2, 'удаление чужого типа вкладку не пересобирает');

    // 7. Серверное «отвязывание» типа (удалённый тип обнулил `type_id` у мысли,
    //    версию мысли не тронув): сигнатура рендера обязана это заметить и
    //    пересобрать типозависимые вкладки по актуальному (корневому) типу.
    store.update({ focus: makeFocus(makeThought({ type_id: null })) } as any);
    await flush();
    assert.equal(builds(), buildsBefore + 3, 'отвязывание типа пересобирает «Свойства»');
    assert.deepEqual(typePropertyQueries.slice(-1), ['root'], 'набор перечитан по корневому типу');
    // «Комментарий» при смене типа сбрасывается из кэша, но пересобирается
    // лениво — при активации вкладки (CodeMirror зря не разрушается); показана
    // «Свойства», поэтому счётчик построений «Комментария» не растёт.
    assert.equal(mainBuilds(), mainBefore, '«Комментарий» пересобирается лениво, не сразу');
  });
});

// ---------------------------------------------------------------------------
// Проводка: подписка редактора, сигнатура рендера, резолв типа вкладки
// ---------------------------------------------------------------------------

describe('проводка реакции редактора на изменение типа (ошибка 94b28014)', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, '..', 'src', 'renderer', rel), 'utf8');

  it('редактор подписан на `thought-type.*` через общий гейт, вкладка не берёт удалённый тип', () => {
    const definitions = read('lib/type-definitions.ts');
    assert.ok(
      /export function isTypeChangeEventType\(/.test(definitions) &&
        /export function typeChangeFacts\(/.test(definitions),
      'контракт «тип изменился» объявлен',
    );
    assert.ok(
      /export function markTypeDeleted\(/.test(definitions) &&
        /export function isTypeDeleted\(/.test(definitions),
      'удалённые типы запоминаются для резолва набора',
    );

    const editor = read('editor/editor.ts');
    assert.ok(
      /isTypeChangeEventType\(evt\.type\)/.test(editor),
      'realtime-подписка редактора разбирает события типа',
    );
    assert.ok(
      /function applyTypeChange\(facts: TypeChangeFacts\): void \{[\s\S]{0,900}?invalidateDefinitionDependentPanes\(\)/.test(
        editor,
      ),
      'смена родителя перечитывает «Свойства» тем же механизмом',
    );
    assert.ok(
      /function repaintEditorHeader\(\): void \{/.test(editor),
      'оформление типа перерисовывает шапку отдельным путём',
    );

    // Тип сущности — часть сигнатуры рендера и гейта store: серверное
    // отвязывание типа версию мысли не меняет. Id сущности тоже входит в
    // fullSignature (задача 90b2256e): skeleton identity его не содержит,
    // поэтому смена сущности обязана менять полную сигнатуру, иначе ранний
    // выход «ничего не изменилось» пропустил бы перерисовку.
    const fullSignature = /const fullSignature =\s*ctx === null\s*\? 'null'\s*: `\$\{identitySignature\}\|\$\{ctx\.ownerId\}\|\$\{ctx\.thought\?\.version \?\? ''\}\|\$\{ctx\.link\?\.version \?\? ''\}\|\$\{ctxTypeId\(ctx\) \?\? ''\}`/;
    assert.ok(fullSignature.test(editor), 'тип сущности входит в сигнатуру рендера');
    assert.ok(
      /liveRenderedKey\.typeId === ctxTypeId\(ctx\)/.test(editor),
      'тип сущности входит в гейт store',
    );
    assert.ok(
      !/identitySignature =\s*ctx === null\s*\? 'null'\s*: `[^`]*ctxTypeId/.test(editor),
      'тип НЕ входит в identitySignature: смена типа обязана идти дешёвым patchHeader',
    );

    const properties = read('editor/properties.ts');
    assert.ok(
      /isTypeDeleted\(\{ ownerType: ownerTypeOf\(ctx\), ownerId: own \}\)/.test(properties),
      'вкладка «Свойства» не запрашивает набор удалённого типа',
    );
  });
});
