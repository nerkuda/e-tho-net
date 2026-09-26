/**
 * Закрытие диалога-редактора с несохранёнными изменениями (требование b58f6aad
 * «Закрытие диалога-редактора с изменениями требует подтверждения», 0.9.1).
 *
 * Контракт каркаса `lib/dialog.ts`: редактор объявляет `dirty`
 * ({@link DialogDirtyGuard}); при изменениях закрытие по Esc и крестику
 * перехватывается подтверждением «Данные изменены. Сохранить изменения?» с
 * кнопками «Сохранить» / «Не сохранять» / «Отменить закрытие». Явная кнопка
 * «Отмена» в футере закрывает редактор молча, отбрасывая изменения.
 *
 * Форма-образец — редактор с одним полем и кнопкой записи, повторяющий
 * реальный редактор сущности (поле сравнивается с загруженным значением).
 * Дом — общий shim (`dom-shim.ts`, конвенция `dialog-entity-dedupe.test.ts`).
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

const { showDialog, closeDialog } = await import('../src/renderer/lib/dialog.js');
const { t } = await import('../src/renderer/lib/i18n.js');
const { div } = await import('../src/renderer/lib/dom.js');

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Все подложки открытых диалогов: редактор первым, подтверждение последним. */
function backdrops(): ShimElement[] {
  return body().children.filter((c) => c.classList.contains('dialog-backdrop'));
}

/** Кнопка футера диалога по подписи. */
function buttonByLabel(backdrop: ShimElement, label: string): ShimElement {
  const btn = backdrop.querySelectorAll('button').find((b) => b.textContent === label);
  assert.ok(btn !== undefined, `в футере есть кнопка «${label}»`);
  return btn!;
}

/** Клик по × в заголовке диалога. */
function clickClose(backdrop: ShimElement): void {
  const closeBtn = backdrop.querySelector('.ui-btn--ghost');
  assert.ok(closeBtn !== null, 'в заголовке есть ×');
  closeBtn!.click();
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

interface Editor {
  input: ShimElement;
  saved: () => boolean;
}

/**
 * Форма-образец редактора сущности: поле с загруженным значением и запись.
 * `dirty.isDirty` сравнивает текущее значение поля с загруженным, `save`
 * помечает запись выполненной и закрывает диалог.
 */
function openEditor(): Editor {
  const input = (globalThis as any).document.createElement('input') as ShimElement;
  input.value = '';
  const bodyEl = div('form-stack');
  bodyEl.append(input as unknown as Node);
  let saved = false;
  showDialog({
    title: 'Редактор сущности',
    size: 'm',
    body: bodyEl,
    dirty: {
      isDirty: () => input.value !== '',
      save: (close) => {
        saved = true;
        close();
      },
    },
    buttons: [
      { label: t('actions.cancel') },
      { label: t('actions.apply'), primary: true },
    ],
  });
  return { input, saved: () => saved };
}

describe('подтверждение закрытия «грязного» редактора (b58f6aad)', () => {
  it('Esc при изменениях открывает подтверждение, редактор остаётся', () => {
    installShim();
    drainDialogs();
    const editor = openEditor();
    editor.input.value = 'правка';
    pressEscape();
    assert.equal(backdrops().length, 2, 'поверх редактора открылось подтверждение');
    const confirm = backdrops()[1]!;
    assert.ok(
      confirm.flatText().includes(t('dialog.unsaved.message')),
      'подтверждение несёт требуемый текст',
    );
    assert.equal(editor.saved(), false, 'запись не выполнялась');
  });

  it('«Отменить закрытие» оставляет редактор открытым и не пишет', () => {
    installShim();
    drainDialogs();
    const editor = openEditor();
    editor.input.value = 'правка';
    pressEscape();
    const confirm = backdrops()[1]!;
    buttonByLabel(confirm, t('dialog.unsaved.stay')).click();
    assert.equal(backdrops().length, 1, 'подтверждение закрыто, редактор на месте');
    assert.equal(editor.saved(), false, 'запись не выполнялась');
    // Esc на подтверждении — тоже «отменить закрытие».
    pressEscape();
    pressEscape();
    assert.equal(backdrops().length, 1, 'Esc на подтверждении не закрывает редактор');
  });

  it('крестик при изменениях: «Не сохранять» закрывает без записи', () => {
    installShim();
    drainDialogs();
    const editor = openEditor();
    editor.input.value = 'правка';
    clickClose(backdrops()[0]!);
    assert.equal(backdrops().length, 2, 'крестик тоже перехвачен подтверждением');
    buttonByLabel(backdrops()[1]!, t('dialog.unsaved.discard')).click();
    assert.equal(backdrops().length, 0, 'редактор закрыт без записи');
    assert.equal(editor.saved(), false, 'запись не выполнялась');
  });

  it('крестик при изменениях: «Сохранить» пишет и закрывает', () => {
    installShim();
    drainDialogs();
    const editor = openEditor();
    editor.input.value = 'правка';
    clickClose(backdrops()[0]!);
    buttonByLabel(backdrops()[1]!, t('dialog.unsaved.save')).click();
    assert.equal(editor.saved(), true, 'запись выполнена');
    assert.equal(backdrops().length, 0, 'редактор закрыт');
  });

  it('явная «Отмена» закрывает молча, без подтверждения и записи', () => {
    installShim();
    drainDialogs();
    const editor = openEditor();
    editor.input.value = 'правка';
    buttonByLabel(backdrops()[0]!, t('actions.cancel')).click();
    assert.equal(backdrops().length, 0, 'подтверждение не показывалось');
    assert.equal(editor.saved(), false, 'изменения отброшены без записи');
  });

  it('чистая форма: Esc и крестик закрывают без подтверждения', () => {
    installShim();
    drainDialogs();
    openEditor();
    pressEscape();
    assert.equal(backdrops().length, 0, 'Esc на чистой форме закрывает сразу');
    installShim();
    drainDialogs();
    openEditor();
    clickClose(backdrops()[0]!);
    assert.equal(backdrops().length, 0, 'крестик на чистой форме закрывает сразу');
  });

  it('после отмены правки форма снова чистая — Esc закрывает', () => {
    installShim();
    drainDialogs();
    const editor = openEditor();
    editor.input.value = 'правка';
    pressEscape();
    buttonByLabel(backdrops()[1]!, t('dialog.unsaved.stay')).click();
    editor.input.value = '';
    pressEscape();
    assert.equal(backdrops().length, 0, 'значение совпало с загруженным — подтверждения нет');
  });
});
