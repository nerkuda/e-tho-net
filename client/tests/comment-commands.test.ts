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
import { ru } from '../src/renderer/lib/locales/ru.js';

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

/**
 * Ожидаемая подпись пункта меню с сочетанием: базовая подпись из словаря плюс
 * действующее сочетание (как `commandTitle` — `effectiveChord` с откатом на
 * умолчание реестра).
 */
function menuLabel(id: string): string {
  const def = (mod as any).COMMENT_COMMANDS[id];
  const chord =
    (keymap as any).effectiveChord(id) ?? (keymap as any).COMMENT_KEYMAP_DEFAULTS[id] ?? null;
  const base = String((ru as Record<string, string>)[def.labelKey]);
  return chord === null ? base : `${base} (${chord})`;
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
    // Идентификатор `comment.split` заведён ТП1 как точка расширения; подпись
    // команды уточнена ТП3 (задача 578c8525) до названия элемента `2a21c27e`.
    assert.ok(labels.includes('Разделить выделение на мысли'));
    assert.ok(labels.includes('Отмена'));
    assert.ok(labels.includes('Сохранить'));
    // Перемещение строк — в контекстном меню с сочетанием в подписи, но НЕ в
    // тулбаре (элемент 0562e0e3; решение пользователя по ошибке ea97b0a1).
    assert.ok(labels.includes(menuLabel('comment.moveLineUp')));
    assert.ok(labels.includes(menuLabel('comment.moveLineDown')));
    assert.ok(
      labels.indexOf(menuLabel('comment.moveLineUp')) > labels.indexOf('Разделить выделение на мысли'),
      'перемещение строк идёт после «разделения»',
    );
    assert.ok(labels.indexOf(menuLabel('comment.moveLineDown')) < labels.indexOf('Отмена'));

    // Соседние пункты (copy/cut/paste/find) сочетаний в подписи не несут —
    // их тема отдельная, здесь только перемещение строк.
    assert.ok(labels.includes('Копировать'));
    assert.ok(labels.includes('Поиск'));

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

  it('пункт меню перемещения строки исполняет команду и несёт disabled-состояние', () => {
    // Пункт меню вызывает ту же команду, что и сочетание Alt+↑/↓.
    let ran = 0;
    mod.registerCommentCommand('comment.moveLineUp', {
      run: () => {
        ran += 1;
        return true;
      },
    });
    const up = mod
      .buildCommentMenuItems(host())
      .find((item) => item.label === menuLabel('comment.moveLineUp'));
    assert.ok(up !== undefined, 'пункт «переместить строку выше» обязан быть в меню');
    assert.equal(up.disabled, false);
    up.onClick?.();
    assert.equal(ran, 1);

    // disabled-логика — из состояния команды, как у соседних команд правки.
    mod.registerCommentCommand('comment.moveLineDown', {
      run: () => false,
      state: () => ({ disabled: true }),
    });
    const down = mod
      .buildCommentMenuItems(host())
      .find((item) => item.label === menuLabel('comment.moveLineDown'));
    assert.ok(down !== undefined);
    assert.equal(down.disabled, true);
  });

  it('подпись пункта меню перемещения строки отражает действующее сочетание', () => {
    const def = mod.COMMENT_COMMANDS['comment.moveLineUp']!;
    const base = String((ru as Record<string, string>)[def.labelKey]);

    // (а) дефолтное сочетание из единого реестра умолчаний.
    const byDefault = mod
      .buildCommentMenuItems(host())
      .find((item) => item.label.startsWith(base));
    assert.equal(byDefault?.label, menuLabel('comment.moveLineUp'));
    assert.equal(byDefault?.label, `${base} (${keymap.COMMENT_KEYMAP_DEFAULTS['comment.moveLineUp']})`);

    // (б) после переопределения подпись несёт НОВОЕ сочетание, а не хардкод.
    keymap.setKeymapOverrides({ 'comment.moveLineUp': 'Ctrl+Alt+M' });
    const overridden = mod
      .buildCommentMenuItems(host())
      .find((item) => item.label.startsWith(base));
    assert.equal(overridden?.label, `${base} (Ctrl+Alt+M)`);
    keymap.setKeymapOverrides({});

    // (в) диалог настройки берёт базовую подпись без сочетания (колонка
    // сочетания — отдельно), поэтому дублирования нет.
    assert.equal(base, ru['comment.cmd.moveLineUp']);
    assert.equal(base.includes('('), false);
    assert.equal(base.includes('Alt+'), false);
  });

  it('меню блока трансклюзии: пять команд в порядке макета, подписи из словаря', () => {
    // Раскладка — точки расширения ТП2 (элемент 1e0fb0bd); «Изменить ссылку»
    // убрано задачей 68591b8a (ссылка правится чипом-шапкой и поповером).
    assert.deepEqual(
      [...mod.TRANSCLUSION_MENU_LAYOUT],
      [
        'transclusion.edit',
        'transclusion.openSource',
        'transclusion.focusSource',
        'transclusion.copyLink',
        'transclusion.copyId',
      ],
    );
    // Меню чипа в просмотре — только команды навигации, без правки.
    assert.deepEqual(
      [...mod.TRANSCLUSION_NAV_MENU_LAYOUT],
      [
        'transclusion.openSource',
        'transclusion.focusSource',
        'transclusion.copyLink',
        'transclusion.copyId',
      ],
    );
    const items = mod.buildTransclusionMenuItems({});
    assert.deepEqual(
      items.map((item) => item.label),
      [
        ru['comment.transclusion.menu.edit'],
        ru['comment.transclusion.menu.open'],
        ru['comment.transclusion.menu.focus'],
        ru['comment.transclusion.menu.copy'],
        ru['comment.transclusion.menu.copyId'],
      ],
    );
    // Без обработчика пункт недоступен, но остаётся в меню.
    assert.deepEqual(items.map((item) => item.disabled), [true, true, true, true, true]);
  });

  it('меню блока трансклюзии: заданный обработчик исполняется по клику пункта', () => {
    const calls: string[] = [];
    const items = mod.buildTransclusionMenuItems({
      'transclusion.openSource': () => calls.push('openSource'),
    });
    const open = items[1]!;
    assert.equal(open.disabled, false, 'пункт с обработчиком доступен');
    open.onClick?.();
    assert.deepEqual(calls, ['openSource']);
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

  it('команды поля вызываются и без редактора (поиск в просмотре)', () => {
    const field = {
      getEditor: () => null,
      root: new ShimElement('div'),
      runFieldCommand: (command: string): boolean => command === 'comment.find',
    };
    // Поиск открывается и в просмотре — команда поля исполняется без редактора
    // (требование d72ea6eb, элемент b8eabc22).
    assert.equal(mod.runCommentCommand('comment.find', field as any), true);
    // Прочие команды без редактора остаются no-op.
    assert.equal(mod.runCommentCommand('comment.bold', field as any), false);
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

  it('Ctrl+Up / Ctrl+Down маршрутизируются в сворачивание/разворачивание (558cac34)', () => {
    assert.equal(keymap.COMMENT_KEYMAP_DEFAULTS['comment.fold'], 'Ctrl+ArrowUp');
    assert.equal(keymap.COMMENT_KEYMAP_DEFAULTS['comment.unfold'], 'Ctrl+ArrowDown');

    const modes: string[] = [];
    const editor: any = {
      snapshot: () => ({ text: '', from: 0, to: 0 }),
      toggleCollapseAtCaret: (mode: string) => {
        modes.push(mode);
        return true;
      },
    };
    mod.registerCommentCommand('comment.fold', {
      run: (ctx) => ctx.editor.toggleCollapseAtCaret('fold'),
    });
    mod.registerCommentCommand('comment.unfold', {
      run: (ctx) => ctx.editor.toggleCollapseAtCaret('unfold'),
    });
    const release = mod.enterCommentEdit(host(editor));

    const up = keyEvent({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true });
    assert.equal(keymap.dispatchKeyEvent(up as KeyboardEvent), true);
    assert.equal(up.defaultPrevented, true);
    const down = keyEvent({ key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true });
    assert.equal(keymap.dispatchKeyEvent(down as KeyboardEvent), true);
    assert.deepEqual(modes, ['fold', 'unfold'], 'комбинации идут через общий диспетчер');

    release();
  });

  it('переопределение сочетаний меняет маршрут команд сворачивания (558cac34)', () => {
    const modes: string[] = [];
    const editor: any = {
      snapshot: () => ({ text: '', from: 0, to: 0 }),
      toggleCollapseAtCaret: (mode: string) => {
        modes.push(mode);
        return true;
      },
    };
    mod.registerCommentCommand('comment.fold', {
      run: (ctx) => ctx.editor.toggleCollapseAtCaret('fold'),
    });
    const release = mod.enterCommentEdit(host(editor));

    // Пользователь переназначил Ctrl+Up на Ctrl+Shift+U (как из слоя настроек).
    keymap.setKeymapOverrides({ 'comment.fold': 'Ctrl+Shift+U' });
    assert.equal(
      keymap.dispatchKeyEvent(keyEvent({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true }) as KeyboardEvent),
      false,
      'старое сочетание больше не срабатывает',
    );
    assert.equal(
      keymap.dispatchKeyEvent(
        keyEvent({ key: 'u', code: 'KeyU', ctrlKey: true, shiftKey: true }) as KeyboardEvent,
      ),
      true,
      'новое сочетание срабатывает',
    );
    assert.deepEqual(modes, ['fold'], 'команда исполнена по новому сочетанию');

    keymap.setKeymapOverrides({});
    release();
  });

  it('команды сворачивания видны в словаре команд с осмысленными подписями', () => {
    for (const id of ['comment.fold', 'comment.unfold']) {
      const def = mod.COMMENT_COMMANDS[id];
      assert.ok(def !== undefined, `нет описания команды ${id}`);
      const label = String((ru as Record<string, string>)[def.labelKey]);
      assert.ok(label.length > 0 && label !== def.labelKey, `подпись команды ${id} из словаря`);
    }
  });
});

/**
 * Кнопки режима под полем комментария (0.12.1, задача 3901f07e, ТП1; элемент
 * интерфейса `a0e5bc2e`): «Редактировать» в просмотре, «Отменить»/«Сохранить»
 * в правке. Кнопки — словарь `lib/ui`; действия идут командой поля, тем же
 * путём, что сочетания Esc/Ctrl+Enter.
 */
describe('кнопки режима под полем (createCommentModeActions)', () => {
  beforeEach(async () => {
    installShim();
    mod = (await import('../src/renderer/editor/comment-commands.js')) as Module;
    mod.commentCommandsInternals.reset();
  });

  function actionsHost(seen: string[]): any {
    return {
      getEditor: () => null,
      root: new ShimElement('div'),
      runFieldCommand: (command: string): boolean => {
        seen.push(command);
        return true;
      },
    };
  }

  it('в просмотре видна «Редактировать», кнопки правки скрыты', () => {
    const actions = mod.createCommentModeActions(actionsHost([]) as any);
    const root = actions.root as unknown as ShimElement;
    const edit = root.querySelector('[data-action="edit"]')!;
    const cancel = root.querySelector('[data-action="cancel"]')!;
    const save = root.querySelector('[data-action="save"]')!;

    assert.equal(edit.hidden, false, '«Редактировать» видна в просмотре');
    assert.equal(cancel.hidden, true, '«Отменить» скрыта в просмотре');
    assert.equal(save.hidden, true, '«Сохранить» скрыта в просмотре');

    // Строки и роли — из словарей (требования edc5faea, 0e5ff1c6): самодельных
    // классов и литералов быть не должно. Кнопка входа в правку — ИКОНОЧНАЯ
    // (ошибка de14e6d2): иконка `pencil` вместо надписи, подсказка/`aria-label`
    // «Редактировать текст» — из словаря.
    assert.equal(edit.textContent, '', 'у иконочной «Редактировать» нет текстовой надписи');
    assert.ok(edit.className.split(' ').includes('ui-btn--icon'), 'кнопка — иконочная (ui-btn--icon)');
    assert.equal(edit.title, ru['comment.action.editTooltip'], 'тултип — из словаря');
    assert.equal(edit.getAttribute('aria-label'), ru['comment.action.editTooltip'], 'aria-label дублирует тултип');
    assert.ok(edit.querySelector('svg') !== null, 'в кнопке — иконка (svg)');
    assert.equal(cancel.textContent, ru['comment.cmd.cancel']);
    assert.equal(save.textContent, ru['comment.cmd.save']);
    assert.ok(edit.className.split(' ').includes('ui-btn--secondary'));
    assert.ok(cancel.className.split(' ').includes('ui-btn--secondary'));
    assert.ok(save.className.split(' ').includes('ui-btn--primary'));
  });

  it('в правке видны «Отменить»/«Сохранить», «Редактировать» скрыта', () => {
    const actions = mod.createCommentModeActions(actionsHost([]) as any);
    const root = actions.root as unknown as ShimElement;
    actions.setEditing(true);
    assert.equal(root.querySelector('[data-action="edit"]')!.hidden, true);
    assert.equal(root.querySelector('[data-action="cancel"]')!.hidden, false);
    assert.equal(root.querySelector('[data-action="save"]')!.hidden, false);
  });

  it('клик исполняет команду поля через диспетчер (единый путь с Esc/Ctrl+Enter)', () => {
    const seen: string[] = [];
    const actions = mod.createCommentModeActions(actionsHost(seen) as any);
    const root = actions.root as unknown as ShimElement;

    root.querySelector('[data-action="edit"]')!.click();
    actions.setEditing(true);
    root.querySelector('[data-action="cancel"]')!.click();
    root.querySelector('[data-action="save"]')!.click();

    assert.deepEqual(seen, ['comment.edit', 'comment.cancel', 'comment.save']);
  });
});
