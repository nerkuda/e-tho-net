/**
 * Юнит-тесты команд поля комментария (0.12.1, задача 3d6f98cb, ТП1):
 * `editor/comment-commands.ts`. DOM-shimmed, как соседние lib-ui-тесты.
 *
 * Проверяются контракты модуля:
 *  - раскладка тулбара и контекстного меню по макету (порядок, подменю,
 *    подменю настроек только в тулбаре — элемент `1ab005ca`/`0562e0e3`);
 *  - реестр исполнителей как точка расширения (команды приходят задачами
 *    `ab0c4470`/ТП2/ТП3);
 *  - регистрация контекста сочетаний `comment-field` на диспетчере
 *    `lib/keymap.ts` (ADR `b420b08c`) и маршрутизация команды к активному полю.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Устанавливает шим DOM, достаточный для импорта `editor/comment-commands.ts`. */
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

type Module = typeof import('../src/renderer/editor/comment-commands.js');
type Keymap = typeof import('../src/renderer/lib/keymap.js');

let mod: Module;
let keymap: Keymap;

const fakeEditor = {
  insertAtCaret: () => undefined,
  snapshot: () => ({ text: '', from: 0, to: 0 }),
} as any;

function host(editor: unknown = fakeEditor): any {
  return { getEditor: () => editor, root: new ShimElement('div') };
}

/** Минимальное событие клавиатуры: `preventDefault` фиксируется флагом. */
function keyEvent(init: Record<string, unknown>): any {
  const event: any = {
    key: init['key'] ?? '',
    code: init['code'] ?? '',
    ctrlKey: init['ctrlKey'] ?? false,
    altKey: init['altKey'] ?? false,
    shiftKey: init['shiftKey'] ?? false,
    metaKey: init['metaKey'] ?? false,
    repeat: false,
    defaultPrevented: false,
    target: null,
    preventDefault(): void {
      event.defaultPrevented = true;
    },
  };
  return event;
}

function findByClass(root: ShimElement, className: string): ShimElement | undefined {
  if (root.className.split(' ').includes(className)) return root;
  for (const child of root.children) {
    const hit = findByClass(child, className);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

describe('команды поля комментария (editor/comment-commands.ts)', () => {
  beforeEach(async () => {
    installShim();
    keymap = (await import('../src/renderer/lib/keymap.js')) as Keymap;
    keymap.keymapInternals.reset();
    mod = (await import('../src/renderer/editor/comment-commands.js')) as Module;
    mod.commentCommandsInternals.reset();
  });

  it('тулбар собирается по макету: команды, подменю и настройки справа', () => {
    const hostForToolbar = host();
    const bar = mod.buildCommentToolbar(hostForToolbar) as unknown as ShimElement;

    assert.ok(bar.className.split(' ').includes(mod.COMMENT_TOOLBAR_CLASS));
    assert.equal(bar.getAttribute('role'), 'toolbar');

    for (const id of [
      'comment.bold',
      'comment.italic',
      'comment.highlight',
      'comment.bulletList',
      'comment.orderedList',
      'comment.taskList',
      'comment.indentList',
      'comment.outdentList',
    ]) {
      assert.ok(
        bar.querySelector(`[data-command="${id}"]`) !== null,
        `кнопка команды ${id} обязана быть в тулбаре`,
      );
    }

    // Два подменю «прочие» и подменю настроек.
    assert.ok(bar.querySelector('[data-submenu="comment.submenu.inline"]') !== null);
    assert.ok(bar.querySelector('[data-submenu="comment.submenu.block"]') !== null);
    assert.ok(bar.querySelector(`[data-submenu="${mod.SETTINGS_SUBMENU_ID}"]`) !== null);

    // Подменю настроек — на правом краю: перед ним распорка.
    assert.ok(findByClass(bar, 'md-field-toolbar__spacer') !== undefined);
    // 8 командных кнопок + 3 подменю + распорка.
    assert.equal(bar.children.length, 12);
  });

  it('подписи кнопок берутся из словаря и несут действующее сочетание', () => {
    const bar = mod.buildCommentToolbar(host()) as unknown as ShimElement;
    const bold = bar.querySelector('[data-command="comment.bold"]') as unknown as ShimElement;
    assert.equal(bold.title, 'Жирный (Ctrl+B)');

    // Пользовательское переопределение меняет подсказку (настройки применяются).
    keymap.setKeymapOverrides({ 'comment.bold': 'Ctrl+Alt+B' });
    const bar2 = mod.buildCommentToolbar(host()) as unknown as ShimElement;
    const bold2 = bar2.querySelector('[data-command="comment.bold"]') as unknown as ShimElement;
    assert.equal(bold2.title, 'Жирный (Ctrl+Alt+B)');
    keymap.setKeymapOverrides({});
  });

  it('контекстное меню повторяет тулбар без подменю настроек', () => {
    const items = mod.buildCommentMenuItems(host());
    const labels = items.map((item) => item.label);
    assert.ok(labels.includes('Жирный'));
    assert.ok(labels.includes('Копировать'));
    assert.ok(labels.includes('Поиск'));
    assert.ok(labels.includes('Разделение'));
    assert.ok(labels.includes('Отмена'));
    assert.ok(labels.includes('Сохранить'));

    const submenuIds = items
      .filter((item) => item.submenu !== undefined)
      .map((item) => item.label);
    assert.deepEqual(submenuIds, ['Прочие внутристрочные', 'Прочие блочные']);
    assert.equal(
      items.some((item) => item.label === 'Настройки поля'),
      false,
      'подменю настроек в контекстном меню отсутствует (элемент 0562e0e3)',
    );
  });

  it('реестр команд — точка расширения: без обработчика no-op, с ним исполняется', () => {
    const field = host();
    assert.equal(mod.runCommentCommand('comment.bold', field), false);
    assert.equal(mod.hasCommentCommandRunner('comment.bold'), false);

    let received: unknown = null;
    mod.registerCommentCommand('comment.bold', {
      run: (ctx) => {
        received = ctx.editor;
      },
    });
    assert.equal(mod.hasCommentCommandRunner('comment.bold'), true);
    assert.equal(mod.runCommentCommand('comment.bold', field), true);
    assert.equal(received, fakeEditor);

    mod.unregisterCommentCommand('comment.bold');
    assert.equal(mod.runCommentCommand('comment.bold', field), false);
  });

  it('поле обрабатывает свои команды раньше реестра', () => {
    let fieldCalls = 0;
    const field = {
      getEditor: () => fakeEditor,
      root: new ShimElement('div'),
      runFieldCommand: (command: string): boolean => {
        fieldCalls += 1;
        return command === 'comment.cancel';
      },
    };
    let registryCalls = 0;
    mod.registerCommentCommand('comment.bold', {
      run: () => {
        registryCalls += 1;
      },
    });
    assert.equal(mod.runCommentCommand('comment.cancel', field as any), true);
    assert.equal(fieldCalls, 1);
    assert.equal(registryCalls, 0);
    assert.equal(mod.runCommentCommand('comment.bold', field as any), true);
    assert.equal(registryCalls, 1);
  });

  it('контекст сочетаний comment-field маршрутизирует команду активному полю', () => {
    let calls = 0;
    mod.registerCommentCommand('comment.bold', {
      run: () => {
        calls += 1;
      },
    });
    const release = mod.enterCommentEdit(host());

    const event = keyEvent({ key: 'b', code: 'KeyB', ctrlKey: true });
    assert.equal(keymap.dispatchKeyEvent(event as KeyboardEvent), true);
    assert.equal(calls, 1);
    assert.equal(event.defaultPrevented, true, 'диспетчер гасит обработанное сочетание');

    release();
    const second = keyEvent({ key: 'b', code: 'KeyB', ctrlKey: true });
    assert.equal(keymap.dispatchKeyEvent(second as KeyboardEvent), false);
    assert.equal(calls, 1, 'вне правки контекст поля снят');
  });
});
