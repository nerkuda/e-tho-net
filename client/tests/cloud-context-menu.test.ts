/**
 * Регресс-тест: контекстное меню доступно в КАЖДОМ отображении облачка мысли
 * (спецификация «Контекстное меню мысли»: холст, панель выделения, дерево
 * «Структур», чипы истории и закреплённых, чипы значений свойств, пилюли
 * локального графа и кнопка «Действия»).
 *
 * Причина появления теста — ошибка b674fc1a «У облачков мыслей пропали
 * контекстные меню»: правка T6 версии 0.10.1 переписала экран «Дневник» и
 * сняла правый клик с чипов ленты (прежний самодельный `showTargetMenu`),
 * а сторож словаря меню этого не заметил — из его перечня просто исчезли
 * функции меню хроники. Набор команд у облачка один на всю программу
 * (`canvas/context-menu.ts` → `showThoughtContextMenu`), поэтому каждое место
 * отображения обязано звать именно его, а не собирать второй список.
 *
 * Композиция команд проверяется unit-тестами конструктора
 * (`context-menu.test.ts`); здесь — только факт делегирования из мест
 * отображения (как в `editor-cloud-menu.test.ts`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { FocusResponse } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

const SRC = {
  historyBar: resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'history-bar.ts'),
  pinnedBar: resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'pinned-bar.ts'),
  chronicle: resolve(
    import.meta.dirname,
    '..',
    'src',
    'renderer',
    'screens',
    'chronicle',
    'chronicle.ts',
  ),
  search: resolve(import.meta.dirname, '..', 'src', 'renderer', 'search', 'search.ts'),
  linksTab: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'links-tab.ts'),
  publicationCard: resolve(
    import.meta.dirname,
    '..',
    'src',
    'renderer',
    'editor',
    'publication-card.ts',
  ),
  canvas: resolve(import.meta.dirname, '..', 'src', 'renderer', 'canvas', 'canvas.ts'),
  contextMenu: resolve(
    import.meta.dirname,
    '..',
    'src',
    'renderer',
    'canvas',
    'context-menu.ts',
  ),
  structures: resolve(
    import.meta.dirname,
    '..',
    'src',
    'renderer',
    'screens',
    'structures',
    'structures.ts',
  ),
  usagePanel: resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'usage-panel.ts'),
};

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Вырезает тело функции по её сигнатуре (до закрывающей скобки в 1-й колонке). */
function functionBody(src: string, signature: string, end = '\n}\n'): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `expected ${signature} to be defined`);
  const stop = src.indexOf(end, start);
  assert.ok(stop > start, `expected ${signature} body to be closed with ${JSON.stringify(end)}`);
  return src.slice(start, stop);
}

describe('контекстное меню облачка — общий конструктор во всех отображениях (b674fc1a)', () => {
  it('чип панели истории зовёт общее меню мысли (и полоса, и строка дропдауна)', () => {
    const src = readText(SRC.historyBar);
    assert.match(
      src,
      /import\s*\{[^}]*showOutOfCanvasThoughtMenu[^}]*\}\s*from\s*'\.\.\/canvas\/context-menu\.js'/,
      'панель истории обязана импортировать общий фасад меню вне холста',
    );
    const chip = functionBody(src, 'function buildChip(');
    assert.ok(
      chip.includes('onContextMenu') && chip.includes('showOutOfCanvasThoughtMenu('),
      'чип полосы истории обязан вешать общее меню мысли на правый клик',
    );
    // «Налево (родственник)» вне холста цепляет родителя САМОЙ мысли: фасад
    // резолвит его явно до открытия меню (ошибка 2baa78fb).
    assert.ok(
      chip.includes("dir: 'siblings'") && chip.includes('openHandler'),
      'чип истории передаёт контекст меню (открытие — путём чипа)',
    );
    // Строки дропдауна строит `showMenuAt` — их меню вешается отдельно.
    const dropdown = functionBody(src, 'function openHistoryMenu(');
    assert.ok(
      dropdown.includes('wireHistoryContextMenu('),
      'строка дропдауна истории обязана получать то же меню мысли',
    );
    const wire = functionBody(src, 'function wireHistoryContextMenu(');
    assert.ok(
      wire.includes('showOutOfCanvasThoughtMenu('),
      'меню строки дропдауна — общий фасад вне холста (резолв родителя до открытия)',
    );
  });

  it('чип панели закреплённых зовёт общее меню мысли', () => {
    const src = readText(SRC.pinnedBar);
    const chip = functionBody(src, 'function buildChip(');
    assert.ok(
      chip.includes('openPinnedThoughtMenu('),
      'чип закреплённых обязан вешать общее меню мысли',
    );
  });

  it('чип ленты «Дневника»: облачко мысли — общее меню + команды записи, связь — меню записи', () => {
    const src = readText(SRC.chronicle);
    assert.match(
      src,
      /import\s*\{[^}]*showOutOfCanvasThoughtMenu[^}]*\}\s*from\s*'\.\.\/\.\.\/canvas\/context-menu\.js'/,
      'лента дневника обязана импортировать общий фасад меню вне холста',
    );
    const chip = functionBody(src, 'function buildChip(');
    assert.ok(
      chip.includes('contextmenu'),
      'buildChip дневника обязан перехватывать правый клик',
    );
    assert.ok(
      chip.includes('showOutOfCanvasThoughtMenu('),
      'облачко мысли в ленте дневника обязано открывать общее меню мысли',
    );
    // Операции контекста записи передаются опцией, а не вторым списком команд.
    assert.ok(
      chip.includes('extraItems') &&
        chip.includes("t('chrono.menu.detach')") &&
        chip.includes("t('chrono.menu.attach')"),
      'команды «Отвязать»/«Связать с…» — блоком extraItems общего меню',
    );
    assert.ok(
      src.includes('function showDiaryLinkMenu('),
      'чип связи в ленте обязан иметь своё короткое меню (общее меню мысли к связи неприменимо)',
    );
  });

  it('три облачка результатов поиска: общее меню мысли через ленивый импорт фасада', () => {
    const src = readText(SRC.search);
    // Статический импорт замкнул бы цикл `app → search → context-menu → app`.
    assert.ok(
      !/import\s*\{[^}]*showThoughtContextMenu/.test(src),
      'search.ts не импортирует фасад меню статически (цикл импортов)',
    );
    assert.match(
      src,
      /await import\('\.\.\/canvas\/context-menu\.js'\)/,
      'фасад меню подключается ленивым import()',
    );
    const actions = functionBody(src, 'function searchCloudActions(');
    assert.ok(
      actions.includes('onContextMenu') && actions.includes('openSearchThoughtMenu('),
      'действия облачка-хита обязаны вешать общее меню мысли на правый клик',
    );
    assert.equal(
      (src.match(/actions: searchCloudActions\(activate, /g) ?? []).length,
      3,
      'меню получают все три облачка: «Мысль по ID», имена и тексты',
    );
    const menu = functionBody(src, 'function openSearchThoughtMenu(');
    assert.ok(
      menu.includes('showThoughtContextMenu(') &&
        menu.includes('showThoughtMenuUnder(') &&
        menu.includes('resolveSiblingParentId('),
      'меню открывается общим фасадом, родитель для «налево» резолвится явно',
    );
    assert.ok(
      menu.includes('store.state.networkId !== networkId'),
      'после await резолва сверяется сеть (класс a3151e33)',
    );
    // Клавиатурный путь — только привязки общего диспетчера.
    assert.ok(
      src.includes("chord: 'Shift+F10'") && src.includes("chord: 'ContextMenu'"),
      'Shift+F10/ContextMenu — привязки lib/keymap.ts',
    );
  });

  it('строки дропдауна закреплённых зовут общее меню мысли (ошибка ffc173c9)', () => {
    const src = readText(SRC.pinnedBar);
    const overflow = functionBody(src, 'function openOverflowMenu(');
    assert.ok(
      overflow.includes('wirePinnedContextMenu('),
      'каждая строка overflow-дропдауна получает меню мысли',
    );
    const wire = functionBody(src, 'function wirePinnedContextMenu(');
    assert.ok(
      wire.includes('openPinnedThoughtMenu('),
      'меню строки — общий конструктор, открытие идёт путём строки',
    );
    // «Налево (родственник)» вне холста цепляет родителя САМОЙ мысли: явный
    // резолв, иначе конструктор берёт родителя фокуса (спецификация
    // «Контекстное меню мысли», ошибка ffc173c9).
    const menu = functionBody(src, 'async function openPinnedThoughtMenu(');
    assert.ok(
      menu.includes('resolveSiblingParentId(') && menu.includes('siblingParentId'),
      'строка закреплённых передаёт siblingParentId явно (резолв до открытия меню)',
    );
    assert.ok(
      menu.includes('store.state.networkId !== networkId'),
      'после await резолва сверяется сеть (класс a3151e33)',
    );
    // Тот же дефект был у видимого чипа панели: он тоже идёт через общий резолв.
    const chip = functionBody(src, 'function buildChip(');
    assert.ok(
      chip.includes('openPinnedThoughtMenu('),
      'видимый чип закреплённых резолвит родителя так же, как строка дропдауна',
    );
  });

  it('упоминания в связях: облачко-мысль зовёт общее меню (ошибка ffc173c9)', () => {
    const src = readText(SRC.linksTab);
    const actions = functionBody(src, 'function mentionCloudActions(');
    assert.ok(
      actions.includes('onContextMenu') && actions.includes('openOutOfCanvasThoughtMenu('),
      'чип упоминания обязан открывать общее меню мысли',
    );
    const menu = functionBody(src, 'async function openOutOfCanvasThoughtMenu(');
    assert.ok(
      menu.includes('showThoughtContextMenu(') &&
        menu.includes('resolveSiblingParentId(') &&
        menu.includes('siblingParentId'),
      'меню вне холста передаёт siblingParentId явно (резолв до открытия)',
    );
    assert.ok(
      menu.includes('store.state.networkId !== networkId'),
      'после await резолва сверяется сеть (класс a3151e33)',
    );
    // Второе место того же файла — облачко конца связи во вкладке «Мысли».
    const endpoint = functionBody(src, 'function buildThoughtCloud(');
    assert.ok(
      endpoint.includes('openOutOfCanvasThoughtMenu('),
      'облачко конца связи резолвит родителя той же функцией',
    );
    assert.equal(
      (src.match(/actions: mentionCloudActions\(\(\) => void open\(hit\), /g) ?? []).length,
      2,
      'обе группы упоминаний (ссылки и тексты) получают меню',
    );
  });

  it('владелец-мысль в карточке публикации: меню + «Убрать из владельцев» (ffc173c9)', () => {
    const src = readText(SRC.publicationCard);
    const cloud = functionBody(src, 'function buildOwnerCloud(');
    assert.ok(
      cloud.includes('onContextMenu') && cloud.includes('isThoughtOwner'),
      'меню вешается только владельцу-МЫСЛИ (связи меню мысли не применимо)',
    );
    const menu = functionBody(src, 'function openOwnerThoughtMenu(');
    assert.ok(
      menu.includes('showThoughtContextMenu(') &&
        menu.includes('resolveSiblingParentId(') &&
        menu.includes('extraItems') &&
        menu.includes("t('publication.cover.ownerRemove')"),
      'общее меню + команда контекста «Убрать из владельцев»',
    );
    assert.ok(
      menu.includes('store.state.networkId !== networkId'),
      'после await резолва сверяется сеть (класс a3151e33)',
    );
  });

  it('общий фасад меню вне холста: резолв родителя до открытия и сверка сети (2baa78fb)', () => {
    const src = readText(SRC.contextMenu);
    const helper = functionBody(src, 'export async function showOutOfCanvasThoughtMenu(');
    assert.ok(
      helper.includes('resolveSiblingParentId(') && helper.includes('siblingParentId'),
      'родитель «налево» резолвится ДО открытия меню и передаётся явно',
    );
    assert.ok(
      helper.includes('store.state.networkId !== networkId'),
      'после await резолва сверяется сеть (класс a3151e33)',
    );
  });

  it('облачко дерева «Структур» зовёт общий фасад меню вне холста (2baa78fb)', () => {
    const src = readText(SRC.structures);
    assert.match(
      src,
      /import\s*\{[^}]*showOutOfCanvasThoughtMenu[^}]*\}\s*from\s*'\.\.\/\.\.\/canvas\/context-menu\.js'/,
      'дерево структур обязано импортировать общий фасад меню вне холста',
    );
    const cloud = functionBody(src, 'function buildCloud(');
    assert.ok(
      cloud.includes('onContextMenu') && cloud.includes('showOutOfCanvasThoughtMenu('),
      'облачко узла дерева обязано открывать общее меню мысли с родителем САМОЙ мысли',
    );
    // «Найти на карте мыслей» — отличие контекста дерева, оно остаётся.
    assert.ok(
      cloud.includes('findOnMapHandler'),
      'команда «Найти на карте мыслей» передаётся опцией контекста',
    );
  });

  it('панель использования: меню строки резолвит родителя и сверяет сеть (2baa78fb)', () => {
    const src = readText(SRC.usagePanel);
    const menu = functionBody(src, 'async function openRowMenu(');
    assert.ok(
      menu.includes('showOutOfCanvasThoughtMenu('),
      'строка панели открывает общее меню мысли вне холста',
    );
    assert.ok(
      menu.includes('store.state.networkId !== networkId'),
      'поздний ленивый импорт не открывает меню для мысли прежней сети',
    );
    assert.ok(
      menu.includes('extraItems'),
      'команда контекста «Очистить свойство» остаётся блоком extraItems',
    );
  });

  it('строка соседа в Ctrl-hover попапе холста: общее меню (ffc173c9)', () => {
    const src = readText(SRC.canvas);
    const row = functionBody(src, 'function neighborPreviewRow(');
    assert.ok(
      row.includes('onContextMenu') &&
        row.includes('openNeighborPreviewThoughtMenu(') &&
        row.includes('closeHoverPreview()'),
      'строка соседа открывает меню мысли и закрывает превью при открытии',
    );
    const menu = functionBody(src, 'async function openNeighborPreviewThoughtMenu(');
    assert.ok(
      menu.includes('showThoughtContextMenu(') &&
        menu.includes('resolveSiblingParentId(') &&
        menu.includes('siblingParentId'),
      'строка соседа передаёт siblingParentId явно (резолв до открытия)',
    );
    assert.ok(
      menu.includes('store.state.networkId !== networkId'),
      'после await резолва сверяется сеть (класс a3151e33)',
    );
  });
});

/**
 * Поведенческий кейс блокера круга 2: правый клик по строке облачка ВНЕ холста
 * обязан спросить родителя САМОЙ мысли (`thoughts.neighbors`), а не взять
 * родителя мысли в фокусе. На дофиксовом `25ada42f` строка overflow-дропдауна
 * закреплённых открывала меню без резолва — счётчик обращений остаётся нулевым
 * (кейс красный).
 */
type Dict = Record<string, unknown>;

function installShims(bridge: Dict): void {
  (globalThis as Dict).HTMLElement = ShimElement;
  (globalThis as Dict).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
    getSelection: () => null,
  } satisfies Dict;
  const win = ((globalThis as Dict).window ?? ((globalThis as Dict).window = {})) as Dict;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.etn = bridge;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
  win.innerWidth = 1024;
  win.innerHeight = 768;
  (globalThis as Dict).ResizeObserver = class {
    observe(): void {
      /* шим */
    }
    unobserve(): void {
      /* шим */
    }
    disconnect(): void {
      /* шим */
    }
  };
}

let activeUnmount: (() => void) | null = null;

async function mountPinnedForMenu(options: {
  pins: string[];
  focusParents: string[];
  parentsOf: (id: string) => Promise<Dict[]>;
}): Promise<{
  host: ShimElement;
  body: ShimElement;
  store: typeof import('../src/renderer/state.js').store;
  neighborCalls: { id: string; dir: string; depth: number }[];
  flush: () => Promise<void>;
  unmount: () => void;
}> {
  activeUnmount?.();
  activeUnmount = null;
  const neighborCalls: { id: string; dir: string; depth: number }[] = [];
  const bridge: Dict = {
    pins: {
      list: () => Promise.resolve(options.pins.map((id) => ({ thought_id: id, position: 0 }))),
    },
    thoughts: {
      resolve: (_networkId: string, ids: string[]) =>
        Promise.resolve(ids.map((id) => ({ id, title: `t-${id}`, active: true }))),
      neighbors: (_networkId: string, id: string, dir: string, depth: number) => {
        neighborCalls.push({ id, dir, depth });
        return options.parentsOf(id);
      },
    },
  };
  installShims(bridge);
  const { store } = await import('../src/renderer/state.js');
  const { setQueryData, queryKeys } = await import('../src/renderer/lib/live/index.js');
  const { mountPinnedBar } = await import('../src/renderer/screens/pinned-bar.js');
  const focus = {
    focused: { id: 'T' },
    parents: options.focusParents.map((id) => ({ id })),
    sorts: {
      parents: { sort: 'alpha', order: 'asc' },
      children: { sort: 'alpha', order: 'asc' },
      siblings: { sort: 'alpha', order: 'asc' },
    },
  } as unknown as FocusResponse;
  store.update({
    profileId: 'profile-1',
    networkId: 'network-1',
    activeTabId: 'tab-A',
    activeView: 'map',
    screen: 'workspace',
    editorTarget: null,
    focus,
    showInactive: false,
    showTrash: true,
    rtStatusByNetwork: { 'network-1': 'connected' },
  });
  setQueryData(queryKeys.pins(), options.pins);
  const host = new ShimElement('div', 'pinned-bar');
  // Раскладки в шиме нет — заставляем панель перенести второй чип в дропдаун.
  (host as unknown as { scrollWidth: number }).scrollWidth = 100;
  (host as unknown as { clientWidth: number }).clientWidth = 10;
  const unmount = mountPinnedBar(host as unknown as HTMLElement);
  activeUnmount = unmount;
  return {
    host,
    body: ((globalThis as Dict).document as { body: ShimElement }).body,
    store,
    neighborCalls,
    flush: async (): Promise<void> => {
      for (let index = 0; index < 6; index += 1) {
        await new Promise((resolveTick) => setTimeout(resolveTick, 0));
      }
    },
    unmount,
  };
}

describe('меню вне холста: родитель «налево» — родитель самой мысли (ffc173c9)', () => {
  it('строка overflow-дропдауна закреплённых резолвит родителя M, а не фокуса T', async () => {
    const harness = await mountPinnedForMenu({
      pins: ['T', 'M'],
      // Фокус — T (ребёнок P1); кликаем по M (ребёнок P2).
      focusParents: ['P1'],
      parentsOf: async (id) => [{ id: id === 'M' ? 'P2' : 'P1' }],
    });
    await harness.flush();
    const more = harness.host.querySelector('.pinned-more');
    assert.ok(more !== null, 'второй закреплённый ушёл в overflow-дропдаун');
    more.click();
    const row = harness.body
      .findAll('menu-item')
      .find((element) => element.dataset['dragId'] === 'M');
    assert.ok(row !== undefined, 'строка мысли M есть в дропдауне');
    row.dispatchContextMenu();
    await harness.flush();
    assert.deepEqual(
      harness.neighborCalls,
      [{ id: 'M', dir: 'parents', depth: 1 }],
      'родитель запрошен для САМОЙ мысли M, а не для мысли в фокусе T',
    );
    assert.equal(harness.body.querySelectorAll('.menu').length, 1, 'меню мысли открылось');
    harness.unmount();
  });
});
