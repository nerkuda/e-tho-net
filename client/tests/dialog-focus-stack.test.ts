/**
 * Фокус в диалогах подтверждения и ловушка Tab в верхнем диалоге (ошибка
 * 0c45bce8 «В диалогах подтверждения нет фокуса»).
 *
 * Контракт каркаса `lib/dialog.ts`:
 *   1. только что открытый (верхний) диалог получает фокус — подтверждение,
 *      открытое над редактором, забирает фокус у нижележащего диалога;
 *   2. Tab не покидает верхний диалог: на краях порядок заворачивается внутрь,
 *      и фокус из чужого места возвращается в верхний диалог;
 *   3. в диалоге подтверждения стрелки ходят по кнопкам панели кнопок.
 *
 * Дом — шим с учётом `document.activeElement` (`ShimElement.focus()` сам по
 * себе активный элемент не ведёт): подкласс записывает фокус, как браузер.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

/** Элемент, чей `focus()` обновляет `document.activeElement` (как браузер). */
class ActiveTrackingElement extends ShimElement {
  override focus(): void {
    super.focus();
    doc().activeElement = this;
  }

  override blur(): void {
    super.blur();
    if (doc().activeElement === this) doc().activeElement = null;
  }
}

function doc(): any {
  return (globalThis as any).document;
}

function installShim(): void {
  windowListeners.length = 0;
  (globalThis as any).document = {
    createElement: (tag: string) => new ActiveTrackingElement(tag),
    createElementNS: (_ns: string, tag: string) => new ActiveTrackingElement(tag),
    documentElement: new ActiveTrackingElement('html'),
    body: new ActiveTrackingElement('body'),
    activeElement: null,
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

const { closeDialog, showDialog, promptDialog, confirmDialog } = await import(
  '../src/renderer/lib/dialog.js'
);
const { t } = await import('../src/renderer/lib/i18n.js');
const { div } = await import('../src/renderer/lib/dom.js');

/** Число `keydown`-слушателей окна — каркас вешает/снимает их на каждый диалог. */
function keydownListenerCount(): number {
  return windowListeners.filter((l) => l.type === 'keydown').length;
}

function body(): ShimElement {
  return doc().body as ShimElement;
}

/** Все подложки открытых диалогов: редактор первым, подтверждение последним. */
function backdrops(): ShimElement[] {
  return body().children.filter((c) => c.classList.contains('dialog-backdrop'));
}

/** Полная очистка стека диалогов между сценариями. */
function drainDialogs(): void {
  for (let i = 0; i < 20; i += 1) closeDialog();
}

interface KeyOverrides {
  shiftKey?: boolean;
}

/** Нажатие клавиши всем слушателям `keydown` окна (как шлёт браузер). */
function pressKey(key: string, overrides: KeyOverrides = {}): void {
  const event = {
    key,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: overrides.shiftKey ?? false,
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

interface Editor {
  input: ActiveTrackingElement;
}

/**
 * Редактор-образец с объявленным `dirty`: Esc при изменениях перехватывается
 * подтверждением «Данные изменены. Сохранить изменения?» — точь-в-точь как
 * диалог создания отбора.
 */
function openEditor(): Editor {
  const input = doc().createElement('input') as ActiveTrackingElement;
  input.value = '';
  const bodyEl = div('form-stack');
  bodyEl.append(input as unknown as Node);
  showDialog({
    title: 'Отбор',
    size: 'm',
    body: bodyEl,
    dirty: {
      isDirty: () => input.value !== '',
      save: (close) => close(),
    },
    buttons: [
      { label: t('actions.cancel') },
      { label: t('actions.apply'), primary: true },
    ],
  });
  return { input };
}

/** Верхний (последний открытый) диалог. */
function topDialog(): ShimElement {
  const all = backdrops();
  const last = all[all.length - 1];
  assert.ok(last !== undefined, 'открыт хотя бы один диалог');
  return last!;
}

/** Кнопка верхнего диалога по подписи (панель кнопок). */
function buttonByLabel(backdrop: ShimElement, label: string): ShimElement {
  const btn = backdrop.querySelectorAll('button').find((b) => b.textContent === label);
  assert.ok(btn !== undefined, `в диалоге есть кнопка «${label}»`);
  return btn!;
}

/** Активный элемент сейчас. */
function active(): ShimElement | null {
  return doc().activeElement as ShimElement | null;
}

/** Клик по × в шапке диалога. */
function clickClose(backdrop: ShimElement): void {
  const closeBtn = backdrop.querySelector('.ui-btn--ghost');
  assert.ok(closeBtn !== null, 'в шапке есть ×');
  closeBtn!.click();
}

describe('прямая очистка при закрытии диалога (0c45bce8, круг 2)', () => {
  it('Esc резолвит промис promptDialog и снимает слушатели', async () => {
    installShim();
    drainDialogs();
    const baseline = keydownListenerCount();
    const promise = promptDialog('Имя', 'Подпись');
    assert.equal(backdrops().length, 1, 'диалог открыт');
    assert.ok(keydownListenerCount() > baseline, 'каркас повесил слушатели');

    pressKey('Escape');
    await assert.doesNotReject(promise);
    assert.equal(await promise, null, 'Esc — отмена, промис резолвится null');
    assert.equal(backdrops().length, 0, 'подложка убрана из DOM');
    assert.equal(keydownListenerCount(), baseline, 'слушатели сняты (не через DOM-событие)');
  });

  it('× резолвит промис confirmDialog и снимает слушатели', async () => {
    installShim();
    drainDialogs();
    const baseline = keydownListenerCount();
    const promise = confirmDialog('Подтверждение', 'Точно?');
    clickClose(topDialog());
    assert.equal(await promise, false, '× — отказ, промис резолвится false');
    assert.equal(backdrops().length, 0, 'подложка убрана из DOM');
    assert.equal(keydownListenerCount(), baseline, 'слушатели сняты');
  });

  it('closeDialog тоже гонит очистку: onClose зовётся один раз, слушатели сняты', async () => {
    installShim();
    drainDialogs();
    const baseline = keydownListenerCount();
    const promise = confirmDialog('Подтверждение', 'Точно?');
    closeDialog();
    assert.equal(await promise, false, 'closeDialog завершает диалог как отказ');
    assert.equal(backdrops().length, 0);
    assert.equal(keydownListenerCount(), baseline, 'слушатели сняты');
  });

  it('фокус возвращается в поле редактора после «Отменить закрытие» (живой сценарий)', () => {
    installShim();
    drainDialogs();
    const editor = openEditor();
    editor.input.value = 'правка';
    pressKey('Escape');
    const confirm = topDialog();
    buttonByLabel(confirm, t('dialog.unsaved.stay')).click();

    assert.equal(backdrops().length, 1, 'редактор остался открыт');
    assert.equal(active(), editor.input, 'фокус вернулся в поле редактора, а не на body');
  });
});

describe('фокус верхнего диалога и ловушка Tab (0c45bce8)', () => {
  it('подтверждение над редактором забирает фокус у нижележащего диалога', () => {
    installShim();
    drainDialogs();
    const editor = openEditor();
    assert.equal(active(), editor.input, 'при открытии редактора курсор — в его поле');

    editor.input.value = 'правка';
    pressKey('Escape');
    assert.equal(backdrops().length, 2, 'поверх редактора открылось подтверждение');

    const confirm = topDialog();
    const current = active();
    assert.ok(current !== null, 'у подтверждения есть активный элемент');
    assert.ok(
      confirm.contains(current!),
      'фокус — в подтверждении, а не в нижележащем диалоге',
    );
    assert.notEqual(current, editor.input, 'фокус ушёл из редактора');
  });

  it('Tab из чужого места возвращает фокус в верхний диалог', () => {
    installShim();
    drainDialogs();
    const editor = openEditor();
    editor.input.value = 'правка';
    pressKey('Escape');
    const confirm = topDialog();

    // Симулируем «фокус остался в редакторе» (исходный симптом).
    doc().activeElement = editor.input;
    pressKey('Tab');
    const afterTab = active();
    assert.ok(afterTab !== null && confirm.contains(afterTab), 'Tab завёл фокус в подтверждение');

    doc().activeElement = editor.input;
    pressKey('Tab', { shiftKey: true });
    const afterShiftTab = active();
    assert.ok(
      afterShiftTab !== null && confirm.contains(afterShiftTab),
      'Shift+Tab тоже заводит фокус в подтверждение',
    );
  });

  it('Tab не покидает верхний диалог: на краях заворачивается внутрь', () => {
    installShim();
    drainDialogs();
    const editor = openEditor();
    editor.input.value = 'правка';
    pressKey('Escape');
    const confirm = topDialog();

    const focusables = confirm.findAll((el) => el.tagName === 'button');
    assert.ok(focusables.length >= 2, 'в подтверждении есть кнопки');
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;

    // Фокус на последнем — Tab заворачивает на первый, оставаясь в диалоге.
    doc().activeElement = last;
    last.focused = false;
    pressKey('Tab');
    const afterWrap = active();
    assert.equal(afterWrap, first, 'Tab с последнего элемента завернулся на первый');
    assert.equal(confirm.contains(first), true, 'фокус не покинул подтверждение');

    // Фокус на первом — Shift+Tab заворачивает на последний.
    doc().activeElement = first;
    pressKey('Tab', { shiftKey: true });
    assert.equal(active(), last, 'Shift+Tab с первого элемента завернулся на последний');
  });

  it('стрелки ходят по кнопкам панели кнопок подтверждения', () => {
    installShim();
    drainDialogs();
    const editor = openEditor();
    editor.input.value = 'правка';
    pressKey('Escape');
    const confirm = topDialog();

    const stay = buttonByLabel(confirm, t('dialog.unsaved.stay'));
    const discard = buttonByLabel(confirm, t('dialog.unsaved.discard'));
    const save = buttonByLabel(confirm, t('dialog.unsaved.save'));

    doc().activeElement = stay;
    pressKey('ArrowRight');
    assert.equal(active(), discard, '→ перевела фокус на следующую кнопку');
    pressKey('ArrowRight');
    assert.equal(active(), save, '→ перевела фокус на последнюю кнопку');
    pressKey('ArrowRight');
    assert.equal(active(), stay, '→ с последней кнопки завернула на первую');
    pressKey('ArrowLeft');
    assert.equal(active(), save, '← с первой кнопки завернула на последнюю');
  });

  it('после «Отменить закрытие» фокус возвращается в редактор', () => {
    installShim();
    drainDialogs();
    const editor = openEditor();
    editor.input.value = 'правка';
    pressKey('Escape');
    const confirm = topDialog();
    buttonByLabel(confirm, t('dialog.unsaved.stay')).click();

    assert.equal(backdrops().length, 1, 'подтверждение закрыто, редактор на месте');
    const current = active();
    assert.ok(current !== null, 'фокус куда-то вернулся');
    assert.equal(
      backdrops()[0]!.contains(current!),
      true,
      'фокус вернулся в нижележащий (оставшийся) диалог, а не на body',
    );
  });
});
