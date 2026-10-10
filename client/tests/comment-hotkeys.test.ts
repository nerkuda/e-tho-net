/**
 * Юнит-тесты диалога настройки сочетаний клавиш комментария (0.12.1, задача
 * d534eb35, ТП1): `editor/comment-hotkeys-dialog.ts` + связка с диспетчером
 * `lib/keymap.ts` и слоем настроек `lib/user-settings.ts`.
 *
 * DOM-shimmed, как соседние тесты редактора. Проверяются контракты модуля:
 *  - регистрация команды открытия диалога в реестре команд поля;
 *  - список команд строится из единой таблицы умолчаний, подписи — из словаря,
 *    действующие сочетания учитывают пользовательские переопределения;
 *  - контроль конфликтов (занятое сочетание распознаётся, судья — другая команда);
 *  - помощники фильтрации и нормализации сочетаний;
 *  - нормализация сочетаний и разбор события клавиатуры в диспетчере.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Устанавливает шим DOM, достаточный для сборки диалога. */
function installShim(): void {
  const body = new ShimElement('body');
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    body,
    querySelector: () => null,
    activeElement: null,
  };
  // Свежий `window` на каждый тест: запоминаем слушатели, зарегистрированные
  // каркасом диалога и режимом записи сочетания, чтобы возить их в тестах.
  const win = ((globalThis as any).window = {}) as Record<string, unknown>;
  const listeners: Array<{ type: string; fn: (event: unknown) => void; capture: boolean }> = [];
  (win as any).__listeners = listeners;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = (type: string, fn: (event: unknown) => void, opts?: unknown) => {
    listeners.push({ type, fn, capture: opts === true });
  };
  win.removeEventListener = (type: string, fn: (event: unknown) => void) => {
    const index = listeners.findIndex((entry) => entry.type === type && entry.fn === fn);
    if (index >= 0) listeners.splice(index, 1);
  };
  win.innerWidth = 1024;
  win.innerHeight = 768;
}

type Dialog = typeof import('../src/renderer/editor/comment-hotkeys-dialog.js');
type Keymap = typeof import('../src/renderer/lib/keymap.js');
type Dialogs = typeof import('../src/renderer/lib/dialog.js');

let dialog: Dialog;
let keymap: Keymap;
let dialogs: Dialogs;

/** Минимальное событие клавиатуры (без DOM-зависимостей). */
function keyEvent(init: Record<string, unknown>): KeyboardEvent {
  return {
    key: init['key'] ?? '',
    code: init['code'] ?? '',
    ctrlKey: init['ctrlKey'] ?? false,
    altKey: init['altKey'] ?? false,
    shiftKey: init['shiftKey'] ?? false,
    metaKey: init['metaKey'] ?? false,
    repeat: init['repeat'] ?? false,
    defaultPrevented: init['defaultPrevented'] ?? false,
    target: null,
    preventDefault(): void {
      (this as { defaultPrevented: boolean }).defaultPrevented = true;
    },
    stopPropagation(): void {
      /* no-op */
    },
  } as unknown as KeyboardEvent;
}

/**
 * Проигрывает нажатие через ПОСЛЕДНИЙ capture-слушатель `keydown` на шиме
 * `window` — это слушатель режима записи сочетания (каркас диалога вешает свой
 * capture-`onKey` раньше, при `showDialog`). Изолирует проверку защиты от уже
 * поглощённого нажатия от обработки Escape каркасом.
 */
function fireCaptureChordListener(event: KeyboardEvent): void {
  const listeners = ((globalThis as any).window.__listeners ?? []) as Array<{
    type: string;
    fn: (event: unknown) => void;
    capture: boolean;
  }>;
  const capture = listeners.filter((entry) => entry.type === 'keydown' && entry.capture);
  capture[capture.length - 1]?.fn(event);
}

/** Тело документа шима. */
function docBody(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Строки списка диалога (именно строки, не их контролы). */
function listRows(): ShimElement[] {
  return docBody().findAll((el) => el.classList.contains('comment-hotkeys-row'));
}

describe('диалог настройки сочетаний клавиш (editor/comment-hotkeys-dialog.ts)', () => {
  beforeEach(async () => {
    installShim();
    keymap = (await import('../src/renderer/lib/keymap.js')) as Keymap;
    keymap.keymapInternals.reset();
    dialogs = (await import('../src/renderer/lib/dialog.js')) as Dialogs;
    dialog = (await import('../src/renderer/editor/comment-hotkeys-dialog.js')) as Dialog;
  });

  afterEach(() => {
    dialogs.closeDialog();
    keymap.setKeymapOverrides({});
  });

  it('порядок команд совпадает с единой таблицей умолчаний keymap', () => {
    assert.deepEqual(
      [...dialog.commentHotkeyCommands()],
      Object.keys(keymap.COMMENT_KEYMAP_DEFAULTS),
    );
  });

  it('chordIn: действующее сочетание — переопределение, иначе умолчание', () => {
    assert.equal(dialog.chordIn({}, 'comment.bold'), 'Ctrl+B');
    assert.equal(dialog.chordIn({ 'comment.bold': 'Ctrl+Alt+B' }, 'comment.bold'), 'Ctrl+Alt+B');
    assert.equal(dialog.chordIn({}, 'comment.unknown'), null);
  });

  it('commentOverrides оставляет только команды комментария с непустым сочетанием', () => {
    assert.deepEqual(
      dialog.commentOverrides({
        'comment.bold': 'Ctrl+Alt+B',
        'comment.italic': null,
        'foreign.command': 'Ctrl+Q',
      }),
      { 'comment.bold': 'Ctrl+Alt+B' },
    );
  });

  it('конфликт: занятое сочетание указывает на команду-владельца', () => {
    // Ctrl+I по умолчанию принадлежит курсиву.
    assert.equal(dialog.chordOwner({}, 'Ctrl+I', 'comment.bold'), 'comment.italic');
    // Для самого владельца конфликта нет.
    assert.equal(dialog.chordOwner({}, 'Ctrl+I', 'comment.italic'), null);
    // Нормализация: строчные модификаторы тоже распознаются.
    assert.equal(dialog.chordOwner({}, 'ctrl+i', 'comment.bold'), 'comment.italic');

    const conflicts = dialog.commentChordConflicts({ 'comment.bold': 'Ctrl+I' });
    assert.equal(conflicts.get('comment.bold'), 'comment.italic');
    assert.equal(conflicts.get('comment.italic'), 'comment.bold');
  });

  it('без конфликтов карта конфликтов пуста', () => {
    assert.equal(dialog.commentChordConflicts({}).size, 0);
    assert.equal(dialog.commentChordConflicts({ 'comment.bold': 'Ctrl+Alt+B' }).size, 0);
  });

  it('диспетчер: нормализация сочетания и разбор события клавиатуры', () => {
    assert.equal(keymap.normalizeChord('ctrl+b'), 'Ctrl+B');
    assert.equal(keymap.normalizeChord('Alt+up'), 'Alt+ArrowUp');
    assert.equal(keymap.normalizeChord('Shift'), null, 'одни модификаторы — не сочетание');

    // Клавиша берётся по event.code: сочетание не зависит от раскладки.
    assert.equal(keymap.chordFromEvent(keyEvent({ code: 'KeyB', key: 'и', ctrlKey: true })), 'Ctrl+B');
    assert.equal(
      keymap.chordFromEvent(keyEvent({ code: 'Digit8', key: '*', ctrlKey: true, shiftKey: true })),
      'Ctrl+Shift+8',
    );
    assert.equal(keymap.chordFromEvent(keyEvent({ code: 'Tab', key: 'Tab' })), 'Tab');
    assert.equal(
      keymap.chordFromEvent(keyEvent({ code: 'ShiftLeft', key: 'Shift', shiftKey: true })),
      null,
      'нажат только модификатор — сочетание ещё не полно',
    );
  });

  it('команда открытия диалога регистрируется в реестре команд поля', async () => {
    const commands = (await import('../src/renderer/editor/comment-commands.js')) as typeof import('../src/renderer/editor/comment-commands.js');
    assert.equal(dialog.COMMENT_HOTKEYS_DIALOG_COMMAND, 'comment.hotkeysDialog');
    assert.equal(commands.hasCommentCommandRunner(dialog.COMMENT_HOTKEYS_DIALOG_COMMAND), false);
    dialog.registerCommentHotkeysDialog();
    assert.equal(commands.hasCommentCommandRunner(dialog.COMMENT_HOTKEYS_DIALOG_COMMAND), true);
  });

  it('открытие диалога строит список команд по умолчаниям', () => {
    dialog.showCommentHotkeysDialog();
    const rows = listRows();
    assert.equal(rows.length, dialog.commentHotkeyCommands().length);

    const bold = rows.find((row) => row.dataset['command'] === 'comment.bold');
    assert.ok(bold !== undefined, 'строка команды «Жирный» обязана быть в списке');
    const chordBtn = bold.querySelector('[data-chord]');
    assert.equal(chordBtn?.textContent, 'Ctrl+B');
    // Умолчание — не переопределение: кнопка сброса заблокирована.
    const resetBtn = bold.querySelector('[data-reset]');
    assert.equal(resetBtn?.disabled, true);
  });

  it('команды сворачивания/разворачивания есть в диалоге со своими умолчаниями (558cac34)', () => {
    dialog.showCommentHotkeysDialog();
    const rows = listRows();

    const fold = rows.find((row) => row.dataset['command'] === 'comment.fold');
    assert.ok(fold !== undefined, 'строка «Свернуть раздел под курсором» в списке');
    assert.equal(fold.querySelector('[data-chord]')?.textContent, 'Ctrl+ArrowUp');
    assert.equal(
      fold.querySelector('.comment-hotkeys-row__label')?.textContent,
      'Свернуть раздел под курсором',
    );

    const unfold = rows.find((row) => row.dataset['command'] === 'comment.unfold');
    assert.ok(unfold !== undefined, 'строка «Развернуть раздел под курсором» в списке');
    assert.equal(unfold.querySelector('[data-chord]')?.textContent, 'Ctrl+ArrowDown');
  });

  it('пользовательское переопределение отражается в строке диалога', () => {
    keymap.setKeymapOverrides({ 'comment.bold': 'Ctrl+Alt+B' });
    dialog.showCommentHotkeysDialog();

    const bold = listRows().find((row) => row.dataset['command'] === 'comment.bold');
    assert.ok(bold !== undefined);
    assert.equal(bold.querySelector('[data-chord]')?.textContent, 'Ctrl+Alt+B');
    assert.equal(bold.querySelector('[data-reset]')?.disabled, false);
  });

  it('клик по сочетанию включает режим записи, сброс возвращает умолчание', () => {
    keymap.setKeymapOverrides({ 'comment.bold': 'Ctrl+Alt+B' });
    dialog.showCommentHotkeysDialog();

    const boldRow = (): ShimElement => {
      const row = listRows().find((item) => item.dataset['command'] === 'comment.bold');
      assert.ok(row !== undefined);
      return row;
    };
    assert.equal(boldRow().querySelector('[data-chord]')?.textContent, 'Ctrl+Alt+B');

    // Режим записи: строка обязана перерисоваться (не остаться прежней).
    boldRow().querySelector('[data-chord]')?.click();
    assert.equal(boldRow().querySelector('[data-chord]')?.textContent, 'Нажмите сочетание…');
    assert.equal(boldRow().classList.contains('comment-hotkeys-row--recording'), true);

    // Сброс к умолчанию отражается тем же обновлением строк.
    boldRow().querySelector('[data-reset]')?.click();
    assert.equal(boldRow().querySelector('[data-chord]')?.textContent, 'Ctrl+B');
    assert.equal(boldRow().classList.contains('comment-hotkeys-row--recording'), false);
    assert.equal(boldRow().querySelector('[data-reset]')?.disabled, true);
  });

  it('конфликтующее сочетание помечается в строке', () => {
    // Ctrl+I по умолчанию принадлежит курсиву — назначаем его жирному.
    keymap.setKeymapOverrides({ 'comment.bold': 'Ctrl+I' });
    dialog.showCommentHotkeysDialog();

    const bold = listRows().find((row) => row.dataset['command'] === 'comment.bold');
    assert.ok(bold !== undefined);
    assert.equal(bold.classList.contains('comment-hotkeys-row--conflict'), true);
  });

  it('режим записи: поглощённое нажатие не захватывается, обычное назначается', () => {
    dialog.showCommentHotkeysDialog();
    const boldRow = (): ShimElement => {
      const row = listRows().find((item) => item.dataset['command'] === 'comment.bold');
      assert.ok(row !== undefined);
      return row;
    };
    boldRow().querySelector('[data-chord]')?.click();

    // Нажатие уже поглощено каркасом диалога (Escape → закрытие/подтверждение):
    // сочетанием оно не становится, режим записи продолжается.
    const swallowed = keyEvent({ key: 'Escape', code: 'Escape', defaultPrevented: true });
    fireCaptureChordListener(swallowed);
    assert.equal(boldRow().querySelector('[data-chord]')?.textContent, 'Нажмите сочетание…');

    // Обычное нажатие назначается команде.
    fireCaptureChordListener(keyEvent({ key: 'j', code: 'KeyJ', ctrlKey: true }));
    assert.equal(boldRow().querySelector('[data-chord]')?.textContent, 'Ctrl+J');
  });
});
