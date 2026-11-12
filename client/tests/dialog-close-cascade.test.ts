/**
 * Закрытие хозяина снимает диалоги, открытые над ним (ошибка 7abb6945,
 * «Диалог подтверждения остаётся на экране, если его хозяин закрылся сам»).
 *
 * Контракт каркаса `lib/dialog.ts`: стек диалогов консистентен. Редактор
 * закрывается сам — например, асинхронное «Применить и закрыть» доезжает
 * после того, как поверх открылось подтверждение, — и подтверждение не имеет
 * права пережить хозяина: в DOM не остаётся `.dialog-backdrop` без владельца,
 * `hasOpenDialog()` не врёт, а промис подтверждения завершается.
 *
 * Обратное правило не меняется: закрытие ВЕРХНЕГО диалога не трогает нижние
 * (каскад идёт только вверх по стеку), `closeDialog()` по-прежнему снимает
 * ровно один верхний диалог.
 *
 * Дом — общий shim (`dom-shim.ts`, конвенция `dialog-dirty-close.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

function installShim(): void {
  windowListeners.length = 0;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type: string, listener: (event: any) => void) => {
      windowListeners.push({ type, listener });
    },
    removeEventListener: (type: string, listener: (event: any) => void) => {
      const index = windowListeners.findIndex((l) => l.type === type && l.listener === listener);
      if (index >= 0) windowListeners.splice(index, 1);
    },
  };
}

installShim();

const { showDialog, closeDialog, hasOpenDialog, confirmDialog } =
  await import('../src/renderer/lib/dialog.js');
const { t } = await import('../src/renderer/lib/i18n.js');
const { div } = await import('../src/renderer/lib/dom.js');

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Все подложки открытых диалогов в порядке DOM (нижний первым). */
function backdrops(): ShimElement[] {
  return body().children.filter((c) => c.classList.contains('dialog-backdrop'));
}

/** Кнопка футера диалога по подписи. */
function buttonByLabel(backdrop: ShimElement, label: string): ShimElement {
  const btn = backdrop.querySelectorAll('button').find((b) => b.textContent === label);
  assert.ok(btn !== undefined, `в футере есть кнопка «${label}»`);
  return btn!;
}

/** Esc — всем слушателям keydown окна (нижние диалоги его игнорируют). */
function pressEscape(): void {
  const event = {
    key: 'Escape',
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
  };
  for (const { type, listener } of [...windowListeners]) {
    if (type === 'keydown') listener(event);
  }
}

/** Полная очистка стека диалогов между сценариями. */
function drainDialogs(): void {
  for (let i = 0; i < 20; i += 1) closeDialog();
}

interface Opened {
  close: () => void;
  closes: () => number;
}

/** Простой диалог: нужен только как звено стека. */
function openPlain(title: string): Opened {
  let closes = 0;
  const close = showDialog({
    title,
    size: 's',
    body: div('dialog-text'),
    onClose: () => {
      closes += 1;
    },
  });
  return { close, closes: () => closes };
}

interface Editor extends Opened {
  input: ShimElement;
  /** Ответ «сервера» доехал: редактор закрывает себя сам. */
  finishApply: () => void;
}

/**
 * Редактор-образец: черновик с «грязной» проверкой и асинхронной записью —
 * как у редактора типа, где `apply('close', close)` закрывает диалог позже
 * клика (асинхронное применение).
 */
function openEditor(): Editor {
  const input = (globalThis as any).document.createElement('input') as ShimElement;
  input.value = '';
  const bodyEl = div('form-stack');
  bodyEl.append(input as unknown as Node);
  let closes = 0;
  /** Закрытие хозяина, отложенное до ответа «сервера». */
  let finishApply: (() => void) | null = null;
  const close = showDialog({
    title: 'Редактор сущности',
    size: 'm',
    body: bodyEl,
    dirty: {
      isDirty: () => input.value !== '',
      save: (hostClose) => {
        finishApply = hostClose;
      },
    },
    buttons: [
      { label: t('actions.cancel') },
      {
        label: t('actions.applyClose'),
        primary: true,
        keepOpen: true,
        onClick: (hostClose) => {
          finishApply = hostClose;
        },
      },
    ],
    onClose: () => {
      closes += 1;
    },
  });
  return {
    close,
    closes: () => closes,
    input,
    finishApply: () => finishApply?.(),
  };
}

describe('стек диалогов: хозяин закрывается — дети снимаются (ошибка 7abb6945)', () => {
  it('подтверждение над хозяином не переживает закрытие хозяина', () => {
    installShim();
    drainDialogs();
    const editor = openEditor();
    editor.input.value = 'правка';
    // Esc на «грязном» редакторе открывает подтверждение поверх него.
    pressEscape();
    assert.equal(backdrops().length, 2, 'поверх редактора открыто подтверждение');
    assert.ok(
      backdrops()[1]!.flatText().includes(t('dialog.unsaved.message')),
      'над редактором — подтверждение закрытия',
    );

    // Редактор закрывается САМ (асинхронное применение доехало позже).
    editor.close();

    assert.equal(backdrops().length, 0, 'в DOM не осталось подложки без владельца');
    assert.equal(hasOpenDialog(), false, 'признак модальности не врёт: стек пуст');
    assert.equal(editor.closes(), 1, 'onClose хозяина отработал ровно один раз');
  });

  it('подтверждение, открытое самой кнопкой записи, снимается каскадом', () => {
    installShim();
    drainDialogs();
    const editor = openEditor();
    editor.input.value = 'правка';
    buttonByLabel(backdrops()[0]!, t('actions.applyClose')).click();
    // «Применение» ещё не ответило, пользователь передумал — Esc даёт подтверждение.
    pressEscape();
    assert.equal(backdrops().length, 2, 'подтверждение открылось над живым редактором');

    editor.finishApply();

    assert.equal(backdrops().length, 0, 'подтверждение снято вместе с хозяином');
    assert.equal(hasOpenDialog(), false, 'стек пуст');
    assert.equal(editor.closes(), 1, 'хозяин закрыт один раз');
  });

  it('промис confirmDialog над хозяином завершается отказом', async () => {
    installShim();
    drainDialogs();
    const host = openPlain('Хозяин');
    const pending = confirmDialog('Удалить?', 'Точно?');
    assert.equal(backdrops().length, 2, 'подтверждение открыто поверх хозяина');

    host.close();

    assert.equal(await pending, false, 'подтверждение без хозяина = отказ');
    assert.equal(backdrops().length, 0, 'стек пуст');
  });

  it('средний диалог: верхний снимается, нижний остаётся верхним', () => {
    installShim();
    drainDialogs();
    const bottom = openPlain('Нижний');
    const middle = openPlain('Средний');
    openPlain('Верхний');
    assert.equal(backdrops().length, 3, 'три диалога в стеке');

    middle.close();

    assert.equal(backdrops().length, 1, 'остался только нижний');
    assert.equal(bottom.closes(), 0, 'закрытие среднего не трогает нижний');
    // Верхним стал нижний: `closeDialog()` снимает именно его.
    closeDialog();
    assert.equal(backdrops().length, 0, 'стек консистентен: следующий closeDialog снял нижний');
    assert.equal(bottom.closes(), 1, 'нижний закрыт штатно');
  });

  it('закрытие верхнего диалога не трогает хозяина (каскад только вверх)', () => {
    installShim();
    drainDialogs();
    const host = openPlain('Хозяин');
    const child = openPlain('Ребёнок');

    child.close();

    assert.equal(backdrops().length, 1, 'хозяин остался');
    assert.equal(host.closes(), 0, 'onClose хозяина не вызван');
  });
});
