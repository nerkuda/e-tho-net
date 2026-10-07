/**
 * Юнит-тесты маппинга выделения просмотра в диапазон исходника markdown
 * (0.12.1, задача 189da39e; требование bac754e4, ADR ee4e721b).
 *
 * Проверяются контракты `sourceRangeFromSelection` из `editor/markdown-field.ts`:
 *  - для размеченного рендера (`@etn/markdown` с `sourceMap`) выделение DOM
 *    переводится в смещения исходника (лист — 1:1 внутри, блок — от якоря
 *    `data-md-after`);
 *  - узлы вне размеченного рендера дают `null` — поле откатывается к
 *    каретке в конец (старое поведение);
 *  - `null`-узлы (выделение потеряно) тоже дают `null`.
 *
 * DOM-shim, как в соседних тестах поля (`clipboard-system.test.ts`):
 * `markdown-field.ts` тянет граф модулей рендерера, читающий `window`/
 * `document` при импорте. Дерево рендера строится вручную — резолвер
 * `sourceOffsetFromCaret` структурный и раскладку не требует.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  expandTransclusions,
  MD_SOURCE_AFTER_ATTR,
  MD_SOURCE_END_ATTR,
  MD_SOURCE_LEAF_ATTR,
  MD_SOURCE_SHIFT_ATTR,
  MD_SOURCE_START_ATTR,
} from '@etn/markdown';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Минимальный `document`/`window` шим — до первого импорта поля. */
function shimDom(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

shimDom();
const { buildExpandedSourceMap, mapViewOffsetToSource, sourceRangeFromSelection, viewSelectionToSourceRange } =
  await import('../src/renderer/editor/markdown-field.js');
const { transclusionInternals } = await import('../src/renderer/editor/transclusion.js');

/** Текстовый узел структурной модели резолвера. */
function textNode(value: string): any {
  return { nodeType: 3, textContent: value, parentNode: null, childNodes: null };
}

/** Элемент с `data-md-*` атрибутами; `children` прописывает `parentNode`. */
function element(attrs: Record<string, string>, children: any[]): any {
  const node: any = {
    nodeType: 1,
    getAttribute: (name: string) => attrs[name] ?? null,
    parentNode: null,
    childNodes: children,
    get textContent(): string {
      return children.map((c) => c.textContent ?? '').join('');
    },
  };
  for (const child of children) child.parentNode = node;
  return node;
}

/**
 * Дерево рендера фрагмента `абзац с ==меткой== хвост`:
 * блок `<p data-md-start=0 data-md-end=25>`, лист `<mark>` над «меткой».
 */
function annotatedParagraph(): { root: any; paragraph: any; mark: any; tail: any } {
  const lead = textNode('абзац с ');
  const mark = element(
    {
      [MD_SOURCE_START_ATTR]: '10',
      [MD_SOURCE_END_ATTR]: '16',
      [MD_SOURCE_LEAF_ATTR]: '1',
      [MD_SOURCE_AFTER_ATTR]: '18',
    },
    [textNode('меткой')],
  );
  const space = textNode(' ');
  const tail = textNode('хвост');
  const paragraph = element(
    { [MD_SOURCE_START_ATTR]: '0', [MD_SOURCE_END_ATTR]: '25' },
    [lead, mark, space, tail],
  );
  const root = element({}, [paragraph]);
  return { root, paragraph, mark, tail };
}

describe('маппинг выделения просмотра в исходник (189da39e)', () => {
  it('клик внутри листа даёт смещение start + символов до каретки', () => {
    const { mark } = annotatedParagraph();
    const range = sourceRangeFromSelection(
      { node: mark.childNodes[0], offset: 2 },
      { node: mark.childNodes[0], offset: 6 },
    );
    assert.deepEqual(range, { anchor: 12, head: 16 });
  });

  it('карта сдвига листа компенсирует escape/HTML-entity (ошибка 1b9cf949)', () => {
    // `**a \* b**`: диапазон видимого текста [2, 8), `\*` короче исходника на 1.
    const text = textNode('a * b');
    const strong = element(
      {
        [MD_SOURCE_START_ATTR]: '2',
        [MD_SOURCE_END_ATTR]: '8',
        [MD_SOURCE_LEAF_ATTR]: '1',
        [MD_SOURCE_SHIFT_ATTR]: '3:1',
      },
      [text],
    );
    element({ [MD_SOURCE_START_ATTR]: '0', [MD_SOURCE_END_ATTR]: '10' }, [strong]);
    // Каретка на `b` (4-й отрисованный символ) → 2 + 4 + 1 = 7 (истина).
    const range = sourceRangeFromSelection({ node: text, offset: 4 }, { node: text, offset: 4 });
    assert.deepEqual(range, { anchor: 7, head: 7 });
    // До укороченного прогона сдвиг не применяется.
    const before = sourceRangeFromSelection({ node: text, offset: 2 }, { node: text, offset: 2 });
    assert.deepEqual(before, { anchor: 4, head: 4 });
  });

  it('клик на уровне блока отсчитывается от предыдущего data-md-after', () => {
    const { tail } = annotatedParagraph();
    // «хвост» — после ' ' (15-й отрисованный символ), якорь mark.after=18.
    const range = sourceRangeFromSelection(
      { node: tail, offset: 0 },
      { node: tail, offset: 5 },
    );
    assert.deepEqual(range, { anchor: 19, head: 24 });
  });

  it('скрытый прогон (HTML-комментарий) на границе анкера компенсируется включительно (29aa3108)', () => {
    // `**a ==c==<!--x--> b**`: скрытый прогон рендерится нулём символов и
    // начинается ровно на границе анкера вложенной конструкции, поэтому его
    // сдвиг применяется в т.ч. при `at === baseRendered`.
    const tail = textNode('cd');
    const anchored = element({ [MD_SOURCE_AFTER_ATTR]: '10' }, []);
    const paragraph = element(
      {
        [MD_SOURCE_START_ATTR]: '0',
        [MD_SOURCE_END_ATTR]: '30',
        [MD_SOURCE_SHIFT_ATTR]: '2:5!',
      },
      [textNode('ab'), anchored, tail],
    );
    element({}, [paragraph]);
    const range = sourceRangeFromSelection({ node: tail, offset: 1 }, { node: tail, offset: 1 });
    // base=10, caret=3, baseRendered=2 → 10 + 1 + 5 = 16.
    assert.deepEqual(range, { anchor: 16, head: 16 });
  });

  it('узлы вне размеченного рендера дают null (откат к каретке в конец)', () => {
    const plain = element({}, [textNode('обычный html')]);
    assert.equal(
      sourceRangeFromSelection(
        { node: plain.childNodes[0], offset: 0 },
        { node: plain.childNodes[0], offset: 3 },
      ),
      null,
    );
  });

  it('потерянное выделение (null-узлы) даёт null', () => {
    assert.equal(
      sourceRangeFromSelection({ node: null, offset: 0 }, { node: null, offset: 0 }),
      null,
    );
  });
});

/* ------------------------------------------------------------------------- *
 * Просмотр с трансклюзиями (ошибка 0fdd8c86)
 * ------------------------------------------------------------------------- */

const TR_ID = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';

/** Развёрнутый текст просмотра с маркерами (как его строит поле: expandWithLoader). */
function expandOnce(raw: string, body: string): string {
  return expandTransclusions(raw, () => ({ found: true, body_md: body }), { markers: true });
}

/**
 * Блок `<p>` с разметкой позиций развёрнутого текста над `text`: имитирует
 * узел рендера просмотра, по которому пришёл двойной клик.
 */
function expandedBlock(expStart: number, text: string): any {
  return element(
    { [MD_SOURCE_START_ATTR]: String(expStart), [MD_SOURCE_END_ATTR]: String(expStart + text.length) },
    [textNode(text)],
  );
}

describe('просмотр с трансклюзией: смещения развёртки → исходник (0fdd8c86)', () => {
  const raw = `Перед блоком.\n\n![[#${TR_ID}]]\n\nПосле блока.\n`;
  const expanded = expandOnce(raw, 'Текст источника.\n\nВторой абзац источника.');

  it('без трансклюзий карта не строится (прежнее поведение)', () => {
    const plain = 'Просто текст без развёртки.\n';
    assert.equal(buildExpandedSourceMap(plain, plain), null);
    assert.equal(buildExpandedSourceMap('', ''), null);
  });

  it('неразвёрнутый фрагмент переводится 1:1 (в место клика)', () => {
    const map = buildExpandedSourceMap(raw, expanded);
    assert.ok(map !== null);
    const expStart = expanded.indexOf('После блока.');
    const srcStart = raw.indexOf('После блока.');
    assert.ok(expStart > raw.indexOf('После блока.'), 'развёртка сдвигает позицию хвоста');
    for (let k = 0; k <= 'После блока.'.length; k += 1) {
      assert.equal(mapViewOffsetToSource(map!, expStart + k), srcStart + k);
    }
  });

  it('двойной клик по хвосту входит в правку с кареткой в месте клика', () => {
    const map = buildExpandedSourceMap(raw, expanded);
    assert.ok(map !== null);
    const expStart = expanded.indexOf('После блока.');
    // «блока» — 2-й и последующие символы слова; клик на границе символов слова.
    const word = 'блока';
    const expWordStart = expStart + 'После '.length;
    const block = expandedBlock(expStart, 'После блока.');
    const range = sourceRangeFromSelection(
      { node: block.childNodes[0], offset: 'После '.length },
      { node: block.childNodes[0], offset: 'После '.length + word.length },
      map!,
    );
    assert.deepEqual(range, {
      anchor: raw.indexOf('После блока.') + 'После '.length,
      head: raw.indexOf('После блока.') + 'После '.length + word.length,
    });
    // и без карты смещение осталось бы в координатах развёртки (регресс не вернулся)
    assert.equal(expWordStart, expStart + 'После '.length);
  });

  it('клик внутри развёрнутого блока ведёт к ссылке-трансклюзии', () => {
    const map = buildExpandedSourceMap(raw, expanded);
    assert.ok(map !== null);
    const refStart = raw.indexOf('![[');
    const inside = expanded.indexOf('Текст источника');
    assert.equal(mapViewOffsetToSource(map!, inside), refStart);
    assert.equal(mapViewOffsetToSource(map!, inside + 3), refStart);
  });

  it('вложенные трансклюзии и отсутствующий источник разбираются', () => {
    const inner = `Внутренний.\n\n![[#${TR_ID}]]\n`;
    const nested = expandOnce(raw, inner);
    const mapNested = buildExpandedSourceMap(raw, nested);
    assert.ok(mapNested !== null);
    assert.equal(
      mapViewOffsetToSource(mapNested!, nested.indexOf('После блока.')),
      raw.indexOf('После блока.'),
    );

    const missing = expandTransclusions(raw, () => ({ found: false, body_md: '' }), {
      markers: true,
    });
    const mapMissing = buildExpandedSourceMap(raw, missing);
    assert.ok(mapMissing !== null);
    assert.equal(
      mapViewOffsetToSource(mapMissing!, missing.indexOf('После блока.')),
      raw.indexOf('После блока.'),
    );
  });
});

/* ------------------------------------------------------------------------- *
 * Вложенные трансклюзии: клик внутри вложенного блока (ошибка 5ecb9f0b)
 * ------------------------------------------------------------------------- */

const NESTED_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const NESTED_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const NESTED_C = 'cccccccc-3333-4333-8333-333333333333';

/**
 * Развёртка трёх уровней: комментарий ссылается на A, A — на B, B — на C.
 * Возвращает исходник поля и развёрнутый текст с вложенными блоками.
 */
function expandThreeLevels(): { raw: string; expanded: string } {
  const raw = `Перед блоком.\n\n![[#${NESTED_A}]]\n\nПосле блока.\n`;
  const bodies: Record<string, string> = {
    [NESTED_A]: `Внешний текст.\n\n![[#${NESTED_B}]]\n\nХвост A.\n`,
    [NESTED_B]: `Глубокий текст.\n\n![[#${NESTED_C}]]\n\nХвост B.\n`,
    [NESTED_C]: `Самый глубокий.\n`,
  };
  return {
    raw,
    expanded: expandTransclusions(raw, (id) => ({ found: id in bodies, body_md: bodies[id] ?? '' }), {
      markers: true,
    }),
  };
}

describe('просмотр с трансклюзией: вложенные блоки (5ecb9f0b)', () => {
  it('клик во внешней части блока ведёт к внешней ссылке, во вложенный — не схлопывается', () => {
    const { raw, expanded } = expandThreeLevels();
    const map = buildExpandedSourceMap(raw, expanded);
    assert.ok(map !== null);
    const outerRef = raw.indexOf('![[');
    // Текст внешнего блока вне вложенных блоков — ссылка внешней трансклюзии.
    assert.equal(mapViewOffsetToSource(map!, expanded.indexOf('Внешний текст.')), outerRef);
    assert.equal(mapViewOffsetToSource(map!, expanded.indexOf('Хвост A.')), outerRef);
    // Вложенный текст (2-й и 3-й уровень) в body_md поля отсутствует — позиции нет,
    // и карта НЕ схлопывает её на внешнюю ссылку (регресс ошибки 5ecb9f0b).
    assert.equal(raw.includes('Глубокий текст.'), false, 'развёртка заменяет вложенную ссылку блоком');
    assert.equal(mapViewOffsetToSource(map!, expanded.indexOf('Глубокий текст.')), null);
    assert.equal(mapViewOffsetToSource(map!, expanded.indexOf('Самый глубокий.')), null);
    assert.equal(mapViewOffsetToSource(map!, expanded.indexOf('Хвост B.')), null);
    // Вне блоков — прежнее поведение 1:1 (ошибка 0fdd8c86).
    assert.equal(
      mapViewOffsetToSource(map!, expanded.indexOf('После блока.')),
      raw.indexOf('После блока.'),
    );
  });

  it('двойной клик внутри вложенного блока даёт null (каретка не на внешней ссылке)', () => {
    const { raw, expanded } = expandThreeLevels();
    const map = buildExpandedSourceMap(raw, expanded);
    assert.ok(map !== null);
    const nestedStart = expanded.indexOf('Глубокий текст.');
    const block = expandedBlock(nestedStart, 'Глубокий текст.');
    const range = sourceRangeFromSelection(
      { node: block.childNodes[0], offset: 0 },
      { node: block.childNodes[0], offset: 'Глубокий'.length },
      map!,
    );
    assert.equal(range, null);
  });

  it('двойной клик во внешней части блока по-прежнему входит в правку на внешней ссылке', () => {
    const { raw, expanded } = expandThreeLevels();
    const map = buildExpandedSourceMap(raw, expanded);
    assert.ok(map !== null);
    const expStart = expanded.indexOf('Внешний текст.');
    const block = expandedBlock(expStart, 'Внешний текст.');
    const range = sourceRangeFromSelection(
      { node: block.childNodes[0], offset: 0 },
      { node: block.childNodes[0], offset: 'Внешний'.length },
      map!,
    );
    assert.deepEqual(range, { anchor: raw.indexOf('![['), head: raw.indexOf('![[') });
  });
});

/* ------------------------------------------------------------------------- *
 * Склейка renderView → viewMap → selectionInView (ошибка 3e74715f)
 * ------------------------------------------------------------------------- */

/**
 * Фейковое поле просмотра: `ownerDocument.getSelection` отдаёт заданное
 * выделение, `contains` определяет, внутри ли поля его концы. Проверяется сам
 * шов `viewSelectionToSourceRange` — та же функция, что зовёт `selectionInView`
 * по двойному клику.
 */
function viewWithSelection(
  anchor: { node: any; offset: number },
  focus: { node: any; offset: number },
  inside = true,
): any {
  const selection = {
    rangeCount: 1,
    anchorNode: anchor.node,
    anchorOffset: anchor.offset,
    focusNode: focus.node,
    focusOffset: focus.offset,
  };
  return { contains: () => inside, ownerDocument: { getSelection: () => selection } };
}

describe('просмотр с трансклюзией: склейка viewMap → selectionInView (3e74715f)', () => {
  const raw = `Перед блоком.\n\n![[#${TR_ID}]]\n\nПосле блока.\n`;
  const body = 'Текст источника.\n\nВторой абзац источника.';
  const loader = (): Promise<{ found: boolean; title: string; body_md: string }> =>
    Promise.resolve({ found: true, title: 'Источник', body_md: body });

  /** Прод-путь renderView: развёртка `expandWithLoader` → карта смещений. */
  async function renderViewMap(): Promise<{ expanded: string; map: NonNullable<ReturnType<typeof buildExpandedSourceMap>> }> {
    const { text } = await transclusionInternals.expandWithLoader(raw, loader);
    const map = buildExpandedSourceMap(raw, text);
    assert.ok(map !== null, 'карта развёртки построена — как в renderView');
    return { expanded: text, map };
  }

  it('двойной клик вне развёрнутого блока входит в правку в месте клика', async () => {
    const { expanded, map } = await renderViewMap();
    const expStart = expanded.indexOf('После блока.');
    const srcStart = raw.indexOf('После блока.');
    const block = expandedBlock(expStart, 'После блока.');
    const view = viewWithSelection(
      { node: block.childNodes[0], offset: 'После '.length },
      { node: block.childNodes[0], offset: 'После '.length + 'блока'.length },
    );

    assert.deepEqual(viewSelectionToSourceRange(view, map), {
      anchor: srcStart + 'После '.length,
      head: srcStart + 'После '.length + 'блока'.length,
    });
  });

  it('двойной клик внутри развёрнутого блока ведёт к ссылке-трансклюзии', async () => {
    const { expanded, map } = await renderViewMap();
    const refStart = raw.indexOf('![[');
    const inside = expanded.indexOf('Текст источника');
    const block = expandedBlock(inside, 'Текст источника.');
    const view = viewWithSelection(
      { node: block.childNodes[0], offset: 0 },
      { node: block.childNodes[0], offset: 'Текст'.length },
    );

    assert.deepEqual(viewSelectionToSourceRange(view, map), { anchor: refStart, head: refStart });
  });

  it('выделение вне поля просмотра не даёт офсета (вход в правку без каретки)', async () => {
    const { expanded, map } = await renderViewMap();
    const inside = expanded.indexOf('Текст источника');
    const block = expandedBlock(inside, 'Текст источника.');
    const view = viewWithSelection(
      { node: block.childNodes[0], offset: 0 },
      { node: block.childNodes[0], offset: 3 },
      false,
    );

    assert.equal(viewSelectionToSourceRange(view, map), undefined);
  });

  it('без развёртки карты нет — смещение берётся из разметки как есть', () => {
    const plain = 'Просто текст без развёртки.\n';
    const start = plain.indexOf('текст');
    const block = expandedBlock(start, 'текст');
    const view = viewWithSelection(
      { node: block.childNodes[0], offset: 0 },
      { node: block.childNodes[0], offset: 'текст'.length },
    );

    assert.deepEqual(viewSelectionToSourceRange(view, null), {
      anchor: start,
      head: start + 'текст'.length,
    });
  });
});
