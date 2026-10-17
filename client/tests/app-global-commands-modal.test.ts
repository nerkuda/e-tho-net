/**
 * Regression test for bug 82346a49 («Глобальные команды карты (Ctrl+C/Ctrl+V,
 * Ctrl+Shift+F) срабатывают при открытом модальном диалоге»).
 *
 * Глобальные привязки `app.copyThought` / `app.pasteThought` /
 * `app.focusMapSearch` (`app.ts:globalKeyBindings`) гейтились только
 * `isEditableTarget(event.target)` + состоянием экрана. Пока фокус в поле
 * диалога, `isEditableTarget` отдавал нажатие нативной обработке, но стоило
 * уйти Tab'ом на кнопку футера — защита исчезала, и:
 *  - Ctrl+C/Ctrl+V копировали/вставляли мысль ПОД полупрозрачной подложкой;
 *  - Ctrl+Shift+F переводил фокус в `.search-input` карты, ломая Tab-ловушку
 *    верхнего диалога.
 *
 * Контракт: пока открыт хотя бы один модальный диалог, команды уровня карты
 * молчат (`hasOpenDialog()` из `lib/dialog.ts` — тот же признак модальности,
 * что у команд масштаба, ошибка 1a3a476e). Нативные Ctrl+C/V внутри полей
 * диалога не подавляются: проверка `isEditableTarget` стоит раньше гейта.
 *
 * Тест гоняет РЕАЛЬНЫЙ диспетчер (`lib/keymap.ts`, ADR b420b08c) и реальные
 * привязки `appInternals.globalKeyBindings()`, открывает НАСТОЯЩИЙ диалог
 * через `showDialog` (общий стек `lib/dialog.ts`). Поэтому удаление
 * `hasOpenDialog()` из любого из трёх обработчиков делает соответствующий
 * assert красным — проверено мутациями.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Строка поиска карты: `focusMapSearch` ставит фокус именно в неё. */
let searchInput: ShimElement | null = null;

/** Минимальное событие клавиатуры (форма — как в `canvas-zoom-scope.test.ts`). */
interface FakeKeyEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
  preventDefault(): void;
}

function keyEvent(init: Partial<FakeKeyEvent>): KeyboardEvent {
  const event: FakeKeyEvent = {
    key: init.key ?? '',
    code: init.code ?? '',
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
    repeat: init.repeat ?? false,
    defaultPrevented: init.defaultPrevented ?? false,
    target: init.target ?? null,
    preventDefault(): void {
      event.defaultPrevented = true;
    },
  };
  return event as unknown as KeyboardEvent;
}

/** Полная форма `Thought` — снимок буфера читает каждое поле. */
function thought(id: string): any {
  return {
    id,
    title: `Мысль ${id}`,
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
  };
}

/**
 * Минимальные `document`/`window`/`navigator` шимы. Должны стоять ДО первого
 * динамического импорта: `lib/etn.ts` захватывает `window` при импорте, а
 * обработчики диалога и уведомлений читают `document` в момент вызова.
 *
 * `HTMLElement` — сам `ShimElement`: `isEditableTarget` проверяет
 * `target instanceof HTMLElement`, и без этого кейс «фокус в поле» был бы
 * ложно-зелёным (поле не распознавалось бы как редактируемое).
 */
function shimDom(): void {
  (globalThis as any).HTMLElement = ShimElement;
  searchInput = new ShimElement('INPUT', 'search-input');
  const doc: Record<string, unknown> = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: (selector: string) => (selector === '.search-input' ? searchInput : null),
    activeElement: null,
    // Ctrl+C сверяет видимое текстовое выделение (ошибка b6690109).
    getSelection: () => null,
  };
  (globalThis as any).document = doc;

  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  // Настоящий обработчик Ctrl+C после перехвата асинхронно строит снимок и
  // читает мысль через мост — без заглушки промис упал бы уже после assert'ов.
  win.etn = {
    thoughts: {
      get: async (_networkId: string, id: string) => thought(id),
      resolve: async (_networkId: string, ids: string[]) => ids.map((id) => thought(id)),
    },
    comments: { list: async () => [] },
    properties: { get: async () => [] },
    attachments: { list: async () => [] },
    links: { listByThought: async () => null },
    types: { listTypeProperties: async () => [] },
  };

  // Ctrl+V без внутреннего снимка читает системный буфер — пустая строка
  // завершает обработчик, не трогая сервер.
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { readText: async () => '' } },
    configurable: true,
    writable: true,
  });
}

/** Регистрирует глобальный контекст приложения (как `initKeyboard`) и отдаёт
 *  реальный диспетчер — команды проверяются через него, а не вызовом `run`. */
async function installAppKeymap() {
  const { keymapInternals, defineKeyContext, dispatchKeyEvent, GLOBAL_CONTEXT_ID } = await import(
    '../src/renderer/lib/keymap.js'
  );
  keymapInternals.reset();
  const { appInternals } = await import('../src/renderer/app.js');
  defineKeyContext({ id: GLOBAL_CONTEXT_ID, bindings: appInternals.globalKeyBindings() });
  const { store } = await import('../src/renderer/state.js');
  return { appInternals, store, dispatch: dispatchKeyEvent };
}

/** Базовое состояние: рабочий стол, карта, сеть выбрана, курсор и фокус на
 *  мысли — без гейта команды гарантированно перехватывают нажатие. */
function liveMapState(cursorId: string): Record<string, unknown> {
  return {
    screen: 'workspace',
    activeView: 'map',
    networkId: 'n1',
    pickerOpen: false,
    activeTabId: null,
    inaccessibleTabIds: new Set<string>(),
    selection: [],
    focus: { focused: thought(cursorId) },
  };
}

/**
 * Открывает НАСТОЯЩИЙ модальный диалог через каркас `lib/dialog.ts` отдаёт
 * функцию закрытия и кнопку футера, на которую каркас переводит фокус (в
 * диалоге нет текстовых полей). Возвращённую функцию тест обязан вызвать —
 * иначе стек останется непустым и сломает соседние проверки.
 */
async function openModalOnButton(): Promise<{ close: () => void; button: ShimElement }> {
  const { showDialog } = await import('../src/renderer/lib/dialog.js');
  const modalBody = new ShimElement('div', 'dialog-body');
  let okButton: ShimElement | null = null;
  const close = showDialog({
    title: 'Модальный диалог',
    body: modalBody as unknown as HTMLElement,
    buttons: [
      { label: 'OK', primary: true, ref: (button) => {
        okButton = button as unknown as ShimElement;
      } },
      { label: 'Отмена' },
    ],
  });
  assert.ok(okButton !== null, 'диалог построил кнопку «OK»');
  // Вешаем фокус диалога на кнопку: симптом воспроизводится именно при
  // фокусе НЕ в текстовом поле (Tab увёл с первого поля на кнопку футера).
  (okButton as any).focus();
  (globalThis as any).document.activeElement = okButton;
  return { close, button: okButton as unknown as ShimElement };
}

/** Ctrl+C / Ctrl+V / Ctrl+Shift+F — те самые глобальные команды карты. */
const COPY = { key: 'c', code: 'KeyC', ctrlKey: true } as const;
const PASTE = { key: 'v', code: 'KeyV', ctrlKey: true } as const;
const MAP_SEARCH = { key: 'f', code: 'KeyF', ctrlKey: true, shiftKey: true } as const;

describe('глобальные команды карты молчат под модальным диалогом (bug 82346a49)', () => {
  beforeEach(async () => {
    shimDom();
    await installAppKeymap();
  });

  it('фокус на кнопке диалога: Ctrl+C/Ctrl+V/Ctrl+Shift+F не перехвачены, после закрытия работают', async () => {
    const { store, dispatch } = await installAppKeymap();
    const { setCursor } = await import('../src/renderer/canvas/kbd-nav.js');
    store.update(liveMapState('cursor-1') as any);
    setCursor('cursor-1');
    try {
      // Живость состояния без диалога: Ctrl+Shift+F действительно перехватывается
      // и ставит фокус в строку поиска карты (иначе тест был бы вакуумным).
      assert.equal(dispatch(keyEvent(MAP_SEARCH)), true, 'без диалога поиск карты перехвачен');
      assert.equal(searchInput?.focused, true, 'без диалога фокус ушёл в .search-input');
      searchInput!.focused = false;

      const { close, button } = await openModalOnButton();
      try {
        assert.equal(button.focused, true, 'фокус диалога стоит на кнопке «OK»');

        // Симптом: под диалогом с фокусом на кнопке команды карты молчат.
        assert.equal(
          dispatch(keyEvent({ ...COPY, target: button as unknown as EventTarget })),
          false,
          'Ctrl+C под диалогом не перехватывается',
        );
        assert.equal(
          dispatch(keyEvent({ ...PASTE, target: button as unknown as EventTarget })),
          false,
          'Ctrl+V под диалогом не перехватывается',
        );
        assert.equal(
          dispatch(keyEvent({ ...MAP_SEARCH, target: button as unknown as EventTarget })),
          false,
          'Ctrl+Shift+F под диалогом не перехватывается',
        );
        assert.equal(
          searchInput?.focused,
          false,
          'фокус не ушёл в .search-input карты за подложкой',
        );
      } finally {
        close();
      }

      // После закрытия последнего диалога карта снова жива.
      assert.equal(dispatch(keyEvent(COPY)), true, 'после закрытия Ctrl+C перехвачен');
      assert.equal(dispatch(keyEvent(PASTE)), true, 'после закрытия Ctrl+V перехвачен');
      assert.equal(dispatch(keyEvent(MAP_SEARCH)), true, 'после закрытия Ctrl+Shift+F перехвачен');
      assert.equal(searchInput?.focused, true, 'после закрытия фокус снова в .search-input');
    } finally {
      setCursor(null);
      store.update({ selection: [], focus: null } as any);
    }
  });

  it('фокус в текстовом поле: Ctrl+C/Ctrl+V/Ctrl+Shift+F остаются нативными и до, и под диалогом', async () => {
    const { store, dispatch } = await installAppKeymap();
    const { setCursor } = await import('../src/renderer/canvas/kbd-nav.js');
    store.update(liveMapState('cursor-1') as any);
    setCursor('cursor-1');
    // Редактируемая поверхность: tagName обязан быть в верхнем регистре —
    // `isEditableTarget` сравнивает с 'INPUT'/'TEXTAREA' строго.
    const field = new ShimElement('INPUT') as unknown as EventTarget;
    try {
      for (const [name, chord] of [
        ['Ctrl+C', COPY],
        ['Ctrl+V', PASTE],
        ['Ctrl+Shift+F', MAP_SEARCH],
      ] as const) {
        const event = keyEvent({ ...chord, target: field });
        assert.equal(dispatch(event), false, `${name} в поле не перехватывается (до диалога)`);
        assert.equal(event.defaultPrevented, false, `${name} в поле не подавляется (до диалога)`);
      }

      const { close } = await openModalOnButton();
      try {
        for (const [name, chord] of [
          ['Ctrl+C', COPY],
          ['Ctrl+V', PASTE],
          ['Ctrl+Shift+F', MAP_SEARCH],
        ] as const) {
          const event = keyEvent({ ...chord, target: field });
          assert.equal(dispatch(event), false, `${name} в поле не перехватывается (диалог открыт)`);
          assert.equal(event.defaultPrevented, false, `${name} в поле не подавляется (диалог открыт)`);
        }
        assert.equal(searchInput?.focused, false, 'поиск карты под диалогом не получил фокус');
      } finally {
        close();
      }

      for (const [name, chord] of [
        ['Ctrl+C', COPY],
        ['Ctrl+V', PASTE],
        ['Ctrl+Shift+F', MAP_SEARCH],
      ] as const) {
        const event = keyEvent({ ...chord, target: field });
        assert.equal(dispatch(event), false, `${name} в поле не перехватывается (после диалога)`);
        assert.equal(event.defaultPrevented, false, `${name} в поле не подавляется (после диалога)`);
      }
    } finally {
      setCursor(null);
      store.update({ selection: [], focus: null } as any);
    }
  });
});
