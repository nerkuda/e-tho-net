/**
 * Динамическое приклеивание футера редактора отбора (задача c20b26ef,
 * элемент интерфейса ca905fbc).
 *
 * Постановка владельца: при высоте окна Electron ≤ 1100 px в неподвижном низу
 * редактора остаются только «Применить» и «Очистить», остальное содержимое
 * футера (фраза-превью, имя с 💾/✕/«…», кнопки места, секция сортировки)
 * прокручивается вместе с деревом условий; при высоте > 1100 px неподвижна вся
 * двухрядная панель, как раньше (решение заказчика 2026-10-14).
 *
 * Проверяются вещи, на которых держится поведение:
 *   1) РАЗМЕТКА: ряд действий `.ff-actions` вынесен из футера в полосу
 *      `.fe-actions` — единственный элемент вне прокручиваемого низа;
 *   2) СОСТАВ ПОЛОСЫ: в компакте в полосе только «Применить»/«Очистить», ряд
 *      кнопок места `.ff-place` («Команды ▾») уходит в прокручиваемый низ;
 *      переключение — по `matchMedia` порога, живой ресайз без перезапуска;
 *   3) ПУСТАЯ ПОЛОСА: у модальных мест (диалог отбора типа, рецепт публикации)
 *      ряд действий пуст — полоса не создаётся (лишний шов);
 *   4) CSS: медиазапрос порога переключает прокрутку, приклеивает полосу и не
 *      даёт «Дневнику» сжаться в ноль (`.chron-filter .fe { min-height }`).
 *      Литерал порога сверяется с константой `FILTER_EDITOR_COMPACT_MAX_HEIGHT`.
 *
 * jsdom не нужен — общий DOM-шим (`./dom-shim.js`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { FilterProfileId, LinkType, NetworkProperty } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Текущее состояние медиазапроса порога (управляется тестом). */
let compactMode = false;
/** Слушатели смены медиазапроса (редактор подписывается на порог). */
const mediaListeners = new Set<(event: { matches: boolean }) => void>();

/** Переключить медиазапрос порога и уведомить подписчиков (живой ресайз). */
function fireMediaChange(matches: boolean): void {
  compactMode = matches;
  for (const listener of mediaListeners) listener({ matches });
}

function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win['innerWidth'] = 1200;
  win['innerHeight'] = 800;
  win['setTimeout'] = (fn: () => void) => {
    fn();
    return 1;
  };
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['matchMedia'] = (query: string) => ({
    media: query,
    get matches(): boolean {
      return compactMode;
    },
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      mediaListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      mediaListeners.delete(listener);
    },
  });
}

installShim();

const RENDERER = join(import.meta.dirname, '..', 'src', 'renderer');
const CSS_PATH = join(RENDERER, 'styles', 'filter-editor.css');
const CHRONICLE_CSS_PATH = join(RENDERER, 'styles', 'screens', 'chronicle.css');

const mod = await import('../src/renderer/lib/filter-editor.js');
const builder = await import('../src/renderer/lib/filter-builder.js');

const DATA = {
  registry: new Map<string, NetworkProperty>(),
  linkTypes: [] as LinkType[],
  thoughtTypes: [],
};

/**
 * Редактор «Структур мыслей» по умолчанию: дерево, сортировка и футер включены.
 * `extra` домешивается в опции фабрики (кнопки места, отключение футера и т. п.).
 */
function buildEditor(
  profile: FilterProfileId = 'thoughts',
  extra: Record<string, unknown> = {},
): any {
  const state = builder.defaultFilterCriteriaState();
  state.tree = builder.defaultFilterTreeGroup('and');
  const handle = mod.buildFilterEditor({
    profile,
    networkId: 'net-1',
    data: DATA,
    getState: () => state,
    ...extra,
    host: {
      apply: () => undefined,
      save: () => undefined,
      reset: () => undefined,
      getName: () => '',
      setName: () => undefined,
      ...(extra['host'] as Record<string, unknown> | undefined),
    },
  });
  return { handle, root: handle.root as unknown as ShimElement };
}

/** Первый потомок с точным классом. */
function one(root: ShimElement, cls: string): ShimElement | null {
  return root.findAll((n) => n.classList.contains(cls))[0] ?? null;
}

/** Кнопка места «Команды ▾» — та самая, что раньше стояла в приклеенной полосе. */
const COMMANDS_BUTTON = { id: 'commands', label: 'Команды ▾', onClick: () => undefined };

describe('футер редактора отбора: динамическое приклеивание (c20b26ef)', () => {
  it('ряд действий вынесен в полосу .fe-actions, остальной футер — в .fe-foot', () => {
    compactMode = false;
    const { root } = buildEditor();
    const layout = root.children.map((child: ShimElement) => child.className);
    assert.equal(
      layout.length,
      3,
      `корень редактора: дерево, низ, полоса действий (${layout.join(' | ')})`,
    );
    assert.match(layout[0]!, /\bft\b/, 'первым — дерево условий');
    assert.match(layout[1]!, /\bfe-foot\b/, 'затем — низ редактора');
    assert.match(layout[2]!, /\bfe-actions\b/, 'последней — полоса действий');

    const actionsBar = root.children[2]!;
    const foot = root.children[1]!;
    assert.ok(one(actionsBar, 'ff-actions') !== null, 'ряд действий — в полосе .fe-actions');
    assert.equal(one(foot, 'ff-actions'), null, 'ряд действий НЕ в прокручиваемом низу');
    assert.ok(one(actionsBar, 'ff-apply') !== null, '«Применить» приклеена');
    assert.ok(one(actionsBar, 'ff-clear') !== null, '«Очистить» приклеена');
    assert.equal(one(actionsBar, 'ff-name'), null, 'ряд имени не приклеен');

    // При низкой высоте окна это содержимое уезжает в прокрутку вместе с деревом.
    assert.ok(one(foot, 'ff-name') !== null, 'поле имени — в низу редактора');
    assert.ok(one(foot, 'ff-preview') !== null, 'фраза-превью — в низу редактора');
    assert.ok(one(foot, 'fs-sort') !== null, 'секция сортировки — в низу редактора');
  });

  it('компакт: в полосе только «Применить»/«Очистить», кнопки места — в прокрутке', () => {
    compactMode = true;
    const { root } = buildEditor('thoughts', { buttons: { extra: [COMMANDS_BUTTON] } });
    const bar = one(root, 'fe-actions');
    assert.ok(bar !== null, 'полоса действий есть — стандартные кнопки на месте');

    // Постановка владельца дословно: внизу остаются только «Применить»/«Очистить».
    assert.ok(one(bar, 'ff-apply') !== null, '«Применить» приклеена');
    assert.ok(one(bar, 'ff-clear') !== null, '«Очистить» приклеена');
    assert.equal(one(bar, 'ff-extra--commands'), null, '«Команды ▾» НЕ в приклеенной полосе');
    assert.equal(one(bar, 'ff-place'), null, 'ряда кнопок места в полосе нет');

    // Кнопки места не потеряны: они в прокручиваемом низу.
    const foot = one(root, 'fe-foot');
    assert.ok(foot !== null, 'низ редактора на месте');
    const place = one(foot, 'ff-place');
    assert.ok(place !== null, 'ряд кнопок места — в прокручиваемом низу');
    assert.ok(one(place, 'ff-extra--commands') !== null, '«Команды ▾» доступны прокруткой');
    assert.equal(one(foot, 'ff-apply'), null, '«Применить» не уехала из полосы');
  });

  it('порог меняется на лету: matchMedia переносит кнопки места без перезапуска', () => {
    compactMode = false;
    const { root } = buildEditor('thoughts', { buttons: { extra: [COMMANDS_BUTTON] } });
    const bar = one(root, 'fe-actions')!;
    assert.ok(one(bar, 'ff-extra--commands') !== null, 'выше порога «Команды ▾» — в полосе');
    assert.ok(one(bar, 'ff-place') !== null, 'выше порога ряд места — тоже в полосе');
    assert.equal(one(one(root, 'fe-foot')!, 'ff-place'), null, 'в прокрутке ряда места нет');

    fireMediaChange(true);
    const compactBar = one(root, 'fe-actions')!;
    assert.equal(
      one(compactBar, 'ff-extra--commands'),
      null,
      'компакт: «Команды ▾» ушли из полосы',
    );
    assert.ok(one(compactBar, 'ff-apply') !== null, 'компакт: «Применить» осталась приклеенной');
    const compactPlace = one(one(root, 'fe-foot')!, 'ff-place');
    assert.ok(compactPlace !== null, 'компакт: ряд места появился в прокрутке');
    assert.ok(
      one(compactPlace, 'ff-extra--commands') !== null,
      'компакт: «Команды ▾» доступны в прокрутке',
    );

    fireMediaChange(false);
    assert.ok(
      one(one(root, 'fe-actions')!, 'ff-extra--commands') !== null,
      'обратный ресайз вернул «Команды ▾» в полосу',
    );
    assert.equal(one(one(root, 'fe-foot')!, 'ff-place'), null, 'и убрал ряд места из прокрутки');
  });

  it('пустая полоса не создаётся (модальные места без своих кнопок)', () => {
    compactMode = false;
    const { root } = buildEditor('thoughts', {
      buttons: { standard: false },
      host: { apply: () => undefined },
    });
    const layout = root.children.map((child: ShimElement) => child.className);
    assert.equal(
      layout.length,
      2,
      `без ряда действий полосы нет: дерево и низ (${layout.join(' | ')})`,
    );
    assert.equal(one(root, 'fe-actions'), null, 'пустая приклеенная полоса не рисуется');

    // Стандартный набор — полоса на месте (поведение не сломано).
    const standard = buildEditor();
    assert.ok(one(standard.root, 'fe-actions') !== null, 'со стандартными кнопками полоса есть');
  });

  it('порог — структурная константа, медиазапрос переключает прокрутку и приклеивает действия', () => {
    // Порог 1100 px — значение постановки владельца; смена — осознанное решение.
    assert.equal(mod.FILTER_EDITOR_COMPACT_MAX_HEIGHT, 1100);

    const css = readFileSync(CSS_PATH, 'utf8');
    const mediaStart = css.indexOf(
      `@media (max-height: ${mod.FILTER_EDITOR_COMPACT_MAX_HEIGHT}px)`,
    );
    assert.ok(
      mediaStart >= 0,
      'медиазапрос порога обязан стоять в модуле стилей (ресайз без перезапуска клиента)',
    );
    const block = css.slice(mediaStart);

    // Прокрутка переезжает с дерева на весь низ редактора.
    assert.match(block, /\.fe\s*\{[^}]*overflow-y:\s*auto/, '.fe прокручивается целиком');
    assert.match(
      block,
      /\.fe > \.ft\s*\{[^}]*overflow-y:\s*visible/,
      '.ft больше не отдельный скролл',
    );

    // Приклеена только полоса действий: непрозрачный фон и шов над ней.
    assert.match(block, /\.fe-actions\s*\{[^}]*position:\s*sticky/, 'полоса действий приклеена');
    assert.match(
      block,
      /\.fe-actions\s*\{[^}]*background:\s*var\(--surface\)/,
      'фон полосы непрозрачен',
    );
    assert.match(
      block,
      /\.fe-actions\s*\{[^}]*border-top:\s*1px solid var\(--border\)/,
      'шов над полосой',
    );

    // Двойной шов в модальном слое: линия под фразой без команд не рисуется.
    assert.match(
      css,
      /\.ff-divider:last-child\s*\{[^}]*display:\s*none/,
      'линия фразы не дублирует границу низа, когда команд в футере нет',
    );
  });

  it('«Дневник» в компакте: редактор не сжимается в ноль, панель прокручивается', () => {
    const css = readFileSync(CHRONICLE_CSS_PATH, 'utf8');
    const threshold = mod.FILTER_EDITOR_COMPACT_MAX_HEIGHT;
    const mediaStart = css.indexOf(`@media (max-height: ${threshold}px)`);
    assert.ok(
      mediaStart >= 0,
      'компактная раскладка «Дневника» живёт в том же медиазапросе порога',
    );
    const block = css.slice(mediaStart);

    const minHeight = block.match(/\.chron-filter\s+\.fe\s*\{[^}]*min-height:\s*(\d+)px/);
    assert.ok(
      minHeight !== null,
      'нулевой .fe с overflow-y:auto — клип-контейнер: нужен min-height',
    );
    assert.ok(
      Number(minHeight[1]) >= 200,
      `минимум редактора должен вмещать дерево и футер (${minHeight[1]}px)`,
    );

    // Панель отбора остаётся хозяином прокрутки (правило уже есть в модуле).
    assert.match(css, /\.chron-filter-area\s*\{[^}]*overflow-y:\s*auto/, 'панель прокручивается');
  });
});
