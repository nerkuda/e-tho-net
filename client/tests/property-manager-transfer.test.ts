/**
 * Регрессионный тест ошибки c83f0215 — «"Применить и закрыть" редактора типа
 * молча ничего не делает при переносе типов между сторонами».
 *
 * Диагноз (2026-09-20): в редакторе свойства (`openPropertyManagerEditor`)
 * PATCH справочника возвращает САМО свойство, дополненное счётчиками
 * (`{ ...property, converted, dropped }`), а клиент читал `result.property`
 * (обёртки нет) — `current` терял `id`. Следующая запись привязок уходила с
 * `property_id: undefined` и падала `422 VALIDATION_ERROR` («нужны либо
 * property_id, либо key и value_type»). Ошибка записывалась в строку, которую
 * этот диалог НЕ выводил (осиротевший `errorLine`) → ни записи, ни ошибки, ни
 * закрытия. Перенос между сторонами — единственная операция, создающая строку
 * (`attach`), поэтому баг проявлялся именно на ней.
 *
 * Тест монтирует НАСТОЯЩИЙ `openPropertyManagerEditor` под минимальным
 * DOM-шимом (jsdom в проекте нет — приём `renderer-editor-mount.test.ts`) и
 * дергает кнопки кликом через поддельный `window.etn`. Покрытие:
 *
 * 1. Перенос строки на другую сторону: `createTypeProperty` уходит с
 *    НАСТОЯЩИМ `property_id` (ответ PATCH — плоский), диалог закрывается.
 * 2. Снятие строки (✕): уходит `removeTypeProperty` с id привязки — «убрать
 *    типы из одной стороны» больше не теряется.
 * 3. Ошибка записи видна в панели кнопок (`footerError`), диалог остаётся
 *    открытым — молчания быть не должно.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement as ShimEl } from './dom-shim.js';

// ---------------------------------------------------------------------------
// Минимальный DOM-шим (хватает пути openPropertyManagerEditor → showDialog)
// ---------------------------------------------------------------------------

function shimDom(): void {
  const doc: any = {
    createElement: (tag: string) => new ShimEl(tag),
    createElementNS: (_ns: string, tag: string) => new ShimEl(tag),
    body: new ShimEl('body'),
    documentElement: new ShimEl('html'),
    head: new ShimEl('head'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  (globalThis as any).document = doc;
  const win: any = ((globalThis as any).window ??= {});
  win.document = doc;
  // Таймеры окна: путь сохранения свойства-связи доводит локальную правку типа
  // связи до холста и панелей (`scheduleTypeRepaint` → `scheduleRefresh`/
  // `scheduleStructuresRefresh`) — им нужны `window.setTimeout`/`clearTimeout`.
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.matchMedia = () => ({ matches: false, addEventListener: () => undefined });
  win.getComputedStyle = () => ({ getPropertyValue: () => '' });
  if ((globalThis as any).navigator === undefined) {
    (globalThis as any).navigator = { userAgent: 'node' };
  }
}

// ---------------------------------------------------------------------------
// Фикстуры: свойство-связь, привязанное к двум типам (источник + назначение)
// ---------------------------------------------------------------------------

const PROPERTY_ID = 'prop-1';
const LINK_TYPE_ID = 'lt-1';
const TYPE_SOURCE = 'tt-source';
const TYPE_TARGET = 'tt-target';
/** Тип-потомок типа-источника: НАСЛЕДУЕТ его привязку (ошибка c59bbd64). */
const TYPE_DESCENDANT = 'tt-descendant';
const BINDING_SOURCE = 'bind-source';
const BINDING_TARGET = 'bind-target';

/** Плоский ответ PATCH справочника: свойство + счётчики (как отдаёт сервер). */
function flattenedUpdateResult(): Record<string, unknown> {
  return {
    id: PROPERTY_ID,
    name: 'категория софта',
    value_type: 'link',
    config: { direction: 'out', link_type_id: LINK_TYPE_ID },
    description: null,
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z',
    converted: 0,
    dropped: 0,
  };
}

interface StubCalls {
  creates: Array<{ ownerType: string; typeId: string; input: any }>;
  removes: Array<{ ownerType: string; typeId: string; bindingId: string }>;
  updates: Array<{ ownerType: string; typeId: string; bindingId: string }>;
}

function makeApi(opts: { removeFails?: boolean; inheritedDuplicate?: boolean } = {}): {
  api: any;
  calls: StubCalls;
} {
  const calls: StubCalls = { creates: [], removes: [], updates: [] };
  /** Живой сервер отвечает NOT_FOUND на повторный DELETE уже снятого id
   *  привязки (`property <id> not found`, ошибка c59bbd64). */
  const alreadyRemoved = new Set<string>();
  const api: any = {
    propertyRegistry: {
      list: async () => [],
      get: async () => flattenedUpdateResult(),
      create: async () => flattenedUpdateResult(),
      // ВАЖНО: ровно то, что отдаёт сервер — плоское свойство со счётчиками.
      update: async () => flattenedUpdateResult(),
      remove: async () => undefined,
      usage: async () => ({ bindings: [], values_count: 0 }),
    },
    types: {
      listTypeProperties: async (_n: string, _o: string, typeId: string) => {
        if (typeId === TYPE_SOURCE) {
          return [
            {
              id: BINDING_SOURCE,
              property_id: PROPERTY_ID,
              key: 'категория софта',
              value_type: 'link',
              config: { direction: 'out', link_type_id: LINK_TYPE_ID },
              required: true,
              side: 'source',
              description: null,
              inherited: false,
            },
          ];
        }
        if (typeId === TYPE_TARGET) {
          return [
            {
              id: BINDING_TARGET,
              property_id: PROPERTY_ID,
              key: 'софт',
              value_type: 'link',
              config: { direction: 'out', link_type_id: LINK_TYPE_ID },
              required: false,
              side: 'target',
              description: null,
              inherited: false,
            },
          ];
        }
        // Сервер отдаёт ЭФФЕКТИВНЫЙ список: потомок «получает» привязку
        // предка с тем же id, но с флагом `inherited: true`.
        if (opts.inheritedDuplicate === true && typeId === TYPE_DESCENDANT) {
          return [
            {
              id: BINDING_SOURCE,
              property_id: PROPERTY_ID,
              key: 'категория софта',
              value_type: 'link',
              config: { direction: 'out', link_type_id: LINK_TYPE_ID },
              required: true,
              side: 'source',
              description: null,
              inherited: true,
            },
          ];
        }
        return [];
      },
      createTypeProperty: async (_n: string, ownerType: string, typeId: string, input: any) => {
        calls.creates.push({ ownerType, typeId, input });
        return {
          id: 'bind-new',
          property_id: input?.property_id ?? '',
          key: 'k',
          value_type: 'link',
          config: { direction: 'out', link_type_id: LINK_TYPE_ID },
          description: null,
        };
      },
      updateTypeProperty: async (
        _n: string,
        ownerType: string,
        typeId: string,
        bindingId: string,
      ) => {
        calls.updates.push({ ownerType, typeId, bindingId });
        return {};
      },
      removeTypeProperty: async (
        _n: string,
        ownerType: string,
        typeId: string,
        bindingId: string,
      ) => {
        if (opts.removeFails === true) throw new Error('Свойство держат привязки');
        if (opts.inheritedDuplicate === true) {
          if (alreadyRemoved.has(bindingId)) {
            throw new Error(`property ${bindingId} not found`);
          }
          alreadyRemoved.add(bindingId);
        }
        calls.removes.push({ ownerType, typeId, bindingId });
      },
      setPropertyDefaultOverride: async () => undefined,
      reorderTypeProperties: async () => [],
      getLinkTypeCounts: async () => ({}),
    },
    locks: {
      acquire: async () => ({
        id: 'lock-1',
        entity_type: 'property',
        entity_id: PROPERTY_ID,
        user_id: 'me',
        client_id: 'c',
        acquired_at_ms: 0,
      }),
      release: async () => undefined,
    },
    admin: { listUsers: async () => [] },
    object: { search: async () => [] },
    users: { list: async () => [] },
    thoughtTypeViews: { list: async () => [] },
  };
  return { api, calls };
}

const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Монтирует редактор свойства под шимом и возвращает корень документа.
 *  `extraTypes` добавляет типы в каталог сети (например, потомка —
 *  наследование привязки, ошибка c59bbd64). */
async function mountEditor(
  api: any,
  extraTypes: Array<{ id: string; name: string }> = [],
): Promise<ShimEl> {
  (globalThis as any).etn = api;
  (globalThis as any).window.etn = api;

  const { store } = await import('../src/renderer/state.js');
  (store.state as any).networkId = 'n1';
  (store.state as any).me = null;
  (store.state as any).linkTypes = [
    { id: 'lt-root', is_root: true, parent_id: null, name_forward: 'связь', name_reverse: 'связь' },
    {
      id: LINK_TYPE_ID,
      is_root: false,
      parent_id: 'lt-root',
      name_forward: 'категория софта',
      name_reverse: 'софт',
    },
  ];
  (store.state as any).thoughtTypes = [
    { id: TYPE_SOURCE, name: 'категория софта', is_root: false, parent_id: 'lt-root' },
    { id: TYPE_TARGET, name: 'софт', is_root: false, parent_id: 'lt-root' },
    ...extraTypes.map((t) => ({ ...t, is_root: false, parent_id: TYPE_SOURCE })),
  ];

  const { openPropertyManagerEditor } = await import('../src/renderer/screens/property-manager.js');
  openPropertyManagerEditor(flattenedUpdateResult() as any, () => undefined);
  await tick(60);
  return (globalThis as any).document.body as ShimEl;
}

const buttons = (root: ShimEl, label: string): ShimEl[] =>
  root.findAll((n) => n.tagName === 'button' && n.textContent === label);

/**
 * Кнопки «✕» (снять привязку) в ЯЧЕЙКАХ строк таблиц: у «✕» внутри редактора
 * значения по умолчанию родитель — `div`, у строки — `td`.
 */
const rowCrosses = (root: ShimEl): ShimEl[] =>
  root.findAll(
    (n) => n.tagName === 'button' && n.textContent === '✕' && n.parent?.tagName === 'td',
  );

/** Добавляет тип на другую сторону через пикер «Добавить тип». */
async function addRowToOtherSide(root: ShimEl, tableIndex: number): Promise<void> {
  buttons(root, 'Добавить тип')[tableIndex]!.fire('click', {});
  await tick(60);
  const dialogs = root.children;
  const picker = dialogs[dialogs.length - 1] as ShimEl;
  const rows = picker.findAll((r) => r.className.includes('ui-tree-row'));
  // Тип, уже стоящий в этой таблице, приходит отмеченным — нам нужен первый
  // НЕотмеченный: только его переносим на эту сторону.
  const target = rows.find(
    (r) =>
      r.findAll((n) => n.tagName === 'input' && (n as any).type === 'checkbox')[0]?.checked ===
      false,
  );
  assert.ok(target !== undefined, 'в пикере нет неотмеченной строки типа');
  const checkbox = target.findAll(
    (n) => n.tagName === 'input' && (n as any).type === 'checkbox',
  )[0]!;
  (checkbox as any).checked = true;
  checkbox.fire('change', {});
  buttons(picker, 'Применить и закрыть')[0]!.fire('click', {});
  await tick(60);
}

describe('редактор свойства: перенос между сторонами (ошибка c83f0215)', () => {
  it('перенос строки на другую сторону: attach уходит с настоящим property_id', async () => {
    shimDom();
    const { api, calls } = makeApi();
    const root = await mountEditor(api);

    await addRowToOtherSide(root, 1); // «Типы назначений» ← тип-источник
    buttons(root, 'Применить и закрыть')[0]!.fire('click', {});
    await tick(60);

    assert.equal(calls.creates.length, 1, 'ожидается ровно одно создание привязки');
    const create = calls.creates[0]!;
    assert.equal(create.typeId, TYPE_SOURCE);
    assert.equal(
      create.input.property_id,
      PROPERTY_ID,
      'attach обязан нести property_id: без него сервер отвечает 422 и запись молча теряется',
    );
    assert.equal(create.input.side, 'target');
    assert.equal(
      buttonErrorText(root),
      null,
      'успешная запись не должна оставлять сообщение об ошибке',
    );
    assert.equal(root.children.length, 0, 'при успехе диалог закрывается');
  });

  it('снятие строки (✕) сохраняется: уходит removeTypeProperty с id привязки', async () => {
    shimDom();
    const { api, calls } = makeApi();
    const root = await mountEditor(api);

    rowCrosses(root)[0]!.fire('click', {});
    buttons(root, 'Применить и закрыть')[0]!.fire('click', {});
    await tick(60);

    assert.deepEqual(
      calls.removes,
      [{ ownerType: 'thought_type', typeId: TYPE_SOURCE, bindingId: BINDING_SOURCE }],
      'снятая строка обязана удаляться на сервере',
    );
    assert.equal(calls.creates.length, 0);
    assert.equal(root.children.length, 0, 'при успехе диалог закрывается');
  });

  /**
   * Ошибка c59bbd64: `listTypeProperties` — ЭФФЕКТИВНЫЙ список, поэтому
   * привязка предка приходит ещё раз у каждого типа-потомка (`inherited: true`)
   * с ТЕМ ЖЕ id. Редактор считал такие записи своими строками: снимок получал
   * дубли, и перенос стороны (пикер снимает весь набор строк стороны) слал
   * повторный `DELETE` того же id. Сервер отвечает `property <id> not found`,
   * и запись переноса падала.
   */
  it('наследованная привязка не дублирует строки: один DELETE на привязку (ошибка c59bbd64)', async () => {
    shimDom();
    const { api, calls } = makeApi({ inheritedDuplicate: true });
    const root = await mountEditor(api, [{ id: TYPE_DESCENDANT, name: 'софт-подтип' }]);

    // Перенос: пикер «Типы источников» снимает весь набор строк стороны
    // (replace-семантика a3828b28) — уходит ровно один DELETE привязки-предка.
    buttons(root, 'Добавить тип')[0]!.fire('click', {});
    await tick(60);
    const picker = root.children[root.children.length - 1]!;
    for (const row of picker.findAll((r) => r.className.includes('ui-tree-row'))) {
      const checkbox = row.findAll(
        (n) => n.tagName === 'input' && (n as any).type === 'checkbox',
      )[0];
      if (checkbox !== undefined && (checkbox as any).checked === true) {
        (checkbox as any).checked = false;
        checkbox.fire('change', {});
      }
    }
    buttons(picker, 'Применить и закрыть')[0]!.fire('click', {});
    await tick(60);

    buttons(root, 'Применить и закрыть')[0]!.fire('click', {});
    await tick(60);

    assert.deepEqual(
      calls.removes.filter((r) => r.bindingId === BINDING_SOURCE),
      [{ ownerType: 'thought_type', typeId: TYPE_SOURCE, bindingId: BINDING_SOURCE }],
      'привязка-предок снимается ровно одним DELETE (дубль унаследованной строки не должен порождать второй)',
    );
    assert.equal(
      buttonErrorText(root),
      null,
      'перенос обязан проходить без NOT_FOUND «property … not found»',
    );
    assert.equal(root.children.length, 0, 'при успехе диалог закрывается');
  });

  it('ошибка записи видна в панели кнопок и диалог не закрывается', async () => {
    shimDom();
    const { api } = makeApi({ removeFails: true });
    const root = await mountEditor(api);

    rowCrosses(root)[0]!.fire('click', {});
    buttons(root, 'Применить и закрыть')[0]!.fire('click', {});
    await tick(60);

    const footer = root.findAll((n) => n.className.includes('dialog-footer'))[0];
    assert.ok(footer !== undefined, 'у диалога есть панель кнопок');
    assert.equal(
      buttonErrorText(root),
      'Свойство держат привязки',
      'ошибка записи обязана быть видна в панели кнопок',
    );
    assert.ok(root.children.length > 0, 'при ошибке диалог остаётся открытым');
  });
});

/** Текст строки ошибки диалога (в футере), либо null. */
function buttonErrorText(root: ShimEl): string | null {
  const footer = root.findAll((n) => n.className.includes('dialog-footer'))[0];
  if (footer === undefined) return null;
  const err = footer.findAll((n) => n.className.includes('error-text'))[0];
  if (err === undefined || err.textContent === '') return null;
  return err.textContent;
}
