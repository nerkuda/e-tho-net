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

// ---------------------------------------------------------------------------
// Минимальный DOM-шим (хватает пути openPropertyManagerEditor → showDialog)
// ---------------------------------------------------------------------------

type Handler = (event: any) => void;

class ShimEl {
  tagName: string;
  className = '';
  children: ShimEl[] = [];
  parent: ShimEl | null = null;
  textContent = '';
  innerHTML = '';
  value = '';
  type = '';
  checked = false;
  title = '';
  placeholder = '';
  rows = 0;
  maxLength = 0;
  colSpan = 0;
  disabled = false;
  hidden = false;
  isConnected = true;
  scrollTop = 0;
  options: ShimEl[] = [];
  autocomplete = '';
  private handlers = new Map<string, Handler[]>();
  readonly dataset: Record<string, string> = {};
  readonly style: any = { setProperty: () => undefined, removeProperty: () => undefined };
  readonly classList = {
    add: (...names: string[]): void => {
      const set = new Set((this.className || '').split(/\s+/).filter(Boolean));
      for (const n of names) for (const c of n.split(/\s+/).filter(Boolean)) set.add(c);
      this.className = [...set].join(' ');
    },
    remove: (...names: string[]): void => {
      const set = new Set((this.className || '').split(/\s+/).filter(Boolean));
      for (const n of names) set.delete(n);
      this.className = [...set].join(' ');
    },
    toggle: (n: string, force?: boolean): void => {
      if (force === true) this.classList.add(n);
      else if (force === false) this.classList.remove(n);
    },
    contains: (n: string): boolean => (this.className || '').split(/\s+/).includes(n),
  };

  constructor(tag: string, className?: string, text?: string) {
    this.tagName = tag;
    if (className !== undefined) this.className = className;
    if (text !== undefined) this.textContent = text;
  }
  append(...nodes: Array<ShimEl | string>): void {
    for (const node of nodes) {
      const el = typeof node === 'string' ? new ShimEl('#text', undefined, node) : node;
      el.parent = this;
      this.children.push(el);
    }
  }
  appendChild(n: ShimEl): ShimEl {
    this.append(n);
    return n;
  }
  prepend(...nodes: ShimEl[]): void {
    for (const n of nodes) n.parent = this;
    this.children.unshift(...nodes);
  }
  replaceChildren(...nodes: ShimEl[]): void {
    this.children = [];
    this.append(...nodes);
  }
  removeChild(n: ShimEl): void {
    this.children = this.children.filter((c) => c !== n);
  }
  remove(): void {
    if (this.parent !== null) this.parent.children = this.parent.children.filter((c) => c !== this);
    for (const hs of this.handlers.values()) for (const h of hs) h({});
    this.parent = null;
    this.isConnected = false;
  }
  addEventListener(type: string, fn: Handler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(fn);
    this.handlers.set(type, list);
  }
  removeEventListener(type: string, fn: Handler): void {
    this.handlers.set(
      type,
      (this.handlers.get(type) ?? []).filter((h) => h !== fn),
    );
  }
  /** Ручной «клик» по кнопке: вызывает записанные обработчики. */
  fire(type: string, event: any = {}): void {
    for (const h of this.handlers.get(type) ?? []) h(event);
  }
  closest(): ShimEl | null {
    return null;
  }
  querySelector(): ShimEl | null {
    return null;
  }
  querySelectorAll(): ShimEl[] {
    return [];
  }
  contains(node: any): boolean {
    return this === node || this.children.some((c) => c.contains(node));
  }
  setAttribute(): void {}
  focus(): void {}
  select(): void {}
  getBoundingClientRect(): any {
    return { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 };
  }
  findAll(pred: (el: ShimEl) => boolean): ShimEl[] {
    const out: ShimEl[] = [];
    const walk = (n: ShimEl): void => {
      for (const c of n.children) {
        if (pred(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

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

function makeApi(opts: { removeFails?: boolean } = {}): { api: any; calls: StubCalls } {
  const calls: StubCalls = { creates: [], removes: [], updates: [] };
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

/** Монтирует редактор свойства под шимом и возвращает корень документа. */
async function mountEditor(api: any): Promise<ShimEl> {
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
  const rows = picker.findAll((r) => r.className.includes('entity-pick-row'));
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
