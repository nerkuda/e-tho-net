/**
 * Тесты записи редактора типа мысли (ошибка 51732f9b «При создании нового
 * типа мысли не доступно добавление отборов»).
 *
 * Что закрепляем:
 *   1. `buildTypePatchInput` — минимальный PATCH существующего типа: оба
 *      способа записи («Записать» и «Применить и закрыть») шлют ОДИН payload,
 *      повторная запись без изменений не пишет ничего (пустой патч), пустые
 *      описание/шаблон нормализуются в `null`.
 *   2. `typeRowRevealIds` — цепочка предков, которую нужно развернуть, чтобы
 *      строка отредактированного типа стала видимой в списке (понятие
 *      «текущая строка»).
 *   3. Структурные якоря `type-manager.ts`: кнопка «Записать» стоит между
 *      «Отмена» и «Применить и закрыть», записывает без закрытия диалога
 *      (`apply('stay', …)`) и после успешной записи обновляет содержимое
 *      (вкладка «Отборы», метаданные, шапка), а список типов делает строку
 *      записанного типа текущей (`currentRowId`, класс `selected`).
 *
 * Чистая логика + структурные проверки — без jsdom, по принятому в клиенте
 * соглашению (см. `type-manager-name-sync.test.ts`, `type-editor-tabs.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { ThoughtType } from '@etn/shared';

import {
  buildTypePatchInput,
  typeRowRevealIds,
  type ThoughtTypeDraft,
} from '../src/renderer/screens/type-manager.js';

const SOURCE_PATH = resolve(
  import.meta.dirname,
  '..',
  'src',
  'renderer',
  'screens',
  'type-manager.ts',
);

function source(): string {
  return readFileSync(SOURCE_PATH, 'utf8');
}

function thoughtType(overrides: Partial<ThoughtType> = {}): ThoughtType {
  return {
    id: 'tt-1',
    name: 'Тип',
    parent_id: null,
    is_root: false,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    comment_template_md: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u-1',
    ...overrides,
  };
}

function draft(overrides: Partial<ThoughtTypeDraft> = {}): ThoughtTypeDraft {
  return {
    name: 'Тип',
    parent_id: null,
    description: '',
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    ...overrides,
  };
}

describe('buildTypePatchInput — запись редактора типа (51732f9b)', () => {
  it('без изменений патч пуст: повторная запись ничего не шлёт', () => {
    const current = thoughtType({ name: 'Тип', description: 'описание' });
    assert.deepEqual(
      buildTypePatchInput(current, draft({ name: 'Тип', description: 'описание' }), 'описание', null),
      {},
    );
  });

  it('уходит только то, что изменилось (имя, описание, родитель, оформление)', () => {
    const current = thoughtType({ name: 'Старое', parent_id: null, description: 'было' });
    const patch = buildTypePatchInput(
      current,
      draft({
        name: 'Новое',
        parent_id: 'parent-1',
        fg_color: '#ff0000',
        font_bold: true,
      }),
      'стало',
      null,
    );
    assert.deepEqual(patch, {
      name: 'Новое',
      parent_id: 'parent-1',
      fg_color: '#ff0000',
      font_bold: true,
      description: 'стало',
    });
  });

  it('очистка описания и шаблона шлёт null (значение снимается)', () => {
    const current = thoughtType({ description: 'было', comment_template_md: '## Шаблон' });
    assert.deepEqual(
      buildTypePatchInput(current, draft({ description: '' }), '', null),
      { description: null, comment_template_md: null },
    );
  });

  it('иконка уходит парой icon + icon_kind', () => {
    const current = thoughtType();
    assert.deepEqual(
      buildTypePatchInput(current, draft({ icon: '🦀', icon_kind: 'emoji' }), '', null),
      { icon: '🦀', icon_kind: 'emoji' },
    );
  });

  it('после применения патча повторный вызов пуст — запись идемпотентна', () => {
    const current = thoughtType({ name: 'Тип', description: null });
    const next = thoughtType({ ...current, description: 'новое' });
    buildTypePatchInput(current, draft({ description: 'новое' }), 'новое', null); // первый раз — правка
    assert.deepEqual(
      buildTypePatchInput(next, draft({ description: 'новое' }), 'новое', null),
      {},
      'после сохранённого изменения повторная запись не должна слать патч',
    );
  });
});

describe('typeRowRevealIds — текущая строка списка типов (51732f9b)', () => {
  const root = thoughtType({ id: 'root', name: 'Основной', is_root: true, parent_id: null });
  const parent = thoughtType({ id: 'a', name: 'A', parent_id: 'root' });
  const child = thoughtType({ id: 'b', name: 'B', parent_id: 'a' });
  const types = [root, parent, child];

  it('вложенный тип: разворачивается вся цепочка предков, сам тип — нет', () => {
    assert.deepEqual(typeRowRevealIds(types, 'b'), ['a', 'root']);
  });

  it('тип у корня: раскрывать нечего', () => {
    assert.deepEqual(typeRowRevealIds(types, 'a'), ['root']);
  });

  it('корневой тип и пустой id: пустой список', () => {
    assert.deepEqual(typeRowRevealIds(types, 'root'), []);
    assert.deepEqual(typeRowRevealIds(types, null), []);
  });

  it('неизвестный тип: пустой список (список не разворачивается зря)', () => {
    assert.deepEqual(typeRowRevealIds(types, 'нет-такого'), []);
  });
});

describe('type-manager — кнопка записи без закрытия (бывш. «Записать») и текущая строка (51732f9b)', () => {
  it('кнопка записи без закрытия объявлена между «Отмена» и «Применить и закрыть»', () => {
    const src = source();
    const applyIdx = src.indexOf("t('actions.applyClose')");
    assert.ok(applyIdx > 0, 'кнопка «Применить и закрыть» не найдена');
    const cancelIdx = src.lastIndexOf("t('actions.cancel')", applyIdx);
    const saveIdx = src.lastIndexOf("t('actions.apply')", applyIdx);
    assert.ok(cancelIdx > 0, 'кнопка «Отмена» не найдена');
    assert.ok(saveIdx > cancelIdx, 'кнопка записи без закрытия не найдена');
    assert.ok(
      cancelIdx < saveIdx && saveIdx < applyIdx,
      'кнопка записи без закрытия должна стоять между «Отмена» и «Применить и закрыть»',
    );
  });

  it('кнопка записи без закрытия пишет без закрытия диалога (apply(«stay») + keepOpen)', () => {
    const src = source();
    const applyIdx = src.indexOf("t('actions.applyClose')");
    const saveIdx = src.lastIndexOf("t('actions.apply')", applyIdx);
    const saveBlock = src.slice(saveIdx, applyIdx);
    assert.ok(saveBlock.includes('keepOpen: true'), 'кнопка записи не должна закрывать диалог');
    assert.ok(
      saveBlock.includes("apply('stay'"),
      'кнопка записи должна вызывать apply в режиме «stay»',
    );
    assert.ok(
      src.slice(applyIdx, applyIdx + 400).includes("apply('close'"),
      '«Применить и закрыть» должна вызывать apply в режиме «close»',
    );
  });

  it('после записи обновляется содержимое диалога и текущая строка списка', () => {
    const src = source();
    assert.ok(src.includes('viewsTab.refresh()'), 'вкладка «Отборы» не перечитывается после записи');
    assert.ok(src.includes('renderMetadataPane()'), '«Метаданные» не обновляются после записи');
    assert.ok(src.includes('syncDialogTitle()'), 'шапка диалога не обновляется после записи');
    assert.ok(src.includes('onChanged(current.id)'), 'список не получает id записанного типа');
  });

  it('список типов ведёт понятие текущей строки', () => {
    const src = source();
    assert.ok(src.includes('currentRowId'), 'нет понятия текущей строки');
    assert.ok(
      src.includes("tr.classList.add('selected')"),
      'текущая строка не подсвечивается классом selected',
    );
    assert.ok(
      src.includes('typeRowRevealIds(types, currentRowId)'),
      'цепочка предков текущей строки не разворачивается',
    );
    assert.ok(src.includes('scrollIntoView'), 'список не прокручивается к текущей строке');
  });
});

describe('type-manager — вкладки несохранённого типа: заглушка и «Сохранить» (e7352642)', () => {
  it('в render() несохранённого типа показана заглушка «Свойства» — таблица не рисуется', () => {
    const src = source();
    // Заглушка идёт через общий хелпер renderNewTypeHint.
    assert.ok(
      src.includes("renderNewTypeHint({"),
      'render() не использует общий хелпер renderNewTypeHint',
    );
    assert.ok(
      src.includes('Сохраните тип, чтобы добавлять свойства'),
      'текст подсказки на «Свойствах» отсутствует или разошёлся',
    );
    // Ветка заглушки на «Свойствах» — ДО отрисовки таблицы «prop-table».
    // В исходнике — `el('table', 'table-list prop-table')` (без префикса
    // `class:` — dom.ts принимает className вторым аргументом).
    const hintIdx = src.indexOf('Сохраните тип, чтобы добавлять свойства');
    const ownTableIdx = src.indexOf("'table-list prop-table'");
    assert.ok(hintIdx > 0 && ownTableIdx > 0 && hintIdx < ownTableIdx, 'заглушка должна быть ДО таблицы');
  });

  it('хелпер renderNewTypeHint экспортируется из lib/type-editor-hints.ts', () => {
    // Заглушка «Свойств» и «Отборов» — один паттерн: файл-helper.
    const helperPath = resolve(
      import.meta.dirname,
      '..',
      'src',
      'renderer',
      'lib',
      'type-editor-hints.ts',
    );
    const helper = readFileSync(helperPath, 'utf8');
    assert.ok(
      helper.includes("export function renderNewTypeHint"),
      'renderNewTypeHint не экспортирован из type-editor-hints.ts',
    );
    assert.ok(
      helper.includes("role: 'primary'"),
      'кнопка «Применить» в хелпере должна нести primary-роль словаря lib/ui',
    );
    assert.ok(
      helper.includes("t('typeEditor.saveHint')"),
      'хелпер должен передавать осмысленный title для кнопки (из словаря)',
    );
  });

  it('в render() несохранённого типа таблица свойств не создаётся — render выходит на заглушке', () => {
    // Ветка: liveTypeId === null → return после renderNewTypeHint.
    const src = source();
    // «return;» внутри render() — есть ДО собственно рендера таблицы.
    const hintBlock = src.match(/if \(liveTypeId === null\)[\s\S]{0,400}?return;/);
    assert.ok(hintBlock !== null, 'в render() должна быть короткая ветка liveTypeId===null → return');
    // После этой ветки идёт отрисовка собственной таблицы (Свойства типа) —
    // убеждаемся, что она НЕ входит в блок раннего return. В исходнике —
    // `el('table', 'table-list prop-table')` (без префикса `class:` — dom.ts
    // принимает className вторым аргументом).
    const ownTableMarker = "'table-list prop-table'";
    const hintEnd = src.indexOf('return;', hintBlock!.index ?? 0);
    const nextTable = src.indexOf(ownTableMarker, hintEnd);
    assert.ok(nextTable > hintEnd, 'таблица свойств рисуется только после выхода из заглушки');
  });

  it('обе вкладки получают onSave — общая команда через apply(\'stay\', …)', () => {
    const src = source();
    // В обе опции пробрасывается `onSave: () => { void apply('stay', () => undefined); }`.
    assert.ok(
      src.includes("onSave: () => {\n      void apply('stay', () => undefined);\n    }"),
      'onSave для props/viewsTab не пробрасывается как общая apply(\'stay\', …)',
    );
  });

  it('liveTypeId обновляется в applyChanges — после записи render() видит реальный id', () => {
    const src = source();
    // В начале applyChanges присваивание liveTypeId = targetId — иначе после
    // первой записи render() остался бы в ветке liveTypeId === null и
    // показал бы заглушку вместо живой таблицы.
    const applyChangesIdx = src.indexOf('async function applyChanges(targetId: string)');
    assert.ok(applyChangesIdx > 0, 'applyChanges не найдена');
    const block = src.slice(applyChangesIdx, applyChangesIdx + 800);
    assert.ok(
      /liveTypeId\s*=\s*targetId/.test(block),
      'applyChanges должен присваивать liveTypeId = targetId в самом начале',
    );
  });

  it('CSS: primary-роль словаря залита акцентом и белым текстом', () => {
    const cssPath = resolve(
      import.meta.dirname,
      '..',
      'src',
      'renderer',
      'lib',
      'ui',
      'button.css',
    );
    const css = readFileSync(cssPath, 'utf8');
    assert.ok(/\.ui-btn--primary\s*\{/.test(css), '.ui-btn--primary не объявлен в lib/ui/button.css');
    assert.ok(/background:\s*var\(--accent\)/.test(css), 'primary-роль должна иметь фон var(--accent)');
    assert.ok(/color:\s*#fff/.test(css), 'primary-роль должна иметь белый текст (#fff)');
  });

  it('регрессия 74d9b4ed: ключ дедупликации нового типа не сломан', () => {
    const src = source();
    assert.ok(
      src.includes("const NEW_THOUGHT_TYPE_DIALOG_KEY = 'thought-type:new'"),
      'сеансовый ключ thought-type:new не найден',
    );
    assert.ok(
      src.includes("id === null ? NEW_THOUGHT_TYPE_DIALOG_KEY : `thought-type:${id}`"),
      'thoughtTypeDialogKey: новая логика дедупликации сломана',
    );
  });
});

describe('thought-type/views-tab — кнопка «Сохранить» в заглушке (e7352642)', () => {
  const SRC_PATH = resolve(
    import.meta.dirname,
    '..',
    'src',
    'renderer',
    'screens',
    'thought-type',
    'views-tab.ts',
  );

  it('BuildViewsTabOpts принимает onSave', () => {
    const src = readFileSync(SRC_PATH, 'utf8');
    // Расстояние от заголовка интерфейса до `onSave?:` большое — комментарий
    // о задаче e7352642 на 5 строк; берём запас 1000 символов.
    assert.ok(
      /BuildViewsTabOpts[\s\S]{0,1000}onSave\?:\s*\(\)\s*=>\s*void/.test(src),
      'BuildViewsTabOpts не объявляет опциональное поле onSave',
    );
  });

  it('renderEmptyTypeHint использует общий renderNewTypeHint (не дублирует разметку)', () => {
    const src = readFileSync(SRC_PATH, 'utf8');
    assert.ok(
      src.includes("renderNewTypeHint({"),
      'renderEmptyTypeHint должен использовать общий хелпер renderNewTypeHint',
    );
    // Подсказка — та же, что была до правки (совместима с регрессией 51732f9b).
    assert.ok(
      src.includes('Сохраните тип, чтобы добавлять отборы'),
      'текст подсказки «Отборов» отсутствует',
    );
  });
});
