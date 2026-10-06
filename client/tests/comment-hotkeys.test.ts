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
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
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
    defaultPrevented: false,
    target: null,
    preventDefault(): void {
      (this as { defaultPrevented: boolean }).defaultPrevented = true;
    },
    stopPropagation(): void {
      /* no-op */
    },
  } as unknown as KeyboardEvent;
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

  it('пользовательское переопределение отражается в строке диалога', () => {
    keymap.setKeymapOverrides({ 'comment.bold': 'Ctrl+Alt+B' });
    dialog.showCommentHotkeysDialog();

    const bold = listRows().find((row) => row.dataset['command'] === 'comment.bold');
    assert.ok(bold !== undefined);
    assert.equal(bold.querySelector('[data-chord]')?.textContent, 'Ctrl+Alt+B');
    assert.equal(bold.querySelector('[data-reset]')?.disabled, false);
  });
});
