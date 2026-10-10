/**
 * Сторож портала и z-index тултипов markdown-редактора (ошибка
 * 7aee1df3-0518-45fe-a8a5-2d177e90c8ea, ветка releases/0.12.1).
 *
 * Дизайн-система ставит `container-type: inline-size` на каркасы
 * (`.fp-host` «Дневника»/«Структур»/«Событий», `.ui-table`, `.ui-tabs` и др.).
 * Inline-size-контейнмент создаёт containing block для `position: fixed`
 * потомков, поэтому дефолтный (fixed) тултип автокомплита CM6 внутри каркаса
 * отсчитывался от ВЕРХНЕГО КРАЯ каркаса, а не от вьюпорта: список `[[` всплывал
 * не у каретки, а ниже (у «Дневника» каркас начинается на ~127px ниже тулбара)
 * и мог уходить за нижний край окна.
 *
 * Лечение — вынести контейнер тултипов порталом в `document.body`
 * (`tooltips({ parent: document.body })` в `mdEditorExtensions`): `body` не
 * несёт контейнмент, fixed-координаты снова отсчитываются от вьюпорта.
 *
 * Портал же вскрыл вторую проблему (блокер приёмки): базовый стиль CM6 держит
 * `.cm-tooltip { z-index: 500 }` (baseTheme), а `.dialog-backdrop` диалогов
 * стоит на `z-index: 900` — тултип `[[` в md-полях ВНУТРИ диалогов (шаблон
 * типа мысли, markdown-поля настроек) уходил ПОД подложку. Проектная конвенция
 * для body-mounted попапов — `z-index: 950` (`.type-combo-list`,
 * type-combobox.css, «above the dialog stack»). Тема редактора (`mdTheme`)
 * монтируется после baseTheme (`Prec.lowest`), поэтому её правило
 * `.cm-tooltip { z-index: 950 }` перекрывает базовый z-index.
 *
 * Реальный поведенческий тест без DOM невозможен (тултип требует живого
 * `EditorView` и раскладки), поэтому контракт зафиксирован сторожем исходника
 * — по образцу `guard-wiki-link-validfor`. Живая проверка геометрии/стека —
 * за прогоном на скрытом GUI-стенде.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const MD_EDITOR = path.resolve(here, '..', 'src', 'renderer', 'editor', 'md-editor.ts');
const DIALOGS_CSS = path.resolve(here, '..', 'src', 'renderer', 'styles', 'dialogs.css');

/** z-index диалоговой подложки из общего стиля — не хардкод, а чтение источника. */
function dialogBackdropZ(): number {
  const css = fs.readFileSync(DIALOGS_CSS, 'utf8');
  const block = css.match(/\.dialog-backdrop\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(block, 'не найден блок .dialog-backdrop в dialogs.css');
  const z = block.match(/z-index:\s*(\d+)/)?.[1];
  assert.ok(z, 'у .dialog-backdrop нет z-index');
  return Number(z);
}

/** z-index, которым mdTheme перекрывает `.cm-tooltip`. */
function mdTooltipZ(): number {
  const src = fs.readFileSync(MD_EDITOR, 'utf8');
  const block = src.match(/\.cm-tooltip'\s*:\s*\{([\s\S]*?)\n\s*\},/)?.[1];
  assert.ok(block, 'в mdTheme не найден блок .cm-tooltip');
  const z = block.match(/zIndex:\s*'?(\d+)'?/)?.[1];
  assert.ok(z, 'mdTheme не задаёт z-index для .cm-tooltip');
  return Number(z);
}

describe('guard: тултипы markdown-редактора вне контейнмент-каркасов', () => {
  it('mdEditorExtensions порталит тултипы в document.body', () => {
    const text = fs.readFileSync(MD_EDITOR, 'utf8');
    assert.match(
      text,
      /tooltips\(\{\s*parent:\s*document\.body\s*\}\)/,
      'тултипы CM6 обязаны порталиться в body — иначе container-type каркаса ' +
        'уводит список [[ от каретки (ошибка 7aee1df3)',
    );
  });

  it('z-index .cm-tooltip выше диалоговой подложки', () => {
    const tooltipZ = mdTooltipZ();
    const backdropZ = dialogBackdropZ();
    assert.ok(
      tooltipZ > backdropZ,
      `тема редактора обязана держать .cm-tooltip выше подложки диалога: ` +
        `тултип ${tooltipZ} должен быть > .dialog-backdrop ${backdropZ}, ` +
        'иначе [[ -автокомплит в диалогах уходит под подложку (ошибка 7aee1df3)',
    );
    assert.ok(
      tooltipZ >= 950,
      `body-mounted попапы держат z-index 950 (type-combobox.css, ` +
        `«above the dialog stack»), получено ${tooltipZ}`,
    );
  });
});
