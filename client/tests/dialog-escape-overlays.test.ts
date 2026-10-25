/**
 * `Escape` при верхнем слое над модальным диалогом (ошибка 9ff6b606).
 *
 * Контракт: `Escape` закрывает ТОЛЬКО верхний слой — диалог, меню, поповер,
 * выпадающий список, панель поиска — и разрешает приоритет общеклиентский
 * диспетчер (`lib/keymap.ts`, реестр `pushKeyOverlay`; ADR `b420b08c`). Диалог
 * регистрируется в том же реестре и стоит в стеке по порядку открытия: слой под
 * ним то же нажатие не обрабатывает — ни несохранённые изменения не
 * подтверждает, ни сам не закрывается. Следующее нажатие `Escape` достаётся
 * следующему слою, затем диалогу.
 *
 * Дом моделирует фазы события честно: window-capture слушатели (каркас
 * диалога) в порядке регистрации, затем window-bubble (диспетчер
 * `lib/keymap.ts`); `stopImmediatePropagation` обрывает цепочку, а
 * `defaultPrevented` гасит диспетчер — как в браузере.
 *
 * Регрессии до фикса: поповер/панель над «грязным» диалогом — первое нажатие
 * звало подтверждение несохранённых изменений, а слой оставался открытым;
 * поповер над меню — Escape закрывал меню, а панель оставалась.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

interface Listener {
  type: string;
  listener: (event: any) => void;
  capture: boolean;
}

const windowListeners: Listener[] = [];
const documentListeners: Listener[] = [];

function installShim(): void {
  windowListeners.length = 0;
  documentListeners.length = 0;
  const documentShim: any = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    activeElement: null,
    addEventListener: (type: string, listener: (event: any) => void, capture?: boolean) => {
      documentListeners.push({ type, listener, capture: capture === true });
    },
    removeEventListener: (type: string, listener: (event: any) => void, capture?: boolean) => {
      const index = documentListeners.findIndex(
        (entry) =>
          entry.type === type && entry.listener === listener && entry.capture === (capture === true),
      );
      if (index >= 0) documentListeners.splice(index, 1);
    },
    querySelector: () => null,
  };
  (globalThis as any).document = documentShim;
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    setTimeout,
    clearTimeout,
    addEventListener: (type: string, listener: (event: any) => void, capture?: boolean) => {
      windowListeners.push({ type, listener, capture: capture === true });
    },
    removeEventListener: (type: string, listener: (event: any) => void, capture?: boolean) => {
      const index = windowListeners.findIndex(
        (entry) =>
          entry.type === type && entry.listener === listener && entry.capture === (capture === true),
      );
      if (index >= 0) windowListeners.splice(index, 1);
    },
  };
}

const { showDialog, closeDialog } = await import('../src/renderer/lib/dialog.js');
const { showMenuAt, closeMenu, isMenuOpen, menuSubmenu } = await import(
  '../src/renderer/lib/menu.js'
);
const { openPopover } = await import('../src/renderer/lib/ui/popover.js');
const { createCommentSearch } = await import('../src/renderer/editor/comment-search.js');
const {
  GLOBAL_CONTEXT_ID,
  defineKeyContext,
  installKeymap,
  keymapInternals,
} = await import('../src/renderer/lib/keymap.js');
const { div } = await import('../src/renderer/lib/dom.js');
const { t } = await import('../src/renderer/lib/i18n.js');
const { wireSuggest, historySuggestSource } = await import(
  '../src/renderer/lib/suggest-dropdown.js'
);

let uninstallKeymap: (() => void) | null = null;

beforeEach(() => {
  installShim();
  keymapInternals.reset();
  defineKeyContext({ id: GLOBAL_CONTEXT_ID, bindings: [] });
  uninstallKeymap = installKeymap();
});

afterEach(() => {
  closeMenu();
  for (let i = 0; i < 20; i += 1) closeDialog();
  uninstallKeymap?.();
  uninstallKeymap = null;
  keymapInternals.reset();
});

function bodyEl(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

function backdrops(): ShimElement[] {
  return bodyEl().children.filter((c) => c.classList.contains('dialog-backdrop'));
}

/** Нажатие `Escape` с честным порядком фаз события. */
function pressEscape(): void {
  const event: any = {
    key: 'Escape',
    code: 'Escape',
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    immediateStopped: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
    stopPropagation: () => undefined,
    stopImmediatePropagation: () => {
      event.immediateStopped = true;
    },
  };
  const capture = windowListeners.filter((entry) => entry.capture && entry.type === 'keydown');
  const bubble = windowListeners.filter((entry) => !entry.capture && entry.type === 'keydown');
  for (const { listener } of [...capture, ...bubble]) {
    if (event.immediateStopped) break;
    listener(event);
  }
}

/** Диалог-редактор с полем; `dirty` — есть ли несохранённые изменения. */
function openEditor(dirty: boolean): void {
  const input = (globalThis as any).document.createElement('input') as ShimElement;
  input.value = dirty ? 'правка' : '';
  const body = div('form-stack');
  body.append(input as unknown as Node);
  showDialog({
    title: 'Редактор сущности',
    size: 'm',
    body,
    dirty: {
      isDirty: () => (input as unknown as { value: string }).value !== '',
      save: (close) => close(),
    },
    buttons: [{ label: t('actions.cancel') }, { label: t('actions.apply'), primary: true }],
  });
}

/** Открывает меню над диалогом. */
function openMenuOverDialog(items = [{ label: 'Переместить выше' }]): void {
  showMenuAt(10, 10, items);
}

/** Открывает панель (`openPopover`) над текущим верхом; возвращает дескриптор. */
function openPanel(): { close: () => void; element: ShimElement } {
  const anchor = new ShimElement('button');
  const handle = openPopover({
    anchor: { element: anchor as unknown as HTMLElement },
    content: { title: 'Панель', body: div('ui-popover-body') as unknown as HTMLElement },
  });
  return { close: handle.close, element: handle.element as unknown as ShimElement };
}

/** Подтверждение несохранённых изменений открыто (второй диалог стопки). */
function confirmationOpen(): boolean {
  return backdrops().length === 2;
}

describe('Escape: верхний слой над диалогом (ошибка 9ff6b606)', () => {
  it('меню над «грязным» диалогом: первый Escape закрывает меню, второй зовёт подтверждение', () => {
    openEditor(true);
    openMenuOverDialog();
    assert.equal(isMenuOpen(), true, 'меню открыто над диалогом');

    pressEscape();
    assert.equal(isMenuOpen(), false, 'первый Escape закрыл меню');
    assert.equal(backdrops().length, 1, 'подтверждения нет — диалог не тронут');
    assert.equal(confirmationOpen(), false);

    pressEscape();
    assert.equal(backdrops().length, 2, 'второй Escape зовёт подтверждение несохранённых изменений');
  });

  it('меню над чистым диалогом: первый Escape закрывает меню, второй — диалог', () => {
    openEditor(false);
    openMenuOverDialog();

    pressEscape();
    assert.equal(isMenuOpen(), false, 'первый Escape закрыл меню');
    assert.equal(backdrops().length, 1, 'диалог остался открытым');

    pressEscape();
    assert.equal(backdrops().length, 0, 'второй Escape закрыл диалог');
  });

  it('меню с подменю над «грязным» диалогом: Escape закрывает меню целиком', () => {
    openEditor(true);
    openMenuOverDialog([
      menuSubmenu('Изменить порядок', [
        { label: 'сделать первой' },
        { label: 'сделать последней' },
      ]),
    ]);
    // Подменю строится на mouseenter строки-родителя.
    const root = bodyEl().children.find((c) => c.classList.contains('menu'));
    assert.ok(root !== undefined, 'корень меню в DOM');
    const parentRow = root!.children.find((c) => c.classList.contains('menu-item'));
    assert.ok(parentRow !== undefined, 'строка-родитель есть');
    parentRow!.emit('mouseenter');
    assert.ok(
      root!.children.some((c) => c.classList.contains('menu-sub')),
      'подменю раскрыто',
    );

    pressEscape();
    assert.equal(isMenuOpen(), false, 'Escape закрыл меню с подменю');
    assert.equal(backdrops().length, 1, 'диалог не тронут');
  });

  it('поповер над «грязным» диалогом: первый Escape закрывает только панель', () => {
    openEditor(true);
    const popover = openPanel();
    assert.equal(popover.element.parent !== null, true, 'панель в DOM');

    pressEscape();
    assert.equal(popover.element.parent !== null, false, 'первый Escape закрыл панель');
    assert.equal(backdrops().length, 1, 'подтверждение не открылось — диалог цел');

    pressEscape();
    assert.equal(backdrops().length, 2, 'второй Escape зовёт подтверждение');
  });

  it('поповер над чистым диалогом: первый Escape закрывает панель, второй — диалог', () => {
    openEditor(false);
    const popover = openPanel();

    pressEscape();
    assert.equal(popover.element.parent !== null, false, 'первый Escape закрыл панель');
    assert.equal(backdrops().length, 1, 'диалог остался открытым');

    pressEscape();
    assert.equal(backdrops().length, 0, 'второй Escape закрыл диалог');
  });

  it('поповер над меню: первый Escape закрывает поповер, меню остаётся (блокер приёмки)', () => {
    openEditor(true);
    openMenuOverDialog();
    const popover = openPanel();

    pressEscape();
    assert.equal(popover.element.parent !== null, false, 'закрыт верхний слой — поповер');
    assert.equal(isMenuOpen(), true, 'меню под ним осталось открытым');
    assert.equal(backdrops().length, 1, 'диалог не тронут');

    pressEscape();
    assert.equal(isMenuOpen(), false, 'второй Escape закрыл меню');

    pressEscape();
    assert.equal(backdrops().length, 2, 'третий Escape зовёт подтверждение');
  });

  it('поповер над меню БЕЗ диалога: Escape закрывает поповер, а меню не глотает нажатие', () => {
    // Регрессия мутации menu.ts: безусловный `stopImmediatePropagation` в
    // capture-слушателе меню закрывал бы попадание диспетчеру, и поповер
    // оставался бы открытым. Диалог здесь не нужен — проверяется чистое LIFO
    // двух всплывающих слоёв.
    openMenuOverDialog();
    const popover = openPanel();

    pressEscape();
    assert.equal(popover.element.parent !== null, false, 'верхний слой (поповер) закрыт');
    assert.equal(isMenuOpen(), true, 'меню под поповером осталось открытым');

    pressEscape();
    assert.equal(isMenuOpen(), false, 'второй Escape закрыл меню');
    assert.equal(backdrops().length, 0, 'диалогов не было');
  });

  it('кейс E: меню → «грязный» диалог 1 → чистый диалог 2 — Escape закрывает диалог 2, меню цело', () => {
    openEditor(true);
    openMenuOverDialog();
    openEditor(false);
    assert.equal(backdrops().length, 2, 'оба диалога открыты');

    pressEscape();
    assert.equal(backdrops().length, 1, 'закрыт верхний диалог 2 (открыт позже меню)');
    assert.equal(isMenuOpen(), true, 'меню под диалогом 2 не тронуто');

    pressEscape();
    assert.equal(isMenuOpen(), false, 'следующий Escape закрыл меню');
    assert.equal(backdrops().length, 1, '«грязный» диалог 1 цел');

    pressEscape();
    assert.equal(backdrops().length, 2, 'Escape диалога 1 зовёт подтверждение');
  });

  it('три уровня: меню до диалога → диалог → диалог закрываются строго сверху вниз', () => {
    openMenuOverDialog();
    openEditor(false);
    openEditor(false);
    assert.equal(backdrops().length, 2, 'два диалога поверх меню');

    pressEscape();
    assert.equal(backdrops().length, 1, 'первый Escape — верхний диалог');
    assert.equal(isMenuOpen(), true, 'меню (открыто раньше диалогов) не тронуто');

    pressEscape();
    assert.equal(backdrops().length, 0, 'второй Escape — диалог под ним');
    assert.equal(isMenuOpen(), true, 'меню всё ещё открыто');

    pressEscape();
    assert.equal(isMenuOpen(), false, 'третий Escape — меню');
  });

  it('закрытие диалога снимает его слой: следующий Escape достаётся диалогу под ним', () => {
    openEditor(false);
    openEditor(false);
    assert.equal(backdrops().length, 2, 'два диалога');

    closeDialog();
    assert.equal(backdrops().length, 1, 'верхний диалог закрыт программно');

    pressEscape();
    assert.equal(backdrops().length, 0, 'Escape ушёл нижнему диалогу, а не в пустоту');
  });

  it('панель с closeOnEsc: false не отнимает Escape у диалога', () => {
    openEditor(true);
    const anchor = new ShimElement('button');
    const handle = openPopover({
      anchor: { element: anchor as unknown as HTMLElement },
      content: { title: 'Панель', body: div('ui-popover-body') as unknown as HTMLElement },
      closeOnEsc: false,
    });
    try {
      pressEscape();
      assert.equal(backdrops().length, 2, 'Escape достался диалогу — подтверждение открылось');
      assert.equal((handle.element as unknown as ShimElement).parent !== null, true, 'панель не закрыта');
    } finally {
      handle.close();
    }
  });

  it('обычный Escape без верхнего слоя: «грязный» диалог зовёт подтверждение, чистый — закрывается', () => {
    openEditor(true);
    pressEscape();
    assert.equal(backdrops().length, 2, 'подтверждение при изменениях');
    for (let i = 0; i < 20; i += 1) closeDialog();

    openEditor(false);
    pressEscape();
    assert.equal(backdrops().length, 0, 'чистый диалог закрывается сразу');
  });

  it('выпадашка подсказок в «грязном» диалоге: первый Escape закрывает список, второй — подтверждение', async () => {
    const input = (globalThis as any).document.createElement('input') as ShimElement;
    input.value = '';
    const body = div('form-stack');
    body.append(input as unknown as Node);
    showDialog({
      title: 'Редактор значения',
      size: 'm',
      body,
      dirty: { isDirty: () => true, save: (close) => close() },
      buttons: [{ label: t('actions.cancel') }, { label: t('actions.apply'), primary: true }],
    });
    const handle = wireSuggest(input as unknown as HTMLInputElement, {
      sources: [
        historySuggestSource({
          load: () => [{ value: 'v1', label: 'Москва' }, { value: 'v2', label: 'СПб' }],
        }),
      ],
      onPick: () => undefined,
    });
    try {
      input.emit('focus');
      await flush();
      assert.ok(
        bodyEl().children.some((child) => child.classList.contains('type-combo-list')),
        'выпадашка открыта',
      );

      pressEscape();
      assert.equal(
        bodyEl().children.some((child) => child.classList.contains('type-combo-list')),
        false,
        'первый Escape закрыл выпадашку',
      );
      assert.equal(backdrops().length, 1, 'подтверждение не открылось — диалог цел');

      pressEscape();
      assert.equal(backdrops().length, 2, 'второй Escape зовёт подтверждение');
    } finally {
      handle.dispose();
    }
  });

  it('поле выпало из DOM с открытым списком: Escape закрывает список и не достаётся диалогу', async () => {
    const host = div('form-stack');
    const input = (globalThis as any).document.createElement('input') as ShimElement;
    input.value = '';
    host.append(input as unknown as Node);
    bodyEl().append(host as unknown as ShimElement);
    const handle = wireSuggest(input as unknown as HTMLInputElement, {
      sources: [
        historySuggestSource({
          load: () => [{ value: 'v1', label: 'Москва' }],
        }),
      ],
      onPick: () => undefined,
    });
    try {
      input.emit('focus');
      await flush();
      assert.ok(
        bodyEl().children.some((child) => child.classList.contains('type-combo-list')),
        'выпадашка открыта',
      );

      // Диалог регистрируется ПОЗЖЕ списка — его слой выше в реестре.
      openEditor(true);
      assert.equal(backdrops().length, 1, 'диалог открыт');

      // Поле выпало из документа (перерисовка/отключение панели), список остался.
      host.replaceChildren();
      input.isConnected = false;
      assert.equal(input.isConnected, false, 'поле отключено от документа');

      pressEscape();
      assert.equal(
        bodyEl().children.some((child) => child.classList.contains('type-combo-list')),
        false,
        'мёртвый список закрыт',
      );
      assert.equal(backdrops().length, 1, 'Escape не достался диалогу — подтверждения нет');
    } finally {
      handle.dispose();
    }
  });

  it('панель поиска в «грязном» диалоге: первый Escape закрывает панель, второй — подтверждение (блокер приёмки)', () => {
    openEditor(true);
    const root = div('md-field');
    const view = div('md-view');
    const search = createCommentSearch({
      root: root as unknown as HTMLElement,
      view: view as unknown as HTMLElement,
      getEditor: () => null,
      isEditing: () => false,
      restoreFocus: () => undefined,
    });
    root.append(search.element);
    search.open('find');
    assert.equal(search.isOpen(), true, 'панель поиска открыта поверх диалога');
    assert.equal(backdrops().length, 1, 'диалог один');

    pressEscape();
    assert.equal(search.isOpen(), false, 'первый Escape закрыл панель поиска');
    assert.equal(backdrops().length, 1, 'подтверждение не открылось — диалог цел');

    pressEscape();
    assert.equal(backdrops().length, 2, 'второй Escape зовёт подтверждение');
    search.destroy();
  });
});

/** Даёт отработать промисам асинхронной загрузки выпадашки. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
