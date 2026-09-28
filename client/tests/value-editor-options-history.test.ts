/**
 * Регресс карточки ошибки 4a96d07a: строковое свойство со списком
 * предопределённых вариантов (`config.options`).
 *
 *  - при входе в поле показывается ВЕСЬ список вариантов, а не только
 *    совпавший с текущим значением;
 *  - «последние значения» у такого свойства не ведутся — выпадашку занимает
 *    сам список вариантов;
 *  - у строкового свойства БЕЗ списка история по-прежнему показывается на
 *    пустом поле (контроль — прежнее поведение не сломано).
 *
 * Харнесс — минимальный DOM-шим (Node, без jsdom), как в
 * value-editor-extra-suggest.test.ts, расширенный `body`, окном и
 * localStorage: выпадашке нужен `document.body`, истории — localStorage.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Ключ истории того же network/property, что и в тестах ниже. */
const RECENT_KEY = 'props.recent.n1.p1';

/** Ставит свежие document/window/localStorage; возвращает `document.body`. */
function installShim(seedRecent: string[] | null): { body: ShimElement } {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
    body,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win['innerWidth'] = 1024;
  win['innerHeight'] = 768;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['dispatchEvent'] = () => undefined;

  const store: Record<string, string> = {};
  if (seedRecent !== null) store[RECENT_KEY] = JSON.stringify(seedRecent);
  (globalThis as any).localStorage = {
    getItem: (key: string): string | null => store[key] ?? null,
    setItem: (key: string, value: string): void => {
      store[key] = value;
    },
    removeItem: (key: string): void => {
      delete store[key];
    },
  };
  return { body };
}

/** Даёт осесть асинхронной цепочке открытия выпадашки. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Первый элемент с тегом `input` в поддереве. */
function findTag(root: ShimElement, tag: string): ShimElement | null {
  if (root.tagName === tag) return root;
  for (const child of root.children) {
    const hit = findTag(child, tag);
    if (hit !== null) return hit;
  }
  return null;
}

/** Открытый список выпадашки (или undefined). */
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

/** Заголовки групп открытого списка. */
function groupHeaders(body: ShimElement): string[] {
  const list = openList(body);
  if (list === undefined) return [];
  return list.children
    .filter((c) => c.classList.contains('type-combo-empty'))
    .map((header) => header.textContent);
}

const OPTIONS = ['Питер', 'Москва', 'Тверь'];

describe('buildValueEditor — строковое свойство со списком вариантов (карточка 4a96d07a)', () => {
  it('фокус на поле с текущим значением показывает ВЕСЬ список, а не только совпавший вариант', async () => {
    const { body } = installShim(null);
    const { buildValueEditor } = await import('../src/renderer/editor/value-editor.js');
    const root = buildValueEditor({
      networkId: 'n1',
      definition: {
        value_type: 'text',
        config: { options: [...OPTIONS] },
        required: false,
        default_value: null,
      },
      value: 'Москва',
      commitOn: 'blur',
      historyPropertyId: 'p1',
      save: () => true,
    }) as unknown as ShimElement;

    const input = findTag(root, 'input');
    assert.ok(input !== null, 'поле ввода есть');
    assert.equal(input!.value, 'Москва', 'поле несёт текущее значение');
    input!.emit('focus');
    await flush();

    assert.deepEqual(rowLabels(body), OPTIONS, 'показан весь список вариантов');
    assert.deepEqual(groupHeaders(body), ['Варианты'], 'история не подмешивается');
  });

  it('«последние значения» не подключаются, когда объявлен список вариантов', async () => {
    const { body } = installShim(['СПб', 'Казань']);
    const { buildValueEditor } = await import('../src/renderer/editor/value-editor.js');
    const root = buildValueEditor({
      networkId: 'n1',
      definition: {
        value_type: 'text',
        config: { options: [...OPTIONS] },
        required: false,
        default_value: null,
      },
      value: null,
      commitOn: 'blur',
      historyPropertyId: 'p1',
      save: () => true,
    }) as unknown as ShimElement;

    const input = findTag(root, 'input');
    assert.ok(input !== null);
    input!.emit('focus');
    await flush();

    assert.deepEqual(groupHeaders(body), ['Варианты'], 'заголовка «Последние значения» нет');
    assert.deepEqual(rowLabels(body), OPTIONS, 'показан список вариантов, история — нет');
  });

  it('без списка вариантов история показывается на пустом поле (контроль)', async () => {
    const { body } = installShim(['СПб', 'Казань']);
    const { buildValueEditor } = await import('../src/renderer/editor/value-editor.js');
    const root = buildValueEditor({
      networkId: 'n1',
      definition: { value_type: 'text', config: null, required: false, default_value: null },
      value: null,
      commitOn: 'blur',
      historyPropertyId: 'p1',
      save: () => true,
    }) as unknown as ShimElement;

    const input = findTag(root, 'input');
    assert.ok(input !== null);
    input!.emit('focus');
    await flush();

    assert.deepEqual(groupHeaders(body), ['Последние значения']);
    assert.deepEqual(rowLabels(body), ['СПб', 'Казань']);
  });
});
