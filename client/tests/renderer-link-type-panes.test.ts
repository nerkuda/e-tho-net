/**
 * Regression test for ETN error 34a9ef10 «Смена родителя или удаление типа
 * связи не перечитывает набор свойств открытого редактора связи» (симметричный
 * случай исправленной 94b28014).
 *
 * Симптом: realtime-события `link-type.updated` (смена `parent_id` сдвигает
 * наследование, правка пары имён и параметров линии меняет то, что рисует
 * шапка) и `link-type.deleted` приходят, клиент перечитывает каталоги типов и
 * обновляет фокус холста, но открытый редактор показанной СВЯЗИ остаётся с
 * прежним типом: подписка редактора слушала только `thought-type.*`
 * (94b28014) поверх `property-definition.*` (74b94c26) и
 * `property-registry.*` (98aa0889).
 *
 * Особенность связи: собственных свойств у одиночной связи нет, а вкладки
 * «Свойства» у её редактора нет вовсе (08-ui-spec.md §6.3, guard
 * `editor-tabs-structure.test.ts`) — типозависимая поверхность редактора связи
 * это ШАПКА (пара имён типа в поле выбора и наследуемый вид линии). Удаление
 * типа сервер отвязывает ссылающиеся связи (`type_id = NULL`, `version + 1`),
 * не присылая событий о самих связях, поэтому редактор перечитывает показанную
 * связь сам.
 *
 * Проверяются: факты об изменении типа связи и гейт (чистые функции
 * `lib/type-definitions.ts`), путь события до перерисовки шапки через
 * `mountEditor` + `initRealtime` под DOM-шимом (как в
 * `renderer-thought-type-panes.test.ts`) и перечитывание отвязанной связи при
 * удалении её собственного типа.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { Link, LinkType } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Чистый гейт: какие изменения типа связи касаются показанной связи
// ---------------------------------------------------------------------------

describe('гейт изменений типа связи (ошибка 34a9ef10)', () => {
  it('имена/линия/родитель/удаление типа связи — что именно перечитывать', async () => {
    const { isTypeChangeEventType, typeChangeFacts } = await import(
      '../src/renderer/lib/type-definitions.js'
    );

    const owner = { ownerType: 'link_type' as const, ownerId: 'la' };
    const updated = (changes: Record<string, unknown>) =>
      typeChangeFacts('link-type.updated', { id: 'la', changes, version: 2 });

    // Пара имён типа рисуется облачком типа в поле выбора шапки — её правка
    // обязана перерисовать шапку.
    assert.deepEqual(updated({ name_forward: 'новое' }), {
      owner,
      deleted: false,
      setChanged: false,
      visualChanged: true,
    });
    const visual = (changes: Record<string, unknown>): boolean | undefined =>
      updated(changes)?.visualChanged;
    assert.equal(visual({ name_reverse: 'обратное' }), true);
    assert.equal(visual({ color: '#fff' }), true);
    assert.equal(visual({ style: 'dashed' }), true);
    assert.equal(visual({ width: 3 }), true);
    // Описание типа связи в редакторе связи не показывается — перечитывать
    // нечего.
    assert.deepEqual(updated({ description: 'текст' }), {
      owner,
      deleted: false,
      setChanged: false,
      visualChanged: false,
    });
    // Смена родителя сдвигает наследование эффективного набора свойств; вид
    // линии шапка резолвит заново при каждом построении поля выбора и диалога
    // ⚙, поэтому отдельной перерисовки шапки не требуется.
    assert.deepEqual(updated({ parent_id: 'other' }), {
      owner,
      deleted: false,
      setChanged: true,
      visualChanged: false,
    });

    assert.deepEqual(typeChangeFacts('link-type.deleted', { id: 'la' }), {
      owner,
      deleted: true,
      setChanged: true,
      visualChanged: true,
    });

    // Владелец — каталог СВЯЗЕЙ, а не мыслей: событие адресует тот же id, но
    // гейт сверяет его с цепочкой типов показанной связи.
    assert.equal(updated({ name_forward: 'x' })?.owner.ownerType, 'link_type');
    // Непригодное событие (нет id) — не влияет ни на что.
    assert.equal(typeChangeFacts('link-type.updated', { changes: {} }), null);
    assert.equal(typeChangeFacts('link-type.deleted', {}), null);

    assert.equal(isTypeChangeEventType('link-type.updated'), true);
    assert.equal(isTypeChangeEventType('link-type.deleted'), true);
    assert.equal(isTypeChangeEventType('link-type.created'), false);

    // Набор «визуальных» полей зависит от вида каталога: имя/иконка/цвета
    // типа мысли по-прежнему перерисовывают шапку редактора мысли (94b28014),
    // а полей линии у типа мысли нет.
    const thoughtOwner = { ownerType: 'thought_type' as const, ownerId: 'ta' };
    assert.deepEqual(typeChangeFacts('thought-type.updated', { id: 'ta', changes: { icon: '🅰' } }), {
      owner: thoughtOwner,
      deleted: false,
      setChanged: false,
      visualChanged: true,
    });
    assert.equal(
      typeChangeFacts('thought-type.updated', { id: 'ta', changes: { width: 3 } })?.visualChanged,
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Реальный путь: realtime-событие до перерисовки шапки редактора связи
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

function makeLink(overrides: Partial<Link> = {}): Link {
  return {
    id: 'l1',
    source_id: 't1',
    target_id: 't2',
    type_id: null,
    color: null,
    style: null,
    width: null,
    active: true,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeLinkType(id: string, overrides: Partial<LinkType> = {}): LinkType {
  return {
    id,
    name_forward: id,
    name_reverse: `${id} (обратно)`,
    parent_id: null,
    is_root: false,
    color: null,
    style: null,
    width: null,
    description: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u1',
    ...overrides,
  };
}

/** Waits for the editor's own async chains (render, refetch, pane builds). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Text of every element in the subtree (для проверки содержимого шапки). */
function collectText(node: ShimElement, out: string[] = []): string[] {
  if (node.textContent !== '') out.push(node.textContent);
  for (const child of node.children) collectText(child, out);
  return out;
}

describe('изменение типа связи перерисовывает редактор показанной связи (34a9ef10)', () => {
  it('шапка обновляется, чужой тип/сеть игнорируются, удаление перечитывает связь', async () => {
    shimDom();
    /** Какие связи редактор перечитывал (удаление типа отвязывает их на сервере). */
    const linkGets: string[] = [];
    /** Серверный каталог типов связи — меняется правками (как на сервере). */
    let serverLinkTypes: LinkType[] = [
      makeLinkType('root', { is_root: true }),
      makeLinkType('la', { parent_id: 'root' }),
      makeLinkType('lb'),
    ];
    /** Сколько раз клиент запрашивал каталог типов связи (проверка общего запроса). */
    let catalogueFetches = 0;
    let realtimeHandler: ((raw: unknown) => void) | null = null;
    (globalThis as any).window.etn = {
      ui: {
        setState: async () => undefined,
        // Открыта вкладка «Метаданные» — перерисовка шапки не зависит от
        // активной вкладки, а вкладки «Свойства» у связи нет вовсе.
        getState: async () => 'metadata',
      },
      admin: { listUsers: async () => [] },
      types: {
        listThoughtTypes: async () => [],
        listLinkTypes: async () => {
          catalogueFetches++;
          return serverLinkTypes;
        },
      },
      properties: { get: async () => [] },
      comments: { list: async () => [], create: async () => undefined },
      thoughts: { get: async () => null, focus: async () => null, resolve: async () => [] },
      links: {
        // Сервер отвязал связь удалённого типа: `type_id = NULL`, версия +1.
        get: async (_n: string, id: string) => {
          linkGets.push(id);
          return makeLink({ id, type_id: null, version: 2 });
        },
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
    const { initRealtime, setRealtimeEffects } = await import('../src/renderer/realtime.js');
    const { applyDerivedRealtime } = await import('../src/renderer/realtime-effects.js');
    const { isTypeDeleted } = await import('../src/renderer/lib/type-definitions.js');

    // Показана связь типа «la» (цепочка la → root); в каталоге есть чужой «lb».
    store.update({
      networkId: 'n1',
      linkTypes: serverLinkTypes,
      editorTarget: { kind: 'link', id: 'l1', link: makeLink({ type_id: 'la' }) },
      selectedLinkId: 'l1',
      collapsedGroups: {},
    } as any);

    initRealtime();
    // Как в приложении (G6): производные эффекты — единственный мост события,
    // он зарегистрирован раньше редактора и первым перечитывает каталоги типов.
    setRealtimeEffects({ onEventApplied: (evt) => applyDerivedRealtime(evt) });
    const host = new ShimElement('div');
    mountEditor(host as any);
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
    const headerText = (): string => collectText(host).join(' | ');

    // Вкладки «Свойства» у редактора связи нет (08-ui-spec.md §6.3) — набор
    // эффективных определений типа связи в редакторе связи не показывается.
    assert.equal(editorInternals.paneBuildCount('properties'), 0, 'у связи нет вкладки «Свойства»');
    assert.ok(headerText().includes('la /'), 'в шапке показан тип связи «la»');

    // 1. Чужой тип связи: в цепочке показанной связи его нет.
    let before = createdElements;
    await feed(
      realtimeEvent('link-type.updated', 'n1', {
        id: 'lb',
        changes: { name_forward: 'чужое' },
        version: 2,
      }),
    );
    assert.equal(createdElements, before, 'правка чужого типа связи шапку не перерисовывает');

    // 2. Чужая сеть: у такого события своё содержимое только у другой вкладки.
    before = createdElements;
    await feed(
      realtimeEvent('link-type.updated', 'n2', {
        id: 'la',
        changes: { name_forward: 'соседняя сеть' },
        version: 2,
      }),
    );
    assert.equal(createdElements, before, 'событие соседней сети игнорируется');

    // 3. Правка пары имён СВОЕГО типа: её рисует облачко типа в шапке. Каталог
    //    типов обновляется асинхронно, поэтому шапка обязана показать ИМЕННО
    //    новое имя, а не повторить прежний вид.
    serverLinkTypes = [
      makeLinkType('root', { is_root: true }),
      makeLinkType('la', { parent_id: 'root', name_forward: 'НОВОЕ' }),
      makeLinkType('lb'),
    ];
    const fetchesBefore = catalogueFetches;
    before = createdElements;
    await feed(
      realtimeEvent('link-type.updated', 'n1', {
        id: 'la',
        changes: { name_forward: 'НОВОЕ' },
        version: 3,
      }),
    );
    assert.ok(createdElements > before, 'правка имени типа связи перерисовывает шапку');
    assert.ok(headerText().includes('НОВОЕ /'), `шапка показывает новое имя: ${headerText()}`);
    assert.equal(
      catalogueFetches,
      fetchesBefore + 1,
      'перезапрос каталога общий: редактор дожидается того же запроса',
    );

    // 4. Предок показанного типа: имя самого типа не менялось, но правка
    //    пришла в его цепочку — шапку перерисовываем тем же путём, лишних
    //    вкладок не трогаем.
    before = createdElements;
    await feed(
      realtimeEvent('link-type.updated', 'n1', {
        id: 'root',
        changes: { name_forward: 'основной' },
        version: 3,
      }),
    );
    assert.ok(createdElements > before, 'правка предка типа связи перерисовывает шапку');

    // 5. Смена родителя: набор определений типа связи в редакторе связи не
    //    показывается, шапка вид линии резолвит заново при построении поля
    //    выбора — событие не даёт видимой работы, но и не ломает редактор.
    before = createdElements;
    const panesBefore = editorInternals.paneBuildCount('metadata');
    await feed(
      realtimeEvent('link-type.updated', 'n1', {
        id: 'la',
        changes: { parent_id: 'lb' },
        version: 4,
      }),
    );
    assert.equal(createdElements, before, 'смена родителя без правки вида шапку не перерисовывает');
    assert.equal(
      editorInternals.paneBuildCount('metadata'),
      panesBefore,
      'вкладки при смене родителя не пересобираются',
    );

    // 6. Удаление СОБСТВЕННОГО типа показанной связи: тип помечается удалённым
    //    (каталог store перезагружается асинхронно), а сама связь — отвязана
    //    сервером без отдельного события, поэтому редактор перечитывает её.
    serverLinkTypes = [
      makeLinkType('root', { is_root: true }),
      makeLinkType('lb'),
    ];
    before = createdElements;
    await feed(realtimeEvent('link-type.deleted', 'n1', { id: 'la' }));
    assert.deepEqual(linkGets, ['l1'], 'показанная связь перечитана с сервера');
    assert.equal(isTypeDeleted({ ownerType: 'link_type', ownerId: 'la' }), true);
    const liveTarget = store.state.editorTarget as { kind: string; link: Link } | null;
    assert.equal(liveTarget?.kind, 'link');
    assert.equal(liveTarget?.link.type_id, null, 'шапка получает отвязанный тип с сервера');
    assert.ok(createdElements > before, 'шапка перерисована после перечитывания связи');
    assert.ok(!headerText().includes('ла /'), 'исчезнувший тип больше не рисуется в шапке');

    // 7. Удаление чужого типа связи — связь не перечитывается.
    await feed(realtimeEvent('link-type.deleted', 'n1', { id: 'lb' }));
    assert.deepEqual(linkGets, ['l1'], 'удаление чужого типа связи связи не трогает');
  });
});

// ---------------------------------------------------------------------------
// Проводка: подписка редактора, перечитывание отвязанной сущности
// ---------------------------------------------------------------------------

describe('проводка реакции редактора на изменение типа связи (ошибка 34a9ef10)', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, '..', 'src', 'renderer', rel), 'utf8');

  it('редактор разбирает link-type.* общим контрактом и перечитывает отвязанную сущность', () => {
    const definitions = read('lib/type-definitions.ts');
    assert.ok(
      /'link-type\.updated'/.test(definitions) && /'link-type\.deleted'/.test(definitions),
      'типы связей входят в контракт «тип изменился»',
    );
    assert.ok(
      /function typeOwnerOfEvent\(\s*type: TypeChangeEventType,\s*id: string,?\s*\)/.test(definitions),
      'вид каталога выводится из имени события',
    );
    assert.ok(
      /LINK_TYPE_VISUAL_KEYS/.test(definitions) && /THOUGHT_TYPE_VISUAL_KEYS/.test(definitions),
      'набор визуальных полей зависит от вида каталога',
    );

    const editor = read('editor/editor.ts');
    assert.ok(
      /function refreshShownEntityAfterTypeDetach\(\): void \{/.test(editor),
      'отвязанная сущность перечитывается с сервера',
    );
    assert.ok(
      /facts\.deleted && ownTypeId !== null && ownTypeId === facts\.owner\.ownerId[\s\S]{0,200}?refreshShownEntityAfterTypeDetach\(\)/.test(
        editor,
      ),
      'перечитывание запускается только для собственного удалённого типа',
    );
    assert.ok(
      /etn\.links\s*\.get\(networkId, target\.id\)/.test(editor),
      'связь перечитывается через links.get',
    );
    // Шапка резолвит оформление типа из каталога, а он приезжает асинхронно:
    // перерисовка ждёт перечитывания каталога, иначе повторяла бы прежний вид.
    assert.ok(
      /facts\.visualChanged\) void reloadTypeCatalogues\(\)\.then\(\(\) => repaintEditorHeader\(\)\)/.test(
        editor,
      ),
      'шапка перерисовывается после обновления каталога типов',
    );
    const typeCatalogues = read('lib/type-catalogues.ts');
    assert.ok(
      /let typeCataloguesReload: Promise<void> \| null = null;/.test(typeCatalogues),
      'перезапрос каталогов делится между параллельными потребителями',
    );
    // Вкладки «Свойства» у редактора связи нет — общий путь инвалидации
    // остаётся общим, без добавления связи несуществующей вкладки.
    assert.ok(
      /const TABS_LINK: EditorTabDef\[\] = \[\s*\{ id: 'main'/.test(editor),
      'набор вкладок связи не менялся',
    );
  });
});
