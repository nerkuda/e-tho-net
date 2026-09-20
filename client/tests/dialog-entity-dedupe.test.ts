/**
 * Тесты защиты от повторного открытия редактора одной сущности
 * (ошибка c2d243bb «Двойной клик по строке типа открывает два редактора
 * одного типа»).
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
 *   3. Регрессии: клик по строке списка по-прежнему открывает редактор
 *      переданного типа; «новый тип»/«новое свойство» (id ещё нет) не
 *      дедуплицируются; понятие текущей строки списка типов (`currentRowId`)
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

/** Элемент с класс-листом, привязанным к `className` (как в add-dialog.test.ts). */
class ShimClassList {
  private owner: ShimElement | null = null;

  attach(owner: ShimElement): void {
    this.owner = owner;
  }

  private tokens(): Set<string> {
    return new Set((this.owner?.className ?? '').split(/\s+/).filter((t) => t !== ''));
  }

  private write(tokens: Set<string>): void {
    if (this.owner !== null) this.owner.className = [...tokens].join(' ');
  }

  add(...names: string[]): void {
    const tokens = this.tokens();
    names.forEach((n) => tokens.add(n));
    this.write(tokens);
  }

  remove(...names: string[]): void {
    const tokens = this.tokens();
    names.forEach((n) => tokens.delete(n));
    this.write(tokens);
  }

  contains(name: string): boolean {
    return this.tokens().has(name);
  }

  toggle(name: string, force?: boolean): void {
    const tokens = this.tokens();
    const next = force ?? !tokens.has(name);
    if (next) tokens.add(name);
    else tokens.delete(name);
    this.write(tokens);
  }
}

/** Последний элемент, получивший фокус (у шима нет слоя отрисовки). */
let focused: ShimElement | null = null;

/** Минимальный элемент, переживающий сборку и поднятие диалога. */
class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  parent: ShimElement | null = null;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = '';
  innerHTML = '';
  value = '';
  type = '';
  title = '';
  placeholder = '';
  disabled = false;
  offsetWidth = 0;
  classList = new ShimClassList();
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(tag: string, className?: string, text?: string) {
    this.tagName = tag;
    this.classList.attach(this);
    if (className !== undefined) this.className = className;
    if (text !== undefined) this.textContent = text;
  }

  /** Как настоящий DOM: узел, уже лежащий в дереве, переносится, а не дублируется. */
  append(...nodes: ShimElement[]): void {
    for (const node of nodes) {
      if (node.parent !== null) {
        const index = node.parent.children.indexOf(node);
        if (index >= 0) node.parent.children.splice(index, 1);
      }
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: ShimElement[]): void {
    this.children = [];
    this.append(...nodes);
  }

  remove(): void {
    if (this.parent !== null) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
      this.parent = null;
    }
    this.emit('remove');
  }

  contains(node: ShimElement | null): boolean {
    if (node === null) return false;
    return node === this || this.children.some((child) => child.contains(node));
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((fn) => fn !== listener));
  }

  emit(type: string, event: any = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  /** Один токен: тег (`input`) или класс (`.dialog-body`) — как в add-dialog.test.ts. */
  querySelectorAll(selector: string): ShimElement[] {
    const byTag = !selector.startsWith('.');
    const token = byTag ? selector : selector.slice(1);
    const hits: ShimElement[] = [];
    const walk = (node: ShimElement): void => {
      const match = byTag ? node.tagName === token : node.className.split(/\s+/).includes(token);
      if (match) hits.push(node);
      node.children.forEach(walk);
    };
    this.children.forEach(walk);
    return hits;
  }

  querySelector(selector: string): ShimElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  focus(): void {
    focused = this;
  }

  setAttribute(name: string, value: string): void {
    this.dataset[name] = value;
  }
}

/** Устанавливает шим document/window (каркас диалогов читает оба). */
function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
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
  const input = new ShimElement('input');
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

describe('ключи редакторов сущностей (c2d243bb)', () => {
  it('ключ типа мысли и свойства — по id сущности', () => {
    assert.equal(thoughtTypeDialogKey('abc'), 'thought-type:abc');
    assert.equal(propertyDialogKey('xyz'), 'property:xyz');
    assert.notEqual(thoughtTypeDialogKey('abc'), propertyDialogKey('abc'));
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

describe('защита подключена в редакторах (c2d243bb)', () => {
  it('редактор типа мысли проверяет повторное открытие и регистрирует ключ', () => {
    const src = source(TYPE_MANAGER_SOURCE);
    // Проверка стоит в начале функции — до захвата блокировки и сборки тела.
    const guardIdx = src.indexOf('raiseOpenDialog(thoughtTypeDialogKey(type.id))');
    const lockIdx = src.indexOf("acquireOrShowBlocked('thought_type'", guardIdx);
    assert.ok(guardIdx > 0, 'нет проверки повторного открытия редактора типа');
    assert.ok(lockIdx > guardIdx, 'проверка должна стоять до захвата блокировки');
    assert.ok(
      src.includes('dedupeKey: type !== null ? thoughtTypeDialogKey(type.id) : undefined'),
      'диалог не регистрирует ключ сущности',
    );
    assert.ok(
      src.includes('if (type !== null && raiseOpenDialog'),
      'новый тип (без id) должен открываться свободно — условие только для существующего',
    );
  });

  it('редактор свойства проверяет повторное открытие и регистрирует ключ', () => {
    const src = source(PROPERTY_MANAGER_SOURCE);
    const guardIdx = src.indexOf('raiseOpenDialog(propertyDialogKey(property.id))');
    const lockIdx = src.indexOf("acquireOrShowBlocked('property'", guardIdx);
    assert.ok(guardIdx > 0, 'нет проверки повторного открытия редактора свойства');
    assert.ok(lockIdx > guardIdx, 'проверка должна стоять до захвата блокировки');
    assert.ok(
      src.includes('dedupeKey: property !== null ? propertyDialogKey(property.id) : undefined'),
      'диалог свойства не регистрирует ключ сущности',
    );
    assert.ok(
      src.includes('if (property !== null && raiseOpenDialog'),
      'новое свойство (без id) должно открываться свободно',
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
    const listenerIdx = src.indexOf("tr.addEventListener('click'");
    const block = src.slice(listenerIdx, listenerIdx + 260);
    assert.ok(block.includes("closest('button')"), 'клик по кнопке ▸/▾/✕ не должен открывать редактор');
    assert.ok(block.includes('showThoughtTypeEditor(type, onChanged)'), 'строка не открывает редактор');
  });

  it('понятие текущей строки и запись списка не затронуты защитой', () => {
    const src = source(TYPE_MANAGER_SOURCE);
    assert.ok(src.includes('currentRowId'), 'нет понятия текущей строки');
    assert.ok(src.includes("tr.classList.add('selected')"), 'текущая строка не подсвечивается');
    assert.ok(src.includes('onChanged(current.id)'), 'список не получает id записанного типа');
    assert.ok(
      src.includes('if (appliedTypeId !== undefined) currentRowId = appliedTypeId;'),
      '«Записать»/«Применить и закрыть» не делают строку текущей',
    );
  });
});
