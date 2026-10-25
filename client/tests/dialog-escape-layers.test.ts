/**
 * `Escape` при верхнем слое над модальным диалогом (ошибка 9ff6b606).
 *
 * Контракт: `Escape` закрывает ТОЛЬКО верхний слой — меню, поповер или
 * выпадающий список над диалогом. Диалог под слоем то же нажатие не
 * обрабатывает: ни несохранённые изменения не подтверждает, ни сам не
 * закрывается. Следующее нажатие `Escape` достаётся диалогу.
 *
 * Дом моделирует фазы события честно: window-capture слушатели (каркас
 * диалога, меню, выпадашка) в порядке регистрации, затем window-bubble
 * (диспетчер `lib/keymap.ts`); `stopImmediatePropagation` обрывает цепочку, а
 * `defaultPrevented` гасит диспетчер — как в браузере.
 *
 * Регрессия до фикса: поповер над «грязным» диалогом — первое нажатие звало
 * подтверждение несохранённых изменений, а панель оставалась открытой.
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
const { escapeLayerInternals } = await import('../src/renderer/lib/escape-layers.js');
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
  escapeLayerInternals.reset();
  keymapInternals.reset();
  defineKeyContext({ id: GLOBAL_CONTEXT_ID, bindings: [] });
  uninstallKeymap = installKeymap();
});

afterEach(() => {
  closeMenu();
  for (let i = 0; i < 20; i += 1) closeDialog();
  uninstallKeymap?.();
  uninstallKeymap = null;
  escapeLayerInternals.reset();
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

/** Открывает панель (`openPopover`) над диалогом; возвращает её дескриптор. */
function openPopoverOverDialog(): { close: () => void; element: ShimElement } {
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
    const popover = openPopoverOverDialog();
    assert.equal(popover.element.parent !== null, true, 'панель в DOM');

    pressEscape();
    assert.equal(popover.element.parent !== null, false, 'первый Escape закрыл панель');
    assert.equal(backdrops().length, 1, 'подтверждение не открылось — диалог цел');

    pressEscape();
    assert.equal(backdrops().length, 2, 'второй Escape зовёт подтверждение');
  });

  it('поповер над чистым диалогом: первый Escape закрывает панель, второй — диалог', () => {
    openEditor(false);
    const popover = openPopoverOverDialog();

    pressEscape();
    assert.equal(popover.element.parent !== null, false, 'первый Escape закрыл панель');
    assert.equal(backdrops().length, 1, 'диалог остался открытым');

    pressEscape();
    assert.equal(backdrops().length, 0, 'второй Escape закрыл диалог');
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
});

/** Даёт отработать промисам асинхронной загрузки выпадашки. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
