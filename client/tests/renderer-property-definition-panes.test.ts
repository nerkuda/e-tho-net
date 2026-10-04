/**
 * Regression test for ETN error 74b94c26 «Открытый редактор не перечитывает
 * свойства при изменении определений свойств типа».
 *
 * Симптом: realtime-события `property-definition.*` (привязка/отвязка свойства
 * у типа, правка роли, override описания) приходят, клиент перечитывает
 * каталоги типов, но открытый редактор перерисовывается по гейту «владелец +
 * слой + версия мысли» — версия мысли не менялась, поэтому таблица «Свойства»
 * оставалась с прежним набором свойств до смены сущности.
 *
 * Здесь проверяются обе половины: гейт по цепочке типов показанной сущности
 * (чистые функции `lib/type-definitions.ts`) и реальный путь события до
 * пересборки вкладки «Свойства» через `mountEditor` + `initRealtime` под
 * DOM-шимом (как в `renderer-type-change-panes.test.ts`), включая локальное
 * уведомление редактора типа/менеджера свойств (свой realtime-эхо до
 * рендерера не доходит — главный процесс его отбрасывает).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { FocusResponse, Thought, ThoughtType } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Чистый гейт: какие изменения определений касаются показанного типа
// ---------------------------------------------------------------------------

describe('гейт изменений определений свойств (ошибка 74b94c26)', () => {
  it('событие `created` касается своего типа, предка и покрытого зеркалом — и не чужого', async () => {
    const {
      definitionChangeAffectsShown,
      definitionChangeFacts,
      isDefinitionEventType,
      rememberShownDefinitions,
      shownDefinitionOwner,
    } = await import('../src/renderer/lib/type-definitions.js');

    // Показана мысль типа `child`, чья цепочка — child → parent → root.
    const shown = {
      ownerType: 'thought_type' as const,
      ids: new Set(['child', 'parent', 'root']),
    };
    const created = (definition: Record<string, unknown>) =>
      definitionChangeFacts('property-definition.created', { definition });

    assert.equal(
      definitionChangeAffectsShown(created({ owner_type: 'thought_type', owner_id: 'child' }), shown),
      true,
      'своя привязка показанного типа — перечитывать',
    );
    assert.equal(
      definitionChangeAffectsShown(created({ owner_type: 'thought_type', owner_id: 'parent' }), shown),
      true,
      'привязка предка наследуется — перечитывать',
    );
    assert.equal(
      definitionChangeAffectsShown(created({ owner_type: 'thought_type', owner_id: 'other' }), shown),
      false,
      'чужой тип — не перечитывать',
    );
    assert.equal(
      definitionChangeAffectsShown(
        created({ owner_type: 'link_type', owner_id: 'child' }),
        shown,
      ),
      false,
      'владелец другой ветви каталога (тип связи) — не перечитывать',
    );
    // Зеркало (требование dde92461): тип накрыт, когда он сам или предок входит
    // в список допустимых типов свойства-связи.
    assert.equal(
      definitionChangeAffectsShown(
        created({
          owner_type: 'thought_type',
          owner_id: 'other',
          config: { allowed_target_type_ids: ['parent'] },
          side: 'source',
        }),
        shown,
      ),
      true,
      'свойство-связь накрывает предка показанного типа — зеркало меняется',
    );
    assert.equal(
      definitionChangeAffectsShown(
        created({
          owner_type: 'thought_type',
          owner_id: 'other',
          config: { allowed_target_type_ids: ['unrelated'] },
          side: 'source',
        }),
        shown,
      ),
      false,
      'список допустимых типов не покрывает цепочку — не перечитывать',
    );

    // `updated`/`deleted` владельца не несут: сверяются с показанным набором.
    rememberShownDefinitions([
      { id: 'bind-child', property_id: 'prop-child', owner_type: 'thought_type', owner_id: 'child' },
      { id: 'bind-parent', property_id: 'prop-parent', owner_type: 'thought_type', owner_id: 'parent' },
    ]);
    assert.deepEqual(shownDefinitionOwner('bind-parent'), {
      ownerType: 'thought_type',
      ownerId: 'parent',
    });
    assert.deepEqual(
      shownDefinitionOwner('prop-parent'),
      { ownerType: 'thought_type', ownerId: 'parent' },
      'событие может адресовать реестровое свойство, а не привязку',
    );
    assert.equal(shownDefinitionOwner('bind-unknown'), null);

    const updated = (id: string, changes: Record<string, unknown> = {}) =>
      definitionChangeFacts('property-definition.updated', { id, changes });
    assert.equal(
      definitionChangeAffectsShown(updated('bind-parent', { required: true }), shown),
      true,
      'правка роли унаследованной привязки — перечитывать',
    );
    assert.equal(
      definitionChangeAffectsShown(updated('bind-unknown', { required: true }), shown),
      false,
      'неизвестная привязка в таблице не отрисована — устаревать нечему',
    );
    assert.equal(
      definitionChangeAffectsShown(
        updated('bind-unknown', { allowedTargetTypeIds: ['other'] }),
        shown,
      ),
      true,
      'списки допустимых типов изменены: прежняя граница покрытия неизвестна',
    );
    assert.equal(
      definitionChangeAffectsShown(
        definitionChangeFacts('property-definition.deleted', { id: 'bind-parent' }),
        shown,
      ),
      true,
      'отвязка свойства у предка меняет наследованный набор',
    );
    assert.equal(
      definitionChangeAffectsShown(
        definitionChangeFacts('property-definition.deleted', { id: 'bind-unknown' }),
        shown,
      ),
      false,
      'отвязка чужого/неотрисованного свойства — не перечитывать',
    );

    assert.equal(isDefinitionEventType('property-definition.created'), true);
    assert.equal(isDefinitionEventType('property-value.set'), false);
    assert.equal(isDefinitionEventType('thought-type.updated'), false);
  });
});

// ---------------------------------------------------------------------------
// Реальный путь: realtime-событие и локальное уведомление до пересборки вкладки
// ---------------------------------------------------------------------------

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
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
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

describe('определения свойств типа перечитывают «Свойства» открытого редактора (74b94c26)', () => {
  it('событие о своём типе (и локальное уведомление) пересобирает вкладку, о чужом — нет', async () => {
    shimDom();
    /** Какие типы редактор запрашивал за определениями свойств. */
    const typePropertyQueries: string[] = [];
    let realtimeHandler: ((raw: unknown) => void) | null = null;
    const definitionOfChild = {
      id: 'bind-child',
      property_id: 'prop-child',
      owner_type: 'thought_type',
      owner_id: 'ta',
      key: 'своё',
      value_type: 'text',
      config: null,
      required: false,
      position: 0,
      side: null,
      description: null,
      inherited: false,
      defined_on: 'ta',
      defined_on_name: 'ta',
    };
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
          return typeId === 'ta' ? [definitionOfChild] : [];
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
    const { notifyTypeDefinitionsChanged } = await import('../src/renderer/lib/type-definitions.js');

    // Показана мысль типа «ta»; в каталоге есть корень и чужой тип «tb».
    store.update({
      networkId: 'n1',
      focus: makeFocus(makeThought({ type_id: 'ta' })),
      thoughtTypes: [makeType('root', { is_root: true }), makeType('ta', { parent_id: 'root' }), makeType('tb')],
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
    // Монотонный seq: роутер слоя дедуплицирует события по seq — повторный
    // seq=1 отбрасывал бы второе и последующие события (G1 техпроекта).
    let realtimeSeq = 0;
    const realtimeEvent = (type: string, networkId: string, data: unknown) => ({
      type,
      seq: ++realtimeSeq,
      ts: '2026-01-01T00:00:00.000Z',
      actor: { user_id: 'u2', client_id: 'c2' },
      network_id: networkId,
      audience: 'network',
      layer_id: '00000000-0000-4000-8000-000000000001',
      data,
    });
    const builds = (): number => editorInternals.paneBuildCount('properties');

    const buildsBefore = builds();
    assert.equal(buildsBefore, 1, 'вкладка «Свойства» построена при монтировании');
    assert.deepEqual(typePropertyQueries, ['ta'], 'набор свойств строился по типу показанной мысли');
    const otherTabsBefore = {
      main: editorInternals.paneBuildCount('main'),
      attachments: editorInternals.paneBuildCount('attachments'),
      chrono: editorInternals.paneBuildCount('chrono'),
    };

    // 1. Чужой тип: определения свойств «tb» набор показанной мысли не меняют.
    await feed(
      realtimeEvent('property-definition.created', 'n1', {
        definition: { owner_type: 'thought_type', owner_id: 'tb', key: 'чужое' },
      }),
    );
    assert.equal(builds(), buildsBefore, 'событие о чужом типе не пересобирает вкладку');
    assert.deepEqual(typePropertyQueries, ['ta'], 'набор свойств повторно не запрашивался');

    // 2. Чужая сеть: своё содержимое у такого события только у другой вкладки.
    await feed(
      realtimeEvent('property-definition.created', 'n2', {
        definition: { owner_type: 'thought_type', owner_id: 'ta', key: 'чужой сети' },
      }),
    );
    assert.equal(builds(), buildsBefore, 'событие соседней сети игнорируется');

    // 3. Свой тип: `created` привязки перечитывает набор показанной мысли —
    //    ровно тот же путь, что при смене типа (ошибка 786bcd69).
    await feed(
      realtimeEvent('property-definition.created', 'n1', {
        definition: { owner_type: 'thought_type', owner_id: 'ta', key: 'новое' },
      }),
    );
    assert.equal(builds(), buildsBefore + 1, 'событие о своём типе пересобирает вкладку');
    assert.deepEqual(typePropertyQueries, ['ta', 'ta'], 'набор перечитан с сервера');

    // 4. `deleted` чужой привязки: владельца берём из показанного набора —
    //    неизвестный id значит «в таблице такого определения нет».
    await feed(realtimeEvent('property-definition.deleted', 'n1', { id: 'bind-unknown' }));
    assert.equal(builds(), buildsBefore + 1, 'удаление неотрисованного определения игнорируется');

    // 5. `deleted` показанной привязки (id из индекса вкладки) — пересборка.
    await feed(realtimeEvent('property-definition.deleted', 'n1', { id: 'bind-child' }));
    assert.equal(builds(), buildsBefore + 2, 'удаление показанной привязки пересобирает вкладку');

    // 6. Локальный путь: свой клиент realtime-эхо не получает, редактор типа и
    //    менеджер свойств уведомляют его сами. Предок показанного типа.
    notifyTypeDefinitionsChanged({ ownerType: 'thought_type', ownerId: 'root' });
    await flush();
    assert.equal(builds(), buildsBefore + 3, 'локальная правка предка пересобирает вкладку');

    notifyTypeDefinitionsChanged({ ownerType: 'thought_type', ownerId: 'tb' });
    await flush();
    assert.equal(builds(), buildsBefore + 3, 'локальная правка чужого типа вкладку не трогает');

    // Типонезависимые вкладки кэш сохраняют (в «Комментарии» живёт CodeMirror —
    // bug 206e33a1: пересборка ради определений его уничтожать не должна).
    assert.equal(
      editorInternals.paneBuildCount('main'),
      otherTabsBefore.main,
      'вкладка «Комментарий» не пересобиралась',
    );
    assert.equal(
      editorInternals.paneBuildCount('attachments'),
      otherTabsBefore.attachments,
      'вкладка «Вложения» кэш сохранила',
    );
    assert.equal(
      editorInternals.paneBuildCount('chrono'),
      otherTabsBefore.chrono,
      'вкладка «Хроника» кэш сохранила',
    );
  });
});

// ---------------------------------------------------------------------------
// Проводка обоих путей в исходниках (локальные производители + индекс вкладки)
// ---------------------------------------------------------------------------

describe('проводка уведомлений об определениях свойств (ошибка 74b94c26)', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, '..', 'src', 'renderer', rel), 'utf8');

  it('локальные правки привязок уведомляют открытый редактор, вкладка ведёт индекс', () => {
    // Редактор типа: после применения черновика привязок (applyChanges).
    const typeManager = read('screens/type-manager.ts');
    assert.ok(
      // Лимит 1500 символов — между applyChanges и notifyTypeDefinitionsChanged
      // может лежать обновление снимка `current` после серии вложенных
      // операций (5bcfa04b, readFreshTypeSnapshot). Контракт один: уведомление
      // идёт по `current.id` СВЕЖЕГО снимка, а не дребеденью из applyChanges.
      /props\.applyChanges\(current\.id\)[\s\S]{0,1500}?notifyTypeDefinitionsChanged\(\{[\s\S]{0,120}?ownerId: current\.id/.test(
        typeManager,
      ),
      'редактор типа уведомляет редактор мысли после записи привязок',
    );
    // Менеджер свойств: после применения строк привязок (applyTypeRows).
    const propertyManager = read('screens/property-manager.ts');
    assert.ok(
      /notifyTypeDefinitionsChanged\(\{ ownerType: 'thought_type', ownerId: thoughtTypeId \}\)/.test(
        propertyManager,
      ),
      'менеджер свойств уведомляет редактор по каждому затронутому типу',
    );
    assert.ok(
      /touchedTypeIds\.add\(row\.thoughtTypeId\)/.test(propertyManager) &&
        /touchedTypeIds\.add\(snap\.thoughtTypeId\)/.test(propertyManager),
      'в затронутые попадают и снятые, и черновые строки',
    );
    // Вкладка «Свойства» ведёт индекс показанных определений — по нему
    // `updated`/`deleted` (у них в событии только id) находят владельца.
    const properties = read('editor/properties.ts');
    assert.ok(
      /rememberShownDefinitions\(definitions\)/.test(properties),
      'вкладка «Свойства» запоминает показанные определения',
    );
    // Редактор слушает оба источника и перечитывает только «Свойства»:
    // чужой путь — через слой (G5: инвалидация `types-catalog`, причина-событие),
    // локальный — прежним каналом `onTypeDefinitionsChanged`.
    const editor = read('editor/editor.ts');
    assert.ok(
      /onQueryInvalidated\(\(prefix, _keys, cause\) => \{[\s\S]{0,160}?prefix !== queryKeys\.typesCatalog\(\)/.test(
        editor,
      ),
      'чужой путь через слой: подписка на инвалидацию types-catalog',
    );
    assert.ok(/asRealtimeCause\(cause\)/.test(editor), 'причина инвалидации — realtime-событие');
    assert.ok(/onTypeDefinitionsChanged\(\(owner\) => \{/.test(editor), 'локальная подписка на месте');
    assert.ok(
      /function invalidateDefinitionDependentPanes\(\): void \{\s*invalidatePanes\(\['properties'\]\)/.test(
        editor,
      ),
      'определения перечитывают только «Свойства» (CodeMirror комментария не рушится)',
    );
  });
});
