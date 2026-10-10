/**
 * Сторож всплывающих панелей `lib/ui` (задача dd1f47d4, требование f74f1aae
 * «Всплывающий предпросмотр — общий компонент lib/ui», ADR 03eb2c61,
 * инвентаризация 3fc7c54d — «Popover (закрываемый кликом вне)»).
 *
 * Правило: всплывающая панель и её механика (оформление, позиционирование,
 * закрытие кликом вне) живут только в компоненте `lib/ui/popover.ts`;
 * потребители (движки) вызывают {@link openPopover} / берут чистую геометрию.
 * Каждый запрет ловится обычным прогоном `npm -w @etn/client test`.
 *
 * Запрещено вне `lib/ui/`:
 *   1. классы панели (`ui-popover`, `ui-popover-head`, `ui-popover-body` и
 *      упразднённые `hover-preview-popup`/`hp-body`/`hp-head`) — панель
 *      собирает `openPopover`;
 *   2. прямые делегированные слушатели «клик вне» (`pointerdown`/`mousedown`
 *      на `document`/`window`) и capture-слушатели `click` на них — закрытие
 *      кликом вне делает компонент;
 *   3. ручная расстановка хвостика панели (`--hp-arrow-left`) — её задаёт
 *      компонент (`--ui-popover-arrow-left`).
 *
 * **Allow-края.** Уже существующие механики закрытия кликом вне, не
 * переведённые на компонент этой задачей (граница задачи: вторая поповерная
 * механика не расширяется), остаются как есть — с обоснованием:
 *   • `search/search.ts` — панель результатов/настроек поиска (фундамент
 *     строки поиска, отдельная механика с исключениями подсказок и диалогов);
 *   • `lib/menu.ts` — контекстное меню (единый модуль меню, задача меню карты
 *     — T9);
 *   • `lib/suggest-dropdown.ts` — выпадашка подсказок (свой жизненный цикл
 *     под полем, поглощается списками этапа 2);
 *   • `screens/tabs/tab-overflow.ts` — список переполнения вкладок (часть
 *     механизма вкладок).
 * Их перевод — отдельные задачи; список закрыт, новый слушатель в обход
 * компонента сторож не пропустит.
 *
 * Строки-комментарии правилами не считаются (в пояснениях имена классов
 * допустимы).
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { assertGuardClean, type GuardRule } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Уже существующие механики закрытия кликом вне (см. обоснование в шапке). */
const ALLOW_OUTSIDE_CLICK = new Set([
  'search/search.ts',
  'lib/menu.ts',
  'lib/suggest-dropdown.ts',
  'screens/tabs/tab-overflow.ts',
]);

/** Строка — комментарий? (в пояснениях имена классов/переменных допустимы). */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Исходник без комментариев. Подстрочная проверка проводки не должна «видеть»
 * вызовы в закомментированном коде (`// attachOutsidePointer();` — не проводка).
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** Общее для всех правил: не `lib/ui`, не комментарий. */
function outsideFacades(rel: string, line: string): boolean {
  return isComment(line) || rel.startsWith('lib/ui/');
}

/** Allow-край правил о «клике вне»: известные движки (кроме комментариев). */
function allowedOutsideClick(rel: string, line: string): boolean {
  return isComment(line) || ALLOW_OUTSIDE_CLICK.has(rel);
}

function rules(): GuardRule[] {
  return [
    {
      name: 'no-own-popover-panel',
      description: 'Панель всплывающего слоя собирает openPopover (классы ui-popover*).',
      pattern:
        /['"](?:ui-popover|ui-popover-head|ui-popover-body|hover-preview-popup|hp-body|hp-head)['"]/,
      allow: outsideFacades,
    },
    {
      name: 'no-pointerdown-outside-click',
      description:
        'Делегированный слушатель «клик вне» (pointerdown/mousedown на document/window) — только через компонент lib/ui/popover.',
      pattern: /(?:document|window)\.addEventListener\(\s*['"](?:pointerdown|mousedown)['"]/,
      allow: allowedOutsideClick,
    },
    {
      name: 'no-capture-click-outside',
      description:
        'Capture-слушатель click на document/window («клик вне») — только через компонент lib/ui/popover.',
      pattern: /(?:document|window)\.addEventListener\(\s*['"]click['"][^\n]*,\s*true\s*\)/,
      allow: allowedOutsideClick,
    },
    {
      name: 'no-manual-popover-arrow',
      description:
        'Смещение хвостика панели задаёт компонент (--ui-popover-arrow-left), не прикладной код.',
      pattern: /--hp-arrow-left/,
      allow: outsideFacades,
    },
  ];
}

describe('guard: всплывающая панель lib/ui', () => {
  it('панель и её механика — только через компонент lib/ui/popover', () => {
    assertGuardClean(RENDERER_ROOT, rules());
  });

  it('поле комментария проводит «клик вне» через компонент, а не своим слушателем', () => {
    // Обратный регресс: поле обязано ставить/снимать «клик вне» через
    // `watchOutsideTap` при входе/выходе из правки. Отключение проводки
    // (attachOutsidePointer/detachOutsidePointer) краснит этот тест
    // (ошибка e2c6c66c, раунд 2). Комментарии вычищаются: закомментированный
    // вызов проводкой не считается.
    const raw = fs.readFileSync(path.join(RENDERER_ROOT, 'editor', 'markdown-field.ts'), 'utf8');
    const src = stripComments(raw);
    assert.doesNotMatch(
      stripComments('// attachOutsidePointer();\n/* watchOutsideTap(x, y) */'),
      /attachOutsidePointer\(\)|watchOutsideTap\(/,
      'вычистка комментариев работает — закомментированная проводка не засчитывается',
    );
    assert.match(
      src,
      /stopOutsideTap\s*=\s*watchOutsideTap\(/,
      '«клик вне» проводят через lib/ui watchOutsideTap',
    );
    assert.match(src, /attachOutsidePointer\(\)/, 'вход в правку ставит слушатель клика вне');
    assert.match(src, /detachOutsidePointer\(\)/, 'выход из правки снимает слушатель клика вне');
    assert.match(src, /const showEdit = [\s\S]*?attachOutsidePointer\(\)/, 'проводка — в showEdit');
  });
});
