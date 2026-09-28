/**
 * Регресс-тесты диалогов списков/типов после ошибки d866bc65 «Список типов
 * мыслей: перенос, мелкие треугольники, наезд колонок, узкая форма» и ошибки
 * 57e05439 «Диалог создания слоя мал».
 *
 * Проверяется рендер исходников (тесты клиента идут без DOM, конвенция
 * соседних тестов — якоря исходника):
 *   1. Дерево типов мыслей и типов связей открывается широкой ролью `l`
 *      (требование 13464c39): три колонки читаются без наезда.
 *   2. Подпись строки дерева несёт словарный класс `.ui-tree-label` и полный
 *      текст в подсказке `title` (без переноса, обрезка многоточием — CSS
 *      `lib/ui/tree.css`, сторож `guard-ui-tree.test.ts`).
 *   3. Диалоги слоя (создание/свойства) используют роль `m` и ставят парные
 *      цветовые поля на одну строку (`.layer-colors-row`), чтобы содержимое
 *      помещалось без прокрутки (ошибка 57e05439).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

const read = (rel: string): string => readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');

describe('диалоги типов: широкая роль и подпись-подсказка (d866bc65)', () => {
  it('объединённый каталог типов и свойств: роль l и дерево с полной подписью', () => {
    // С 0.10.2 (задача 979761cd) три списка — вкладки одного диалога; широкую
    // роль l несёт он (панели роли не задают).
    const src = read('screens/type-catalogue.ts');
    assert.match(
      src,
      /title:\s*t\('catalogue\.title'\)[\s\S]{0,400}?size:\s*'l'/,
      'объединённый диалог каталога обязан использовать широкую роль l',
    );
    const tt = read('screens/type-manager.ts');
    assert.match(tt, /TREE_LABEL_CLASS/, 'подпись строки типа мысли обязана нести .ui-tree-label');
    assert.match(tt, /name\.title = item\.type\.name/, 'подпись строки обязана давать title');
    const pm = read('screens/property-manager.ts');
    assert.match(pm, /TREE_LABEL_CLASS/, 'подпись строки типа связи обязана нести .ui-tree-label');
    assert.match(pm, /label\.title =/, 'подпись строки обязана давать title');
  });
});

describe('диалоги слоя: роль m и цвета в одну строку (57e05439)', () => {
  it('создание слоя — роль m', () => {
    const src = read('screens/layers.ts');
    assert.match(
      src,
      /title:\s*'Новый слой изменений',[\s\S]{0,200}?size:\s*'m'/,
      'диалог создания слоя обязан использовать роль m без прокрутки',
    );
  });

  it('свойства слоя — роль m и парные цвета на одной строке', () => {
    const src = read('screens/layers.ts');
    assert.match(
      src,
      /Свойства слоя[\s\S]{0,400}?size:\s*'m'/,
      'диалог свойств слоя обязан использовать роль m без прокрутки',
    );
    assert.match(
      src,
      /div\('form-row two-col-row layer-colors-row'\)/,
      'парные цветовые поля обязаны идти одной строкой',
    );
  });
});
