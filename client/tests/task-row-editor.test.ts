/**
 * Точечная правка строки задачи **компонентой редактирования комментария**
 * (0.16.1, задача `cfb8cb72`, пункт 1 ТЗ живой приёмки).
 *
 * Проверяется ПОВЕДЕНИЕ ПОЛЯ на настоящем CodeMirror 6 (не подделка): панель
 * получает поле фабрикой, поэтому клавиатурный контракт строки обязан быть
 * проверен здесь, а не через заглушку списка.
 *  • `Ctrl+Enter`/`Cmd+Enter` — ЕДИНОЕ сохранение (и однострочной, и
 *    многострочной строки): жест гасится в capture-фазе на корне поля, текст
 *    берётся у поля, отказ экрана оставляет правку открытой;
 *  • `Enter` — перевод строки/продолжение списка, а не сохранение;
 *  • `Tab`/`Shift+Tab` — отступ/сдвиг строки (подзадача/повышение), правка НЕ
 *    завершается;
 *  • `Ctrl+Enter` без изменений закрывает правку без записи.
 *
 * DOM — общий шим `./dom-shim.js` плюс глобалы, которые CodeMirror 6 читает сам
 * (`MutationObserver`, `localStorage`, `defaultView`, `document.head`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { EditorView, runScopeHandlers } from '@codemirror/view';

import { ShimElement } from './dom-shim.js';

/** Дождаться промисов сохранения (микрозадачи + запись). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Установить DOM-глобалы до импорта модулей рендерера. */
function shimDom(): void {
  const body = new ShimElement('body');
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px' });
  const doc: Record<string, any> = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    documentElement: new ShimElement('html'),
    head: new ShimElement('head'),
    body,
    adoptedStyleSheets: [],
    activeElement: null,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    dispatchEvent: (): boolean => true,
    querySelector: (): null => null,
    getSelection: () => null,
    hasFocus: () => false,
    createRange: () => ({
      setStart: (): void => undefined,
      setEnd: (): void => undefined,
      getClientRects: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    }),
  };
  (globalThis as any).document = doc;
  (ShimElement.prototype as any).ownerDocument = doc;
  (ShimElement.prototype as any).getSelection = () => null;
  (globalThis as any).MutationObserver = class {
    observe(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
    takeRecords(): unknown[] {
      return [];
    }
  };
  const ls = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => ls.get(key) ?? null,
    setItem: (key: string, value: string) => void ls.set(key, value),
    removeItem: (key: string) => void ls.delete(key),
    clear: () => ls.clear(),
    key: (index: number) => [...ls.keys()][index] ?? null,
    get length() {
      return ls.size;
    },
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, any>;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = (): boolean => true;
  win.addEventListener = (): void => undefined;
  win.removeEventListener = (): void => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  });
  doc.defaultView = win;
  win.document = doc;
  win.getSelection = () => null;
  win.requestAnimationFrame = () => 1;
  win.cancelAnimationFrame = (): void => undefined;
}

/** Корень CM6 внутри поля правки. */
function viewOf(root: HTMLElement): EditorView {
  const content = root.querySelector<HTMLElement>('.cm-content');
  assert.ok(content, 'поле CM6 смонтировано');
  const view = EditorView.findFromDOM(content);
  assert.ok(view, 'вид CM6 найден по DOM');
  return view;
}

/** Заменить текст поля так же, как печатает пользователь (транзакцией CM6). */
function type(root: HTMLElement, text: string): void {
  const view = viewOf(root);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

/**
 * Нажатие клавиши по контракту поля: `runScopeHandlers` — публичная точка
 * разрешения keymap CM6 (`editor`-scope), без шума DOMObserver.
 */
function press(
  root: HTMLElement,
  key: string,
  keyCode: number,
  mods: Record<string, boolean> = {},
): boolean {
  const view = viewOf(root);
  return runScopeHandlers(
    view,
    {
      key,
      keyCode,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
      ...mods,
    } as unknown as KeyboardEvent,
    'editor',
  );
}

/** Ctrl/Cmd+Enter по КОРНЮ поля — capture-перехват компоненты правки. */
function pressCommit(root: HTMLElement, meta = false): { prevented: boolean; stopped: boolean } {
  const state = { prevented: false, stopped: false };
  (root as unknown as ShimElement).emit('keydown', {
    key: 'Enter',
    keyCode: 13,
    ctrlKey: !meta,
    metaKey: meta,
    preventDefault: (): void => {
      state.prevented = true;
    },
    stopPropagation: (): void => {
      state.stopped = true;
    },
  });
  return state;
}

const { createTaskRowEditor } = await import('../src/renderer/editor/task-row-editor.js');

/** Дескриптор поля правки с журналом сохранений и закрытий. */
interface Field {
  root: HTMLElement;
  saved: string[];
  closed: number;
  dispose(): void;
}

/** Открыть правку строки с заданным исходным markdown и исходом сохранения. */
function openField(md: string, saveResult = true): Field {
  const field: Field = {
    root: null as unknown as HTMLElement,
    saved: [],
    closed: 0,
    dispose: () => undefined,
  };
  const handle = createTaskRowEditor({
    md,
    className: 'ui-task-row-edit',
    ariaLabel: 'Правка строки задачи',
    save: async (next) => {
      field.saved.push(next);
      return saveResult;
    },
    closed: () => {
      field.closed += 1;
    },
  });
  field.root = handle.root;
  field.dispose = () => handle.dispose();
  return field;
}

before(async () => {
  shimDom();
  // Поле правки получает контекст комментария → требует открытую сеть.
  const state = await import('../src/renderer/state.js');
  state.store.update({ networkId: 'n1', network: { first_day_of_week: 1 } } as any);
});

describe('правка строки задачи компонентой комментария (пункт 1 ТЗ 2026-11-18)', () => {
  it('поле открывается сразу в правке и правит СЫРУЮ строку с маркером', () => {
    const field = openField('- [ ] задача');
    try {
      assert.ok(field.root.classList.contains('ui-task-row-md'), 'поле помечено компактным видом');
      assert.ok(field.root.classList.contains('ui-task-row-edit'), 'класс строки из фабрики');
      assert.equal(
        viewOf(field.root).state.doc.toString(),
        '- [ ] задача',
        'в поле — markdown строки как есть (маркер задачи на месте)',
      );
    } finally {
      field.dispose();
    }
  });

  it('Ctrl+Enter сохраняет текст поля и закрывает правку (capture до keymap CM6)', async () => {
    const field = openField('- [ ] задача');
    try {
      type(field.root, '- [ ] задача — сделано');
      const commit = pressCommit(field.root);
      assert.equal(commit.prevented, true, 'жест погашен до действия CM6 по умолчанию');
      assert.equal(commit.stopped, true, 'событие не всплывает до общего диспетчера клавиш');
      await flush();
      assert.deepEqual(field.saved, ['- [ ] задача — сделано'], 'сохранён текст ИЗ ПОЛЯ');
      assert.equal(field.closed, 1, 'успешное сохранение закрывает правку');
    } finally {
      field.dispose();
    }
  });

  it('Cmd+Enter на macOS — то же сохранение', async () => {
    const field = openField('- [ ] задача');
    try {
      type(field.root, '- [x] задача');
      pressCommit(field.root, true);
      await flush();
      assert.deepEqual(field.saved, ['- [x] задача'], 'Meta+Enter не хуже Ctrl+Enter');
      assert.equal(field.closed, 1, 'правка закрыта');
    } finally {
      field.dispose();
    }
  });

  it('многострочная строка сохраняется ЕДИНЫМ жестом (без отдельного «коммита»)', async () => {
    const field = openField('- [ ] задача');
    try {
      type(field.root, '- [ ] задача\n  - [ ] подзадача\nчто сделано');
      pressCommit(field.root);
      await flush();
      assert.deepEqual(
        field.saved,
        ['- [ ] задача\n  - [ ] подзадача\nчто сделано'],
        'в правке и сохранении — весь текст поля, включая дописанные строки',
      );
      assert.equal(field.closed, 1, 'правка закрыта');
    } finally {
      field.dispose();
    }
  });

  it('отказ экрана оставляет правку открытой (текст не теряется)', async () => {
    const field = openField('- [ ] задача', false);
    try {
      type(field.root, '- [ ] задача — правка отклонена');
      pressCommit(field.root);
      await flush();
      assert.equal(field.saved.length, 1, 'запись попытались выполнить');
      assert.equal(field.closed, 0, 'при отказе поле осталось в правке');
      assert.equal(
        viewOf(field.root).state.doc.toString(),
        '- [ ] задача — правка отклонена',
        'набранный текст остался в поле',
      );
    } finally {
      field.dispose();
    }
  });

  it('Ctrl+Enter без изменений закрывает правку, не трогая источник', async () => {
    const field = openField('- [ ] задача');
    try {
      pressCommit(field.root);
      await flush();
      assert.deepEqual(field.saved, [], 'нечего записывать — записи нет');
      assert.equal(field.closed, 1, 'правка закрыта');
    } finally {
      field.dispose();
    }
  });

  it('Enter — перевод строки, сохранение остаётся за Ctrl+Enter', async () => {
    const field = openField('- [ ] задача');
    try {
      const handled = press(field.root, 'Enter', 13);
      await flush();
      assert.deepEqual(field.saved, [], 'Enter не пишет источник');
      assert.equal(field.closed, 0, 'правка не завершается');
      assert.equal(handled, true, 'Enter обработан keymap поля (перевод строки)');
      assert.equal(
        viewOf(field.root).state.doc.lines,
        2,
        'Enter добавил строку — можно дописать «что сделано»',
      );
    } finally {
      field.dispose();
    }
  });

  it('Tab — отступ (подзадача), Shift+Tab — сдвиг влево; правка не завершается', async () => {
    const field = openField('- [ ] задача');
    try {
      assert.equal(press(field.root, 'Tab', 9), true, 'Tab обработан полем, а не ушёл в фокус');
      assert.equal(
        viewOf(field.root).state.doc.toString(),
        '  - [ ] задача',
        'Tab дал отступ вложенной строки',
      );
      press(field.root, 'Tab', 9);
      assert.equal(
        viewOf(field.root).state.doc.toString(),
        '    - [ ] задача',
        'второй Tab — ещё уровень',
      );
      assert.equal(
        press(field.root, 'Tab', 9, { shiftKey: true }),
        true,
        'Shift+Tab обработан полем',
      );
      assert.equal(
        viewOf(field.root).state.doc.toString(),
        '  - [ ] задача',
        'Shift+Tab сдвинул строку влево (повышение)',
      );
      assert.deepEqual(field.saved, [], 'ни один из жестов не пишет источник');
      assert.equal(field.closed, 0, 'правка открыта после отступов');
    } finally {
      field.dispose();
    }
  });
});
