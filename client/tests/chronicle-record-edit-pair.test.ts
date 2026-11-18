/**
 * Пара «заголовок ↔ тело» единой правки дневниковой записи (0.16.1, блокер Б3 и
 * замечание З2 вердикта `84c71c37` по задаче `cfb8cb72`).
 *
 * **Что было не так.** «Открыть источник» строки задачи из панели «Дневника»
 * входил в правку тела (`editLine`), тело звало `onEditChange(true)`, заголовок
 * присоединялся к правке и тут же звал хозяина «войти в правку заголовка». Хозяин
 * асинхронно (после дочитывания тела) ставил фокус в `INPUT` заголовка уже ПОСЛЕ
 * фокуса строки задачи: каретка уезжала из `.cm-content`, а `scrollTop = 0`
 * перебивался прокруткой к фокусу.
 *
 * **Как проверяется.**
 *  1. Модель правила (`record-edit-pair.ts`): программно открытый заголовок не
 *     перебивает фокус тела, вход с заголовка открывает тело.
 *  2. DOM на настоящих компонентах: `createRecordTitle` + `createMarkdownField`
 *     входят в правку строки `lineNo` — каретка в `.cm-content` на этой строке, а
 *     не в `INPUT` заголовка; `Escape` закрывает правку и закрывает заголовок.
 *  3. Структура экрана (`chronicle.ts` под Node не поднимается): прокрутка ленты
 *     применяется ПОСЛЕ входа в правку, `editLine` возвращает промис, вход с
 *     заголовка идёт через правило пары.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { EditorView } from '@codemirror/view';

import * as keymap from '../src/renderer/lib/keymap.js';
import {
  recordEditPair,
  type RecordEditPairActions,
} from '../src/renderer/screens/chronicle/record-edit-pair.js';
import { ShimElement } from './dom-shim.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');
const CHRONICLE = readFileSync(resolve(RENDERER, 'screens', 'chronicle', 'chronicle.ts'), 'utf8');

/* ---------------------------------------------------------------- *
 * 1. Модель правила: кому принадлежит фокус
 * ---------------------------------------------------------------- */

describe('пара «заголовок ↔ тело»: правило фокуса (блокер 84c71c37)', () => {
  interface Journal {
    actions: RecordEditPairActions;
    calls: string[];
  }

  /** Действия экрана с журналом вызовов: важен и состав, и порядок. */
  function journal(state: { body: boolean; title: boolean }): Journal {
    const calls: string[] = [];
    return {
      calls,
      actions: {
        bodyEditing: () => state.body,
        titleEditing: () => state.title,
        openTitle: () => {
          calls.push('openTitle');
          state.title = true;
        },
        closeTitle: () => {
          calls.push('closeTitle');
          state.title = false;
        },
        enterBodyEdit: () => calls.push('enterBodyEdit'),
        focusFeedNavigation: () => calls.push('focusFeedNavigation'),
      },
    };
  }

  it('вход в ТЕЛО открывает заголовок без фокуса и без «войти в правку заголовка»', () => {
    const state = { body: false, title: false };
    const { actions, calls } = journal(state);
    state.body = true;
    recordEditPair.bodyChanged(actions, true);
    assert.deepEqual(calls, ['openTitle'], 'тело открыло заголовок БЕЗ входа в правку заголовка');
    assert.equal(state.title, true, 'заголовок в правке');
  });

  it('вход в ТЕЛО при уже открытом заголовке ничего не переключает', () => {
    const state = { body: false, title: true };
    const { actions, calls } = journal(state);
    state.body = true;
    recordEditPair.bodyChanged(actions, true);
    assert.deepEqual(calls, [], 'заголовок уже открыт — повторно не трогаем');
  });

  it('выход из правки тела закрывает заголовок и возвращает фокус в навигацию', () => {
    const state = { body: true, title: true };
    const { actions, calls } = journal(state);
    state.body = false;
    recordEditPair.bodyChanged(actions, false);
    assert.deepEqual(calls, ['closeTitle', 'focusFeedNavigation'], 'правка закрывается целиком');
  });

  it('тело УЖЕ в правке: «войти в правку заголовка» НЕ перебивает фокус', () => {
    // Ровно сценарий блокера: `beginEdit(false)` программно открытого заголовка
    // тоже зовёт `onBeginEdit`, но фокус принадлежит телу (или строке задачи).
    const state = { body: true, title: true };
    const { actions, calls } = journal(state);
    recordEditPair.titleBegan(actions);
    assert.deepEqual(calls, [], 'никаких входов: каретка остаётся там, куда вошёл пользователь');
  });

  it('вход начался с ЗАГОЛОВКА: тело открывается', () => {
    const state = { body: false, title: true };
    const { actions, calls } = journal(state);
    recordEditPair.titleBegan(actions);
    assert.deepEqual(calls, ['enterBodyEdit'], 'двойной клик по заголовку открывает и тело');
  });
});

/* ---------------------------------------------------------------- *
 * 2. DOM: каретка в теле на строке задачи, а не в заголовке
 * ---------------------------------------------------------------- */

/** Установить DOM-глобалы до импорта модулей рендерера (как в `task-row-editor`). */
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

/** Маркер задачи на третьей (с нуля — второй) строке тела записи. */
const MD = 'первая строка\nвторая строка\n- [ ] задача [[2026-11-18]]\nхвост';

/** Сценарий «Открыть источник» на настоящих компонентах записи. */
interface Scenario {
  /** Вход в правку на строке `lineNo` — то же, что делает `CardEditor.editLine`. */
  editLine(lineNo: number): void;
  /** Открыта ли правка тела с точки зрения экрана (`onEditChange`). */
  editing(): boolean;
  /** Сколько раз хозяин входил в правку заголовка (`enterBodyEdit`). */
  titleEntries(): number;
  /** Сколько раз фокус возвращался в навигацию ленты. */
  navFocus(): number;
  /** Поле ввода заголовка, если заголовок в правке. */
  titleInput(): ShimElement | null;
  /** Контентная область CM6 тела. */
  content(): ShimElement;
  dispose(): void;
}

/** Поднять пару «заголовок + тело» с правилом `recordEditPair` как в экране. */
async function openScenario(): Promise<Scenario> {
  const { createRecordTitle } = await import('../src/renderer/screens/chronicle/record-title.js');
  const { createMarkdownField, focusMarkdownFieldLineStart } =
    await import('../src/renderer/editor/markdown-field.js');

  let editing = false;
  let enteredFromTitle = 0;
  let navigationFocus = 0;
  let title: ReturnType<typeof createRecordTitle> | null = null;
  let root: HTMLElement | null = null;

  const actions: RecordEditPairActions = {
    bodyEditing: () => editing,
    titleEditing: () => title?.isEditing() === true,
    openTitle: () => title?.beginEdit(false),
    closeTitle: () => title?.endEdit(false, false),
    // Хозяин входит в правку с заголовка — в экране это `enterBodyEdit('title')`;
    // здесь достаточно счётчика: правило обязано НЕ звать его при входе в тело.
    enterBodyEdit: () => {
      enteredFromTitle += 1;
    },
    focusFeedNavigation: () => {
      navigationFocus += 1;
    },
  };

  title = createRecordTitle({
    value: 'Запись',
    label: 'Запись',
    editHint: 'Правка',
    placeholder: 'Заголовок',
    commitOnBlur: false,
    onBeginEdit: () => recordEditPair.titleBegan(actions),
  });

  root = createMarkdownField({
    md: MD,
    html: '',
    onEditChange: (isEdit) => {
      editing = isEdit;
      recordEditPair.bodyChanged(actions, isEdit);
    },
  });
  document.body.append(title.node(), root);

  const fieldRoot = root;
  return {
    editLine: (lineNo) => focusMarkdownFieldLineStart(fieldRoot, lineNo),
    editing: () => editing,
    titleEntries: () => enteredFromTitle,
    navFocus: () => navigationFocus,
    titleInput: () => {
      const node = title!.node() as unknown as ShimElement;
      return node.tagName === 'input' ? node : null;
    },
    content: () => {
      const content = fieldRoot.querySelector('.cm-content');
      assert.ok(content, 'поле CM6 смонтировано');
      return content as unknown as ShimElement;
    },
    dispose: () => {
      (title!.node() as unknown as HTMLElement).remove();
      (fieldRoot as unknown as HTMLElement).remove();
    },
  };
}

/** Escape по глобальному диспетчеру: верхний слой правки поля ловит его сам. */
function pressEscape(): void {
  keymap.dispatchKeyEvent({
    key: 'Escape',
    preventDefault: (): void => undefined,
    stopPropagation: (): void => undefined,
  } as unknown as KeyboardEvent);
}

before(async () => {
  shimDom();
  // Поле правки читает контекст открытой сети (как у комментария).
  const state = await import('../src/renderer/state.js');
  state.store.update({ networkId: 'n1', network: { first_day_of_week: 1 } } as any);
});

describe('«Открыть источник» строки задачи: каретка в теле, а не в заголовке (блокер 84c71c37)', () => {
  beforeEach(() => keymap.keymapInternals.reset());

  it('каретка в `.cm-content` на строке задачи (caretLine = line_no), заголовок без фокуса', async () => {
    const scenario = await openScenario();
    try {
      scenario.editLine(2);
      assert.equal(scenario.editing(), true, 'правка тела открыта');
      const input = scenario.titleInput();
      assert.ok(input, 'заголовок присоединился к правке (единая правка записи)');
      assert.equal(input.focused, false, 'фокус НЕ в INPUT заголовка');
      assert.equal(scenario.content().focused, true, 'каретка в поле тела');
      assert.equal(
        scenario.titleEntries(),
        0,
        'программно открытый заголовок не зовёт «войти в правку заголовка»',
      );

      const view = EditorView.findFromDOM(scenario.content() as unknown as HTMLElement);
      assert.ok(view, 'вид CM6 найден по DOM');
      const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
      assert.equal(line, 2, 'каретка в начале строки задачи (line_no = 2)');
      assert.equal(
        view.state.sliceDoc(view.state.selection.main.head, view.state.selection.main.head + 2),
        '- ',
        'каретка стоит в начале строки, перед маркером задачи',
      );
    } finally {
      scenario.dispose();
    }
  });

  it('Escape закрывает правку целиком: тело и заголовок, фокус — в навигацию ленты', async () => {
    const scenario = await openScenario();
    try {
      scenario.editLine(2);
      assert.equal(scenario.editing(), true, 'правка открыта');
      pressEscape();
      assert.equal(scenario.editing(), false, 'Escape закрыл правку тела');
      assert.equal(scenario.titleInput(), null, 'заголовок вернулся в просмотр вместе с телом');
      assert.equal(scenario.navFocus(), 1, 'фокус возвращён в навигацию ленты');
    } finally {
      scenario.dispose();
    }
  });

  after(() => keymap.keymapInternals.reset());
});

/* ---------------------------------------------------------------- *
 * 3. Структура экрана: порядок прокрутки и вход в правку
 * ---------------------------------------------------------------- */

describe('экран «Дневник»: порядок входа в правку строки источника (блокер 84c71c37)', () => {
  it('`editLine` возвращает промис входа в правку — есть что ждать перед прокруткой', () => {
    assert.match(
      CHRONICLE,
      /editLine: \(lineNo: number\) => enterBodyEditAtLine\(lineNo\)/,
      'промис `enterBodyEditAtLine` не теряется',
    );
    assert.match(CHRONICLE, /async function editRecordLine\(/, 'вход в правку ждётся');
    assert.match(
      CHRONICLE,
      /await cardEditors\.get\(card\)\?\.editLine\(lineNo\)/,
      'карточка awaited: правка уже открыта, каретка поставлена',
    );
  });

  it('прокрутка ленты в начало — ПОСЛЕ входа в правку (оба пути)', () => {
    const start = CHRONICLE.indexOf('export async function openChronicleTaskLine');
    assert.ok(start > 0, 'точка входа «Открыть источник» на месте');
    const body = CHRONICLE.slice(start, start + 2600);
    const firstEdit = body.indexOf('await editRecordLine(');
    const firstScroll = body.indexOf('feedWrap.scrollTop = 0');
    assert.ok(firstEdit > 0, 'вход в правку в теле функции');
    assert.ok(firstScroll > firstEdit, '`scrollTop` ставится после входа в правку');
    // Путь записи, отсутствовавшей в ленте (после `jumpToRecord`), — тот же порядок.
    const secondEdit = body.indexOf('await editRecordLine(', firstEdit + 1);
    const secondScroll = body.indexOf('feedWrap.scrollTop = 0', firstScroll + 1);
    assert.ok(secondEdit > firstEdit, 'второй путь: вход в правку');
    assert.ok(secondScroll > secondEdit, 'второй путь: прокрутка после входа');
  });

  it('вход с заголовка идёт через правило пары, а не напрямую в тело', () => {
    assert.match(
      CHRONICLE,
      /onBeginEdit: \(\) => recordEditPair\.titleBegan\(recordEditActions\)/,
      'заголовок спрашивает правило: тело уже в правке — фокус не перебиваем',
    );
    // `enterBodyEditAtLine` не трогает заголовок: каретка ставится только в тело.
    const start = CHRONICLE.indexOf('const enterBodyEditAtLine');
    assert.ok(start > 0, 'вход в правку строки на месте');
    const body = CHRONICLE.slice(start, start + 500);
    assert.doesNotMatch(body, /beginEdit/, 'заголовок не получает фокус при входе в строку');
  });
});
