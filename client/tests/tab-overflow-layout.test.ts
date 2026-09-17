/**
 * Unit tests for `recomputeOverflow` (screens/tabs/tab-overflow.ts) — раскладка
 * полосы вкладок в двух режимах.
 *
 * Повод: после переименования вкладки редактора «Основное» → «Комментарий»
 * заголовок вылезал за пределы кнопки. Причина — режим `fixed`: ширина кнопки
 * задавалась числом (110, при нехватке места сжималась до 80), а текст внутри
 * так не сжимается. Для полосы редактора введён режим `content`: ширина кнопки —
 * по заголовку, а не поместившиеся вкладки уходят в `[▾N]`. Полоса рабочего
 * стола осталась на `fixed` (там важна одинаковая ширина вкладок).
 *
 * Тест работает на фейковой полосе: `recomputeOverflow` трогает только
 * `root.clientWidth`, `style.width`/`style.minWidth`, `hidden` и
 * `getBoundingClientRect()` — DOM не нужен. Фейк считает прямоугольники от
 * текущих стилей так же, как браузер: `width: auto` — ширина содержимого,
 * явная ширина — заданное число (но не меньше `min-width`), `hidden` — ноль.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  recomputeOverflow,
  type StripElements,
  type TabLayout,
} from '../src/renderer/screens/tabs/tab-overflow.js';

const TABS_SRC = resolve(
  import.meta.dirname,
  '..',
  'src',
  'renderer',
  'screens',
  'tabs',
  'tabs.ts',
);

/** Промежуток flex-строки (`.editor-tabs { gap: 2px }`). */
const GAP = 2;

/**
 * Шим `getComputedStyle`: раскладке нужны только внутренние отступы полосы
 * (`contentBoxWidth`), чтобы лимит считался по content-box, а не по
 * `clientWidth` (тот включает padding — `▾N` уезжала бы под обрез).
 */
function shimComputedStyle(paddingX: number): void {
  (globalThis as { getComputedStyle?: unknown }).getComputedStyle = () => ({
    paddingLeft: `${paddingX}px`,
    paddingRight: `${paddingX}px`,
  });
}

shimComputedStyle(0);

interface FakeTab {
  id: string;
  /** Ширина содержимого кнопки (заголовок + счётчик «(N)»). */
  natural: number;
  style: Record<string, string>;
  hidden: boolean;
}

interface FakeStrip {
  elements: StripElements<string>;
  tabs: FakeTab[];
  setContainerWidth(px: number): void;
  /** Есть ли хоть одна видимая кнопка уже своего содержимого. */
  anyVisibleNarrowerThanContent(): boolean;
}

function buildStrip(opts: {
  widths: number[];
  containerWidth: number;
  accessoryWidth?: number;
}): FakeStrip {
  const tabs: FakeTab[] = opts.widths.map((natural, i) => ({
    id: `t${i}`,
    natural,
    style: {},
    hidden: false,
  }));

  const widthOf = (tab: FakeTab): number => {
    if (tab.hidden) return 0;
    const min = tab.style['minWidth'] === undefined ? 0 : Number.parseFloat(tab.style['minWidth']);
    const explicit = tab.style['width'];
    const base =
      explicit === undefined || explicit === 'auto' ? tab.natural : Number.parseFloat(explicit);
    return Math.max(min, base);
  };

  const rectOf = (index: number): { width: number; left: number; right: number } => {
    let x = 0;
    for (let i = 0; i < tabs.length; i += 1) {
      const width = widthOf(tabs[i]!);
      if (i === index) return { width, left: x, right: x + width };
      x += width + GAP;
    }
    return { width: 0, left: 0, right: 0 };
  };

  const buttons = tabs.map((tab, index) => ({
    style: tab.style,
    get hidden(): boolean {
      return tab.hidden;
    },
    set hidden(value: boolean) {
      tab.hidden = value;
    },
    getBoundingClientRect: () => rectOf(index) as DOMRect,
  }));

  let containerWidth = opts.containerWidth;
  const root = {
    get clientWidth(): number {
      return containerWidth;
    },
  };
  const accessory =
    opts.accessoryWidth === undefined
      ? undefined
      : { getBoundingClientRect: () => ({ width: opts.accessoryWidth }) as DOMRect };
  const overflow = { hidden: true, textContent: '', title: '' };

  const elements = {
    root,
    visible: buttons,
    hidden: [],
    reserveButton: accessory,
    overflowButton: overflow,
  } as unknown as StripElements<string>;

  return {
    elements,
    tabs,
    setContainerWidth: (px) => {
      containerWidth = px;
    },
    anyVisibleNarrowerThanContent: () =>
      tabs.some((tab) => !tab.hidden && widthOf(tab) < tab.natural),
  };
}

/** Длинный заголовок («Комментарий») рядом с короткими («Граф»). */
const TITLES = [104, 88, 112, 100, 108, 62, 98];

describe('recomputeOverflow — режим content (вкладки редактора: ширина по заголовку)', () => {
  const content: TabLayout = { kind: 'content', minWidth: 80 };

  it('в широкую панель помещаются все вкладки, `▾N` скрыта', () => {
    const strip = buildStrip({ widths: TITLES, containerWidth: 1200 });
    recomputeOverflow(
      strip.elements,
      strip.tabs.map((t) => t.id),
      content,
    );
    assert.ok(!strip.tabs.some((t) => t.hidden), 'все вкладки видны');
    assert.equal(strip.elements.overflowButton?.hidden, true, 'кнопка `▾N` скрыта');
    assert.equal(strip.elements.hidden.length, 0, 'скрытых нет');
    assert.ok(!strip.anyVisibleNarrowerThanContent(), 'ни одна кнопка не сжата');
  });

  it('ни одна кнопка не ужимается: заголовок всегда помещается целиком', () => {
    // Та самая ошибка: при фиксированной ширине (fixed) кнопка «Комментарий»
    // становилась 80px при содержимом 104px — текст вылезал за кнопку.
    const strip = buildStrip({ widths: TITLES, containerWidth: 420 });
    recomputeOverflow(
      strip.elements,
      strip.tabs.map((t) => t.id),
      content,
    );
    assert.ok(
      strip.tabs.some((t) => t.hidden),
      'часть вкладок ушла в `▾N`',
    );
    assert.equal(strip.elements.overflowButton?.hidden, false, 'кнопка `▾N` показана');
    assert.ok(
      !strip.anyVisibleNarrowerThanContent(),
      'видимые кнопки шире или равны своему содержимому',
    );
  });

  it('в `hidden` уходят только хвостовые вкладки, счётчик совпадает с `▾N`', () => {
    const strip = buildStrip({ widths: TITLES, containerWidth: 420 });
    recomputeOverflow(
      strip.elements,
      strip.tabs.map((t) => t.id),
      content,
    );
    const visible = strip.tabs.filter((t) => !t.hidden);
    assert.ok(
      visible.length > 0 && visible.length < strip.tabs.length,
      'часть видна, часть скрыта',
    );
    // Скрытые — строго хвост: порядок полосы не переставляется.
    for (let i = 0; i < strip.tabs.length; i += 1) {
      assert.equal(
        strip.tabs[i]!.hidden,
        i >= visible.length,
        `вкладка ${i} — хвостовая или видимая`,
      );
    }
    assert.deepEqual(
      strip.elements.hidden,
      strip.tabs.slice(visible.length).map((t) => t.id),
      'elements.hidden — хвост allItems',
    );
    assert.equal(strip.elements.overflowButton?.textContent, `▾${strip.elements.hidden.length}`);
  });

  it('minWidth работает как пол для коротких заголовков', () => {
    const strip = buildStrip({ widths: [40, 40], containerWidth: 1200 });
    recomputeOverflow(
      strip.elements,
      strip.tabs.map((t) => t.id),
      content,
    );
    assert.deepEqual(
      strip.tabs.map((t) => t.style['minWidth']),
      ['80px', '80px'],
      'короткие вкладки не выглядят огрызками',
    );
  });

  it('кнопка `▾N` учитывается в раскладке: её появление сужает поместившийся набор', () => {
    // Панель ровно под все вкладки без запаса: запас под `▾N` не влезает,
    // поэтому набор обязан сократиться, а не переползти под кнопку.
    const totalWithGaps = TITLES.reduce((sum, w) => sum + w, 0) + GAP * (TITLES.length - 1);
    const strip = buildStrip({ widths: TITLES, containerWidth: totalWithGaps });
    recomputeOverflow(
      strip.elements,
      strip.tabs.map((t) => t.id),
      content,
    );
    assert.ok(
      !strip.tabs[strip.tabs.length - 1]!.hidden || strip.elements.overflowButton?.hidden === false,
      'последняя вкладка либо видна, либо лежит в `▾N`',
    );
    // Проверка инварианта раскладки: видимая цепочка + `▾N` не шире панели.
    const visible = strip.tabs.filter((t) => !t.hidden);
    const visibleWidth =
      visible.reduce((sum, t) => sum + Math.max(80, t.natural), 0) +
      GAP * Math.max(0, visible.length - 1);
    const overflowWidth = strip.elements.overflowButton?.hidden === false ? 32 + GAP : 0;
    assert.ok(visibleWidth + overflowWidth <= totalWithGaps, 'раскладка помещается в панель');
  });

  it('пустая панель (clientWidth = 0) — раскладка не трогается', () => {
    const strip = buildStrip({ widths: TITLES, containerWidth: 0 });
    recomputeOverflow(
      strip.elements,
      strip.tabs.map((t) => t.id),
      content,
    );
    assert.ok(!strip.tabs.some((t) => t.hidden), 'ничего не скрыто до появления размеров');
    assert.equal(strip.elements.overflowButton?.hidden, true, 'кнопка `▾N` не показана');
  });

  it('внутренние отступы полосы не считаются доступной шириной', () => {
    // `.editor-tabs { padding: 8px 10px 0 }`: 20px по горизонтали — не место для
    // вкладок. Считая по `clientWidth` (он включает padding), раскладка решила
    // бы, что помещается на 20px больше, и кнопка `▾N` уехала бы под
    // `overflow: hidden` полосы — вместе со скрытыми вкладками.
    const totalWithGaps = TITLES.reduce((sum, w) => sum + w, 0) + GAP * (TITLES.length - 1);
    // clientWidth = цепочка + 20px отступов − 4px: по content-box вкладки уже
    // не помещаются (по clientWidth — «помещаются» с запасом 16px).
    const strip = buildStrip({ widths: TITLES, containerWidth: totalWithGaps + 20 - 4 });
    shimComputedStyle(10);
    try {
      recomputeOverflow(
        strip.elements,
        strip.tabs.map((t) => t.id),
        content,
      );
    } finally {
      shimComputedStyle(0);
    }
    assert.ok(
      strip.tabs.some((t) => t.hidden),
      'с отступами полосы вкладки не помещаются — часть обязана уйти в `▾N`',
    );
    assert.equal(strip.elements.overflowButton?.hidden, false);
  });
});

describe('recomputeOverflow — режим fixed (вкладки рабочего стола: одна ширина на все)', () => {
  const fixed: TabLayout = { kind: 'fixed', defaultWidth: 180, minWidth: 120 };

  it('пока всё помещается — ширина по умолчанию, всё видно', () => {
    const strip = buildStrip({ widths: TITLES, containerWidth: 1400 });
    recomputeOverflow(
      strip.elements,
      strip.tabs.map((t) => t.id),
      fixed,
    );
    assert.deepEqual(new Set(strip.tabs.map((t) => t.style['width'])), new Set(['180px']));
    assert.ok(!strip.tabs.some((t) => t.hidden), 'все вкладки видны');
    assert.equal(strip.elements.overflowButton?.hidden, true);
  });

  it('при нехватке места ширина ужимается до минимума, хвост уходит в `▾N`', () => {
    const strip = buildStrip({ widths: TITLES, containerWidth: 700 });
    recomputeOverflow(
      strip.elements,
      strip.tabs.map((t) => t.id),
      fixed,
    );
    const widths = new Set(strip.tabs.map((t) => t.style['width']));
    assert.equal(widths.size, 1, 'ширина одна на все вкладки');
    const width = Number.parseFloat([...widths][0]!);
    assert.ok(width >= 120, 'не уже минимума');
    assert.ok(width < 180, 'ужата относительно ширины по умолчанию');
    assert.ok(
      strip.tabs.some((t) => t.hidden),
      'не поместившиеся ушли в `▾N`',
    );
    assert.equal(strip.elements.overflowButton?.hidden, false);
  });

  it('кнопка может оказаться уже своего содержимого — это и была ошибка редактора', () => {
    // Документируем поведение fixed: длинный заголовок в ужатой кнопке не
    // помещается. Именно поэтому полоса редактора переведена на `content`.
    // Панель 260px на две вкладки по 140px: ширина падает до 130px — меньше
    // содержимого, текст вылезал бы за кнопку.
    const strip = buildStrip({ widths: [140, 140], containerWidth: 260 });
    recomputeOverflow(
      strip.elements,
      strip.tabs.map((t) => t.id),
      fixed,
    );
    assert.deepEqual(new Set(strip.tabs.map((t) => t.style['width'])), new Set(['130px']));
    assert.ok(
      strip.anyVisibleNarrowerThanContent(),
      'fixed сжимает кнопку ниже содержимого (текст вылезал бы за кнопку)',
    );
  });

  it('запас под кнопку-аксессуар учитывается', () => {
    const withoutAccessory = buildStrip({ widths: TITLES, containerWidth: 900 });
    recomputeOverflow(
      withoutAccessory.elements,
      withoutAccessory.tabs.map((t) => t.id),
      fixed,
    );
    const withAccessory = buildStrip({ widths: TITLES, containerWidth: 900, accessoryWidth: 200 });
    recomputeOverflow(
      withAccessory.elements,
      withAccessory.tabs.map((t) => t.id),
      fixed,
    );
    assert.ok(
      withAccessory.elements.hidden.length >= withoutAccessory.elements.hidden.length,
      'аксессуар отнимает место у вкладок, а не наоборот',
    );
  });
});

describe('выбор режима раскладки по полосе', () => {
  it('вкладки рабочего стола остаются на фиксированной ширине', () => {
    // Одинаковая ширина воркспейс-вкладок — дизайн-решение, а не недосмотр:
    // адаптивными сделаны только вкладки редактора (у них заголовки разной
    // длины и их семь).
    const src = readFileSync(TABS_SRC, 'utf8');
    assert.match(
      src,
      /const TAB_LAYOUT = \{ kind: 'fixed', defaultWidth: 180, minWidth: 120 \}/,
      'the workspace strip keeps one width for all tabs',
    );
    assert.ok(
      !/kind:\s*'content'/.test(src),
      'the workspace strip must not switch to content sizing',
    );
    assert.equal(
      (src.match(/recomputeOverflow\(elements, /g) ?? []).length,
      2,
      'both call sites pass the layout explicitly',
    );
  });
});
