/**
 * Ctrl-hover предпросмотр мысли чужой сети (чип кросс-сетевой ссылки значения,
 * ошибка 9be98ae1).
 *
 * Резолвер `thought-cross-network` (`lib/hover-preview.js`) читает цель в ЧУЖОЙ
 * сети (id — из `data-hp-network`) и в заголовке попапа обязательно ставит имя
 * сети-источника. Деградация: сеть недоступна (нет в каталоге сетей) или мысль
 * в ней недоступна — вместо комментария сообщение об этом. Нет постоянного
 * комментария — попап не открывается (`null`).
 *
 * Движок предпросмотра (делегированные слушатели `document`) тестом не
 * поднимается — проверяется сам резолвер через его тестовый шов
 * `hoverPreviewInternals`.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const FOREIGN_NET = '22222222-2222-4222-8222-222222222222';
const FOREIGN_THOUGHT = '33333333-3333-4333-8333-333333333333';

/** Настройка `etn` на текущий сценарий. */
let scenario: {
  networks: Array<{ id: string; display_name: string }>;
  thoughtThrows: boolean;
  comments: Array<{ kind: string; body_html: string; body_md?: string }>;
};

function installShim(): void {
  scenario = { networks: [], thoughtThrows: false, comments: [] };
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    etn: {
      networks: { list: async () => scenario.networks },
      thoughts: {
        get: async () => {
          if (scenario.thoughtThrows) throw new Error('gone');
          return {};
        },
      },
      comments: {
        list: async () =>
          scenario.comments.map((c) => ({ ...c, title: null, valid_from: '', valid_to: null })),
      },
    },
  };
}

let moduleCache: any = null;
async function loadInternals(): Promise<any> {
  if (moduleCache === null) {
    installShim();
    moduleCache = await import('../src/renderer/lib/hover-preview.js');
  }
  return moduleCache.hoverPreviewInternals;
}

/** Триггер-чип с атрибутами чужой мысли. */
function trigger(title = 'Чужая мысль'): ShimElement {
  const el = new ShimElement('span');
  el.dataset['hpKind'] = 'thought-cross-network';
  el.dataset['hpOwnerType'] = 'thought';
  el.dataset['hpOwnerId'] = FOREIGN_THOUGHT;
  el.dataset['hpTitle'] = title;
  el.dataset['hpNetwork'] = FOREIGN_NET;
  return el;
}

describe('Ctrl-hover: предпросмотр мысли чужой сети (9be98ae1)', () => {
  let internals: any;
  let store: any;

  beforeEach(async () => {
    internals = await loadInternals();
    store = (await import('../src/renderer/state.js')).store;
    // Каталог сетей кэшируется в store — между сценариями его чистим,
    // иначе «сеть недоступна» не воспроизводится после успешного теста.
    store.update({ networkList: [] });
    scenario.networks = [{ id: FOREIGN_NET, display_name: 'Чужая сеть' }];
    scenario.thoughtThrows = false;
    scenario.comments = [
      { kind: 'permanent', body_html: '<p>Постоянный комментарий цели</p>' },
    ];
  });

  it('показывает комментарий цели, в заголовке — имя сети-источника', async () => {
    const content = await internals.resolveCrossNetworkThoughtContent(trigger());
    assert.ok(content !== null, 'попап строится');
    assert.ok(content!.title.includes('Чужая сеть'), 'в заголовке имя сети-источника');
    assert.ok(content!.title.includes('Чужая мысль'), 'в заголовке имя цели');
    // Тело карточки — общая оболочка комментария `lib/ui/comment.ts`
    // (задача 9cb87c42), текст комментария — во вложенном виде.
    const view = content!.body.querySelector('.comment-view') as unknown as
      | { innerHTML: string }
      | null;
    assert.ok(view !== null, 'тело карточки — оболочка комментария с видом');
    assert.ok(
      view!.innerHTML.includes('Постоянный комментарий цели'),
      'в теле — комментарий чужой мысли',
    );
  });

  it('сеть недоступна — сообщение вместо комментария, имя сети в заголовке', async () => {
    scenario.networks = [];
    const content = await internals.resolveCrossNetworkThoughtContent(trigger());
    assert.ok(content !== null, 'попап строится');
    assert.ok(content!.title.includes('Чужая мысль'), 'заголовок сохранён');
    assert.ok(content!.body.flatText().includes('Сеть недоступна'), 'сообщение о недоступности сети');
  });

  it('мысль недоступна в сети — сообщение вместо комментария', async () => {
    scenario.thoughtThrows = true;
    const content = await internals.resolveCrossNetworkThoughtContent(trigger());
    assert.ok(content !== null, 'попап строится');
    assert.ok(content!.title.includes('Чужая сеть'), 'в заголовке имя сети-источника');
    assert.ok(
      content!.body.flatText().includes('Мысль недоступна'),
      'сообщение о недоступности мысли',
    );
  });

  it('нет постоянного комментария — попап не открывается', async () => {
    scenario.comments = [];
    const content = await internals.resolveCrossNetworkThoughtContent(trigger());
    assert.equal(content, null);
  });
});
