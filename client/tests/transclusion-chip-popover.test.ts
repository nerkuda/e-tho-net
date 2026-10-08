/**
 * DOM-пробы шапки-чипа и поповера правки ссылки трансклюзии (0.12.1, ТП
 * `fcde7c55`, задача `68591b8a`).
 *
 * Проверяют наблюдаемое поведение, не сводимое к чистым функциям:
 *  1. `decorateViewTransclusionChips` вешает на блок просмотра чип «имя · раздел»
 *     (имя — из карты развёртки), идемпотентно; клик чипа открывает меню команд
 *     навигации в точке клика;
 *  2. `openTransclusionLinkPopover` открывает поповер с полем живого поиска,
 *     списком разделов источника (целиком сразу) и командами; выбор раздела
 *     применяется ОДНОЙ транзакцией замены диапазона ссылки.
 *
 * DOM-shimmed, как соседние lib-ui-тесты (`comment-commands.test.ts`).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { EditorState } from '@codemirror/state';

import { parseTransclusions } from '@etn/markdown';

import { ShimElement } from './dom-shim.js';
import {
  TRANSCLUSION_CHIP_CLASS,
  TRANSCLUSION_HEAD_CLASS,
  TRANSCLUSION_POPOVER_CLASS,
  decorateViewTransclusionChips,
  openTransclusionLinkPopover,
} from '../src/renderer/editor/transclusion.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const NET = 'c4f9a3b2-1111-2222-3333-444455556666';

/** Минимальный DOM/window-шим (поповер, меню, выпадашка, списки). */
function installShim(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.innerWidth = 1024;
  win.innerHeight = 768;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

/** Заглушка моста `etn`: имя источника и тело постоянного комментария. */
function stubEtn(body: string): void {
  const stub = {
    thoughts: {
      resolve: async (_networkId: string, ids: string[]) =>
        ids.map((id) => ({ id, title: id === ID_A ? 'Мысль A' : 'Мысль B' })),
      findDuplicates: async () => [],
    },
    comments: {
      list: async () => [{ id: 'perm', kind: 'permanent', body_md: body, body_html: '', version: 1 }],
    },
  };
  (globalThis as any).etn = stub;
  // `lib/etn.ts` читает мост через `window.etn`, когда `window` определён
  // (шим его ставит) — заглушка нужна на обоих объектах.
  const win = (globalThis as any).window as { etn?: unknown } | undefined;
  if (win !== undefined) win.etn = stub;
}

/** Микрозадача: даёт осесть асинхронной загрузке разделов/поиска. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Блок просмотра `.md-transclusion` с источником и (опц.) разделом. */
function viewBlock(sourceId: string, section: string | null): ShimElement {
  const block = new ShimElement('div');
  block.className = 'md-transclusion';
  block.setAttribute('data-transclusion-source', sourceId);
  if (section !== null) block.setAttribute('data-transclusion-section', section);
  return block;
}

/** Корень просмотра с одним блоком. */
function viewRoot(block: ShimElement): ShimElement {
  const root = new ShimElement('div');
  root.className = 'md-field-view';
  root.append(block);
  return root;
}

beforeEach(() => {
  installShim();
});

describe('чип-шапка блока в просмотре (68591b8a)', () => {
  it('вешает чип «имя · раздел» из карты развёртки', () => {
    const root = viewRoot(viewBlock(ID_A, 'Раздел'));
    decorateViewTransclusionChips(root as unknown as HTMLElement, new Map([[ID_A, 'Мысль']]));
    const heads = root.querySelectorAll(`.${TRANSCLUSION_HEAD_CLASS}`);
    assert.equal(heads.length, 1, 'одна шапка на блок');
    const chip = heads[0]!.querySelector(`.${TRANSCLUSION_CHIP_CLASS}`);
    assert.ok(chip !== null, 'шапка несёт чип');
    assert.equal(chip!.textContent, 'Мысль · Раздел', 'подпись — имя и раздел');
  });

  it('идемпотентна: повторная разметка не плодит шапки', () => {
    const root = viewRoot(viewBlock(ID_A, null));
    decorateViewTransclusionChips(root as unknown as HTMLElement, new Map([[ID_A, 'Мысль']]));
    decorateViewTransclusionChips(root as unknown as HTMLElement, new Map([[ID_A, 'Мысль']]));
    assert.equal(root.querySelectorAll(`.${TRANSCLUSION_HEAD_CLASS}`).length, 1);
  });

  it('клик по чипу открывает меню команд навигации (без смены ссылки)', () => {
    const root = viewRoot(viewBlock(ID_A, null));
    decorateViewTransclusionChips(root as unknown as HTMLElement, new Map([[ID_A, 'Мысль']]));
    const chip = root.querySelector(`.${TRANSCLUSION_CHIP_CLASS}`) as ShimElement;
    chip.click();
    const body = (globalThis as any).document.body as ShimElement;
    const menu = body.querySelector('.menu');
    assert.ok(menu !== null, 'меню открыто в теле документа');
    const rows = menu!.querySelectorAll('.menu-item');
    assert.equal(rows.length, 4, 'ровно четыре команды навигации (без правки)');
  });
});

describe('поповер правки ссылки (68591b8a)', () => {
  it('открывает поле поиска, разделы источника целиком и команды', async () => {
    stubEtn('## Альфа\nтекст\n## Бета\nтекст');
    const { store } = await import('../src/renderer/state.js');
    store.update({ networkId: NET });
    try {
      const doc = `![[#${ID_A}]]`;
      const ref = parseTransclusions(doc)[0]!;
      const view = { state: EditorState.create({ doc }), dispatch: () => undefined };
      openTransclusionLinkPopover(view as any, ref, new ShimElement('button') as unknown as HTMLElement);
      await tick();
      await tick();

      const body = (globalThis as any).document.body as ShimElement;
      const popover = body.querySelector(`.${TRANSCLUSION_POPOVER_CLASS}`);
      assert.ok(popover !== null, 'поповер открыт');
      // Поле живого поиска (внутри общего попапа) и четыре команды.
      assert.ok(
        body.querySelectorAll('.transclusion-popover-input').length >= 1,
        'есть поле живого поиска мыслей',
      );
      const rows = popover!.querySelectorAll('.transclusion-popover-row');
      const labels = rows.map((row) => row.textContent);
      assert.deepEqual(
        labels,
        ['Весь комментарий', 'Альфа', 'Бета'],
        'разделы источника показаны целиком сразу',
      );
      const commandsBox = body.querySelector('.transclusion-popover-commands');
      assert.ok(commandsBox !== null, 'есть ряд команд');
      const commands = commandsBox!.children.filter((child) => child.classList.contains('ui-btn'));
      assert.equal(commands.length, 5, 'четыре навигации + «Удалить блок» (c11b82ee)');
      assert.ok(
        commands.some((child) => (child as { title?: string }).title === 'Удалить блок'),
        'в поповере есть команда «Удалить блок»',
      );
    } finally {
      store.update({ networkId: null });
    }
  });

  it('выбор раздела применяется ОДНОЙ транзакцией замены ссылки', async () => {
    stubEtn('## Альфа\nтекст\n## Бета\nтекст');
    const { store } = await import('../src/renderer/state.js');
    store.update({ networkId: NET });
    try {
      const doc = `до ![[#${ID_A}]] после`;
      const ref = parseTransclusions(doc)[0]!;
      const events: any[] = [];
      const view: { state: EditorState; dispatch(spec: any): void } = {
        state: EditorState.create({ doc }),
        dispatch(spec: any): void {
          events.push(spec);
          view.state = view.state.update(spec).state;
        },
      };
      openTransclusionLinkPopover(view as any, ref, new ShimElement('button') as unknown as HTMLElement);
      await tick();
      await tick();

      const body = (globalThis as any).document.body as ShimElement;
      const betta = body
        .querySelectorAll('.transclusion-popover-row')
        .find((row) => row.textContent === 'Бета');
      assert.ok(betta !== undefined, 'строка раздела «Бета» найдена');
      betta!.click();
      await tick();

      assert.equal(events.length, 1, 'смена раздела — ровно одна транзакция');
      assert.deepEqual(events[0].changes, {
        from: ref.start,
        to: ref.end,
        insert: `![[#${ID_A}#Бета]]`,
      });
      assert.equal(view.state.doc.toString(), `до ![[#${ID_A}#Бета]] после`);
    } finally {
      store.update({ networkId: null });
    }
  });
});
