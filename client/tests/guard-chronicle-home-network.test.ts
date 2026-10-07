/**
 * Сторож ошибки ab4e499f: «Дневник: после смены сети запись создаётся с HOME
 * прежней сети».
 *
 * Симптом: `homeId`/`homePromise` в `screens/chronicle/chronicle.ts` — модульный
 * кэш корневой мысли (HOME), разрешаемой ПО СЕТИ, — не был привязан к сети и не
 * сбрасывался при её смене. В сети, открытой не первой, первичная привязка новой
 * записи уходила с `owner_id` = HOME прежней сети, и сервер отвечал
 * `NOT_FOUND: thought … not found` (`comment-service.ts` `ensureOwnerExists`).
 *
 * Сторож ПОВЕДЕНЧЕСКИЙ: он поднимает РЕАЛЬНЫЙ экран `mountChronicle` под Node с
 * DOM-шимом, открывает «Дневник» в сети A, переключает сеть на B, создаёт запись
 * штатным путём (кнопка «Добавить запись дневника» → заголовок → Enter) и проверяет
 * `networkId` и `targets[0].owner_id` у исходящего `comments.createMulti` — это и
 * есть тело `POST /comments`. Совпадение текста исходника не проверяется: при
 * откате фикса проба краснеет по значению `owner_id`.
 *
 * Два кейса:
 *  1. обычный путь — HOME сети A уже разрешён, затем смена сети на B;
 *  2. ГОНКА — промис `findRootThought` сети A завершается ПОСЛЕ смены на сеть B
 *     (управляемая отложенность): поздний `.then` прежней сети не должен
 *     затирать кэш HOME текущей сети (`chronicle.ts` `getHome`, защита `.then`).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import { ShimElement } from './dom-shim.js';

// Клавиатура заголовка идёт через диспетчер контекстов: стек между тестами чист.
beforeEach(() => keymap.keymapInternals.reset());

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Корневая мысль (HOME) каждой из двух сетей стенда. */
const HOME: Record<string, string> = { netA: 'home-A', netB: 'home-B' };

/** Минимальный DOM-шим: ровно те глобали, что трогает монтирование экрана. */
function shimDom(): void {
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' };
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as any).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  };
  (globalThis as any).MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
  (globalThis as any).requestAnimationFrame = (cb: () => void): number => {
    cb();
    return 0;
  };
  (globalThis as any).cancelAnimationFrame = (): void => undefined;
  (globalThis as any).getComputedStyle = () => ({
    paddingLeft: '0px',
    paddingRight: '0px',
    paddingTop: '0px',
    paddingBottom: '0px',
  });
  (globalThis as any).localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  const doc: any = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style },
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  (globalThis as any).document = doc;
  // Мутируем ТОТ ЖЕ объект `window` (конвенция `renderer-editor-mount`):
  // `lib/etn.js` читает `window` на каждом обращении.
  const win = ((globalThis as any).window ??= {}) as Record<string, any>;
  win.document = doc;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
  win.getComputedStyle = (globalThis as any).getComputedStyle;
  win.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  win.location = { href: 'http://localhost' };
}

/** Запись вызова `etn.<ns>.<method>` для проверки аргументов. */
interface Call {
  ns: string;
  method: string;
  args: any[];
}

/** Отложенный промис с ручным `resolve` (для управляемой гонки). */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Дать провернуться микро-/макрозадачам текущего пути. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Заглушка `Comment` с заданной первичной привязкой. */
function comment(id: string, owner: string): Record<string, unknown> {
  return {
    id,
    kind: 'chronological',
    title: 'T',
    body_md: 'B',
    body_html: '<p>B</p>',
    valid_from: '2026-09-29T10:00:00.000Z',
    valid_to: '2026-09-29T10:00:00.000Z',
    use_time: false,
    version: 1,
    created_at: '2026-09-29T10:00:00.000Z',
    updated_at: '2026-09-29T10:00:00.000Z',
    created_by: 'u',
    updated_by: 'u',
    targets: [{ owner_type: 'thought', owner_id: owner }],
  };
}

/** Общие заглушки `window.etn`; `structures.query` и захват create — у теста. */
function baseEtn(win: Record<string, any>, onCreate: (networkId: string, targets: any[]) => void): void {
  win.etn = {
    ui: { getState: async () => null, setState: async () => undefined },
    tabs: { updateState: async () => undefined },
    thoughts: {
      get: async (_networkId: string, id: string) => ({
        id,
        title: id,
        icon: null,
        fg_color: null,
        bg_color: null,
      }),
    },
    chronicle: { query: async () => ({ rows: [], total: 0 }) },
    comments: {
      createMulti: async (networkId: string, targets: any[]) => {
        onCreate(networkId, targets);
        return comment('c1', targets[0]?.owner_id ?? '');
      },
      update: async (_n: string, id: string) => comment(id, ''),
      get: async (_n: string, id: string) => comment(id, ''),
      addTarget: async (_n: string, id: string) => comment(id, ''),
      remove: async () => undefined,
      removeTarget: async () => undefined,
    },
    links: { get: async () => undefined },
    attachments: { list: async () => ({ items: [] }) },
  };
}

/** Создать запись штатным путём: кнопка «Добавить» → заголовок → Enter. */
function createRecord(host: ShimElement): void {
  const add = host.querySelector('.diary-add-btn');
  assert.ok(add, 'кнопка «Добавить запись дневника» смонтирована');
  add!.click();
  const input = host.querySelector('.diary-record-title-input');
  assert.ok(input, 'поле заголовка слота смонтировано');
  input!.value = 'Тест';
  // Контекст правки на стеке (beginEdit кладёт его сразу) — шлём через диспетчер.
  keymap.dispatchKeyEvent({
    key: 'Enter',
    target: input,
    preventDefault() {},
  } as unknown as KeyboardEvent);
}

describe('guard: HOME «Дневника» привязан к сети (ошибка ab4e499f)', () => {
  it('запись в сети B создаётся с HOME сети B, а не прежней A', async () => {
    shimDom();

    const calls: Call[] = [];
    let createNetwork: string | null = null;
    let createTargets: any[] | null = null;
    let resolveCreate: () => void = () => undefined;
    const created = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });

    const win = (globalThis as any).window as Record<string, any>;
    baseEtn(win, (networkId, targets) => {
      createNetwork = networkId;
      createTargets = targets;
      resolveCreate();
    });
    win.etn.structures = {
      query: async (networkId: string) => {
        calls.push({ ns: 'structures', method: 'query', args: [networkId] });
        return { items: [{ id: HOME[networkId] ?? '' }], total: 1 };
      },
    };

    const { store } = await import('../src/renderer/state.js');
    const chronicle = await import('../src/renderer/screens/chronicle/chronicle.js');

    const host = new ShimElement('div') as unknown as HTMLElement & { isConnected: boolean };
    host.isConnected = true;

    // Сеть A: открываем «Дневник» — HOME кэшируется.
    store.update({ activeView: 'chronicle', networkId: 'netA', activeTabId: 'tabA' });
    chronicle.mountChronicle(host);
    await chronicle.ensureChronicleInitialised();
    assert.ok(
      calls.some((c) => c.ns === 'structures' && c.method === 'query' && c.args[0] === 'netA'),
      'HOME сети A разрешён при входе в «Дневник»',
    );

    // Смена сети при активном виде: штатный путь — подписка на store.
    calls.length = 0;
    store.update({ networkId: 'netB', activeTabId: 'tabB' });
    await new Promise((r) => setTimeout(r, 0));

    createRecord(host as unknown as ShimElement);
    await created;

    // Тело `POST /comments`: сеть текущая, первичная привязка — её HOME.
    const target0 = ((createTargets as any[] | null) ?? [])[0] as
      | { owner_type?: string; owner_id?: string }
      | undefined;
    assert.equal(createNetwork, 'netB', 'запись создаётся в текущей сети');
    assert.equal(target0?.owner_type, 'thought', 'первичная привязка — мысль');
    assert.equal(
      target0?.owner_id,
      HOME.netB,
      'владелец записи — HOME ТЕКУЩЕЙ сети, а не прежней',
    );
    assert.notEqual(
      target0?.owner_id,
      HOME.netA,
      'HOME прежней сети в тело запроса не попадает',
    );
  });

  it('поздний промис HOME сети A после смены на B не затирает кэш (гонка)', async () => {
    shimDom();

    let createNetwork: string | null = null;
    let createTargets: any[] | null = null;
    let resolveCreate: () => void = () => undefined;
    const created = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });

    // Управляемые разрешения HOME: сеть A отдаём позже сети B.
    const homeA = deferred<{ items: Array<{ id: string }>; total: number }>();
    const homeB = deferred<{ items: Array<{ id: string }>; total: number }>();
    let askedA = false;
    let askedB = false;

    const win = (globalThis as any).window as Record<string, any>;
    baseEtn(win, (networkId, targets) => {
      createNetwork = networkId;
      createTargets = targets;
      resolveCreate();
    });
    win.etn.structures = {
      query: async (networkId: string) => {
        if (networkId === 'netA') {
          askedA = true;
          return homeA.promise;
        }
        if (networkId === 'netB') {
          askedB = true;
          return homeB.promise;
        }
        return { items: [], total: 0 };
      },
    };

    const { store } = await import('../src/renderer/state.js');
    const chronicle = await import('../src/renderer/screens/chronicle/chronicle.js');

    const host = new ShimElement('div') as unknown as HTMLElement & { isConnected: boolean };
    host.isConnected = true;
    store.update({ activeView: 'chronicle', networkId: 'netA', activeTabId: 'tabA' });
    chronicle.mountChronicle(host);

    // Старт «Дневника» в сети A НЕ ждём: разрешение HOME(A) намеренно зависает.
    const initA = chronicle.ensureChronicleInitialised().catch(() => undefined);
    await tick();
    assert.ok(askedA, 'разрешение HOME сети A начато и ещё не завершено');

    // Смена сети на B, пока промис HOME(A) висит.
    store.update({ networkId: 'netB', activeTabId: 'tabB' });
    await tick();
    assert.ok(askedB, 'смена сети начала разрешение HOME сети B');

    // Сначала завершается HOME(B) — кэш заполняется корректным значением...
    homeB.resolve({ items: [{ id: HOME.netB ?? '' }], total: 1 });
    await tick();
    await tick();

    // ...затем «поздно» завершается HOME(A): его `.then` не должен затереть кэш.
    homeA.resolve({ items: [{ id: HOME.netA ?? '' }], total: 1 });
    await tick();
    await tick();
    await initA;

    createRecord(host as unknown as ShimElement);
    await created;

    const target0 = ((createTargets as any[] | null) ?? [])[0] as
      | { owner_type?: string; owner_id?: string }
      | undefined;
    assert.equal(createNetwork, 'netB', 'запись создаётся в текущей сети B');
    assert.equal(
      target0?.owner_id,
      HOME.netB,
      'поздний промис HOME(A) не затёр кэш: владелец — HOME текущей сети B',
    );
    assert.notEqual(
      target0?.owner_id,
      HOME.netA,
      'HOME прежней сети A в тело запроса не попадает',
    );
  });
});
