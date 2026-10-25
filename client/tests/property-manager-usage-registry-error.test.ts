/**
 * Менеджер свойств: клик по типу в таблице использования не молчит при отказе
 * чтения реестра (ошибка b55fedb6).
 *
 * Симптом: `openTypeEditorByUsage` читал реестр свойств без обработки отказа, а
 * обработчик клика не ожидал промис — при обрыве связи редактор не открывался,
 * сообщения не было, в консоли renderer оставался необработанный отказ.
 *
 * Регресс-тест монтирует НАСТОЯЩИЙ редактор свойства (`openPropertyManagerEditor`)
 * под минимальным DOM-шимом (приём `property-manager-transfer.test.ts`), кликает
 * по строке использования при отказном `propertyRegistry.list` и требует
 * видимый диалог ошибки (мутация «убрать try/catch обработчика» краснит тест
 * необработанным отказом).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement as ShimEl } from './dom-shim.js';

const NETWORK_ID = 'n1';
const PROPERTY_ID = 'prop-1';
const LINK_TYPE_ID = 'lt-1';
const TYPE_SOURCE = 'tt-source';
const TYPE_TARGET = 'tt-target';

/** Сколько раз редактор прочитал реестр свойств (1 — открытие, 2 — клик). */
let listCalls = 0;
/** Состояние связи: после открытия редактора реестр «обрывается». */
let listFails = false;

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
  (globalThis as any).HTMLElement = ShimEl;
  (globalThis as any).document = doc;
  const win: any = ((globalThis as any).window ??= {});
  win.document = doc;
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

/** Плоское свойство-связь — как отдаёт сервер (со счётчиками). */
function propertyRow(): Record<string, unknown> {
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

function makeApi(): any {
  const api: any = {
    propertyRegistry: {
      list: async () => {
        listCalls += 1;
        if (listFails) throw new Error('сеть недоступна');
        return [propertyRow()];
      },
      get: async () => propertyRow(),
      create: async () => propertyRow(),
      update: async () => propertyRow(),
      remove: async () => undefined,
      // Строка использования: тип связи, к которому подключено свойство.
      usage: async () => ({
        bindings: [
          {
            owner_type: 'link_type',
            owner_id: LINK_TYPE_ID,
            owner_name: 'категория софта',
            values_in_type_count: 1,
          },
        ],
        values_in_type_count: 1,
        values_outside_type_count: 0,
      }),
    },
    types: {
      listTypeProperties: async () => [],
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
  return api;
}

const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

function bodyEl(): ShimEl {
  return (globalThis as any).document.body as ShimEl;
}

function textOf(node: ShimEl): string {
  let out = node.textContent;
  for (const child of node.children) out += textOf(child);
  return out;
}

/** Монтирует редактор свойства и дожидается загрузки строк использования. */
async function mountEditor(): Promise<ShimEl> {
  shimDom();
  listCalls = 0;
  listFails = false;
  const api = makeApi();
  (globalThis as any).etn = api;
  (globalThis as any).window.etn = api;

  const { store } = await import('../src/renderer/state.js');
  (store.state as any).networkId = NETWORK_ID;
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

  const { openPropertyManagerEditor } = await import(
    '../src/renderer/screens/property-manager.js'
  );
  openPropertyManagerEditor(propertyRow() as any, () => undefined, undefined, {
    // Явный «новый» ключ не нужен: редактор открывается по id свойства.
  });
  await tick(80);
  return bodyEl();
}

describe('менеджер свойств: отказ реестра при клике в таблице использования (b55fedb6)', () => {
  it('клик по типу связи даёт диалог ошибки, а не необработанный отказ', async () => {
    const body = await mountEditor();
    assert.equal(listCalls, 1, 'открытие редактора прочитало реестр');

    // Строка использования кликабельна: кнопка «категория софта» в таблице.
    // «Метаданные» свёрнуты по умолчанию (ленивое тело) — раскрываем группу,
    // чтобы таблица использования попала в DOM.
    const metaHeader = body
      .findAll((n) => n.className.includes('collapsible-summary'))
      .find((n) => textOf(n).includes('Метаданные'));
    assert.ok(metaHeader !== undefined, 'группа «Метаданные» есть в редакторе');
    metaHeader.click();
    await tick(20);

    const usageButton = body
      .findAll((n) => n.tagName === 'button' && n.className.includes('link-btn'))
      .find((n) => n.textContent === 'категория софта');
    assert.ok(usageButton !== undefined, 'строка использования построена');

    // Обрыв связи: чтение реестра при клике отказывает.
    listFails = true;
    usageButton.click();
    await tick(80);

    const dialogs = body.children.filter((child) => child.classList.contains('dialog-backdrop'));
    const last = dialogs[dialogs.length - 1];
    assert.ok(last !== undefined, 'отказ не проглочен — показан диалог ошибки');
    const text = textOf(last!);
    assert.ok(text.includes('Открыть тип'), `заголовок диалога: ${text}`);
    assert.ok(text.includes('сеть недоступна'), `причина отказа видна: ${text}`);
  });
});
