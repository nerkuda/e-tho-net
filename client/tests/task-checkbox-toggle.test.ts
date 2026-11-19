/**
 * Живые чекбоксы задач в режиме ПРОСМОТРА комментария (0.16.1, задача
 * `cfb8cb72`, пункт 8 ТЗ живой приёмки).
 *
 * Просмотр записи/постоянного комментария — это готовый `body_html` от единого
 * рендерера: чекбокс в нём отключён и был простым индикатором. Модуль делает его
 * командой: клик переключает `- [ ]` ↔ `- [x]` В ТЕКСТЕ источника
 * (`etn.comments.update`), а не только вид контрола.
 *
 * Здесь проверяется адресация и запись:
 *  • клик по N-му чекбоксу правит N-ю строку с чек-боксом `body_md`;
 *  • вендорский `disabled` снимается, контрол помечается живым классом;
 *  • code fence и `- [ ]` в середине строки не адресуются (грамматика та же,
 *    что у просмотра);
 *  • число чекбоксов DOM и источника не совпало — no-op с откатом контрола
 *    (лучше ничего не делать, чем править чужую строку).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/** Дождаться промисов записи. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Минимальный DOM: модулю нужны `document.body`, `window.etn` и сеть в store. */
function shimDom(): void {
  const body = new ShimElement('body');
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    documentElement: new ShimElement('html'),
    body,
    activeElement: null,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    dispatchEvent: (): boolean => true,
    querySelector: (): null => null,
    contains: (node: unknown) => body.contains(node as ShimElement | null),
  };
  (ShimElement.prototype as any).ownerDocument = (globalThis as any).document;
  const win = ((globalThis as any).window ??= {}) as Record<string, any>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = (): boolean => true;
  win.addEventListener = (): void => undefined;
  win.removeEventListener = (): void => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  });
}

/** Чекбокс вендорской разметки (`input[type=checkbox][disabled]`). */
function checkbox(host: ShimElement, checked: boolean): ShimElement {
  const box = new ShimElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.disabled = true;
  host.append(box);
  return box;
}

/** Клик по контролу: в браузере `checked` меняется ДО `click`. */
function click(host: ShimElement, box: ShimElement): void {
  host.emit('click', {
    target: box,
    preventDefault: (): void => undefined,
    stopPropagation: (): void => undefined,
  });
}

interface Api {
  updates: Array<{ bodyMd: string; version: number }>;
}

/** Подставной `window.etn` с управляемым источником комментария. */
function fakeApi(bodyMd: string, version = 1): Api {
  const api: Api = { updates: [] };
  const stub = {
    comments: {
      get: async (_networkId: string, id: string) => ({
        id,
        body_md: bodyMd,
        version,
        body_html: '<p>html</p>',
      }),
      update: async (
        _networkId: string,
        id: string,
        input: { body_md?: string },
        expected?: number,
      ) => {
        api.updates.push({ bodyMd: input.body_md ?? '', version: expected ?? 0 });
        return {
          id,
          body_md: input.body_md,
          version: (expected ?? 0) + 1,
          body_html: '<p>new</p>',
        };
      },
    },
  };
  (globalThis as any).etn = stub;
  ((globalThis as any).window as Record<string, unknown>)['etn'] = stub;
  return api;
}

const { LIVE_TASK_CHECKBOX_CLASS, wireTaskCheckboxes } =
  await import('../src/renderer/editor/task-checkbox-toggle.js');

before(async () => {
  shimDom();
  const state = await import('../src/renderer/state.js');
  state.store.update({ networkId: 'n1', network: { first_day_of_week: 1 } } as any);
});

describe('живые чекбоксы просмотра комментария (пункт 8 ТЗ 2026-11-18)', () => {
  it('вендорский контрол становится живым: disabled снят, класс поставлен', () => {
    fakeApi('- [ ] задача');
    const host = new ShimElement('div');
    const box = checkbox(host, false);
    const off = wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c1' }));
    assert.equal(box.disabled, false, 'disabled снят — контрол шлёт клики');
    assert.ok(box.classList.contains(LIVE_TASK_CHECKBOX_CLASS), 'контрол помечен живым классом');
    off();
  });

  it('клик переключает `[ ]` → `[x]` в body_md источника', async () => {
    const api = fakeApi('- [ ] первая\n- [x] вторая', 3);
    const host = new ShimElement('div');
    const first = checkbox(host, false);
    checkbox(host, true);
    const saved: string[] = [];
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({
      commentId: 'c1',
      onSaved: (md) => saved.push(md),
    }));
    first.checked = true;
    click(host, first);
    await flush();
    assert.deepEqual(
      api.updates,
      [{ bodyMd: '- [x] первая\n- [x] вторая', version: 3 }],
      'правлена строка ИМЕННО этого чекбокса; соседняя не тронута, версия источника — в PATCH',
    );
    assert.deepEqual(
      saved,
      ['- [x] первая\n- [x] вторая'],
      'владельцу просмотра отдан новый markdown',
    );
  });

  it('клик снимает отметку: `[x]` → `[ ]`', async () => {
    const api = fakeApi('- [x] задача', 1);
    const host = new ShimElement('div');
    const box = checkbox(host, true);
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c1' }));
    box.checked = false;
    click(host, box);
    await flush();
    assert.deepEqual(api.updates, [{ bodyMd: '- [ ] задача', version: 1 }], 'отметка снята');
  });

  it('`- [ ]` внутри code fence не адресуется', async () => {
    const api = fakeApi('```\n- [ ] не задача\n```\n- [ ] задача', 1);
    const host = new ShimElement('div');
    const box = checkbox(host, false);
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c1' }));
    box.checked = true;
    click(host, box);
    await flush();
    assert.deepEqual(
      api.updates,
      [{ bodyMd: '```\n- [ ] не задача\n```\n- [x] задача', version: 1 }],
      'правлена строка после fence, а не «- [ ]» внутри него',
    );
  });

  it('число чекбоксов DOM и источника не совпало — no-op с откатом контрола', async () => {
    const api = fakeApi('- [ ] только одна строка', 1);
    const host = new ShimElement('div');
    const first = checkbox(host, false);
    checkbox(host, false);
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c1' }));
    first.checked = true;
    click(host, first);
    await flush();
    assert.deepEqual(api.updates, [], 'источник не тронут: адрес неоднозначен');
    assert.equal(first.checked, false, 'контрол возвращён к снапшоту');
  });

  it('без адреса комментария клик ничего не пишет', async () => {
    const api = fakeApi('- [ ] задача', 1);
    const host = new ShimElement('div');
    const box = checkbox(host, false);
    wireTaskCheckboxes(host as unknown as HTMLElement, () => null);
    box.checked = true;
    click(host, box);
    await flush();
    assert.deepEqual(api.updates, [], 'просмотр без источника остаётся только индикатором');
  });

  it('отписка снимает слушатель', async () => {
    const api = fakeApi('- [ ] задача', 1);
    const host = new ShimElement('div');
    const box = checkbox(host, false);
    const off = wireTaskCheckboxes(host as unknown as HTMLElement, () => ({ commentId: 'c1' }));
    off();
    box.checked = true;
    click(host, box);
    await flush();
    assert.deepEqual(api.updates, [], 'после отписки клики не обрабатываются');
  });

  it('своя запись помечается ДО PATCH и снимается после ответа (гашение эха)', async () => {
    fakeApi('- [ ] задача', 2);
    const host = new ShimElement('div');
    const box = checkbox(host, false);
    const order: string[] = [];
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({
      commentId: 'c1',
      beginSave: () => {
        order.push('begin');
        return () => order.push('release');
      },
      onSaved: () => order.push('saved'),
    }));
    box.checked = true;
    click(host, box);
    await flush();
    // Сервер публикует `comment.updated` ДО ответа PATCH: метка обязана стоять
    // уже во время запроса, иначе эхо перерисует просмотр и сорвёт прокрутку.
    assert.deepEqual(order, ['begin', 'saved', 'release'], 'метка живёт ровно на время записи');
  });

  it('владелец просмотра получает ОБНОВЛЁННЫЙ комментарий (пункт 9 уточнения 2026-11-19)', async () => {
    fakeApi('- [ ] задача', 4);
    const host = new ShimElement('div');
    const box = checkbox(host, false);
    const saved: Array<{ md: string; html: string; version: number }> = [];
    wireTaskCheckboxes(host as unknown as HTMLElement, () => ({
      commentId: 'c1',
      onSaved: (md, html, comment) => saved.push({ md, html, version: comment.version }),
    }));
    box.checked = true;
    click(host, box);
    await flush();
    // Третий аргумент — ответ сервера: строка ленты обновляется точечно
    // (html + версия), без перезапроса и без пересборки карточки.
    assert.deepEqual(
      saved,
      [{ md: '- [x] задача', html: '<p>new</p>', version: 5 }],
      'снапшот строки обновляется из ответа comments.update',
    );
  });
});
