/**
 * После закрытия диалога фокус возвращается вызвавшему списку (ошибка
 * 28d69bc6, правило 10 требования 11ddd910 «Единые правила диалогов-списков»).
 *
 * Что закрепляем (каркас `lib/dialog.ts`):
 *   1. Каркас запоминает элемент, владевший фокусом до показа диалога, и
 *      возвращает ему фокус при закрытии ЛЮБЫМ путём (Esc, ×, кнопка футера,
 *      `closeDialog`).
 *   2. Стопка диалогов: закрытие верхнего возвращает фокус элементу нижнего,
 *      закрытие нижнего — списку.
 *
 * Дом — минимальный шим (конвенция `dialog-backdrop-close.test.ts`).
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

const { closeDialog, showDialog } = await import('../src/renderer/lib/dialog.js');

function doc(): any {
  return (globalThis as any).document;
}

function body(): ShimElement {
  return doc().body as ShimElement;
}

/** Создаёт подключённый к документу элемент (isConnected === true). */
function attached(tag: string): ShimElement {
  const node = new ShimElement(tag);
  body().append(node);
  return node;
}

/** Открывает диалог; `focusedBefore` — активный элемент на момент показа. */
function openDialog(title: string, focusedBefore: ShimElement): ShimElement {
  doc().activeElement = focusedBefore;
  showDialog({ title, body: attached('div') as unknown as HTMLElement });
  return body().children.filter((c) => c.classList.contains('dialog-backdrop')).at(-1)!;
}

describe('возврат фокуса списку после закрытия диалога (28d69bc6)', () => {
  it('closeDialog возвращает фокус владельцу фокуса до показа', () => {
    installShim();
    const list = attached('div');
    list.focused = false;
    openDialog('Редактор', list);
    assert.equal(list.focused, false, 'до закрытия фокус у диалога, а не у списка');
    closeDialog();
    assert.equal(list.focused, true, 'после закрытия фокус вернулся списку');
  });

  it('Esc и кнопка футера тоже возвращают фокус', () => {
    installShim();
    const list = attached('div');
    openDialog('Редактор', list);
    closeDialog();
    assert.equal(list.focused, true);

    const list2 = attached('div');
    list2.focused = false;
    openDialog('Ещё', list2);
    const backdrop = body().children.filter((c) => c.classList.contains('dialog-backdrop')).at(-1)!;
    const closeBtn = backdrop.querySelector('.ui-btn--ghost');
    assert.ok(closeBtn !== null, 'в заголовке есть ×');
    closeBtn!.click();
    assert.equal(list2.focused, true, '× возвращает фокус списку');
  });

  it('стопка диалогов: закрытие верхнего возвращает фокус нижнему', () => {
    installShim();
    const list = attached('div');
    const field = attached('input');
    openDialog('Нижний', list);
    openDialog('Верхний', field);
    closeDialog();
    assert.equal(field.focused, true, 'верхний закрылся — фокус у элемента нижнего');
    assert.equal(list.focused, false, 'фокус списка ещё не возвращён');
    closeDialog();
    assert.equal(list.focused, true, 'нижний закрылся — фокус вернулся списку');
  });

  it('не тронутый DOM: фокус не ставится удалённому элементу', () => {
    installShim();
    const list = attached('div');
    openDialog('Редактор', list);
    body().removeChild(list);
    list.isConnected = false;
    closeDialog();
    assert.equal(list.focused, false, 'удалённому элементу фокус не навязываем');
  });

  it('нет активного элемента — закрытие не падает и ничего не фокусирует', () => {
    installShim();
    doc().activeElement = null;
    showDialog({ title: 'Диалог', body: attached('div') as unknown as HTMLElement });
    closeDialog();
    assert.equal(
      body().children.filter((c) => c.classList.contains('dialog-backdrop')).length,
      0,
      'диалог закрылся без ошибок',
    );
  });

  // Ошибка 28d69bc6 (переоткрыта): редактор открывают кнопкой тулбара или
  // пунктом меню — `document.activeElement` в этот момент кнопка, а после
  // закрытия меню вообще `body`. Возврат фокуса туда не оживляет стрелки.
  // Фокус обязан уходить ЯКОРЮ списка (`data-focus-anchor`) — корню дерева,
  // который переживает перерисовку строк.
  it('редактор над диалогом-списком: фокус уходит дереву, стрелки двигают строку', async () => {
    installShim();
    const { createTree } = await import('../src/renderer/lib/ui/tree.js');
    type Node_ = { id: string; parentId?: string | null };
    const items: Node_[] = [
      { id: 'one', parentId: null },
      { id: 'two', parentId: null },
    ];
    const host = new ShimElement('div');
    const tree = createTree<Node_>({
      items,
      renderContent: () => new ShimElement('span') as unknown as HTMLElement,
    });
    const root = tree.root as unknown as ShimElement;
    const editBtn = new ShimElement('button');
    const listBody = new ShimElement('div');
    listBody.append(editBtn, root);
    host.append(listBody);

    // Диалог-список «Типы мыслей».
    showDialog({ title: 'Типы мыслей', body: listBody as unknown as HTMLElement });
    // Пользователь нажал кнопку тулбара — фокус у неё (как в браузере).
    doc().activeElement = editBtn;
    // Редактор типа открывается НАД диалогом-списком.
    openDialog('Редактор типа', editBtn);
    // Список перерисован (тип записан): узлы строк пересозданы, корень — тот же.
    tree.render();
    editBtn.focused = false;
    root.focused = false;

    closeDialog();
    assert.equal(root.focused, true, 'фокус вернулся якорю дерева, а не кнопке');
    assert.equal(editBtn.focused, false, 'кнопка фокус не удерживает');

    const before = tree.getCurrentId();
    root.emit('keydown', { key: 'ArrowDown', preventDefault: () => undefined });
    assert.notEqual(tree.getCurrentId(), before, 'стрелка двигает текущую строку без клика');

    closeDialog(); // закрыть диалог-список — стек пуст для следующих тестов
    assert.equal(
      body().children.filter((c) => c.classList.contains('dialog-backdrop')).length,
      0,
      'оба диалога закрыты',
    );
  });

  it('владелец фокуса отвязан (меню закрыто): фокус уходит живому якорю дерева', async () => {
    installShim();
    const { createTree } = await import('../src/renderer/lib/ui/tree.js');
    const tree = createTree<{ id: string }>({
      items: [{ id: 'only' }],
      renderContent: () => new ShimElement('span') as unknown as HTMLElement,
    });
    const root = tree.root as unknown as ShimElement;
    const listBody = new ShimElement('div');
    listBody.append(root);
    showDialog({ title: 'Типы мыслей', body: listBody as unknown as HTMLElement });

    // Пункт контекстного меню: к моменту открытия редактора меню уже удалено,
    // `document.activeElement` — отвязанный узел.
    const menuItem = new ShimElement('button');
    menuItem.isConnected = false;
    doc().activeElement = menuItem;
    openDialog('Редактор типа', menuItem);

    closeDialog();
    assert.equal(root.focused, true, 'фокус ушёл живому контейнеру списка');
    assert.equal(menuItem.focused, false, 'отвязанному узлу фокус не навязываем');

    closeDialog();
  });
});
