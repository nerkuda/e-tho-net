/**
 * Сторож замечаний визуальной приёмки 0.11.1, волна 7 (задача 36c700f6):
 *
 *  1) клик по разделу/тексту документа — ПОЛНЫЙ выбор: мысль открыта в
 *     редакторе → сплошная рамка `.pub-doc-editor`, пунктир `.pub-doc-current`
 *     гаснет (общее правило `shouldDrawCurrentFrame`, ADR e6d48e09);
 *  2) пустые мысли-тексты видны блоками нормальной высоты (DTO отдаёт `body_html`
 *     пустой строкой; клиент рисует пустой абзац, блок выделяется/редактируется);
 *  3) титульный лист — виртуальный портретный лист (1:√2), обложка сверху, две
 *     равные половины (заголовок/подзаголовок), автор внизу справа с отступами;
 *     кегль подбирается фиттингом (чистая функция `fitFontSize`).
 *
 * Поведенческие части (реальный клик и замер DOM) — на живом стенде; здесь
 * структурные инварианты и юнит-тесты чистой логики.
 *
 * Входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type {
  Publication,
  PublicationAssembly,
  PublicationAssemblySection,
} from '@etn/shared';

import { documentBlocks, fitFontSize } from '../src/renderer/screens/publications/model.js';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');
const read = (...parts: string[]): string => fs.readFileSync(path.join(RENDERER, ...parts), 'utf8');

const WS = read('screens', 'publications', 'workspace.ts');
const MODEL = read('screens', 'publications', 'model.ts');
const CSS = read('styles', 'screens', 'publications.css');

// --- Фикстуры сборки/публикации (минимальные) ------------------------------

function publication(overrides: Partial<Publication> = {}): Publication {
  return {
    id: 'pub1',
    title: 'Док',
    subtitle: null,
    summary_md: null,
    authorship: null,
    cover_attachment_id: null,
    cover_url: null,
    cover_kind: 'none',
    assembly_date: null,
    title_recipe: null,
    text_sources: [],
    extra_properties: [],
    numbering_from: null,
    numbering_to: null,
    active: true,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    version: 1,
    created_at: '2026-10-01T00:00:00.000Z',
    created_by: 'u',
    updated_at: '2026-10-01T00:00:00.000Z',
    updated_by: 'u',
    ...overrides,
  };
}

function section(
  thoughtId: string,
  texts: PublicationAssemblySection['texts'] = [],
): PublicationAssemblySection {
  return {
    thought_id: thoughtId,
    node_key: `e:${thoughtId}`,
    anchor: `pub-${thoughtId}`,
    level: 1,
    heading: thoughtId,
    preamble_html: '',
    texts,
    extra: [],
    flags: { repeat_of: null, cycle_cut: false },
    children: [],
  };
}

function assembly(sections: PublicationAssemblySection[]): PublicationAssembly {
  return {
    publication: {
      title: 'Док',
      subtitle: null,
      authorship: null,
      assembly_date: null,
      summary_html: '',
      cover: { kind: 'placeholder', ref: null },
      new_candidates: 0,
    },
    sections,
    excluded: [],
    warnings: [],
    meta: { page: 1, per_page: 20, total_roots: sections.length, has_more: false },
  };
}

describe('волна 7, п.1: клик по разделу/тексту — полный выбор (ADR e6d48e09)', () => {
  it('тело документа применяет общее правило ядра, а не свою логику', () => {
    assert.match(
      WS,
      /import\s*\{[^}]*shouldDrawCurrentFrame[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/ui\/nav-core\.js'/s,
      'workspace импортирует правило двухрамочности из ядра',
    );
    assert.match(WS, /function paintDocFrames\(/, 'обе рамки рисуются единой функцией');
    assert.match(
      WS,
      /shouldDrawCurrentFrame\(\s*entry\.thoughtId\s*,\s*openedId\s*\)/,
      'пунктир подавляется через общее правило ядра',
    );
    assert.match(
      WS,
      /function paintEditorHighlight\(\):\s*void\s*\{\s*paintDocFrames\(docNav\.current\(\)\)/m,
      'смена цели редактора пересчитывает обе рамки (а не только сплошную)',
    );
    assert.match(
      WS,
      /const openedId = currentThoughtId\(\)/,
      'открытая мысль — единое определение currentThoughtId (цель редактора, иначе фокус)',
    );
  });

  it('CSS: пунктир и сплошная рамка с кантом — как у остальных экранов', () => {
    assert.match(CSS, /\.pub-doc-current\s*\{[^}]*outline:\s*2px dashed/s, 'текущий — пунктир');
    assert.match(
      CSS,
      /\.pub-doc-editor\s*\{[^}]*outline:\s*2px solid var\(--layer-focus-stripe/s,
      'открытый в редакторе — сплошная рамка фокуса',
    );
    assert.match(
      CSS,
      /\.pub-doc-editor\s*\{[^}]*box-shadow:\s*inset 0 0 0 4px var\(--focus-ring-contrast\)/s,
      'второй кант двойной обводки сохранён',
    );
  });
});

describe('волна 7, п.2: пустые мысли-тексты видны блоками', () => {
  it('пустой текст остаётся блоком документа (DTO body_html = "")', () => {
    const asm = assembly([
      section('A', [{ thought_id: 'T', anchor: 'pub-T', edge_id: 'e:T', body_html: '' }]),
    ]);
    const blocks = documentBlocks(asm, publication());
    const text = blocks.find((block) => block.kind === 'text');
    assert.ok(text !== undefined, 'блок текста построен, несмотря на пустой комментарий');
    assert.equal(text.html, '');
  });

  it('пустой комментарий рисуется видимой пустой строкой, а не пропуском', () => {
    assert.match(WS, /function renderTextBody\(/, 'тело текста рендерит общая функция');
    assert.match(
      WS,
      /if \(empty\)\s*\{[\s\S]*?el\('p',\s*'pub-doc-text-line'\)/,
      'пустой текст получает абзац-заглушку',
    );
    assert.match(WS, /renderTextBody\(node,\s*block\.html\)/, 'текст-блок идёт через renderTextBody');
    assert.match(WS, /renderTextBody\(node,\s*html\)/, 'точечная правка пустого текста — тоже');
    assert.match(WS, /addEventListener\('dblclick'/, 'пустой блок редактируется двойным кликом');
    assert.match(CSS, /\.pub-doc-text-empty\s*\{[^}]*min-height/s, 'пустому блоку задана высота строки');
  });
});

describe('волна 7, п.3: титульный лист — портретный лист, зоны, фиттинг', () => {
  it('контейнер — A-портрет (1:√2), обложка-фон под текстом, две равные половины', () => {
    assert.match(
      CSS,
      /\.pub-doc-titlepage\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1\.414/s,
      'высота листа = ширина × √2',
    );
    // Обложка — независимый фоновый слой всего листа (абсолютный, под текстом).
    assert.match(
      CSS,
      /\.pub-doc-hero\s*\{[^}]*position:\s*absolute[^}]*top:\s*0[^}]*left:\s*0[^}]*width:\s*100%/s,
      'обложка — абсолютный фоновый слой сверху во всю ширину',
    );
    assert.match(
      CSS,
      /\.pub-doc-title-zone,\s*\.pub-doc-subtitle-zone\s*\{[^}]*flex:\s*1 1 0/s,
      'лист делится на две равные половины',
    );
    assert.match(
      CSS,
      /\.pub-doc-title-zone\s*\{[^}]*align-items:\s*flex-end/s,
      'заголовок прижат к низу верхней половины',
    );
    assert.match(
      CSS,
      /\.pub-doc-subtitle-zone\s*\{[^}]*align-items:\s*center[^}]*justify-content:\s*center/s,
      'подзаголовок — по центру нижней половины',
    );
    assert.match(
      CSS,
      /\.pub-doc-meta\s*\{[^}]*right:\s*var\(--space-4\)[^}]*bottom:\s*var\(--space-4\)/s,
      'автор внизу справа с отступами от краёв',
    );
    // Контурная обводка трёх текстов поверх обложки (приём волны 1).
    assert.match(
      CSS,
      /\.pub-doc-titlepage-cover \.pub-doc-title[\s\S]*?\.pub-doc-titlepage-cover \.pub-doc-subtitle[\s\S]*?\.pub-doc-titlepage-cover \.pub-doc-meta[\s\S]*?-webkit-text-stroke/s,
      'обводка заголовка, подзаголовка и автора',
    );
  });

  it('разметка строит фон-обложку, половины и вызывает фиттинг', () => {
    assert.match(WS, /div\('pub-doc-hero'\)/, 'фоновый слой обложки');
    assert.match(WS, /div\('pub-doc-title-zone'\)/, 'верхняя половина — заголовок');
    assert.match(WS, /div\('pub-doc-subtitle-zone'\)/, 'нижняя половина — подзаголовок');
    assert.match(WS, /pub-doc-titlepage-cover/, 'модификатор обводки на листе с обложкой');
    assert.match(WS, /function fitTitleFonts\(/, 'фиттинг вынесен в функцию');
    const calls = WS.match(/fitTitleFonts\(\)/g) ?? [];
    assert.ok(calls.length >= 2, 'фиттинг вызывается при рендере документа и на ползунке ширины');
    assert.match(WS, /function fitTitleZone\(/, 'замер зоны вынесен в отдельный шаг');
  });

  it('fitFontSize итеративно уменьшает кегль и не опускается ниже предела', () => {
    const config = { max: 48, min: 20, step: 2 };
    // Влезает сразу — стартовый кегль.
    assert.equal(fitFontSize(config, () => false), 48);
    // Не влезает до 30px — первое влезающее.
    assert.equal(fitFontSize(config, (size) => size > 30), 30);
    // Не влезает никогда — нижний предел.
    assert.equal(fitFontSize(config, () => true), 20);
    assert.match(MODEL, /export function fitFontSize\(/, 'чистая функция фиттинга — в модели');
  });
});
