/**
 * Уровень 1 тех.проекта «Инкрементальное обновление списков UI» (задача
 * 3bfef1f7): общий модуль сохранения прокрутки `lib/ui/scroll-anchor.ts`.
 *
 * Проверяется механика якоря: полная пересборка не сбрасывает позицию; якорь
 * держит у верхней кромки ту же строку, когда строки выше изменили высоту;
 * укоротившийся/пустой список клампится; «наверх» — сборка без обёртки.
 * DOM-шим (jsdom в проекте нет).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { preserveScroll } from '../src/renderer/lib/ui/scroll-anchor.js';
import { ShimElement } from './dom-shim.js';

/** Контейнер прокрутки с настраиваемой геометрией. */
function makeHost(): ShimElement {
  const host = new ShimElement('div', 'scroller');
  host.clientHeight = 200;
  host.scrollHeight = 2000;
  return host;
}

/**
 * Пересборка содержимого «как в браузере»: контейнер очищается, `scrollTop`
 * клампится в 0 (реальный DOM опустошает контейнер и сбрасывает прокрутку).
 * Каждая строка несёт ключ в `data-key` и заданный `offsetTop`.
 */
function rebuild(host: ShimElement, rows: Array<{ key: string; top: number }>): void {
  host.replaceChildren();
  host.scrollTop = 0;
  for (const row of rows) {
    const el = new ShimElement('div', 'row');
    el.setAttribute('data-key', row.key);
    el.offsetTop = row.top;
    host.append(el);
  }
}

const asHost = (el: ShimElement): HTMLElement => el as unknown as HTMLElement;

describe('preserveScroll: позиция прокрутки при пересборке (задача 3bfef1f7)', () => {
  it('длинный список: scrollTop=500 переживает пересборку', () => {
    const host = makeHost();
    const rows = [0, 100, 200, 300, 400, 500, 600].map((top) => ({ key: `k${top}`, top }));
    rebuild(host, rows);
    host.scrollTop = 500;

    preserveScroll(asHost(host), () => rebuild(host, rows));

    assert.equal(host.scrollTop, 500, 'позиция та же — строки выше не изменились');
  });

  it('якорь выше изменил высоту: позиция скорректирована по якорю', () => {
    const host = makeHost();
    const before = [0, 100, 200, 300, 400, 500, 600].map((top) => ({ key: `k${top}`, top }));
    rebuild(host, before);
    host.scrollTop = 500; // у кромки — строка k500

    // Строки выше выросли на 60px — та же строка уехала вниз; прокрутка
    // сдвигается вместе с якорем, содержимое у кромки не меняется.
    const after = before.map((row) => ({ key: row.key, top: row.top + 60 }));
    preserveScroll(asHost(host), () => rebuild(host, after));

    assert.equal(host.scrollTop, 560, 'scrollTop = прежний + сдвиг якоря');
  });

  it('якорь пропал (список стал короче): прежний scrollTop клампится', () => {
    const host = makeHost();
    const before = [0, 100, 200, 300, 400, 500, 600].map((top) => ({ key: `k${top}`, top }));
    rebuild(host, before);
    host.scrollTop = 500;

    host.scrollHeight = 300; // содержимое стало короче видимой части
    preserveScroll(asHost(host), () =>
      rebuild(host, [
        { key: 'k0', top: 0 },
        { key: 'k100', top: 100 },
      ]),
    );

    assert.equal(host.scrollTop, 100, 'клампинг по новой высоте (300 − 200)');
  });

  it('пустой результат пересборки: восстановление в 0', () => {
    const host = makeHost();
    rebuild(host, [{ key: 'a', top: 0 }, { key: 'b', top: 100 }]);
    host.scrollTop = 100;

    host.scrollHeight = 40; // «Ничего не найдено» — содержимого нет
    preserveScroll(asHost(host), () => rebuild(host, []));

    assert.equal(host.scrollTop, 0, 'пустой список законно показывает начало');
  });

  it('строка с ключом вида data-row-key (дневник) — тоже якорь', () => {
    const host = makeHost();
    const rebuildTable = (rows: Array<{ key: string; top: number }>): void => {
      host.replaceChildren();
      host.scrollTop = 0;
      for (const row of rows) {
        const el = new ShimElement('div', 'card');
        el.setAttribute('data-row-key', row.key);
        el.offsetTop = row.top;
        host.append(el);
      }
    };
    const rows = [0, 100, 200, 300, 400, 500].map((top) => ({ key: `r${top}`, top }));
    rebuildTable(rows);
    host.scrollTop = 500;

    preserveScroll(asHost(host), () => rebuildTable(rows));

    assert.equal(host.scrollTop, 500, 'якорь по data-row-key держит позицию');
  });

  it('семантика «наверх»: сборка без обёртки оставляет список в начале', () => {
    const host = makeHost();
    rebuild(host, [{ key: 'a', top: 0 }, { key: 'b', top: 500 }]);
    host.scrollTop = 500;

    // Новый отбор/первый вход — сборку зовут напрямую, без preserveScroll.
    rebuild(host, [{ key: 'x', top: 0 }]);

    assert.equal(host.scrollTop, 0, 'без обёртки позиция не сохраняется');
  });
});
