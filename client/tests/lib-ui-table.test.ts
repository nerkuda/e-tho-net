/**
 * Единая таблица списков `lib/ui` (задача dad2b029, требование 93115633,
 * компонент 88111458, техпроект 78398ec5).
 *
 * Проверяем поведение по DoD без настоящего Vaadin Grid:
 *   • чистые функции — цикл сортировки, стабильная сортировка, навигационная
 *     математика (стрелки/Home/End/PgUp/PgDn), TSV-копирование с заголовками
 *     и экранированием;
 *   • фасад на подставном адаптере (`GridTableAdapter`-стаб): колонки/строки,
 *     текущая строка с клавиатуры, Enter-активация, клик/двойной клик,
 *     контекстное меню строки, копирование, пустое состояние, выделение;
 *   • реактивная подписка на селектор store — таблица перерисовывается сама,
 *     без ручных invalidate-хуков вызывающего, и отписывается при destroy.
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`), конвенция
 * `lib-ui-fields.test.ts`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import type { TableColumn } from '../src/renderer/lib/ui/table.js';
import type { GridColumnSpec, GridTableAdapter } from '../src/renderer/lib/ui/table-grid.js';

function shimDom(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (_text: string) => new ShimElement('#text') as any,
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.innerWidth = 1000;
  win.innerHeight = 800;
}

type TableModule = typeof import('../src/renderer/lib/ui/table.js');
type GridModule = typeof import('../src/renderer/lib/ui/table-grid.js');

async function load(): Promise<{ table: TableModule; grid: GridModule }> {
  shimDom();
  (globalThis as any).window.etn = {
    ui: { setState: async () => undefined, getState: async () => null },
  };
  const table = await import('../src/renderer/lib/ui/table.js');
  const grid = await import('../src/renderer/lib/ui/table-grid.js');
  return { table, grid };
}

interface Row {
  id: string;
  name: string;
  size: number;
}

const COLUMNS: TableColumn<Row>[] = [
  { key: 'name', header: 'Имя', sortable: true },
  { key: 'size', header: 'Размер', sortable: true, align: 'end' },
];

/** Подставной адаптер: записывает вызовы фасада и умеет «стрелять» событиями. */
class StubAdapter implements GridTableAdapter {
  readonly element = new ShimElement('div') as unknown as HTMLElement;
  columnSets: Array<readonly GridColumnSpec[]> = [];
  itemSets: Array<readonly unknown[]> = [];
  actives: Array<unknown> = [];
  selectedSets: Array<readonly unknown[]> = [];
  scrolled: unknown[] = [];
  destroyed = false;

  private sortCb: ((key: string) => void) | null = null;
  private clickCb: ((index: number, at: { x: number; y: number }) => void) | null = null;
  private dblCb: ((index: number) => void) | null = null;
  private ctxCb: ((index: number, at: { x: number; y: number }) => void) | null = null;

  get columns(): readonly GridColumnSpec[] {
    return this.columnSets[this.columnSets.length - 1] ?? [];
  }
  get items(): readonly unknown[] {
    return this.itemSets[this.itemSets.length - 1] ?? [];
  }
  get active(): unknown {
    return this.actives[this.actives.length - 1];
  }

  setColumns(columns: readonly GridColumnSpec[]): void {
    this.columnSets.push(columns);
  }
  setItems(rows: readonly unknown[]): void {
    this.itemSets.push(rows);
  }
  setActive(row: unknown | null): void {
    this.actives.push(row);
  }
  setSelected(rows: readonly unknown[]): void {
    this.selectedSets.push(rows);
  }
  scrollToRow(row: unknown): void {
    this.scrolled.push(row);
  }
  onSortRequest(cb: (key: string) => void): void {
    this.sortCb = cb;
  }
  onRowClick(cb: (index: number, at: { x: number; y: number }) => void): void {
    this.clickCb = cb;
  }
  onRowDblClick(cb: (index: number) => void): void {
    this.dblCb = cb;
  }
  onRowContextMenu(cb: (index: number, at: { x: number; y: number }) => void): void {
    this.ctxCb = cb;
  }
  destroy(): void {
    this.destroyed = true;
  }
  emitSort(key: string): void {
    this.sortCb?.(key);
  }
  emitClick(index: number, x = 1, y = 2): void {
    this.clickCb?.(index, { x, y });
  }
  emitDblClick(index: number): void {
    this.dblCb?.(index);
  }
  emitContextMenu(index: number, x = 5, y = 6): void {
    this.ctxCb?.(index, { x, y });
  }
}

const ROWS: Row[] = [
  { id: 'a', name: 'Бета', size: 30 },
  { id: 'b', name: 'Альфа', size: 10 },
  { id: 'c', name: 'Гамма', size: 20 },
];

function keyEvent(key: string, ctrl = false): any {
  return {
    key,
    ctrlKey: ctrl,
    metaKey: false,
    shiftKey: false,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  };
}

describe('lib/ui/table: чистые функции', () => {
  it('cycleSort: другая колонка → asc, та же → asc → desc → нет', async () => {
    const { table } = await load();
    const s1 = table.cycleSort(table.NO_SORT, 'name');
    assert.deepEqual(s1, { key: 'name', dir: 'asc' });
    const s2 = table.cycleSort(s1, 'name');
    assert.deepEqual(s2, { key: 'name', dir: 'desc' });
    const s3 = table.cycleSort(s2, 'name');
    assert.deepEqual(s3, { key: null, dir: null });
    assert.deepEqual(table.cycleSort(s2, 'size'), { key: 'size', dir: 'asc' });
  });

  it('sortRows: числа численно, строки по-русски, стабильно', async () => {
    const { table } = await load();
    const cols = COLUMNS;
    const bySize = table.sortRows(ROWS, cols, { key: 'size', dir: 'asc' });
    assert.deepEqual(
      bySize.map((r) => r.id),
      ['b', 'c', 'a'],
    );
    const byName = table.sortRows(ROWS, cols, { key: 'name', dir: 'asc' });
    assert.deepEqual(
      byName.map((r) => r.name),
      ['Альфа', 'Бета', 'Гамма'],
    );
    const noSort = table.sortRows(ROWS, cols, table.NO_SORT);
    assert.deepEqual(noSort.map((r) => r.id), ['a', 'b', 'c']);
    assert.notEqual(noSort, ROWS, 'без сортировки — копия, не тот же массив');
  });

  it('sortRows: одинаковая сортировка стабильна (равные значения — исходный порядок)', async () => {
    const { table } = await load();
    const rows: Row[] = [
      { id: '1', name: 'x', size: 5 },
      { id: '2', name: 'x', size: 5 },
      { id: '3', name: 'x', size: 1 },
    ];
    const sorted = table.sortRows(rows, COLUMNS, { key: 'size', dir: 'asc' });
    assert.deepEqual(sorted.map((r) => r.id), ['3', '1', '2']);
  });

  it('nextRowIndex: стрелки, границы, без текущей строки, пусто', async () => {
    const { table } = await load();
    assert.equal(table.nextRowIndex('ArrowDown', 1, 5, 10), 2);
    assert.equal(table.nextRowIndex('ArrowUp', 1, 5, 10), 0);
    assert.equal(table.nextRowIndex('ArrowDown', 4, 5, 10), 4, 'не выходим за конец');
    assert.equal(table.nextRowIndex('ArrowUp', 0, 5, 10), 0, 'не выходим за начало');
    assert.equal(table.nextRowIndex('Home', 3, 5, 10), 0);
    assert.equal(table.nextRowIndex('End', 0, 5, 10), 4);
    assert.equal(table.nextRowIndex('PageDown', 0, 100, 10), 10);
    assert.equal(table.nextRowIndex('PageUp', 15, 100, 10), 5);
    assert.equal(table.nextRowIndex('ArrowDown', -1, 5, 10), 0, 'без текущей — первая');
    assert.equal(table.nextRowIndex('End', -1, 5, 10), 4, 'без текущей End — последняя');
    assert.equal(table.nextRowIndex('PageDown', -1, 100, 10), 9, 'без текущей PgDn — первая страница');
    assert.equal(table.nextRowIndex('ArrowDown', 0, 0, 10), -1, 'пусто — цели нет');
  });

  it('rowsToTsv: заголовки, порядок, экранирование табуляции/кавычек/перевода строки', async () => {
    const { table } = await load();
    const cols = COLUMNS;
    const tsv = table.rowsToTsv(cols, [ROWS[0] as Row]);
    assert.equal(tsv, 'Имя\tРазмер\r\nБета\t30');

    const tricky = [{ id: 't', name: 'a\tb"c\nd', size: 1 }];
    const escaped = table.rowsToTsv(cols, tricky);
    assert.equal(escaped, 'Имя\tРазмер\r\n"a\tb""c\nd"\t1');
    assert.equal(table.escapeTsvCell('plain'), 'plain');
  });
});

describe('lib/ui/table: фасад на стабе адаптера', () => {
  it('корень таблицы несёт якорь возврата фокуса (правило 10, 28d69bc6)', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const t = table.createTable<Row>({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      adapter: stub,
    });
    assert.ok(
      (t.element as unknown as ShimElement).hasAttribute('data-focus-anchor'),
      'обёртка таблицы — якорь возврата фокуса; без него закрытие редактора ' +
        'не оживляет стрелочную навигацию списка (правило 10 требования 11ddd910)',
    );
  });

  it('отдаёт колонки и строки адаптеру, пустое состояние скрыто', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const t = table.createTable<Row>({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      adapter: stub,
    });
    assert.equal(stub.columns.length, 2);
    assert.equal(stub.columns[0]?.sortable, true);
    assert.equal(stub.columns[1]?.align, 'end');
    assert.deepEqual(
      (stub.items as Row[]).map((r) => r.id),
      ['a', 'b', 'c'],
    );
    const emptyEl = (t.element as unknown as ShimElement).findAll(table.TABLE_EMPTY_CLASS)[0];
    assert.equal(emptyEl?.hidden, true, 'данные есть — пустое состояние скрыто');
  });

  it('пустой источник — видно пустое состояние с текстом', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const t = table.createTable<Row>({
      columns: COLUMNS,
      rows: [],
      rowKey: (r) => r.id,
      emptyText: 'Ничего нет',
      emptyHint: 'Добавьте строку',
      adapter: stub,
    });
    const emptyEl = (t.element as unknown as ShimElement).findAll(table.TABLE_EMPTY_CLASS)[0];
    assert.equal(emptyEl?.hidden, false);
    // Заголовок и подсказку рисует общий компонент `lib/ui/empty-state.ts`.
    assert.ok(emptyEl?.flatText().includes('Ничего нет'), 'виден заголовок из опции');
    assert.ok(emptyEl?.flatText().includes('Добавьте строку'), 'видна подсказка из опции');

    // Смена состояния списком с фильтром — через setEmpty.
    t.setEmpty({ title: 'Не найдено', hint: 'Измените запрос' });
    assert.ok(emptyEl?.flatText().includes('Не найдено'), 'setEmpty меняет текст состояния');
  });

  it('клик по заголовку сортирует, цикл asc/desc/нет идёт через фасад', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    table.createTable<Row>({ columns: COLUMNS, rows: ROWS, rowKey: (r) => r.id, adapter: stub });
    stub.emitSort('size');
    assert.deepEqual(
      (stub.items as Row[]).map((r) => r.id),
      ['b', 'c', 'a'],
    );
    assert.equal(stub.columns.find((c) => c.key === 'size')?.sortDir, 'asc');
    stub.emitSort('size');
    assert.deepEqual(
      (stub.items as Row[]).map((r) => r.id),
      ['a', 'c', 'b'],
    );
    stub.emitSort('size');
    assert.deepEqual(
      (stub.items as Row[]).map((r) => r.id),
      ['a', 'b', 'c'],
    );
    // Клик по несуществующей/несортируемой колонке ничего не меняет.
    stub.emitSort('missing');
    assert.deepEqual(
      (stub.items as Row[]).map((r) => r.id),
      ['a', 'b', 'c'],
    );
  });

  it('клавиатура двигает текущую строку и уведомляет onCurrentChange', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const changes: Array<string | null> = [];
    const t = table.createTable<Row>({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      adapter: stub,
      onCurrentChange: (key) => changes.push(key),
    });
    const wrapper = t.element as unknown as ShimElement;
    assert.equal(t.getCurrent(), null);

    wrapper.emit('keydown', keyEvent('ArrowDown'));
    assert.equal(t.getCurrent()?.key, 'a');
    wrapper.emit('keydown', keyEvent('ArrowDown'));
    assert.equal(t.getCurrent()?.key, 'b');
    wrapper.emit('keydown', keyEvent('End'));
    assert.equal(t.getCurrent()?.key, 'c');
    wrapper.emit('keydown', keyEvent('ArrowUp'));
    assert.equal(t.getCurrent()?.key, 'b');
    wrapper.emit('keydown', keyEvent('Home'));
    assert.equal(t.getCurrent()?.key, 'a');
    assert.deepEqual(changes, ['a', 'b', 'c', 'b', 'a'], 'onCurrentChange на каждое перемещение');
    assert.equal(stub.active, ROWS[0], 'строка подсвечена активной');
    assert.ok(stub.scrolled.includes(ROWS[0]), 'к текущей строке проскроллено');
  });

  it('Enter активирует текущую строку', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const activated: string[] = [];
    const t = table.createTable<Row>({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      adapter: stub,
      onActivate: (row) => activated.push(row.id),
    });
    const wrapper = t.element as unknown as ShimElement;
    wrapper.emit('keydown', keyEvent('ArrowDown')); // текущая 'a'
    wrapper.emit('keydown', keyEvent('Enter'));
    assert.deepEqual(activated, ['a']);
  });

  it('клик и двойной клик по строке: текущая, onRowClick, onActivate', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const clicks: string[] = [];
    const activated: string[] = [];
    const t = table.createTable<Row>({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      adapter: stub,
      onRowClick: (row) => clicks.push(row.id),
      onActivate: (row) => activated.push(row.id),
    });
    stub.emitClick(1);
    assert.equal(t.getCurrent()?.key, 'b');
    assert.deepEqual(clicks, ['b']);
    stub.emitDblClick(2);
    assert.equal(t.getCurrent()?.key, 'c');
    assert.deepEqual(activated, ['c']);
  });

  it('onDblActivate: двойной клик зовёт его вместо onActivate, клик — только текущая', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const activated: string[] = [];
    const edited: string[] = [];
    const t = table.createTable<Row>({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      adapter: stub,
      onActivate: (row) => activated.push(row.id),
      onDblActivate: (row) => edited.push(row.id),
    });
    stub.emitClick(1);
    assert.equal(t.getCurrent()?.key, 'b', 'клик делает строку текущей');
    assert.deepEqual(activated, [], 'клик не активирует строку (правило 6)');
    stub.emitDblClick(2);
    assert.equal(t.getCurrent()?.key, 'c');
    assert.deepEqual(edited, ['c'], 'двойной клик открывает редактор (onDblActivate)');
    assert.deepEqual(activated, [], 'onActivate при заданном onDblActivate двойным кликом не зовётся');
  });

  it('контекстное меню строки строится вызывающим и показывается на координатах', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const asked: string[] = [];
    table.createTable<Row>({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      adapter: stub,
      rowMenu: (row) => {
        asked.push(row.id);
        return [{ label: 'Открыть', onClick: () => undefined }];
      },
    });
    stub.emitContextMenu(2, 40, 60);
    assert.deepEqual(asked, ['c'], 'пункты запрошены для строки под курсором');
    const body = (globalThis as any).document.body as ShimElement;
    const menu = body.findAll('menu')[0];
    assert.ok(menu !== undefined && menu !== null, 'меню показано');
    assert.equal(menu?.flatText().includes('Открыть'), true);
  });

  it('Ctrl+C копирует текущую строку в TSV через переданный буфер', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const copied: string[] = [];
    const t = table.createTable<Row>({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      adapter: stub,
      clipboard: (text) => copied.push(text),
    });
    const wrapper = t.element as unknown as ShimElement;
    wrapper.emit('keydown', keyEvent('ArrowDown')); // текущая 'a'
    wrapper.emit('keydown', keyEvent('c', true));
    assert.deepEqual(copied, ['Имя\tРазмер\r\nБета\t30']);
    assert.equal(t.buildCopyText(), 'Имя\tРазмер\r\nБета\t30');
  });

  it('multi-выделение: Space переключает, Ctrl+C копирует выделение', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const copied: string[] = [];
    const t = table.createTable<Row>({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      adapter: stub,
      selection: 'multi',
      clipboard: (text) => copied.push(text),
    });
    const wrapper = t.element as unknown as ShimElement;
    wrapper.emit('keydown', keyEvent('ArrowDown')); // 'a'
    wrapper.emit('keydown', keyEvent(' '));
    wrapper.emit('keydown', keyEvent('ArrowDown')); // 'b'
    wrapper.emit('keydown', keyEvent(' '));
    assert.deepEqual(t.getSelection().sort(), ['a', 'b']);
    wrapper.emit('keydown', keyEvent('c', true));
    assert.equal(copied[0], 'Имя\tРазмер\r\nБета\t30\r\nАльфа\t10');
    // Повторный Space снимает выделение.
    wrapper.emit('keydown', keyEvent(' '));
    assert.deepEqual(t.getSelection(), ['a']);
  });

  it('реактивный источник: смена store перерисовывает таблицу сама, destroy отписывает', async () => {
    const { table } = await load();
    const { store } = await import('../src/renderer/state.js');
    store.update({ pins: [] } as any);
    const stub = new StubAdapter();
    const t = table.createTable<Row>({
      columns: COLUMNS,
      rows: (state) => state.pins as unknown as readonly Row[],
      rowKey: (r) => r.id,
      adapter: stub,
    });
    assert.deepEqual(stub.items, [], 'подписка сразу отдала текущий срез');

    store.update({ pins: ROWS.slice(0, 2) } as any);
    assert.deepEqual(
      (stub.items as Row[]).map((r) => r.id),
      ['a', 'b'],
      'realtime/store-апдейт перерисовал список без invalidate вызывающего',
    );

    const before = stub.itemSets.length;
    t.destroy();
    store.update({ pins: ROWS } as any);
    assert.equal(stub.itemSets.length, before, 'после destroy подписка снята');
    assert.equal(stub.destroyed, true);
  });

  it('setCurrent/setSelection извне и refresh', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const t = table.createTable<Row>({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      adapter: stub,
      selection: 'multi',
    });
    t.setCurrent('b');
    assert.equal(t.getCurrent()?.key, 'b');
    t.setSelection(['c']);
    assert.deepEqual(t.getSelection(), ['c']);
    assert.ok((stub.selectedSets.at(-1) as Row[]).some((r) => r.id === 'c'));
    const before = stub.columnSets.length;
    t.refresh();
    assert.equal(stub.columnSets.length, before + 1, 'refresh пересобирает колонки');
  });
});

// --- Расширение фасада: управляемая сортировка и режим ячеек (задача 20ac6917)

describe('lib/ui/table: управляемая сортировка (задача 20ac6917)', () => {
  it('cycleSort toggle: desc↔asc без «нет», новая колонка — заданное направление', async () => {
    const { table } = await load();
    const first = table.cycleSort(table.NO_SORT, 'created_at', { mode: 'toggle', dir: 'desc' });
    assert.deepEqual(first, { key: 'created_at', dir: 'desc' });
    const flipped = table.cycleSort(first, 'created_at', { mode: 'toggle' });
    assert.deepEqual(flipped, { key: 'created_at', dir: 'asc' });
    const back = table.cycleSort(flipped, 'created_at', { mode: 'toggle' });
    assert.deepEqual(back, { key: 'created_at', dir: 'desc' }, 'никогда не сбрасывается в «нет»');
    // Другая колонка — своё направление (без него — desc).
    assert.deepEqual(table.cycleSort(back, 'updated_at', { mode: 'toggle' }), {
      key: 'updated_at',
      dir: 'desc',
    });
    assert.deepEqual(
      table.cycleSort(back, 'updated_at', { mode: 'toggle', dir: 'asc' }),
      { key: 'updated_at', dir: 'asc' },
    );
  });

  it('фасад: defaultSort, defaultSortDir, цикл toggle и внешний setSort', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const t = table.createTable<Row>({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      adapter: stub,
      sortMode: 'toggle',
      defaultSort: { key: 'size', dir: 'desc' },
    });
    assert.deepEqual(t.getSort(), { key: 'size', dir: 'desc' }, 'начальная сортировка — из defaultSort');
    assert.deepEqual(
      (stub.items as Row[]).map((r) => r.id),
      ['a', 'c', 'b'],
      'строки сразу в порядке defaultSort',
    );

    stub.emitSort('size');
    assert.deepEqual(t.getSort(), { key: 'size', dir: 'asc' }, 'та же колонка → asc');
    stub.emitSort('size');
    assert.deepEqual(t.getSort(), { key: 'size', dir: 'desc' }, 'и обратно → desc');

    stub.emitSort('name');
    assert.deepEqual(
      t.getSort(),
      { key: 'name', dir: 'desc' },
      'новая колонка — направление по умолчанию (desc), а не asc',
    );

    t.setSort({ key: 'size', dir: 'asc' });
    assert.deepEqual(t.getSort(), { key: 'size', dir: 'asc' }, 'внешний setSort');
    assert.deepEqual(
      (stub.items as Row[]).map((r) => r.id),
      ['b', 'c', 'a'],
      'setSort пересчитал порядок строк',
    );
  });

  it('defaultSortDir колонки задаёт направление первого клика при toggle', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const cols: TableColumn<Row>[] = [
      { key: 'name', header: 'Имя', sortable: true, defaultSortDir: 'asc' },
      { key: 'size', header: 'Размер', sortable: true, defaultSortDir: 'desc' },
    ];
    const t = table.createTable<Row>({
      columns: cols,
      rows: ROWS,
      rowKey: (r) => r.id,
      adapter: stub,
      sortMode: 'toggle',
    });
    t.requestSort('name');
    assert.deepEqual(t.getSort(), { key: 'name', dir: 'asc' });
    t.requestSort('size');
    assert.deepEqual(t.getSort(), { key: 'size', dir: 'desc' });
  });
});

describe('lib/ui/table: режим ячеек nav: cell (задача 20ac6917)', () => {
  /** Ячейка с `count` чипами-фокусируемыми элементами (клик пишет метку). */
  function chipCell(
    table: TableModule,
    count: number,
    clicks: string[],
    label: string,
  ): Node {
    const cell = new ShimElement('span');
    for (let i = 0; i < count; i++) {
      const chip = new ShimElement('span', table.TABLE_FOCUSABLE_CLASS);
      chip.addEventListener('click', () => clicks.push(`${label}-${i}`));
      cell.append(chip);
    }
    return cell as unknown as Node;
  }

  it('стрелки движут по колонкам/чипам, Enter активирует чип, ячейка подсвечена', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const clicks: string[] = [];
    const cols: TableColumn<Row>[] = [
      { key: 'name', header: 'Имя', render: () => chipCell(table, 2, clicks, 'name') },
      { key: 'size', header: 'Размер', render: () => chipCell(table, 1, clicks, 'size') },
    ];
    const t = table.createTable<Row>({
      columns: cols,
      rows: ROWS,
      rowKey: (r) => r.id,
      adapter: stub,
      nav: 'cell',
    });
    const wrapper = t.element as unknown as ShimElement;
    // Отрисовываем ячейки строки 0 так, как это делает вендорская сетка.
    for (const column of stub.columns) {
      wrapper.append(column.render(ROWS[0], 0) as unknown as ShimElement);
    }
    assert.equal(t.getCellCursor()?.row, -1, 'до выбора строки курсора строки нет');

    wrapper.emit('keydown', keyEvent('ArrowDown'));
    assert.equal(t.getCellCursor()?.row, 0, '↓ встаёт на первую строку');
    assert.equal(t.getCurrent()?.key, 'a');
    // Текущая ячейка/элемент подсвечены.
    const currentCell = wrapper.findAll(table.TABLE_CELL_CURRENT_CLASS)[0];
    assert.ok(currentCell !== undefined, 'текущая ячейка подсвечена');
    assert.equal(
      currentCell?.findAll(table.TABLE_FOCUSABLE_CURRENT_CLASS).length,
      1,
      'подсвечен ровно один чип',
    );

    wrapper.emit('keydown', keyEvent('ArrowRight'));
    assert.deepEqual(t.getCellCursor(), { row: 0, col: 0, item: 1 }, '→ по чипам колонки');
    wrapper.emit('keydown', keyEvent('ArrowRight'));
    assert.deepEqual(t.getCellCursor(), { row: 0, col: 1, item: 0 }, '→ на краю — в соседнюю колонку');
    wrapper.emit('keydown', keyEvent('ArrowLeft'));
    assert.deepEqual(t.getCellCursor(), { row: 0, col: 0, item: 0 }, '← возвращает в колонку');
    wrapper.emit('keydown', keyEvent('Tab'));
    assert.deepEqual(t.getCellCursor(), { row: 0, col: 1, item: 0 }, 'Tab — следующая колонка');

    // Enter активирует выбранный чип (клик по нему).
    wrapper.emit('keydown', keyEvent('Enter'));
    assert.deepEqual(clicks, ['size-0'], 'Enter кликнул выбранный чип');
  });

  it('↑/↓ двигают строки, сохраняя колонку и сбрасывая элемент', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const cols: TableColumn<Row>[] = [
      { key: 'name', header: 'Имя', render: () => chipCell(table, 2, [], 'name') },
    ];
    const changes: Array<string | null> = [];
    const t = table.createTable<Row>({
      columns: cols,
      rows: ROWS,
      rowKey: (r) => r.id,
      adapter: stub,
      nav: 'cell',
      onCurrentChange: (key) => changes.push(key),
    });
    const wrapper = t.element as unknown as ShimElement;
    for (let index = 0; index < ROWS.length; index++) {
      const row = ROWS[index] as Row;
      wrapper.append(stub.columns[0]!.render(row, index) as unknown as ShimElement);
    }
    wrapper.emit('keydown', keyEvent('ArrowDown'));
    wrapper.emit('keydown', keyEvent('ArrowRight'));
    assert.deepEqual(t.getCellCursor(), { row: 0, col: 0, item: 1 });
    wrapper.emit('keydown', keyEvent('ArrowDown'));
    assert.deepEqual(
      t.getCellCursor(),
      { row: 1, col: 0, item: 0 },
      '↓ следующая строка, элемент сброшен',
    );
    assert.deepEqual(changes, ['a', 'b'], 'смена строки уведомляет onCurrentChange');
    wrapper.emit('keydown', keyEvent('ArrowUp'));
    assert.equal(t.getCellCursor()?.row, 0);
  });

  it('без фокусируемых элементов ячейки Enter активирует строку', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const activated: string[] = [];
    const t = table.createTable<Row>({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      adapter: stub,
      nav: 'cell',
      onActivate: (row) => activated.push(row.id),
    });
    const wrapper = t.element as unknown as ShimElement;
    // Ячейки без `ui-table-focusable`: рисуем их через стаб.
    for (const column of stub.columns) {
      wrapper.append(column.render(ROWS[0], 0) as unknown as ShimElement);
    }
    wrapper.emit('keydown', keyEvent('ArrowDown'));
    wrapper.emit('keydown', keyEvent('Enter'));
    assert.deepEqual(activated, ['a'], 'Enter на ячейке без чипов активирует строку');
  });

  it('режим row (по умолчанию) курсора ячеек не создаёт', async () => {
    const { table } = await load();
    const stub = new StubAdapter();
    const t = table.createTable<Row>({
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      adapter: stub,
    });
    assert.equal(t.getCellCursor(), null);
    const wrapper = t.element as unknown as ShimElement;
    wrapper.emit('keydown', keyEvent('ArrowDown'));
    assert.equal(t.getCurrent()?.key, 'a', 'построчная навигация не изменилась');
  });
});
