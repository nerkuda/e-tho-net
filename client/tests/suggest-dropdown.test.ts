/**
 * Юнит-тесты единой выпадашки подсказок
 * (client/src/renderer/lib/suggest-dropdown.ts).
 *
 * Критерий приёмки задачи 9a2e30b1: контракт работает одинаково на всех трёх
 * источниках (история / живой поиск / config.options) — навигация стрелками,
 * Enter, клик, Esc и потеря фокуса проверяются для каждого источника одним и
 * тем же набором сценариев. Отдельно — ручное открытие handle.open(), источник
 * `always`, несколько источников сразу, гонки асинхронной загрузки и dispose.
 *
 * Модуль гоняется под Node с минимальным DOM-шимом (тот же подход, что у
 * recent-values.test.ts). Окно шима хранит настоящие capture-слушатели в
 * порядке регистрации — это важно: защита диалога от Esc держится именно на
 * том, что слушатель выпадашки зарегистрирован раньше диалогового, поэтому
 * «диалог» в тестах — фальшивый слушатель, добавленный после подключения.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  historySuggestSource,
  isInsideSuggestDropdown,
  searchSuggestSource,
  optionsSuggestSource,
  wireSuggest,
  type SuggestEntry,
  type SuggestHandle,
  type SuggestSource,
} from '../src/renderer/lib/suggest-dropdown.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// DOM-шим
// ---------------------------------------------------------------------------

/** Keydown-событие нужной модулю формы, со счётчиками потребления. */
function key(name: string, mods: Record<string, boolean> = {}): any {
  return {
    key: name,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    ...mods,
    defaultPrevented: false,
    immediateStopped: false,
    stopPropagation(): void {},
    stopImmediatePropagation(): void {
      this.immediateStopped = true;
    },
    preventDefault(): void {
      this.defaultPrevented = true;
    },
  };
}

/** Mousedown-событие: target + preventDefault. */
function mousedown(target: any): any {
  return {
    target,
    defaultPrevented: false,
    immediateStopped: false,
    stopImmediatePropagation(): void {
      this.immediateStopped = true;
    },
    preventDefault(): void {
      this.defaultPrevented = true;
    },
  };
}

interface ShimWindow {
  innerWidth: number;
  innerHeight: number;
  addEventListener(type: string, listener: (event: any) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: any) => void, capture?: boolean): void;
  /** Тестовый помощник: capture-слушатели по очереди регистрации. */
  dispatchCapture(type: string, event: any): void;
  captureCount(type: string): number;
}

/**
 * Ставит свежие document/window. Window хранит только capture-слушатели
 * (выпадашка и диалог вешают Esc/клик именно в capture) и выполняет их в
 * порядке регистрации с честным stopImmediatePropagation.
 */
function installShim(): { input: ShimElement; body: ShimElement; win: ShimWindow } {
  const input = new ShimElement('input');
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body,
  };
  const capture = new Map<string, Array<(event: any) => void>>();
  const win: ShimWindow = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener(type, listener, captureFlag) {
      if (captureFlag !== true) return;
      const list = capture.get(type) ?? [];
      list.push(listener);
      capture.set(type, list);
    },
    removeEventListener(type, listener, captureFlag) {
      if (captureFlag !== true) return;
      const list = capture.get(type) ?? [];
      capture.set(
        type,
        list.filter((fn) => fn !== listener),
      );
    },
    dispatchCapture(type, event) {
      for (const listener of [...(capture.get(type) ?? [])]) {
        if (event.immediateStopped === true) break;
        listener(event);
      }
    },
    captureCount(type) {
      return (capture.get(type) ?? []).length;
    },
  };
  (globalThis as any).window = win;
  return { input, body, win };
}

/** Даёт осесть асинхронной цепочке открытия списка. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Открытый список (или undefined). */
function openList(body: ShimElement): ShimElement | undefined {
  return body.children.find((c) => c.classList.contains('type-combo-list'));
}

/** Подписи выбираемых строк (заголовки групп пропускаются). */
function rowLabels(body: ShimElement): string[] {
  const list = openList(body);
  if (list === undefined) return [];
  return list.children
    .filter((c) => c.classList.contains('type-combo-item'))
    .map((row) => row.children[0]?.textContent ?? '');
}

/** Выбираемые строки. */
function itemRows(body: ShimElement): ShimElement[] {
  const list = openList(body);
  if (list === undefined) return [];
  return list.children.filter((c) => c.classList.contains('type-combo-item'));
}

/** Заголовки групп открытого списка. */
function groupHeaders(body: ShimElement): string[] {
  const list = openList(body);
  if (list === undefined) return [];
  return list.children
    .filter((c) => c.classList.contains('type-combo-empty'))
    .map((header) => header.textContent);
}

interface Wired {
  input: ShimElement;
  body: ShimElement;
  win: ShimWindow;
  handle: SuggestHandle;
  picked: SuggestEntry[];
}

/** Подключает выпадашку с одним источником; записывает выборы. */
function wire(source: SuggestSource): Wired {
  const { input, body, win } = installShim();
  const picked: SuggestEntry[] = [];
  const handle = wireSuggest(input as unknown as HTMLInputElement, {
    sources: [source],
    onPick: (entry) => picked.push(entry),
  });
  return { input, body, win, handle, picked };
}

/** Выполняет сценарий открытия и ждёт отрисовки списка. */
async function openBy(fn: () => void): Promise<void> {
  fn();
  await flush();
}

/** Esc через window-capture с фальшивым диалогом, слушающим то же нажатие. */
function dialogEsc(win: ShimWindow): { closed: () => number; press: (mods?: Record<string, boolean>) => any } {
  let closed = 0;
  win.addEventListener('keydown', () => {
    closed += 1;
  }, true);
  return {
    closed: () => closed,
    press: (mods) => {
      const evt = key('Escape', mods);
      win.dispatchCapture('keydown', evt);
      return evt;
    },
  };
}

// ---------------------------------------------------------------------------
// Источник «история последних значений»
// ---------------------------------------------------------------------------

describe('suggest-dropdown: история последних значений (when=empty)', () => {
  const entries: SuggestEntry[] = [
    { value: 'v1', label: 'Москва' },
    { value: 'v2', label: 'СПб' },
    { value: 'v3', label: 'Казань' },
  ];

  function source(): SuggestSource {
    return historySuggestSource({ load: () => entries });
  }

  it('фабрика: when=empty, заголовок «Последние значения» по умолчанию', () => {
    const s = source();
    assert.equal(s.when, 'empty');
    assert.equal(s.header, 'Последние значения');
  });

  it('фокус на пустом поле открывает список с заголовком', async () => {
    const w = wire(source());
    await openBy(() => w.input.emit('focus'));
    assert.deepEqual(rowLabels(w.body), ['Москва', 'СПб', 'Казань']);
    assert.deepEqual(groupHeaders(w.body), ['Последние значения']);
    assert.ok(!itemRows(w.body).some((r) => r.classList.contains('active')), 'без выделения');
  });

  it('фокус на заполненном поле ничего не открывает; пустой ответ не открывает', async () => {
    const filled = wire(source());
    filled.input.value = 'СПб';
    await openBy(() => filled.input.emit('focus'));
    assert.equal(openList(filled.body), undefined, 'заполненное поле — без истории');

    const empty = wire(historySuggestSource({ load: () => [] }));
    await openBy(() => empty.input.emit('focus'));
    assert.equal(openList(empty.body), undefined, 'пустая история — без списка');
  });

  it('ввод закрывает список, очистка до пустой строки открывает его снова', async () => {
    const w = wire(source());
    await openBy(() => w.input.emit('focus'));
    assert.equal(rowLabels(w.body).length, 3);

    w.input.value = 'Мос';
    w.input.emit('input');
    assert.equal(openList(w.body), undefined, 'ввод закрывает историю');

    w.input.value = '';
    await openBy(() => w.input.emit('input'));
    assert.deepEqual(rowLabels(w.body), ['Москва', 'СПб', 'Казань']);
  });

  it('клавиатура: ↑/↓ перебирают, Enter выбирает выделенное', async () => {
    const w = wire(source());
    await openBy(() => w.input.emit('focus'));
    const rows = itemRows(w.body);

    const down = key('ArrowDown');
    w.input.emit('keydown', down);
    assert.ok(down.defaultPrevented, 'стрелка потребляется открытым списком');
    assert.ok(rows[0]?.classList.contains('active'), '↓ выделяет первую строку');
    w.input.emit('keydown', key('ArrowDown'));
    assert.ok(rows[1]?.classList.contains('active'), 'вторая ↓ двигает выделение');
    assert.ok(!rows[0]?.classList.contains('active'));
    w.input.emit('keydown', key('ArrowUp'));
    assert.ok(rows[0]?.classList.contains('active'), '↑ возвращает выделение');

    const enter = key('Enter');
    w.input.emit('keydown', enter);
    assert.ok(enter.defaultPrevented, 'Enter потребляется открытым списком');
    assert.deepEqual(w.picked, [entries[0]]);
    assert.equal(openList(w.body), undefined, 'список закрыт после выбора');
  });

  it('Enter без выделения выбирает первую строку', async () => {
    const w = wire(source());
    await openBy(() => w.input.emit('focus'));
    w.input.emit('keydown', key('Enter'));
    assert.deepEqual(w.picked, [entries[0]]);
    assert.equal(openList(w.body), undefined);
  });

  it('Esc: закрывает список, гасит нажатие до диалога, ничего не выбирает', async () => {
    const w = wire(source());
    await openBy(() => w.input.emit('focus'));
    // «Диалог» вешает свой capture-слушатель ПОСЛЕ подключения выпадашки —
    // как showDialog, который регистрирует Esc в конце своего показа.
    const dialog = dialogEsc(w.win);

    const esc = dialog.press();
    assert.ok(esc.immediateStopped, 'Esc погашен — до слушателя диалога не дошёл');
    assert.ok(esc.defaultPrevented);
    assert.equal(dialog.closed(), 0, 'диалог не закрылся');
    assert.equal(openList(w.body), undefined, 'список закрылся');
    assert.deepEqual(w.picked, [], 'выбора не было');
    assert.equal(w.input.value, '', 'поле не тронуто');

    // Список закрыт — Esc снова принадлежит диалогу (событие не погашено).
    dialog.press();
    assert.equal(dialog.closed(), 1, 'закрытый список не держит Esc');

    // Зажатый Esc не должен закрыть список и тут же диалог: повторы гасятся.
    dialog.press({ repeat: true });
    assert.equal(dialog.closed(), 1, 'повтор Esc погашен и без открытого списка');
  });

  it('потеря фокуса: blur и клик мимо закрывают список без выбора', async () => {
    const w = wire(source());
    await openBy(() => w.input.emit('focus'));
    w.input.emit('blur');
    assert.equal(openList(w.body), undefined, 'blur закрывает список');

    await openBy(() => w.input.emit('focus'));
    assert.equal(rowLabels(w.body).length, 3, 'фокус открывает список снова');

    const outside = new ShimElement('button');
    w.win.dispatchCapture('mousedown', mousedown(outside));
    assert.equal(openList(w.body), undefined, 'клик мимо закрывает список');
    assert.deepEqual(w.picked, []);

    // Клик обратно в поле список не закрывает.
    await openBy(() => w.input.emit('focus'));
    w.win.dispatchCapture('mousedown', mousedown(w.input));
    assert.equal(rowLabels(w.body).length, 3, 'клик по полю не закрывает список');
  });

  it('клик по строке выбирает её; mousedown гасится, фокус остаётся в поле', async () => {
    const w = wire(source());
    await openBy(() => w.input.emit('focus'));
    const rows = itemRows(w.body);

    const down = mousedown(rows[1] ?? null);
    rows[1]?.emit('mousedown', down);
    assert.ok(down.defaultPrevented, 'mousedown предотвращён — нет blur-коммита');
    rows[1]?.click();
    assert.deepEqual(w.picked, [entries[1]]);
    assert.equal(openList(w.body), undefined, 'список закрыт после выбора');
  });

  it('handle.open() принудительно открывает историю и на заполненном поле', async () => {
    const w = wire(source());
    w.input.value = 'уже введено';
    w.input.emit('focus');
    await flush();
    assert.equal(openList(w.body), undefined, 'автоматически история не открывается');

    await openBy(() => w.handle.open());
    assert.deepEqual(rowLabels(w.body), ['Москва', 'СПб', 'Казань'], 'все источники, игнорируя when');
  });

  it('ответ, пришедший после ввода или blur, список не открывает', async () => {
    let resolveLoad: (entries: SuggestEntry[]) => void = () => undefined;
    const gate = new Promise<SuggestEntry[]>((resolve) => {
      resolveLoad = resolve;
    });
    const typed = wire(historySuggestSource({ load: () => gate }));
    typed.input.emit('focus');
    typed.input.value = 'Мос';
    typed.input.emit('input');
    resolveLoad(entries);
    await flush();
    assert.equal(openList(typed.body), undefined, 'ввод выиграл гонку — списка нет');

    const blurred = wire(historySuggestSource({ load: () => gate }));
    blurred.input.emit('focus');
    blurred.input.emit('blur');
    resolveLoad(entries);
    await flush();
    assert.equal(openList(blurred.body), undefined, 'blur выиграл гонку — списка нет');
  });
});

// ---------------------------------------------------------------------------
// Источник «живой поиск»
// ---------------------------------------------------------------------------

describe('suggest-dropdown: результаты живого поиска (when=typed)', () => {
  const catalogue: SuggestEntry[] = [
    { value: 'v1', label: 'Москва' },
    { value: 'v2', label: 'Мурманск' },
    { value: 'v3', label: 'СПб' },
  ];
  /** Запросы, дошедшие до load. */
  const queries: string[] = [];

  function source(): SuggestSource {
    return searchSuggestSource({
      load: (query) => {
        queries.push(query);
        return catalogue.filter((e) => e.label.toLowerCase().includes(query.toLowerCase()));
      },
    });
  }

  it('фабрика: when=typed, заголовка по умолчанию нет', () => {
    const s = source();
    assert.equal(s.when, 'typed');
    assert.equal(s.header, undefined);
  });

  it('пустое поле списка не открывает; после первого символа — открывает', async () => {
    const w = wire(source());
    await openBy(() => w.input.emit('focus'));
    assert.equal(openList(w.body), undefined, 'без введённого символа поиска нет');

    queries.length = 0;
    await openBy(() => {
      w.input.value = 'м';
      w.input.emit('input');
    });
    assert.deepEqual(queries, ['м'], 'load получил введённый фрагмент');
    assert.deepEqual(rowLabels(w.body), ['Москва', 'Мурманск']);
    assert.deepEqual(groupHeaders(w.body), [], 'заголовка без header нет');
  });

  it('перепечатывание сужает список тем же открытым элементом', async () => {
    const w = wire(source());
    w.input.value = 'м';
    await openBy(() => w.input.emit('focus'));
    assert.equal(rowLabels(w.body).length, 2);
    const list = openList(w.body);

    queries.length = 0;
    await openBy(() => {
      w.input.value = 'мос';
      w.input.emit('input');
    });
    assert.deepEqual(queries, ['мос'], 'новый запрос — новый фрагмент');
    assert.deepEqual(rowLabels(w.body), ['Москва']);
    assert.equal(openList(w.body), list, 'список перерисован на месте');
  });

  it('клавиатура: Enter выбирает выделенное; без выделения — первое', async () => {
    const w = wire(source());
    w.input.value = 'м';
    await openBy(() => w.input.emit('focus'));
    w.input.emit('keydown', key('ArrowDown'));
    w.input.emit('keydown', key('ArrowDown'));
    const enter = key('Enter');
    w.input.emit('keydown', enter);
    assert.ok(enter.defaultPrevented);
    assert.deepEqual(w.picked, [catalogue[1]]);
    assert.equal(openList(w.body), undefined);

    // Открыть заново: выделения нет, Enter берёт первую строку.
    w.input.emit('focus');
    await openBy(() => w.input.emit('input'));
    w.input.emit('keydown', key('Enter'));
    assert.deepEqual(w.picked, [catalogue[1], catalogue[0]]);
  });

  it('Esc, blur, клик мимо и клик по строке — общий контракт', async () => {
    const w = wire(source());
    w.input.value = 'м';
    await openBy(() => w.input.emit('focus'));

    const dialog = dialogEsc(w.win);
    const esc = dialog.press();
    assert.ok(esc.immediateStopped);
    assert.equal(dialog.closed(), 0, 'диалог не закрылся');
    assert.equal(openList(w.body), undefined);
    assert.deepEqual(w.picked, []);

    await openBy(() => w.input.emit('input'));
    w.input.emit('blur');
    assert.equal(openList(w.body), undefined, 'blur закрывает список');

    // После blur поле нужно снова сфокусировать — как в настоящем браузере.
    await openBy(() => w.input.emit('focus'));
    w.win.dispatchCapture('mousedown', mousedown(new ShimElement('div')));
    assert.equal(openList(w.body), undefined, 'клик мимо закрывает список');

    await openBy(() => w.input.emit('input'));
    const rows = itemRows(w.body);
    const down = mousedown(rows[1] ?? null);
    rows[1]?.emit('mousedown', down);
    assert.ok(down.defaultPrevented);
    rows[1]?.click();
    assert.deepEqual(w.picked, [catalogue[1]]);
    assert.equal(openList(w.body), undefined, 'список закрыт после выбора');
  });
});

// ---------------------------------------------------------------------------
// Источник «закрытый список config.options»
// ---------------------------------------------------------------------------

describe('suggest-dropdown: закрытый список config.options', () => {
  const options = ['Питер', 'Москва', 'Тверь'];

  function source(): SuggestSource {
    return optionsSuggestSource(options, { header: 'Варианты' });
  }

  it('фабрика: when=typed; пустой запрос — весь список, фрагмент сужает без регистра', async () => {
    const s = source();
    assert.equal(s.when, 'typed');
    assert.equal(s.header, 'Варианты');
    assert.deepEqual(await s.load(''), [
      { value: 'Питер', label: 'Питер' },
      { value: 'Москва', label: 'Москва' },
      { value: 'Тверь', label: 'Тверь' },
    ]);
    assert.deepEqual(await s.load('мо'), [{ value: 'Москва', label: 'Москва' }]);
    assert.deepEqual(await s.load('МО'), [{ value: 'Москва', label: 'Москва' }], 'регистр не важен');
    assert.deepEqual(await s.load('нет такого'), []);
  });

  it('ввод открывает суженный список с заголовком', async () => {
    const w = wire(source());
    w.input.value = 'мо';
    await openBy(() => w.input.emit('focus'));
    assert.deepEqual(rowLabels(w.body), ['Москва']);
    assert.deepEqual(groupHeaders(w.body), ['Варианты']);
  });

  it('клавиатура: ↑/↓ и Enter выбирают из вариантов', async () => {
    const w = wire(source());
    w.input.value = 'мо';
    await openBy(() => w.input.emit('focus'));
    const down = key('ArrowDown');
    w.input.emit('keydown', down);
    assert.ok(down.defaultPrevented);
    w.input.emit('keydown', key('Enter'));
    assert.deepEqual(w.picked, [{ value: 'Москва', label: 'Москва' }]);
    assert.equal(openList(w.body), undefined);
  });

  it('Esc, blur, клик мимо и клик по строке — общий контракт', async () => {
    const w = wire(source());
    await openBy(() => w.handle.open()); // на пустом поле — полный список
    assert.deepEqual(rowLabels(w.body), ['Питер', 'Москва', 'Тверь'], 'ручное открытие — весь каталог');

    const dialog = dialogEsc(w.win);
    const esc = dialog.press();
    assert.ok(esc.immediateStopped);
    assert.equal(dialog.closed(), 0, 'диалог не закрылся');
    assert.equal(openList(w.body), undefined);

    await openBy(() => w.handle.open());
    w.input.emit('blur');
    assert.equal(openList(w.body), undefined, 'blur закрывает список');

    await openBy(() => w.handle.open());
    w.win.dispatchCapture('mousedown', mousedown(new ShimElement('div')));
    assert.equal(openList(w.body), undefined, 'клик мимо закрывает список');

    await openBy(() => w.handle.open());
    const rows = itemRows(w.body);
    rows[2]?.click();
    assert.deepEqual(w.picked, [{ value: 'Тверь', label: 'Тверь' }]);
    assert.equal(openList(w.body), undefined, 'список закрыт после выбора');
  });
});

// ---------------------------------------------------------------------------
// Общие контракты: always, несколько источников, dispose
// ---------------------------------------------------------------------------

describe('suggest-dropdown: общие контракты', () => {
  it('источник when=always открыт при любом содержимом поля', async () => {
    const source: SuggestSource = {
      when: 'always',
      header: 'Всегда',
      load: () => [{ value: 'a', label: 'А' }],
    };
    const w = wire(source);

    await openBy(() => w.input.emit('focus'));
    assert.deepEqual(rowLabels(w.body), ['А'], 'пустое поле — список есть');

    w.input.value = 'x';
    await openBy(() => w.input.emit('input'));
    assert.deepEqual(rowLabels(w.body), ['А'], 'ввод список не закрывает');

    w.input.value = '';
    await openBy(() => w.input.emit('input'));
    assert.deepEqual(rowLabels(w.body), ['А'], 'очистка список не закрывает');
  });

  it('несколько источников — один список в порядке источников, с заголовками', async () => {
    const { input, body } = installShim();
    const picked: SuggestEntry[] = [];
    const handle = wireSuggest(input as unknown as HTMLInputElement, {
      sources: [
        searchSuggestSource({
          header: 'Поиск',
          load: () => [
            { value: 's1', label: 'С-раз' },
            { value: 's2', label: 'С-два' },
          ],
        }),
        optionsSuggestSource(['О-раз', 'О-два'], { header: 'Варианты' }),
      ],
      onPick: (entry) => picked.push(entry),
    });

    // Ручное открытие (кнопка ▾): у options-источника пустой запрос — весь каталог.
    await openBy(() => handle.open());
    assert.deepEqual(rowLabels(body), ['С-раз', 'С-два', 'О-раз', 'О-два'], 'строки в порядке источников');
    assert.deepEqual(groupHeaders(body), ['Поиск', 'Варианты']);

    // Выделение ходит сквозь группы: три ↓ — третья строка (О-раз).
    input.emit('keydown', key('ArrowDown'));
    input.emit('keydown', key('ArrowDown'));
    input.emit('keydown', key('ArrowDown'));
    const rows = itemRows(body);
    assert.ok(rows[2]?.classList.contains('active'), 'курсор перешёл во вторую группу');
    input.emit('keydown', key('Enter'));
    assert.deepEqual(picked, [{ value: 'О-раз', label: 'О-раз' }]);
  });

  it('dispose: закрывает список и снимает все слушатели', async () => {
    const w = wire(historySuggestSource({ load: () => [{ value: 'a', label: 'А' }] }));
    await openBy(() => w.input.emit('focus'));
    assert.equal(rowLabels(w.body).length, 1);
    assert.equal(w.win.captureCount('keydown'), 1);
    assert.equal(w.win.captureCount('mousedown'), 1);

    w.handle.dispose();
    assert.equal(openList(w.body), undefined, 'список закрыт');
    assert.equal(w.win.captureCount('keydown'), 0, 'capture-слушатель снят');
    assert.equal(w.win.captureCount('mousedown'), 0, 'capture-слушатель снят');

    await openBy(() => w.input.emit('focus'));
    assert.equal(openList(w.body), undefined, 'после dispose выпадашка молчит');
  });

  it('поле выпало из документа — оконные слушатели снимаются сами', async () => {
    const w = wire(historySuggestSource({ load: () => [{ value: 'a', label: 'А' }] }));
    await openBy(() => w.input.emit('focus'));
    assert.equal(w.win.captureCount('mousedown'), 1);

    w.input.isConnected = false;
    w.win.dispatchCapture('mousedown', mousedown(new ShimElement('div')));
    assert.equal(w.win.captureCount('mousedown'), 0, 'mousedown-слушатель снят');
    assert.equal(w.win.captureCount('keydown'), 0, 'keydown-слушатель снят');
  });
});

// ---------------------------------------------------------------------------
// Богатая строка: мысль показывается облачком фабрики
// ---------------------------------------------------------------------------

describe('suggest-dropdown: строка-мысль — облачко общей фабрики', () => {
  const rich: SuggestEntry = {
    value: 't1',
    label: 'Мысль в корзине',
    thought: { id: 't1', title: 'Мысль в корзине', active: false, marked_for_deletion: true },
  };
  const plain: SuggestEntry = { value: 't2', label: 'Просто строка' };
  const source: SuggestSource = { when: 'typed', load: () => [rich, plain] };

  /** Корень облачка в строке (первый ребёнок строки-подсказки). */
  function cloudOf(row: ShimElement | undefined): ShimElement | undefined {
    return row?.children[0];
  }

  it('мысль идёт готовым облачком, а не голой подписью', async () => {
    const w = wire(source);
    w.input.value = 'м';
    await openBy(() => {
      w.input.emit('focus');
      w.input.emit('input');
    });
    const rows = itemRows(w.body);
    const cloud = cloudOf(rows[0]);
    assert.ok(cloud !== undefined, 'у строки-мысли есть облачко');
    assert.ok(cloud.className.includes('prop-ref-cloud'), 'профиль chip');
    assert.ok(
      cloud.classList.contains('cloud-width-container'),
      'ширина — по контейнеру выпадашки (width: container)',
    );
    assert.ok(cloud.classList.contains('dim'), 'неактуальная мысль бледная');
    assert.ok(
      cloud.children.some((c) => c.className === 'list-trash-mark'),
      'метка корзины показана',
    );
    assert.ok(
      !rows[0]?.children.some((c) => c.className === 'type-combo-label'),
      'голой текстовой подписи у строки-мысли нет',
    );
  });

  it('нессылочная подсказка остаётся голым текстом', async () => {
    const w = wire(source);
    w.input.value = 'м';
    await openBy(() => {
      w.input.emit('focus');
      w.input.emit('input');
    });
    const row = itemRows(w.body)[1];
    assert.equal(row?.children[0]?.className, 'type-combo-label');
    assert.equal(row?.children[0]?.textContent, 'Просто строка');
  });

  it('клик по строке-облачку выбирает мысль', async () => {
    const w = wire(source);
    w.input.value = 'м';
    await openBy(() => {
      w.input.emit('focus');
      w.input.emit('input');
    });
    itemRows(w.body)[0]?.click();
    assert.deepEqual(w.picked, [rich]);
    assert.equal(openList(w.body), undefined);
  });

  it('секции строк дают заголовки групп', async () => {
    const w = wire({
      when: 'always',
      load: () => [
        { value: 'a', label: 'А', section: 'Токены' },
        { value: 'b', label: 'Б', section: 'Токены' },
        { value: 'c', label: 'В', section: 'Мысли' },
      ],
    });
    await openBy(() => w.input.emit('focus'));
    assert.deepEqual(groupHeaders(w.body), ['Токены', 'Мысли']);
    assert.deepEqual(rowLabels(w.body), ['А', 'Б', 'В']);
  });

  it('недоступная строка не выбирается ни кликом, ни Enter, и пропускается стрелками', async () => {
    const w = wire({
      when: 'always',
      load: () => [
        { value: 'x', label: 'Недоступно', disabled: true },
        { value: 'y', label: 'Доступно' },
      ],
    });
    await openBy(() => w.input.emit('focus'));
    const rows = itemRows(w.body);
    assert.ok(rows[0]?.classList.contains('disabled'), 'строка помечена disabled');
    rows[0]?.click();
    assert.deepEqual(w.picked, [], 'клик по недоступной строке ничего не выбирает');

    w.input.emit('keydown', key('ArrowDown'));
    assert.ok(rows[1]?.classList.contains('active'), '↓ перешагивает недоступную строку');
    w.input.emit('keydown', key('Enter'));
    assert.deepEqual(w.picked, [{ value: 'y', label: 'Доступно' }]);
  });

  it('pickFirstOnEnter=false: Enter по свободному тексту не выбирает', async () => {
    const { input, body } = installShim();
    const picked: SuggestEntry[] = [];
    wireSuggest(input as unknown as HTMLInputElement, {
      sources: [{ when: 'always', load: () => [{ value: 'a', label: 'А' }] }],
      pickFirstOnEnter: false,
      onPick: (entry) => picked.push(entry),
    });
    await openBy(() => input.emit('focus'));
    const enter = key('Enter');
    input.emit('keydown', enter);
    assert.ok(!enter.defaultPrevented, 'свободный Enter не потреблён');
    assert.deepEqual(picked, [], 'выбора нет');
    assert.notEqual(openList(body), undefined, 'список остался открыт');

    input.emit('keydown', key('ArrowDown'));
    input.emit('keydown', key('Enter'));
    assert.deepEqual(picked, [{ value: 'a', label: 'А' }], 'выделенная строка выбирается');
  });
});

// ---------------------------------------------------------------------------
// Слой выпадашки как «свой» для панелей, закрывающихся кликом вне себя
// (ошибка 72a06e01: строка поиска карты пряталась от клика по подсказке)
// ---------------------------------------------------------------------------

describe('слой выпадашки подсказок виден панелям-владельцам', () => {
  it('открытый список опознаётся по своему узлу, закрытый — нет', async () => {
    const w = wire({ when: 'always', load: () => [{ value: 'a', label: 'А' }] });
    assert.equal(
      isInsideSuggestDropdown(w.input as unknown as Node),
      false,
      'до открытия списка его строк ещё нет',
    );

    await openBy(() => w.input.emit('focus'));
    const list = openList(w.body);
    assert.ok(list !== undefined, 'список открыт');
    assert.equal(
      isInsideSuggestDropdown(list.children[0] as unknown as Node),
      true,
      'строка подсказки — внутри слоя (клик по ней не «вне» панели-владельца)',
    );
    assert.equal(
      isInsideSuggestDropdown(list as unknown as Node),
      true,
      'сам список — тоже слой',
    );
    assert.equal(
      isInsideSuggestDropdown(w.input as unknown as Node),
      false,
      'поле ввода — не слой выпадашки (панель проверяет его сама)',
    );
    assert.equal(isInsideSuggestDropdown(null), false);

    w.handle.close();
    assert.equal(
      isInsideSuggestDropdown(list.children[0] as unknown as Node),
      false,
      'строка закрытого списка слоем больше не считается',
    );
  });

  it('выбор строки закрывает слой (строка выбирается тем же кликом)', async () => {
    const w = wire({ when: 'always', load: () => [{ value: 'a', label: 'А' }] });
    await openBy(() => w.input.emit('focus'));
    const row = itemRows(w.body)[0];
    assert.ok(row !== undefined);
    row.click();
    assert.deepEqual(w.picked, [{ value: 'a', label: 'А' }]);
    assert.equal(
      isInsideSuggestDropdown(row as unknown as Node),
      false,
      'после выбора список снят — слой пуст',
    );
  });
});
