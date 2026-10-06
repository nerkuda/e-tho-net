/**
 * Юнит-тесты регистрации тел команд поля комментария (0.12.1, задача
 * ab0c4470, ТП1): `editor/comment-format.ts`.
 *
 * DOM-shimmed, как соседний `comment-commands.test.ts`. Проверяются:
 *  - регистрация всех тел команд форматирования и копирования/вырезания/
 *    вставки (ошибка `80f978e5`) в реестре `registerCommentCommand`;
 *  - копировать/вырезать/вставить работают через текст CM6 (снимок/правку),
 *    а не DOM-выделение;
 *  - точечное Prec.high-перекрытие конфликтов CM6 (соответствие сочетаний).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function installShim(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    body: new ShimElement('body'),
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

type Commands = typeof import('../src/renderer/editor/comment-commands.js');
type Format = typeof import('../src/renderer/editor/comment-format.js');

let commands: Commands;
let format: Format;

/** Фейковый редактор: хранит снимок и собирает применённые правки. */
function fakeEditor(text: string, from: number, to: number = from) {
  const state = { text, from, to };
  const edits: any[] = [];
  return {
    snapshot: () => ({ ...state }),
    applyEdit: (edit: any) => {
      edits.push(edit);
    },
    edits,
  };
}

function host(editor: unknown): any {
  return { getEditor: () => editor, root: new ShimElement('div') };
}

const FORMAT_IDS = [
  'comment.bold',
  'comment.italic',
  'comment.highlight',
  'comment.strike',
  'comment.underline',
  'comment.inlineCode',
  'comment.h1',
  'comment.h2',
  'comment.h3',
  'comment.bulletList',
  'comment.orderedList',
  'comment.taskList',
  'comment.blockquote',
  'comment.codeBlock',
  'comment.table',
  'comment.hr',
  'comment.htmlComment',
  'comment.indentList',
  'comment.outdentList',
  'comment.moveLineUp',
  'comment.moveLineDown',
  'comment.copy',
  'comment.cut',
  'comment.paste',
];

describe('comment-format: регистрация тел команд', () => {
  beforeEach(async () => {
    installShim();
    commands = (await import('../src/renderer/editor/comment-commands.js')) as Commands;
    commands.commentCommandsInternals.reset();
    format = (await import('../src/renderer/editor/comment-format.js')) as Format;
    format.setCommentClipboardPort(null);
    format.installCommentFormatCommands();
  });

  it('регистрирует тела всех внутристрочных и блочных команд', () => {
    for (const id of FORMAT_IDS) {
      assert.equal(commands.hasCommentCommandRunner(id), true, `нет исполнителя команды ${id}`);
    }
  });

  it('команда форматирования применяет правку к снимку редактора', () => {
    const editor = fakeEditor('hello', 0, 5);
    assert.equal(commands.runCommentCommand('comment.bold', host(editor)), true);
    assert.equal(editor.edits.length, 1);
    assert.deepEqual(editor.edits[0].changes, [{ from: 0, to: 5, insert: '**hello**' }]);
  });

  it('состояние кнопки: активность и применимость', () => {
    const active = fakeEditor('**x**', 2, 3);
    assert.equal(commands.commentCommandState('comment.bold', active.snapshot()).active, true);

    const collapsed = fakeEditor('x', 0, 0);
    assert.equal(commands.commentCommandState('comment.copy', collapsed.snapshot()).disabled, true);
    assert.equal(commands.commentCommandState('comment.copy', fakeEditor('x', 0, 1).snapshot()).disabled, false);
    assert.equal(commands.commentCommandState('comment.moveLineUp', collapsed.snapshot()).disabled, true);
  });

  it('копировать кладёт markdown выделения в буфер (не DOM-строку)', () => {
    const written: string[] = [];
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(''),
      writeText: (text) => {
        written.push(text);
        return Promise.resolve();
      },
    });
    const editor = fakeEditor('# Заголовок', 2, 11);
    assert.equal(commands.runCommentCommand('comment.copy', host(editor)), true);
    assert.deepEqual(written, ['Заголовок']);
  });

  it('вырезать копирует и удаляет выделение', async () => {
    const written: string[] = [];
    format.setCommentClipboardPort({
      readText: () => Promise.resolve(''),
      writeText: (text) => {
        written.push(text);
        return Promise.resolve();
      },
    });
    const editor = fakeEditor('abc def', 4, 7);
    assert.equal(commands.runCommentCommand('comment.cut', host(editor)), true);
    await Promise.resolve();
    assert.deepEqual(written, ['def']);
    assert.deepEqual(editor.edits[0].changes, [{ from: 4, to: 7, insert: '' }]);
  });

  it('вставить вставляет текст буфера в позицию каретки', async () => {
    format.setCommentClipboardPort({
      readText: () => Promise.resolve('XY'),
      writeText: () => Promise.resolve(),
    });
    const editor = fakeEditor('ab', 1, 1);
    assert.equal(commands.runCommentCommand('comment.paste', host(editor)), true);
    await Promise.resolve();
    assert.deepEqual(editor.edits[0].changes, [{ from: 1, to: 1, insert: 'XY' }]);
    assert.deepEqual(editor.edits[0].selection, { anchor: 3, head: 3 });
  });

  it('пункты меню отражают применимость: копировать/вырезать недоступны без выделения', () => {
    const collapsed = commands.buildCommentMenuItems(host(fakeEditor('x', 0, 0)));
    const selected = commands.buildCommentMenuItems(host(fakeEditor('x', 0, 1)));
    const copyOf = (items: ReturnType<Commands['buildCommentMenuItems']>): boolean | undefined =>
      items.find((item) => item.label === 'Копировать')?.disabled;
    assert.equal(copyOf(collapsed), true);
    assert.equal(copyOf(selected), false);
  });

  it('сочетания конфликтов CM6 переводятся в нотацию keymap', () => {
    assert.deepEqual(format.chordToCm6Keys('Ctrl+I'), ['Ctrl-i', 'Mod-i']);
    assert.deepEqual(format.chordToCm6Keys('Ctrl+Shift+K'), ['Ctrl-Shift-k', 'Mod-Shift-k']);
    assert.deepEqual(format.chordToCm6Keys('Alt+ArrowUp'), ['Alt-ArrowUp']);
    assert.deepEqual(format.chordToCm6Keys('Tab'), ['Tab']);
    assert.deepEqual(format.chordToCm6Keys('Shift+Tab'), ['Shift-Tab']);
  });

  it('расширение перекрытия собирается без ошибок', () => {
    assert.notEqual(format.commentFieldKeymapExtension(), undefined);
  });
});
