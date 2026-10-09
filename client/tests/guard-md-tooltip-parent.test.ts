/**
 * Сторож портала тултипов markdown-редактора (ошибка
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
 * несёт контейнмент, fixed-координаты снова отсчитываются от вьюпорта. Тема
 * переносится самим CM6 (контейнер несёт `themeClasses` редактора).
 *
 * Реальный поведенческий тест без DOM невозможен (тултип требует живого
 * `EditorView` и раскладки), поэтому контракт зафиксирован сторожем исходника
 * — по образцу `guard-wiki-link-validfor`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const MD_EDITOR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
  'editor',
  'md-editor.ts',
);

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
});
