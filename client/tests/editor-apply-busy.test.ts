/**
 * Блокировка кнопок на время применения (ошибка 8695a68c «У редактора типа нет
 * блокировки кнопок на время применения — двойной клик запускает два apply»).
 *
 * Контракт: пока черновик пишется на сервер, кнопки футера диалога отключены
 * (08-ui-spec.md — панель кнопок: на busy все disabled), а повторный клик не
 * запускает второй параллельный `apply` (для редактора типа это два PATCH с
 * одной версией — риск 409 и двойной записи; для редактора свойства — двойное
 * создание). После ответа сервера состояние восстанавливается: успех закрывает
 * диалог (режим «Применить и закрыть») или оставляет его открытым («Записать»),
 * ошибка — оставляет открытым с активными кнопками.
 *
 * Тест монтирует НАСТОЯЩИЕ `showThoughtTypeEditor` и `openPropertyManagerEditor`
 * под общим DOM-шимом (jsdom в проекте нет — приёмы `property-manager-transfer`
 * и `renderer-editor-mount`) и кликает кнопки поддельным `window.etn`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement as ShimEl } from './dom-shim.js';

// ---------------------------------------------------------------------------
// DOM-шим: хватает пути диалог-редактор → `showDialog` → клик по футеру
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
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.matchMedia = () => ({ matches: false, addEventListener: () => undefined });
  win.getComputedStyle = () => ({ getPropertyValue: () => '' });
  win.requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
  win.cancelAnimationFrame = (id: any) => clearTimeout(id);
  win.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  if ((globalThis as any).navigator === undefined) {
    (globalThis as any).navigator = { userAgent: 'node', language: 'ru' };
  }
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Чистое окружение теста: новый DOM-шим и пустой стек диалогов (иначе диалог
 * предыдущего сценария «поднимается» по ключу дедупликации и тест видит чужой
 * черновик).
 */
async function resetDialogs(): Promise<void> {
  shimDom();
  const { closeDialog } = await import('../src/renderer/lib/dialog.js');
  for (let i = 0; i < 20; i += 1) closeDialog();
}

function body(): ShimEl {
  return (globalThis as any).document.body as ShimEl;
}

/** Все подложки открытых диалогов (нижняя первая). */
function backdrops(): ShimEl[] {
  return body().children.filter((c) => c.classList.contains('dialog-backdrop'));
}

/** Верхний (текущий) диалог. */
function topDialog(): ShimEl {
  const dialogs = backdrops();
  assert.ok(dialogs.length > 0, 'диалог открыт');
  return dialogs[dialogs.length - 1]!;
}

/** Кнопка по подписи в диалоге. */
function button(root: ShimEl, label: string): ShimEl {
  const btn = root.findAll((n) => n.tagName === 'button' && n.textContent === label)[0];
  assert.ok(btn !== undefined, `кнопка «${label}» есть в диалоге`);
  return btn!;
}

/** Поле ввода с заданным значением (или текстовое поле-описание). */
function inputWithValue(root: ShimEl, value: string): ShimEl {
  const input = root.findAll((n) => n.tagName === 'input' && (n as any).value === value)[0];
  assert.ok(input !== undefined, `поле со значением «${value}» есть в диалоге`);
  return input!;
}

/** Промис, которым тест управляет ответом «сервера». */
function gate<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Редактор типа мысли
// ---------------------------------------------------------------------------

function thoughtType(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'tt-1',
    name: 'Тип',
    parent_id: 'tt-root',
    is_root: false,
    icon: null,
    icon_kind: 'emoji',
    icon_color: null,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    comment_template_md: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u-1',
    ...overrides,
  };
}

const ROOT_TYPE = thoughtType({ id: 'tt-root', name: 'основной', is_root: true, parent_id: null });

interface TypeEditorHarness {
  root: ShimEl;
  calls: { updates: number; creates: number };
}

/** Монтирует настоящий редактор существующего типа с поддельным `window.etn`. */
async function mountTypeEditor(update: () => Promise<any>): Promise<TypeEditorHarness> {
  const calls = { updates: 0, creates: 0 };
  const api: any = {
    types: {
      listThoughtTypes: async () => [ROOT_TYPE, thoughtType()],
      getThoughtType: async () => thoughtType(),
      updateThoughtType: async () => {
        calls.updates += 1;
        return update();
      },
      createThoughtType: async () => {
        calls.creates += 1;
        return thoughtType();
      },
      listTypeProperties: async () => [],
      listThoughtTypeProperties: async () => [],
    },
    ui: { getState: async () => null, setState: async () => undefined },
    viewRegistry: { list: async () => [] },
    thoughtTypeViews: { list: async () => [] },
    propertyRegistry: { list: async () => [] },
    locks: {
      acquire: async () => ({
        id: 'lock-1',
        entity_type: 'thought_type',
        entity_id: 'tt-1',
        user_id: 'me',
        client_id: 'c',
        acquired_at_ms: 0,
      }),
      release: async () => undefined,
    },
  };
  (globalThis as any).window.etn = api;

  const { store } = await import('../src/renderer/state.js');
  (store.state as any).networkId = 'n1';
  (store.state as any).me = null;
  (store.state as any).network = { id: 'n1' };
  (store.state as any).thoughtTypes = [ROOT_TYPE, thoughtType()];

  const { showThoughtTypeEditor } = await import('../src/renderer/screens/type-manager.js');
  void showThoughtTypeEditor(thoughtType(), () => undefined);
  await tick(60);
  return { root: topDialog(), calls };
}

/** Правка имени в шапке редактора типа: черновик становится «грязным». */
function renameType(root: ShimEl, next: string): void {
  const input = inputWithValue(root, 'Тип');
  (input as any).value = next;
  input.fire('input', {});
}

describe('редактор типа: busy на время записи (8695a68c)', () => {
  it('двойной клик по «Применить и закрыть» даёт одну запись, кнопки гаснут до ответа', async () => {
    await resetDialogs();
    const server = gate<any>();
    const { root, calls } = await mountTypeEditor(() => server.promise);
    renameType(root, 'Тип переименованный');

    const applyClose = button(root, 'Применить и закрыть');
    applyClose.fire('click', {});
    // Второй клик «второй половиной» двойного клика: идёт та же запись.
    applyClose.fire('click', {});
    await tick(30);

    assert.equal(calls.updates, 1, 'второй клик не запустил второй PATCH');
    assert.equal(applyClose.disabled, true, '«Применить и закрыть» отключена на время записи');
    assert.equal(button(root, 'Применить').disabled, true, '«Применить» отключена на время записи');
    assert.equal(button(root, 'Отмена').disabled, true, '«Отмена» отключена на время записи');
    assert.equal(backdrops().length, 1, 'диалог ещё открыт: ответа сервера нет');

    server.resolve(thoughtType({ name: 'Тип переименованный', version: 2 }));
    await tick(80);

    assert.equal(backdrops().length, 0, 'успех «Применить и закрыть» закрывает диалог');
  });

  it('«Записать» после успеха возвращает кнопки, диалог остаётся открытым', async () => {
    await resetDialogs();
    const server = gate<any>();
    const { root, calls } = await mountTypeEditor(() => server.promise);
    renameType(root, 'Тип переименованный');

    const save = button(root, 'Применить');
    save.fire('click', {});
    save.fire('click', {});
    await tick(30);

    assert.equal(calls.updates, 1, 'второй клик не запустил второй PATCH');
    assert.equal(save.disabled, true, '«Применить» отключена на время записи');

    server.resolve(thoughtType({ name: 'Тип переименованный', version: 2 }));
    await tick(120);

    assert.equal(backdrops().length, 1, '«Записать» не закрывает диалог');
    assert.equal(save.disabled, false, 'после записи кнопка снова активна');
    assert.equal(button(root, 'Применить и закрыть').disabled, false, 'вторая кнопка записи тоже');
    assert.equal(button(root, 'Отмена').disabled, false, '«Отмена» снова активна');
  });

  it('ошибка записи: кнопки снова активны, диалог открыт, текст ошибки в футере', async () => {
    await resetDialogs();
    const server = gate<any>();
    const { root, calls } = await mountTypeEditor(() => server.promise);
    renameType(root, 'Тип переименованный');

    const applyClose = button(root, 'Применить и закрыть');
    applyClose.fire('click', {});
    await tick(30);
    assert.equal(applyClose.disabled, true, 'во время записи кнопка отключена');

    server.reject(new Error('сервер отказал'));
    await tick(80);

    assert.equal(calls.updates, 1, 'запись была одна');
    assert.equal(backdrops().length, 1, 'ошибка не закрывает диалог');
    assert.equal(applyClose.disabled, false, 'после ошибки запись можно повторить');
    assert.equal(button(root, 'Применить').disabled, false, 'кнопка «Применить» снова активна');
    assert.equal(button(root, 'Отмена').disabled, false, '«Отмена» снова активна');
    assert.ok(topDialog().flatText().includes('сервер отказал'), 'текст ошибки виден в диалоге');
  });
});

// ---------------------------------------------------------------------------
// Редактор свойства (справочник свойств сети)
// ---------------------------------------------------------------------------

const PROPERTY_ID = 'prop-1';

/** Скалярное свойство справочника: PATCH без привязок и типа связи. */
function scalarProperty(overrides: Record<string, unknown> = {}): any {
  return {
    id: PROPERTY_ID,
    name: 'заметка',
    value_type: 'text',
    config: null,
    description: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    types_count: 0,
    values_count: 0,
    ...overrides,
  };
}

interface PropertyEditorHarness {
  root: ShimEl;
  calls: { updates: number; creates: number };
}

/** Монтирует настоящий редактор свойства с поддельным `window.etn`. */
async function mountPropertyEditor(update: () => Promise<any>): Promise<PropertyEditorHarness> {
  const calls = { updates: 0, creates: 0 };
  const api: any = {
    types: {
      listThoughtTypes: async () => [ROOT_TYPE],
      listTypeProperties: async () => [],
      listThoughtTypeProperties: async () => [],
      setPropertyDefaultOverride: async () => undefined,
      reorderTypeProperties: async () => [],
      getLinkTypeCounts: async () => ({}),
    },
    propertyRegistry: {
      list: async () => [scalarProperty()],
      get: async () => scalarProperty(),
      update: async () => {
        calls.updates += 1;
        return update();
      },
      create: async () => {
        calls.creates += 1;
        return scalarProperty();
      },
      remove: async () => undefined,
      usage: async () => ({ bindings: [], values_count: 0 }),
    },
    ui: { getState: async () => null, setState: async () => undefined },
    thoughtTypeViews: { list: async () => [] },
    locks: {
      acquire: async () => ({
        id: 'lock-1',
        entity_type: 'thought_type',
        entity_id: 'tt-1',
        user_id: 'me',
        client_id: 'c',
        acquired_at_ms: 0,
      }),
      release: async () => undefined,
    },
    admin: { listUsers: async () => [] },
    object: { search: async () => [] },
    users: { list: async () => [] },
  };
  (globalThis as any).window.etn = api;

  const { store } = await import('../src/renderer/state.js');
  (store.state as any).networkId = 'n1';
  (store.state as any).me = null;
  (store.state as any).thoughtTypes = [ROOT_TYPE];
  (store.state as any).linkTypes = [{ id: 'lt-root', is_root: true, parent_id: null }];

  const { openPropertyManagerEditor } = await import('../src/renderer/screens/property-manager.js');
  openPropertyManagerEditor(scalarProperty(), () => undefined);
  await tick(80);
  return { root: topDialog(), calls };
}

describe('редактор свойства: busy на время записи (8695a68c)', () => {
  it('двойной клик по «Применить и закрыть» даёт один PATCH, кнопки гаснут до ответа', async () => {
    await resetDialogs();
    const server = gate<any>();
    const { root, calls } = await mountPropertyEditor(() => server.promise);

    // Описание — обычная текстовая область редактора свойства.
    const description = root.findAll((n) => n.tagName === 'textarea')[0];
    assert.ok(description !== undefined, 'поле описания есть в редакторе свойства');
    (description as any).value = 'новое описание';
    description!.fire('input', {});

    const applyClose = button(root, 'Применить и закрыть');
    applyClose.fire('click', {});
    applyClose.fire('click', {});
    await tick(40);

    assert.equal(calls.updates, 1, 'второй клик не запустил второй PATCH');
    assert.equal(applyClose.disabled, true, 'кнопка записи отключена на время записи');
    assert.equal(button(root, 'Отмена').disabled, true, '«Отмена» отключена на время записи');
    assert.equal(backdrops().length, 1, 'диалог ещё открыт: ответа сервера нет');

    server.resolve(scalarProperty({ description: 'новое описание' }));
    await tick(120);

    assert.equal(backdrops().length, 0, 'успех закрывает диалог');
  });
});
