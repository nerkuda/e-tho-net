/**
 * Регресс-тест ошибки `8c890ee7`: комментарий длиннее вьюпорта начального
 * разбора обслуживается целиком без правки.
 *
 * **Что моделируется.** Состояние создаётся на документе длиннее
 * `Work.InitViewport`, поэтому дерево обрезано. Затем применяется транзакция
 * parse-worker'а (`Language.setState`, без `docChanged` и `selection`) —
 * {@link dispatchBackgroundParse}. Поля, производные от дерева (`livePreview`
 * в `md-live.ts` и `collapseDecoField` в `comment-collapse.ts`), обязаны
 * пересобраться на этой транзакции: иначе разметка и шевроны хвоста остаются
 * в состоянии «до правки».
 *
 * **Почему helper, а не создание состояния здесь.** На документе длиннее
 * вьюпорта полное дерево headless недостижимо при создании (см.
 * `tests/editor-parse.ts`), поэтому осознанно обрезанное состояние и модель
 * доразбора живут в `tests/editor-parse-worker.ts` (сторож
 * `guard-editor-parse-complete.test.ts` сканирует только `*.test.ts`).
 *
 * **Мутации (проверено).** Убрать условие пробуждения по ссылке дерева из
 * `livePreview.update` — краснеют проверки live preview; из
 * `collapseDecoField.update` — краснеют проверки разделов и маркеров.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, type EditorState, type Extension } from '@codemirror/state';

import { ShimElement } from './dom-shim.js';
import { MAX_HEADLESS_PARSE_LENGTH } from './editor-parse.js';
import { createTruncatedDocumentState, dispatchBackgroundParse } from './editor-parse-worker.js';
import { livePreview } from '../src/renderer/editor/md-live.js';
import { wikiLinkLanguage } from '../src/renderer/editor/wiki-link.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Число заголовков в документе; последний заведомо за вьюпортом разбора. */
const HEADINGS = 80;

/**
 * Тот же документ, что в стороже `guard-editor-parse-complete.test.ts`:
 * заголовок + тело (54 символа на раздел), всего заметно больше 3000.
 */
const LONG_DOC = '## Раздел с длинным телом\n\nтекст раздела для разбора\n\n'.repeat(HEADINGS);

type Module = typeof import('../src/renderer/editor/comment-collapse.js');

let mod: Module;

/** Минимальный shim DOM, нужный модулю сворачивания (как в соседних тестах). */
function installShim(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    body: new ShimElement('body'),
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

/** Расширения редактора комментария в той же сборке, что и в продукте. */
function editorExtensions(): Extension[] {
  return [
    markdown({ base: markdownLanguage, extensions: [wikiLinkLanguage()] }),
    livePreview,
    mod.commentCollapseExtension(mod.createCommentCollapseState('net', undefined)),
  ];
}

/** Декорации live preview: всего, за вьюпортом начального разбора и дальний край. */
function liveStats(state: EditorState): { count: number; tail: number; maxTo: number } {
  let count = 0;
  let tail = 0;
  let maxTo = 0;
  for (let it = state.field(livePreview).iter(); it.value !== null; it.next()) {
    count += 1;
    if (it.from >= MAX_HEADLESS_PARSE_LENGTH) tail += 1;
    maxTo = Math.max(maxTo, it.to);
  }
  return { count, tail, maxTo };
}

/** Маркеры гаттера сворачивания: всего и за вьюпортом начального разбора. */
function markerStats(state: EditorState): { count: number; tail: number } {
  const field = state.field(mod.commentCollapseInternals.collapseDecoField);
  let count = 0;
  let tail = 0;
  for (let it = field.markers.iter(); it.value !== null; it.next()) {
    count += 1;
    if (it.from >= MAX_HEADLESS_PARSE_LENGTH) tail += 1;
  }
  return { count, tail };
}

describe('ошибка 8c890ee7: доразбор длинного комментария', () => {
  it('без правки и перемещения каретки обслуживает хвост разметкой и шевронами', async () => {
    installShim();
    mod = (await import('../src/renderer/editor/comment-collapse.js')) as Module;

    assert.ok(LONG_DOC.length > MAX_HEADLESS_PARSE_LENGTH, 'документ длиннее вьюпорта разбора');

    const truncated = createTruncatedDocumentState(LONG_DOC, editorExtensions());

    // Состояние «до»: поля построены по обрезанному дереву.
    const beforeLive = liveStats(truncated);
    const beforeSections = mod.commentCollapseInternals.collectSections(truncated);
    const beforeMarkers = markerStats(truncated);
    const beforeCollapseValue = truncated.field(mod.commentCollapseInternals.collapseDecoField);

    assert.ok(beforeLive.count > 0, 'начало документа размечено');
    assert.ok(beforeSections.length > 0, 'начало документа даёт разделы');
    assert.ok(
      beforeSections.length < HEADINGS,
      `обрезанное дерево теряет разделы (${beforeSections.length} из ${HEADINGS})`,
    );
    assert.equal(beforeSections.filter((s) => s.anchorFrom >= MAX_HEADLESS_PARSE_LENGTH).length, 0);
    assert.equal(beforeMarkers.tail, 0, 'маркеров за вьюпортом нет');

    // Транзакция parse-worker'а: полное дерево, ни правки, ни выделения.
    const parsed = dispatchBackgroundParse(truncated);
    assert.equal(parsed.doc.eq(truncated.doc), true, 'документ не менялся');
    assert.equal(parsed.selection.eq(truncated.selection), true, 'каретка не двигалась');

    const afterLive = liveStats(parsed);
    const afterSections = mod.commentCollapseInternals.collectSections(parsed);
    const afterMarkers = markerStats(parsed);

    // Live preview: декорации хвоста появились без правки/каретки.
    assert.ok(
      afterLive.count > beforeLive.count,
      `live preview не пересобрался: ${afterLive.count} декораций против ${beforeLive.count}`,
    );
    assert.ok(afterLive.tail > 0, 'live preview размечен за вьюпортом начального разбора');
    assert.ok(
      afterLive.maxTo > MAX_HEADLESS_PARSE_LENGTH,
      `дальний край разметки (${afterLive.maxTo}) должен уйти за вьюпорт`,
    );

    // Сворачивание: разделы и маркеры гаттера хвоста появились без правки.
    assert.ok(
      afterSections.length > beforeSections.length,
      `разделы хвоста не появились: ${afterSections.length} против ${beforeSections.length}`,
    );
    assert.ok(
      afterSections.some((s) => s.anchorFrom >= MAX_HEADLESS_PARSE_LENGTH),
      'разделы за вьюпортом начального разбора должны появиться',
    );
    assert.ok(
      afterMarkers.count > beforeMarkers.count,
      `маркеры не пересобрались: ${afterMarkers.count} против ${beforeMarkers.count}`,
    );
    assert.ok(afterMarkers.tail > 0, 'шевроны хвоста появились');
    assert.equal(afterMarkers.count, afterSections.length, 'маркер есть у каждого раздела');
    assert.notEqual(
      parsed.field(mod.commentCollapseInternals.collapseDecoField),
      beforeCollapseValue,
      'поле свёртки обязано пересобраться на доразборе',
    );
  });

  it('перемещение каретки не пересобирает свёртку; live preview за кареткой — штатно', async () => {
    installShim();
    mod = (await import('../src/renderer/editor/comment-collapse.js')) as Module;

    const state = dispatchBackgroundParse(createTruncatedDocumentState(LONG_DOC, editorExtensions()));
    const collapseBefore = state.field(mod.commentCollapseInternals.collapseDecoField);
    const liveBefore = state.field(livePreview);

    const moved = state.update({ selection: EditorSelection.cursor(10) }).state;

    // Дерево на выделении не меняется — лишней пересборки свёртки быть не должно.
    assert.equal(
      moved.field(mod.commentCollapseInternals.collapseDecoField),
      collapseBefore,
      'выделение не меняет дерево — поле свёртки не пересобирается',
    );
    // Live preview следует за кареткой (активный блок раскрывается) — это
    // штатный триггер пересборки, не связанный с доразбором.
    assert.notEqual(moved.field(livePreview), liveBefore, 'live preview пересобирается вслед за кареткой');
  });
});
