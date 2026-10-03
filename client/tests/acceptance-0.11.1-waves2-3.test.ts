/**
 * Сторож замечаний визуальной приёмки 0.11.1, волны 2 и 3 (задачи 7cfaba7c и
 * 77cce0ba) — структурные проверки разметки, CSS и словаря там, где поведение
 * уже покрыто юнит-тестами ядра (нумерация, фокус комментария).
 *
 * Входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');
const read = (...parts: string[]): string => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const WS = read('screens', 'publications', 'workspace.ts');
const WIZ = read('screens', 'publications', 'wizard.ts');
const RECIPE = read('screens', 'publications', 'recipe.ts');
const PUBL = read('screens', 'publications', 'publications.ts');
const PROPMGR = read('screens', 'property-manager.ts');
const DIALOG_CM = read('canvas', 'context-menu.ts');
const CSS = read('styles', 'screens', 'publications.css');
const RU = read('lib', 'locales', 'ru.ts');

describe('7cfaba7c п.1: мастер создания — только титульные данные, без вкладок', () => {
  it('диалог без вкладок, контент — тело «Название»', () => {
    assert.ok(!WIZ.includes('tabs:'), 'вкладок в мастере больше нет');
    assert.match(WIZ, /body:\s*metaBody/, 'контент диалога — титульные поля');
    assert.ok(!WIZ.includes('buildRecipeBuilder'), 'шаг рецепта убран');
    assert.ok(!WIZ.includes('buildEntityChipField'), 'шаг свойств текстов убран');
  });
});

describe('7cfaba7c п.2: пустой отбор — пустое состояние с подсказкой', () => {
  it('клиент читает серверный маркер и показывает подсказку', () => {
    assert.match(WS, /PUBLICATION_EMPTY_RECIPE_WARNING/, 'маркер предупреждения сборки');
    assert.match(WS, /emptyState\(\{ title: t\('publications\.ws\.emptyRecipe'\)/, 'подсказка пустого отбора');
    assert.ok(RU.includes("'publications.ws.emptyRecipe'"), 'строка словаря есть');
  });
});

describe('7cfaba7c п.3: варианты свойств показывают стороны', () => {
  it('вариант на КАЖДУЮ сторону + каноническое имя чипа', () => {
    assert.match(RECIPE, /linkPropertyEntityOptions\(listRows\)/, 'строки на стороны связи');
    assert.match(RECIPE, /export function propertyChipTitles/, 'карта канонических имён чипа');
    assert.match(
      RECIPE,
      /linkEndIconSpec\(row\.side \?\? 'source', row\.visual\)/,
      'значок направления стороны в варианте',
    );
  });
});

describe('7cfaba7c п.4: контекстное меню «В публикации»', () => {
  it('раздельные команды раздела и без общего подменю «Добавить»', () => {
    assert.match(WS, /createChild\(block\.parentThoughtId, 'section'\)/, 'раздел на этом уровне — родитель блока');
    assert.match(WS, /createChild\(block\.thoughtId, 'section'\)/, 'подчинённый раздел — сам блок');
    assert.match(WS, /hideAddCommand:\s*true/, 'общее подменю «Добавить» скрыто');
    assert.match(DIALOG_CM, /hideAddCommand/, 'опция прокинута в общий конструктор меню');
    assert.ok(RU.includes("'publications.block.addSectionSibling'"), 'строка «на этом уровне»');
    assert.ok(RU.includes("'publications.block.addSectionChild'"), 'строка «подчинённый раздел»');
  });
});

describe('77cce0ba п.1 (волна 3): фон области чтения следует слою', () => {
  it('.pub-ws-host полотно берёт --layer-bg', () => {
    assert.match(
      CSS,
      /\.pub-ws-host\s*\{[^}]*background:\s*var\(--layer-bg,\s*var\(--bg\)\)/s,
      'область чтения тоже следует фону активного слоя',
    );
  });
});

describe('77cce0ba п.2 (волна 3): подсветка открытой в редакторе мысли', () => {
  it('текущий блок — пунктир, открытый в редакторе — сплошная рамка фокуса', () => {
    assert.match(CSS, /\.pub-doc-current\s*\{[^}]*outline:\s*2px dashed/s, 'текущий — пунктир');
    assert.match(
      CSS,
      /\.pub-doc-editor\s*\{[^}]*outline:\s*2px solid var\(--layer-focus-stripe,\s*var\(--accent\)\)/s,
      'открытый в редакторе — сплошная рамка фокуса',
    );
    assert.match(WS, /function paintEditorHighlight\(\)/, 'подсветка пересчитывается');
    assert.match(WS, /store\.subscribe\(paintEditorHighlight\)/, 'реагирует на смену цели редактора');
    assert.match(WS, /editorHighlightUnsub\(\)/, 'подписка снимается при разборе');
  });
});

describe('77cce0ba п.4 (волна 3): тосты экспорта', () => {
  it('успех с путём и сбой с причиной — тостами', () => {
    assert.match(PUBL, /notice\(t\('publications\.export\.saved'/, 'тост успеха');
    assert.match(PUBL, /notice\(t\('publications\.export\.failed/, 'тост сбоя');
    assert.match(PUBL, /result\.cancelled\) return/, 'отмена диалога — не событие');
    assert.ok(RU.includes("'publications.export.saved'"), 'строка успеха');
    assert.ok(RU.includes("'publications.export.saveFailed'"), 'строка сбоя сохранения');
  });
});

describe('77cce0ba п.5 (волна 3): вид значения «Публикация» в списке', () => {
  it('публикация доступна в выборе видов значения', () => {
    assert.match(
      PROPMGR,
      /const SELECTABLE_VALUE_TYPES: PropertyValueType\[\] = \[[^\]]*'publication'/s,
      "вид 'publication' в списке выбора",
    );
  });
});
