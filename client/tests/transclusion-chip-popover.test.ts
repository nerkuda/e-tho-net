/**
 * DOM-пробы шапки-чипа и поповера правки ссылки трансклюзии (0.12.1, ТП
 * `fcde7c55`, задача `68591b8a`).
 *
 * Проверяют наблюдаемое поведение, не сводимое к чистым функциям:
 *  1. `decorateViewTransclusionChips` вешает на блок просмотра чип «имя · раздел»
 *     (имя — из карты развёртки), идемпотентно; клик чипа открывает меню команд
 *     навигации в точке клика;
 *  2. `openTransclusionLinkPopover` (переделка по задаче `aa309fb7`): сверху —
 *     команды навигации без подписи (удаление крестиком), первой командой
 *     центра — «Все разделы комментария», ниже — живой поиск ПО РАЗДЕЛАМ
 *     мини-синтаксисом подстрок, затем список разделов; поиска мысли нет; выбор
 *     раздела применяется ОДНОЙ транзакцией замены диапазона ссылки.
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
const ID_B = '11111111-2222-3333-4444-555555555555';
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

/**
 * Надпись строки раздела БЕЗ метки уровня: у строк источника надпись лежит в
 * обёртке `.ui-btn__label` (перед ней — префикс `H1`–`H6`), у строки текущего
 * раздела без уровня надпись стоит прямо на кнопке.
 */
function rowLabel(row: ShimElement): string {
  const label = row.querySelector('.ui-btn__label');
  return label === null ? row.textContent : label.textContent;
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

describe('поповер правки ссылки (68591b8a, переделка aa309fb7)', () => {
  it('команды сверху без подписи, «Все разделы комментария» и разделы источника', async () => {
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
      // Панель команд — ПЕРВЫЙ элемент поповера, без подписи «Команды».
      const first = popover!.children[0]!;
      assert.ok(
        first.classList.contains('transclusion-popover-commands'),
        'панель команд стоит сверху',
      );
      assert.ok(
        !popover!.textContent.includes('Команды'),
        'у панели команд нет подписи «Команды»',
      );
      assert.ok(!popover!.textContent.includes('Мысль'), 'поиска мысли в поповере нет');
      const commands = first.children.filter((child) => child.classList.contains('ui-btn'));
      assert.equal(commands.length, 5, 'четыре навигации + удаление блока');
      assert.ok(
        commands.some((child) => (child as { title?: string }).title === 'Удалить блок'),
        'в поповере есть команда удаления блока',
      );
      // Первая команда центра — «Все разделы комментария» с тултипом.
      const all = popover!.querySelector('.transclusion-popover-all');
      assert.ok(all !== null, 'есть команда «Все разделы комментария»');
      assert.equal(all!.textContent, 'Все разделы комментария');
      assert.equal(
        (all as { title?: string }).title,
        'Показать все разделы комментария мысли',
        'тултип команды',
      );
      // Список разделов источника — целиком сразу, без строки «Весь комментарий».
      const rows = popover!
        .querySelector('.transclusion-popover-sections')!
        .querySelectorAll('.transclusion-popover-row');
      assert.deepEqual(
        rows.map((row) => rowLabel(row)),
        ['Альфа', 'Бета'],
        'разделы источника показаны целиком сразу',
      );
    } finally {
      store.update({ networkId: null });
    }
  });

  it('живой поиск по разделам: подстроки без регистра и порядка, пусто — все', async () => {
    stubEtn('## Первая строка\nтекст\n## Вторая строка\nтекст\n## Третья часть\nтекст');
    const { store } = await import('../src/renderer/state.js');
    store.update({ networkId: NET });
    try {
      // Отдельный источник (ID_B): общий кэш источников на сеть удержал бы тело
      // предыдущего теста — суть проверки в другом наборе разделов.
      const doc = `![[#${ID_B}]]`;
      const ref = parseTransclusions(doc)[0]!;
      const view = { state: EditorState.create({ doc }), dispatch: () => undefined };
      openTransclusionLinkPopover(view as any, ref, new ShimElement('button') as unknown as HTMLElement);
      await tick();
      await tick();

      const body = (globalThis as any).document.body as ShimElement;
      const popover = body.querySelector(`.${TRANSCLUSION_POPOVER_CLASS}`)!;
      const list = popover.querySelector('.transclusion-popover-sections')!;
      const input = popover.querySelector('.transclusion-popover-input')!;
      const labels = (): string[] =>
        list.querySelectorAll('.transclusion-popover-row').map((row) => rowLabel(row));
      assert.equal(labels().length, 3, 'пусто — все разделы');

      // Регистр и порядок не важны; обе части обязаны присутствовать (мини-синтаксис).
      input.value = 'стр вт';
      input.dispatchEvent({ type: 'input' });
      assert.deepEqual(labels(), ['Вторая строка'], 'подстроки без регистра и порядка');

      input.value = 'тре';
      input.dispatchEvent({ type: 'input' });
      assert.deepEqual(labels(), ['Третья часть'], 'одна подстрока');

      input.value = 'неттакого';
      input.dispatchEvent({ type: 'input' });
      assert.deepEqual(labels(), [], 'нет совпадений — пусто');
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
        .find((row) => rowLabel(row) === 'Бета');
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

  it('«Все разделы комментария» применяет ссылку без раздела одной транзакцией (aa309fb7)', async () => {
    stubEtn('## Альфа\nтекст\n## Бета\nтекст');
    const { store } = await import('../src/renderer/state.js');
    store.update({ networkId: NET });
    try {
      const doc = `![[#${ID_A}#Бета]]`;
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
      const all = body.querySelector('.transclusion-popover-all');
      assert.ok(all !== null, 'команда «Все разделы комментария» найдена');
      all!.click();
      await tick();

      assert.equal(events.length, 1, 'ссылка без раздела — ровно одна транзакция');
      assert.deepEqual(events[0].changes, {
        from: ref.start,
        to: ref.end,
        insert: `![[#${ID_A}]]`,
      });
      assert.equal(view.state.doc.toString(), `![[#${ID_A}]]`);
    } finally {
      store.update({ networkId: null });
    }
  });
});

describe('уровни и префиксы строк списка разделов (9cdbefd2)', () => {
  // Отдельный источник на тест: общий кэш тел на сеть удержал бы тело
  // предыдущего теста (sourceCache ключ — `сеть:источник`).
  const SRC_LEVELS = '33333333-1111-4111-8111-111111111111';
  const SRC_MISSING = '44444444-1111-4111-8111-111111111111';
  const SRC_SEARCH = '55555555-1111-4111-8111-111111111111';

  /** Открывает поповер для источника и возвращает корень документа. */
  async function openPopover(id: string, source: string, doc = `![[#${id}]]`): Promise<ShimElement> {
    stubEtn(source);
    const { store } = await import('../src/renderer/state.js');
    store.update({ networkId: NET });
    const ref = parseTransclusions(doc)[0]!;
    const view = { state: EditorState.create({ doc }), dispatch: () => undefined };
    openTransclusionLinkPopover(view as any, ref, new ShimElement('button') as unknown as HTMLElement);
    await tick();
    await tick();
    return (globalThis as any).document.body as ShimElement;
  }

  /** Возвращает сеть в исходное состояние (данные и кэш изолируются ключом источника). */
  async function resetNetwork(): Promise<void> {
    (await import('../src/renderer/state.js')).store.update({ networkId: null });
  }

  it('строки источника несут метку H1–H6 и data-level по уровню заголовка', async () => {
    const body = await openPopover(SRC_LEVELS, '# Первый\nтекст\n## Второй\nтекст\n### Третий');
    try {
      const rows = body
        .querySelector('.transclusion-popover-sections')!
        .querySelectorAll('.transclusion-popover-row');
      assert.deepEqual(rows.map((row) => rowLabel(row)), ['Первый', 'Второй', 'Третий']);
      assert.deepEqual(
        rows.map((row) => row.querySelector('.transclusion-popover-level')!.textContent),
        ['H1', 'H2', 'H3'],
        'перед названием — приглушённая метка уровня',
      );
      assert.deepEqual(
        rows.map((row) => row.getAttribute('data-level')),
        ['1', '2', '3'],
        'отступ задаётся атрибутом уровня',
      );
    } finally {
      await resetNetwork();
    }
  });

  it('строка текущего раздела, которого нет в источнике, — без метки и отступа', async () => {
    const body = await openPopover(SRC_MISSING, '## Есть\nтекст', `![[#${SRC_MISSING}#Чужой]]`);
    try {
      const rows = body
        .querySelector('.transclusion-popover-sections')!
        .querySelectorAll('.transclusion-popover-row');
      assert.equal(rows.length, 2, 'строка чужого раздела + раздел источника');
      assert.equal(rowLabel(rows[0]!), 'Чужой', 'чужой раздел — первой строкой, помечен активным');
      assert.equal(rows[0]!.querySelector('.transclusion-popover-level'), null, 'без метки уровня');
      assert.equal(rows[0]!.getAttribute('data-level'), null, 'без отступа по уровню');
    } finally {
      await resetNetwork();
    }
  });

  it('живой поиск фильтрует по названию раздела, а не по метке уровня', async () => {
    const body = await openPopover(SRC_SEARCH, '## Альфа\nтекст\n## Бета');
    try {
      const list = body.querySelector('.transclusion-popover-sections')!;
      const input = body.querySelector('.transclusion-popover-input')!;
      const labels = (): string[] =>
        list.querySelectorAll('.transclusion-popover-row').map((row) => rowLabel(row));
      assert.equal(labels().length, 2, 'пусто — все разделы');
      input.value = 'аль';
      input.dispatchEvent({ type: 'input' });
      assert.deepEqual(labels(), ['Альфа'], 'поиск по названию');
      // Метка уровня — `H2`, но в поиск она не входит.
      input.value = 'H2';
      input.dispatchEvent({ type: 'input' });
      assert.deepEqual(labels(), [], 'метка уровня в поиск не входит');
    } finally {
      await resetNetwork();
    }
  });
});
