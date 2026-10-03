/**
 * Сторож-структура рабочей области публикации по карточке ea1b5f14 (пункты
 * 1–7): карточка шапки, оглавление без текстов, контекстное меню «В
 * публикации», двойной клик по тексту, ползунок ширины, единые блочные стили
 * и титульный лист.
 *
 * Полноценный DOM-прогон рабочей области дорог (см.
 * `publication-workspace-reactive.test.ts`), поэтому здесь проверяется
 * структура разметки и подключение фасадов, а поведенческие части — юнит-
 * тестами модели (`publications-workspace-model.test.ts`) и фасада
 * (`lib-ui-slider.test.ts`).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');
const WS = fs.readFileSync(
  path.join(ROOT, 'screens', 'publications', 'workspace.ts'),
  'utf8',
);
const CSS = fs.readFileSync(path.join(ROOT, 'styles', 'screens', 'publications.css'), 'utf8');

describe('ea1b5f14: рабочая область публикации — пункты 1–7', () => {
  it('п.1: обложка и титул — единая кликабельная карточка, кнопки вне неё', () => {
    assert.match(WS, /div\('pub-ws-card'\)/, 'карточка шапки построена');
    assert.match(WS, /card\.append\(coverBox, titleBox\)/, 'обложка и титул внутри карточки');
    assert.match(
      WS,
      /card\.addEventListener\('click'[\s\S]*?opts\.onOpenCard/,
      'клик в любом месте карточки открывает панель редактора',
    );
    assert.match(WS, /div\('pub-ws-right'\)/, 'кнопки шапки — вне карточки');
    assert.match(CSS, /\.pub-ws-card:hover\s*\{[^}]*background/s, 'hover-подсветка карточки');
  });

  it('п.2: оглавление рендерит только разделы, каждое вхождение — со своим якорем', () => {
    // Тексты в оглавлении строит модель (tocLines) — проверено юнит-тестом
    // publications-workspace-model; здесь фиксируем, что строка текста в TOC
    // не строится, а раздел остаётся кликабельным.
    assert.match(WS, /if \(line\.kind === 'section'\)/, 'строка оглавления — раздел');
    assert.ok(!WS.includes("node.classList.add('pub-toc-text')"), 'строк текстов в TOC больше нет');
    assert.match(WS, /scrollToAnchor\(anchor\)/, 'клик по разделу прокручивает документ');
    assert.match(WS, /function updateCurrentSection\(\)/, 'прокрутка подсвечивает текущий раздел');
  });

  it('п.3: контекстное меню блока — подменю «В публикации» + общие команды мысли', () => {
    assert.match(WS, /buildThoughtMenuItems/, 'общие команды берутся из словаря меню мысли');
    assert.match(WS, /menuSubmenu\(t\('publications\.block\.menu'/, 'подменю «В публикации» первым');
    assert.match(WS, /publications\.block\.moveUp/, 'команда «Сдвинуть вверх»');
    assert.match(WS, /publications\.block\.moveDown/, 'команда «Сдвинуть вниз»');
    assert.match(WS, /publications\.block\.moveToSection/, 'команда «Переместить в раздел…»');
    assert.match(WS, /publications\.block\.addText/, 'команда «Добавить текст раздела…»');
    assert.match(WS, /setExcluded\(block\.thoughtId, !excluded\)/, 'исключение/включение');
    // У текста «Добавить раздел» нет: команда только для раздела.
    const addSection = WS.indexOf('publications.block.addSection');
    const guard = WS.slice(Math.max(0, addSection - 400), addSection);
    assert.match(guard, /block\.kind === 'section'/, '«Добавить раздел» — только у раздела');
    // Сдвиг порядка — общим commitOrder (тот же PUT order, что в задаче D).
    assert.match(WS, /commitOrder\(reordered\)/, 'сдвиг блока идёт через общий commitOrder');
  });

  it('п.4: двойной клик по тексту открывает комментарий в правке с кареткой', () => {
    assert.match(WS, /addEventListener\('dblclick'/, 'двойной клик подключён');
    assert.match(WS, /openThoughtCommentEditor/, 'открывается комментарий мысли в редакторе');
    assert.match(WS, /closest\('p, li, blockquote, h1, h2, h3, h4, h5, h6'\)/, 'берётся кликнутый абзац');
  });

  it('п.5: ползунок ширины — над кнопками, фасадный, из персональных настроек', () => {
    assert.match(WS, /uiSlider\(\{/, 'ползунок строится фасадом lib/ui');
    assert.match(WS, /headerRight\.append\(widthSlider\.root, actions\)/, 'ползунок над рядом кнопок');
    assert.match(WS, /opts\.getTextWidth\(\)/, 'значение берётся из персональных настроек');
    assert.match(WS, /opts\.onTextWidthChange\(value\)/, 'завершение сохраняет настройку');
    assert.match(WS, /applyTextWidth\(opts\.getTextWidth\(\)\)/, 'ширина применяется при открытии');
    assert.match(CSS, /width:\s*var\(--pub-doc-width, 100%\)/, 'документ задаёт ширину долей');
  });

  it('п.6: блочные стили документа — типографика comment-view, отступы только в документе', () => {
    assert.match(WS, /div\('pub-doc comment-view'\)/, 'документ берёт типографику markdown-просмотра');
    assert.match(CSS, /\.pub-doc\.comment-view\s*\{[^}]*max-height:\s*none/s, 'прокрутку держит документ');
    assert.match(CSS, /\.pub-doc-preamble\s*,\s*\.pub-doc-text\s*\{[^}]*margin-block/s, 'отступ между текстами мыслей');
    assert.match(CSS, /\.pub-doc-text > :first-child/, 'крайние абзацы не удваивают блочный отступ');
    // Отступы не протекают в панель оглавления: правила привязаны к `.pub-doc`.
    assert.ok(!/\.pub-toc[^{]*\{[^}]*margin-block:\s*var\(--space-3\)/s.test(CSS), 'в TOC отступов нет');
  });

  it('п.7: титульный лист — обложка с заголовком поверх, без обложки — крупнее H1', () => {
    assert.match(WS, /div\('pub-doc-hero'\)/, 'с обложкой — титул-герой');
    assert.match(WS, /div\('pub-doc-hero-overlay'\)/, 'заголовок поверх обложки');
    assert.match(CSS, /\.pub-doc-hero-overlay[\s\S]*?text-shadow/, 'окантовка/тень для читаемости');
    assert.match(
      CSS,
      /\.pub-doc\.comment-view \.pub-doc-title\s*\{[^}]*font-size:\s*var\(--font-size-3xl/s,
      'название крупнее H1',
    );
  });

  it('блокеры верификации: поддерево/сопоставление свойства/владелец панели', () => {
    // Блокер 1: диалог переноса и защита от цикла используют поддерево.
    assert.match(WS, /subtreeIds\(/, 'поддерево считается общим предикатом');
    assert.match(WS, /const excluded = subtreeIds\(block\.thoughtId, all\)/, 'диалог исключает поддерево');
    assert.match(WS, /subtreeIds\(block\.thoughtId, sectionTreeItems\(\)\)\.has\(targetSectionId\)/, 'защита от цикла при переносе');
    assert.match(WS, /publications\.block\.moveCycle/, 'понятное сообщение об отказе');
    // Блокеры 2–3: сопоставление значения-связи с выбранным свойством.
    assert.match(WS, /linkEntryMatchesPick\(/, 'сверка по id И по имени стороны');
    assert.match(
      WS,
      /'values' in v && linkEntryMatchesPick\(v, pick\)/,
      'аддитивное добавление находит внетиповое значение (блокер 2)',
    );
    assert.match(
      WS,
      /linkEntryMatchesPick\(value, \{ propertyId: item\.propertyId, key: item\.name \}\)/,
      'перенос текста находит внетиповое значение (блокер 3)',
    );
    // Блокер 4: ожидание поля сверяет владельца отрисованной панели.
    const editor = fs.readFileSync(path.join(ROOT, 'editor', 'editor.ts'), 'utf8');
    assert.match(editor, /from '\.\/comment-focus\.js'/, 'ядро ожидания вынесено');
    assert.match(editor, /commentFocusStep\(\{/, 'шаг ожидания через предикат');
    assert.match(editor, /renderCtx\.ownerType === 'thought' \? renderCtx\.ownerId : null/, 'владелец панели сверяется с id');
  });
});
