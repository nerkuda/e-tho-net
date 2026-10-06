/**
 * Тесты общеклиентского диспетчера контекстов сочетаний клавиш
 * (`lib/keymap.ts`, ADR `b420b08c`, задача e7bf87e3, ТП1).
 *
 * Проверяются контракты модуля:
 *  - реестр контекстов и стек активных контекстов: «текущий элемент» = вершина,
 *    диалог поверх поля перехватывает сочетания, поле внутри диалога несёт свои
 *    сочетания, а не сочетания диалога-хозяина;
 *  - независимость сопоставления от раскладки (`event.code`: `Digit8`, `KeyC` —
 *    ср. ошибка 98302e81);
 *  - разрешение пользовательских переопределений (в т.ч. снятие сочетания);
 *  - единственная точка перехвата `installKeymap` (уважает уже `preventDefault`);
 *  - таблица умолчаний команд комментария из реестра аудита `2ec4058b`.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  COMMENT_KEYMAP_DEFAULTS,
  GLOBAL_CONTEXT_ID,
  chordCandidates,
  currentKeyContext,
  defineKeyContext,
  dispatchKeyEvent,
  effectiveChord,
  eventChordCandidates,
  getKeymapOverrides,
  installKeymap,
  keyContextStack,
  keymapInternals,
  pushKeyContext,
  removeKeyContext,
  setKeymapOverrides,
  type KeyBindingDef,
} from '../src/renderer/lib/keymap.js';

/** Минимальное событие клавиатуры: `preventDefault` фиксируется флагом. */
interface FakeKeyEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  target: null;
  preventDefault(): void;
}

function keyEvent(init: Partial<FakeKeyEvent>): FakeKeyEvent {
  const event: FakeKeyEvent = {
    key: init.key ?? '',
    code: init.code ?? '',
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
    repeat: init.repeat ?? false,
    defaultPrevented: init.defaultPrevented ?? false,
    target: null,
    preventDefault(): void {
      event.defaultPrevented = true;
    },
  };
  return event;
}

/** Регистрирует контекст с одной командой и возвращает счётчик вызовов. */
function registerOne(id: string, command: string, chord: string): () => number {
  const calls = { count: 0 };
  const binding: KeyBindingDef = {
    command,
    chord,
    run: () => {
      calls.count += 1;
      return true;
    },
  };
  defineKeyContext({ id, bindings: [binding] });
  return () => calls.count;
}

beforeEach(() => {
  keymapInternals.reset();
});

describe('lib/keymap: нормализация сочетаний', () => {
  it('раскладывает модификаторы в фиксированном порядке', () => {
    assert.deepEqual(chordCandidates('Shift+Ctrl+8'), chordCandidates('Ctrl+Shift+8'));
    assert.ok(chordCandidates('Ctrl+Shift+8').includes('Ctrl+Shift+8'));
    assert.ok(chordCandidates('Ctrl+Shift+8').includes('Ctrl+Shift+Digit8'));
  });

  it('независимо от раскладки: Ctrl+Shift+8 совпадает с event.code Digit8', () => {
    // На русской раскладке Shift+8 даёт '*', но физическая клавиша Digit8.
    const event = keyEvent({ key: '*', code: 'Digit8', ctrlKey: true, shiftKey: true });
    const candidates = new Set(eventChordCandidates(event as unknown as KeyboardEvent));
    assert.ok(chordCandidates('Ctrl+Shift+8').some((c) => candidates.has(c)));
  });

  it('независимо от раскладки: Ctrl+C совпадает на кириллице (KeyC)', () => {
    const event = keyEvent({ key: 'с', code: 'KeyC', ctrlKey: true });
    const candidates = new Set(eventChordCandidates(event as unknown as KeyboardEvent));
    assert.ok(chordCandidates('Ctrl+C').some((c) => candidates.has(c)));
  });

  it('сочетание «Ctrl++» парсится, несмотря на клавишу «+»', () => {
    assert.ok(chordCandidates('Ctrl++').length > 0);
  });
});

describe('lib/keymap: стек контекстов', () => {
  it('вершина стека выигрывает у нижележащих', () => {
    const globalCalls = registerOne(GLOBAL_CONTEXT_ID, 'a', 'Ctrl+B');
    const fieldCalls = registerOne('comment-field', 'b', 'Ctrl+B');

    assert.equal(dispatchKeyEvent(keyEvent({ key: 'b', ctrlKey: true }) as unknown as KeyboardEvent), true);
    assert.equal(globalCalls(), 1, 'сочетание без активного контекста идёт в глобальный');
    assert.equal(fieldCalls(), 0);

    const pop = pushKeyContext('comment-field');
    assert.equal(currentKeyContext(), 'comment-field');
    dispatchKeyEvent(keyEvent({ key: 'b', ctrlKey: true }) as unknown as KeyboardEvent);
    assert.equal(fieldCalls(), 1, 'контекст поля перекрывает глобальный');
    assert.equal(globalCalls(), 1);

    pop();
    assert.equal(currentKeyContext(), null);
  });

  it('диалог поверх поля перехватывает сочетания', () => {
    registerOne('comment-field', 'field.action', 'Ctrl+B');
    const dialogCalls = registerOne('dialog', 'dialog.action', 'Ctrl+B');

    pushKeyContext('comment-field');
    pushKeyContext('dialog');
    assert.deepEqual(keyContextStack(), ['comment-field', 'dialog']);
    assert.equal(currentKeyContext(), 'dialog');

    dispatchKeyEvent(keyEvent({ key: 'b', ctrlKey: true }) as unknown as KeyboardEvent);
    assert.equal(dialogCalls(), 1, 'сочетание исполняет диалог, а не поле под ним');
  });

  it('поле внутри диалога несёт свои сочетания, а не сочетания хозяина', () => {
    const dialogCalls = registerOne('dialog', 'dialog.action', 'Ctrl+B');
    const fieldCalls = registerOne('comment-field', 'field.action', 'Ctrl+B');

    // Диалог открыт, затем фокус ушёл в его вложенное поле комментария —
    // поле на вершине и перекрывает диалог-хозяина.
    pushKeyContext('dialog');
    pushKeyContext('comment-field');

    dispatchKeyEvent(keyEvent({ key: 'b', ctrlKey: true }) as unknown as KeyboardEvent);
    assert.equal(fieldCalls(), 1, 'вложенное поле поля выигрывает у диалога');
    assert.equal(dialogCalls(), 0);

    // Фокус вернулся диалогу — снова его сочетание.
    removeKeyContext('comment-field');
    dispatchKeyEvent(keyEvent({ key: 'b', ctrlKey: true }) as unknown as KeyboardEvent);
    assert.equal(dialogCalls(), 1);
  });

  it('обработчик, вернувший false, уступает нижележащему контексту', () => {
    const globalCalls = registerOne(GLOBAL_CONTEXT_ID, 'a', 'Ctrl+B');
    defineKeyContext({
      id: 'field',
      bindings: [
        { command: 'decline', chord: 'Ctrl+B', run: () => false },
      ],
    });
    pushKeyContext('field');
    assert.equal(
      dispatchKeyEvent(keyEvent({ key: 'b', ctrlKey: true }) as unknown as KeyboardEvent),
      true,
    );
    assert.equal(globalCalls(), 1, 'отказ верхней привязки пропускает событие ниже');
  });

  it('неизвестное сочетание не обрабатывается', () => {
    registerOne(GLOBAL_CONTEXT_ID, 'a', 'Ctrl+B');
    assert.equal(
      dispatchKeyEvent(keyEvent({ key: 'z', ctrlKey: true }) as unknown as KeyboardEvent),
      false,
    );
  });

  it('pushKeyContext требует объявленный контекст', () => {
    assert.throws(() => pushKeyContext('nope'), /не объявлен/);
  });
});

describe('lib/keymap: preventDefault', () => {
  it('обработанное сочетание помечается preventDefault', () => {
    registerOne(GLOBAL_CONTEXT_ID, 'a', 'Ctrl+B');
    const event = keyEvent({ key: 'b', ctrlKey: true });
    dispatchKeyEvent(event as unknown as KeyboardEvent);
    assert.equal(event.defaultPrevented, true);
  });

  it('необработанное сочетание preventDefault не зовёт', () => {
    registerOne(GLOBAL_CONTEXT_ID, 'a', 'Ctrl+B');
    const event = keyEvent({ key: 'x', ctrlKey: true });
    dispatchKeyEvent(event as unknown as KeyboardEvent);
    assert.equal(event.defaultPrevented, false);
  });
});

describe('lib/keymap: пользовательские переопределения', () => {
  it('override заменяет сочетание команды', () => {
    registerOne(GLOBAL_CONTEXT_ID, 'comment.bold', 'Ctrl+B');
    setKeymapOverrides({ 'comment.bold': 'Ctrl+Shift+B' });

    assert.equal(effectiveChord('comment.bold'), 'Ctrl+Shift+B');
    assert.equal(
      dispatchKeyEvent(keyEvent({ key: 'b', ctrlKey: true }) as unknown as KeyboardEvent),
      false,
      'старое сочетание больше не срабатывает',
    );
    assert.equal(
      dispatchKeyEvent(
        keyEvent({ key: 'b', ctrlKey: true, shiftKey: true }) as unknown as KeyboardEvent,
      ),
      true,
      'новое сочетание срабатывает',
    );
  });

  it('override = null снимает сочетание с команды', () => {
    registerOne(GLOBAL_CONTEXT_ID, 'comment.bold', 'Ctrl+B');
    setKeymapOverrides({ 'comment.bold': null });
    assert.equal(effectiveChord('comment.bold'), null);
    assert.equal(
      dispatchKeyEvent(keyEvent({ key: 'b', ctrlKey: true }) as unknown as KeyboardEvent),
      false,
    );
    assert.deepEqual(getKeymapOverrides(), { 'comment.bold': null });
  });
});

describe('lib/keymap: единственная точка перехвата', () => {
  it('installKeymap ставит один слушатель и снимает его', () => {
    const listeners: Array<(event: unknown) => void> = [];
    const target = {
      addEventListener: (type: string, listener: (event: unknown) => void): void => {
        assert.equal(type, 'keydown');
        listeners.push(listener);
      },
      removeEventListener: (_type: string, listener: (event: unknown) => void): void => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    };
    registerOne(GLOBAL_CONTEXT_ID, 'a', 'Ctrl+B');
    const uninstall = installKeymap(target as unknown as EventTarget);
    assert.equal(listeners.length, 1);

    const event = keyEvent({ key: 'b', ctrlKey: true });
    listeners[0]?.(event);
    assert.equal(event.defaultPrevented, true);

    uninstall();
    assert.equal(listeners.length, 0);
  });

  it('уже preventDefault-нутое событие диспетчер не трогает', () => {
    let handled = 0;
    defineKeyContext({
      id: GLOBAL_CONTEXT_ID,
      bindings: [{ command: 'a', chord: 'Escape', run: () => { handled += 1; return true; } }],
    });
    const listeners: Array<(event: unknown) => void> = [];
    const target = {
      addEventListener: (_type: string, listener: (event: unknown) => void): void => {
        listeners.push(listener);
      },
      removeEventListener: (): void => undefined,
    };
    installKeymap(target as unknown as EventTarget);
    listeners[0]?.(keyEvent({ key: 'Escape', defaultPrevented: true }));
    assert.equal(handled, 0, 'съеденное capture-обработчиком нажатие не повторяется');
  });
});

describe('lib/keymap: умолчания команд комментария (реестр аудита 2ec4058b)', () => {
  it('итоговые умолчания зафиксированы', () => {
    assert.deepEqual(COMMENT_KEYMAP_DEFAULTS, {
      'comment.bold': 'Ctrl+B',
      'comment.italic': 'Ctrl+I',
      'comment.underline': 'Ctrl+U',
      'comment.strike': 'Ctrl+S',
      'comment.inlineCode': 'Ctrl+E',
      'comment.highlight': 'Ctrl+Shift+H',
      'comment.h1': 'Ctrl+Alt+1',
      'comment.h2': 'Ctrl+Alt+2',
      'comment.h3': 'Ctrl+Alt+3',
      'comment.bulletList': 'Ctrl+Shift+8',
      'comment.orderedList': 'Ctrl+Shift+7',
      'comment.taskList': 'Ctrl+Shift+9',
      'comment.blockquote': 'Ctrl+Shift+Q',
      'comment.codeBlock': 'Ctrl+Shift+K',
      'comment.moveLineUp': 'Alt+ArrowUp',
      'comment.moveLineDown': 'Alt+ArrowDown',
      'comment.indentList': 'Tab',
      'comment.outdentList': 'Shift+Tab',
      'comment.find': 'Ctrl+F',
      'comment.replace': 'Ctrl+H',
      'comment.findNext': 'F3',
      'comment.findPrevious': 'Shift+F3',
      'comment.globalSearch': 'Ctrl+Shift+F',
    });
  });

  it('все умолчания разбираются в непустые сочетания', () => {
    for (const [command, chord] of Object.entries(COMMENT_KEYMAP_DEFAULTS)) {
      assert.ok(chordCandidates(chord).length > 0, `сочетание команды ${command} разбирается`);
    }
  });
});
