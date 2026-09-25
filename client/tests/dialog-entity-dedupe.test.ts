/**
 * Тесты защиты от повторного открытия редактора одной сущности
 * (ошибки c2d243bb «Двойной клик по строке типа открывает два редактора
 * одного типа» и 74d9b4ed «Повторный клик по «Добавить» открывает два
 * редактора новой сущности»).
 *
 * Что закрепляем:
 *   1. Механизм каркаса диалогов (`lib/dialog.ts`): диалог с `dedupeKey`
 *      находится `raiseOpenDialog`, уже открытый поднимается наверх стопки и
 *      получает фокус, второго диалога не появляется; ключ снимается при
 *      закрытии. Диалог ДРУГОЙ сущности открывается поверх свободно — стопка
 *      диалогов сохранена.
 *   2. Ключи редакторов (`thoughtTypeDialogKey` / `propertyDialogKey`) и их
 *      подключение в `showThoughtTypeEditor` / `openPropertyManagerEditor` —
 *      проверка повторного открытия стоит до сборки тела диалога, а сам факт
 *      открытия регистрируется через `dedupeKey`.
 *   3. Редактор ЕЩЁ НЕ созданной сущности тоже дедуплицируется (74d9b4ed):
 *      `thought-type:new` / `property:new` — сеансовый ключ на все точки
 *      создания; повторный вход поднимает открытый редактор, после закрытия
 *      ключ свободен, разные виды сосуществуют, «Записать» (keepOpen) ключ не
 *      снимает.
 *   4. Регрессии: клик по строке списка по-прежнему открывает редактор
 *      переданного типа; понятие текущей строки списка типов (`currentRowId`)
 *      не затронуто.
 *
 * Дом — минимальный шим (конвенция соседних тестов, см. `add-dialog.test.ts`):
 * поведение каркаса диалогов наблюдаемо только с DOM, поэтому здесь шим, а не
 * якоря исходника. `append` шима двигает узел, как настоящий DOM: поднятие
 * диалога переставляет backdrop, а не дублирует его.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

/** Последний элемент, получивший фокус (у шима нет слоя отрисовки). */
let focused: ShimElement | null = null;

/**
 * Шим с датчиком фокуса: тест наблюдает, куда каркас перевёл фокус при поднятии
 * диалога (`document.activeElement` шим не ведёт).
 */
class FocusTrackingElement extends ShimElement {
  override focus(): void {
    super.focus();
    recordFocus(this);
  }
}

/** Запоминает элемент, получивший фокус (передача `this` без aliasing). */
function recordFocus(el: ShimElement): void {
  focused = el;
}

/** Устанавливает шим document/window (каркас диалогов читает оба). */
function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new FocusTrackingElement(tag),
    createElementNS: (_ns: string, tag: string) => new FocusTrackingElement(tag),
    documentElement: new FocusTrackingElement('html'),
    body: new FocusTrackingElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

installShim();

const { closeDialog, raiseOpenDialog, showDialog } = await import(
  '../src/renderer/lib/dialog.js'
);
const { thoughtTypeDialogKey } = await import('../src/renderer/screens/type-manager.js');
const { propertyDialogKey } = await import('../src/renderer/screens/property-manager.js');

/** Устанавливает фокус-датчик в исходное состояние перед диалогом. */
function resetFocus(): void {
  focused = null;
}

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Открытые backdrop'и в DOM (порядок = порядок отрисовки). */
function backdrops(): ShimElement[] {
  return body().children.filter((child) => child.classList.contains('dialog-backdrop'));
}

/** Заголовок диалога (для проверки, какой именно диалог остался/поднят). */
function titleOf(backdrop: ShimElement): string {
  return backdrop.querySelector('.dialog-title')?.textContent ?? '';
}

/** Открывает диалог с полем ввода внутри и возвращает его backdrop. */
function openDialog(key: string | undefined, title: string): ShimElement {
  const input = new FocusTrackingElement('input');
  const dialogBody = new ShimElement('div', 'dialog-body');
  dialogBody.append(input);
  showDialog({ title, body: dialogBody as unknown as HTMLElement, dedupeKey: key });
  return backdrops()[backdrops().length - 1]!;
}

describe('raiseOpenDialog — повторное открытие редактора одной сущности (c2d243bb)', () => {
  it('повторное открытие того же типа поднимает существующий, второго диалога нет', () => {
    openDialog(thoughtTypeDialogKey('t1'), 'Тип мысли');
    assert.equal(backdrops().length, 1, 'открыт ровно один диалог');

    // Второй клик по той же строке: вызывающий (showThoughtTypeEditor) сначала
    // спрашивает каркас — диалог уже открыт, второй не создаётся.
    assert.equal(raiseOpenDialog(thoughtTypeDialogKey('t1')), true, 'существующий диалог поднят');
    assert.equal(backdrops().length, 1, 'второй диалог того же типа не создан');

    closeDialog();
    assert.equal(backdrops().length, 0);
  });

  it('другой тип открывается поверх свободно — стопка диалогов не ломается', () => {
    openDialog(thoughtTypeDialogKey('t1'), 'Тип t1');
    assert.equal(raiseOpenDialog(thoughtTypeDialogKey('t2')), false, 'другой тип не поднимается');

    openDialog(thoughtTypeDialogKey('t2'), 'Тип t2');
    assert.equal(backdrops().length, 2, 'редактор другого типа открылся поверх');

    closeDialog();
    closeDialog();
    assert.equal(backdrops().length, 0);
  });

  it('поднятый диалог становится верхним в стопке (Esc/Ctrl+Enter — снова на нём)', () => {
    openDialog(thoughtTypeDialogKey('t1'), 'Тип t1');
    openDialog(thoughtTypeDialogKey('t2'), 'Тип t2');
    // Верхний сейчас t2; повторный клик по t1 поднимает его наверх.
    assert.equal(raiseOpenDialog(thoughtTypeDialogKey('t1')), true);
    closeDialog();
    const left = backdrops();
    assert.equal(left.length, 1, 'закрыт ровно один диалог');
    assert.equal(titleOf(left[0]!), 'Тип t2', 'закрылся верхний — поднятый t1, остался t2');
    closeDialog();
  });

  it('поднятие ставит фокус в первое поле и подсвечивает диалог', () => {
    const backdrop = openDialog(thoughtTypeDialogKey('t1'), 'Тип t1');
    resetFocus();
    assert.equal(raiseOpenDialog(thoughtTypeDialogKey('t1')), true);
    assert.equal(
      focused,
      backdrop.querySelector('input'),
      'фокус перешёл в первое поле уже открытого диалога',
    );
    assert.equal(backdrop.classList.contains('dialog-raised'), true, 'диалог подсвечен');
    closeDialog();
  });

  it('ключ снимается при закрытии — диалог можно открыть заново', () => {
    openDialog(thoughtTypeDialogKey('t1'), 'Тип t1');
    closeDialog();
    assert.equal(raiseOpenDialog(thoughtTypeDialogKey('t1')), false, 'после закрытия ключа нет');
  });

  it('диалог без ключа не участвует в дедупликации', () => {
    openDialog(undefined, 'Новый тип мысли');
    assert.equal(raiseOpenDialog(thoughtTypeDialogKey('t1')), false);
    assert.equal(raiseOpenDialog(''), false);
    // Безымянные диалоги стакаются как раньше.
    openDialog(undefined, 'Ещё новый тип мысли');
    assert.equal(backdrops().length, 2);
    closeDialog();
    closeDialog();
  });

  it('subscribe: закрытие диалога запускает onClose ровно один раз', () => {
    let closes = 0;
    const dialogBody = new ShimElement('div', 'dialog-body');
    showDialog({
      title: 'Тип t1',
      body: dialogBody as unknown as HTMLElement,
      dedupeKey: thoughtTypeDialogKey('t1'),
      onClose: () => {
        closes += 1;
      },
    });
    closeDialog();
    assert.equal(closes, 1);
    closeDialog();
    assert.equal(closes, 1, 'повторное закрытие не считает второй onClose');
  });
});

describe('ключи редакторов сущностей (c2d243bb, 74d9b4ed)', () => {
  it('ключ типа мысли и свойства — по id сущности', () => {
    assert.equal(thoughtTypeDialogKey('abc'), 'thought-type:abc');
    assert.equal(propertyDialogKey('xyz'), 'property:xyz');
    assert.notEqual(thoughtTypeDialogKey('abc'), propertyDialogKey('abc'));
  });

  it('ключ ещё не созданной сущности — сеансовый ключ вида', () => {
    assert.equal(thoughtTypeDialogKey(null), 'thought-type:new');
    assert.equal(propertyDialogKey(null), 'property:new');
    assert.notEqual(thoughtTypeDialogKey(null), propertyDialogKey(null));
    assert.notEqual(thoughtTypeDialogKey(null), thoughtTypeDialogKey('abc'));
  });
});

describe('raiseOpenDialog — редактор ещё не созданной сущности (74d9b4ed)', () => {
  it('повторное «Добавить» при открытом редакторе создания второй не создаёт', () => {
    openDialog(thoughtTypeDialogKey(null), 'Новый тип мысли');
    assert.equal(backdrops().length, 1, 'открыт ровно один редактор создания');

    // Второй клик по «Добавить»/«Создать новый»: вызывающий сначала спрашивает
    // каркас — диалог уже открыт, второй не создаётся.
    assert.equal(
      raiseOpenDialog(thoughtTypeDialogKey(null)),
      true,
      'открытый редактор создания поднят',
    );
    assert.equal(backdrops().length, 1, 'второй редактор создания не создан');
    closeDialog();
    assert.equal(backdrops().length, 0);
  });

  it('после закрытия ключ свободен — следующее «Добавить» открывает свежий редактор', () => {
    openDialog(thoughtTypeDialogKey(null), 'Новый тип мысли');
    closeDialog();
    assert.equal(
      raiseOpenDialog(thoughtTypeDialogKey(null)),
      false,
      'после закрытия редактора создания ключ снят',
    );
  });

  it('редакторы разных видов (новый тип + новое свойство) сосуществуют', () => {
    openDialog(thoughtTypeDialogKey(null), 'Новый тип мысли');
    assert.equal(
      raiseOpenDialog(propertyDialogKey(null)),
      false,
      'новый тип и новое свойство — разные ключи',
    );
    openDialog(propertyDialogKey(null), 'Новое свойство');
    assert.equal(backdrops().length, 2, 'оба редактора создания открыты одновременно');
    closeDialog();
    closeDialog();
    assert.equal(backdrops().length, 0);
  });

  it('ключ создания не мешает редактору существующей сущности', () => {
    openDialog(thoughtTypeDialogKey(null), 'Новый тип мысли');
    assert.equal(raiseOpenDialog(thoughtTypeDialogKey('t1')), false);
    openDialog(thoughtTypeDialogKey('t1'), 'Тип t1');
    assert.equal(backdrops().length, 2, 'редактор существующего типа открылся поверх создания');
    closeDialog();
    closeDialog();
  });

  it('«Записать» (keepOpen) не снимает ключ — он живёт до закрытия диалога', () => {
    let clicks = 0;
    const dialogBody = new ShimElement('div', 'dialog-body');
    showDialog({
      title: 'Новый тип мысли',
      body: dialogBody as unknown as HTMLElement,
      dedupeKey: thoughtTypeDialogKey(null),
      buttons: [
        { label: 'Отмена' },
        {
          label: 'Записать',
          keepOpen: true,
          onClick: () => {
            clicks += 1;
          },
        },
        { label: 'Применить и закрыть', primary: true, keepOpen: true },
      ],
    });
    const backdrop = backdrops()[backdrops().length - 1]!;
    const save = backdrop
      .querySelectorAll('button')
      .find((btn) => btn.textContent === 'Записать');
    assert.ok(save !== undefined, 'кнопка «Записать» есть в диалоге');
    (save as unknown as { emit: (type: string) => void }).emit('click');
    assert.equal(clicks, 1, '«Записать» вызвала запись');
    assert.equal(backdrops().length, 1, 'диалог остался открыт после «Записать»');
    assert.equal(
      raiseOpenDialog(thoughtTypeDialogKey(null)),
      true,
      'ключ создания остаётся занятым до закрытия',
    );
    closeDialog();
    assert.equal(raiseOpenDialog(thoughtTypeDialogKey(null)), false, 'после закрытия ключ снят');
  });
});

const TYPE_MANAGER_SOURCE = resolve(
  import.meta.dirname,
  '..',
  'src',
  'renderer',
  'screens',
  'type-manager.ts',
);
const PROPERTY_MANAGER_SOURCE = resolve(
  import.meta.dirname,
  '..',
  'src',
  'renderer',
  'screens',
  'property-manager.ts',
);

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('защита подключена в редакторах (c2d243bb, 74d9b4ed)', () => {
  it('редактор типа мысли проверяет повторное открытие и регистрирует ключ', () => {
    const src = source(TYPE_MANAGER_SOURCE);
    // Проверка стоит в начале функции — до захвата блокировки и сборки тела,
    // и работает в т.ч. для ещё не созданного типа (ключ `thought-type:new`).
    const guardIdx = src.indexOf('raiseOpenDialog(thoughtTypeDialogKey(type?.id ?? null))');
    const lockIdx = src.indexOf("acquireOrShowBlocked('thought_type'", guardIdx);
    assert.ok(guardIdx > 0, 'нет проверки повторного открытия редактора типа');
    assert.ok(lockIdx > guardIdx, 'проверка должна стоять до захвата блокировки');
    assert.ok(
      src.includes('dedupeKey: thoughtTypeDialogKey(type?.id ?? null)'),
      'диалог не регистрирует ключ сущности (в т.ч. для нового типа)',
    );
    assert.ok(
      !src.includes('type !== null ? thoughtTypeDialogKey(type.id) : undefined'),
      'новый тип не должен оставаться без ключа',
    );
  });

  it('редактор свойства проверяет повторное открытие и регистрирует ключ', () => {
    const src = source(PROPERTY_MANAGER_SOURCE);
    const guardIdx = src.indexOf('raiseOpenDialog(propertyDialogKey(property?.id ?? null))');
    const lockIdx = src.indexOf("acquireOrShowBlocked('property'", guardIdx);
    assert.ok(guardIdx > 0, 'нет проверки повторного открытия редактора свойства');
    assert.ok(lockIdx > guardIdx, 'проверка должна стоять до захвата блокировки');
    assert.ok(
      src.includes('dedupeKey: propertyDialogKey(property?.id ?? null)'),
      'диалог свойства не регистрирует ключ сущности (в т.ч. для нового)',
    );
    assert.ok(
      !src.includes('property !== null ? propertyDialogKey(property.id) : undefined'),
      'новое свойство не должно оставаться без ключа',
    );
  });

  it('журнал активности открывает редакторы через защищённые функции', () => {
    const src = source(
      resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'activity', 'activity.ts'),
    );
    assert.ok(
      src.includes('showThoughtTypeEditor(type, () => undefined)'),
      'активность должна открывать редактор типа через общий защищённый вход',
    );
    assert.ok(
      src.includes('openPropertyManagerEditor(prop, () => undefined)'),
      'активность должна открывать редактор свойства через общий защищённый вход',
    );
  });
});

describe('регрессии списка типов (c2d243bb)', () => {
  it('клик по строке по-прежнему открывает редактор этого типа (мимо кнопок)', () => {
    const src = source(TYPE_MANAGER_SOURCE);
    // Строку дерева рисует общий компонент `lib/ui/tree.ts` (задача d1c15a2d):
    // активация строки — его `onActivate`, кнопки (✕) строку не активируют.
    const listenerIdx = src.indexOf('onActivate:');
    assert.ok(listenerIdx >= 0, 'у дерева типов нет активации строки');
    const block = src.slice(listenerIdx, listenerIdx + 160);
    assert.ok(
      block.includes('showThoughtTypeEditor(item.type, onChanged)'),
      'активация строки не открывает редактор этого типа',
    );
  });

  it('понятие текущей строки и запись списка не затронуты защитой', () => {
    const src = source(TYPE_MANAGER_SOURCE);
    assert.ok(src.includes('currentRowId'), 'нет понятия текущей строки');
    assert.ok(src.includes('tree.setCurrentId(currentRowId)'), 'текущая строка не подсвечивается');
    assert.ok(src.includes('onChanged(current.id)'), 'список не получает id записанного типа');
    assert.ok(
      src.includes('if (appliedTypeId !== undefined) currentRowId = appliedTypeId;'),
      '«Записать»/«Применить и закрыть» не делают строку текущей',
    );
  });
});
