/**
 * Строка сохранённых отборов и диалог их выбора (задача 2ebe4206).
 *
 * Контракт: в самом низу панели отбора — строка «имя отбора» + дискета
 * (записать) + крестик (удалить) + «…» (выбрать); список сохранённых отборов
 * открывается диалогом: поиск по именам сверху (правило 1 требования
 * 11ddd910), строка управления «Изменить/Копировать/Удалить» над текущей
 * строкой (правило 2), навигация ↑/↓, клик делает строку текущей,
 * Enter/«Выбрать» применяют, двойной клик открывает редактор, и контекстное
 * меню строки «Переименовать» / «Скопировать»
 * (копия с « (копия)») / «Удалить». «Хроника» работает так же, как «Структуры».
 *
 * Клиентские тесты идут без jsdom (конвенция соседних тестов), поэтому чистая
 * логика проверяется напрямую, а разметка — по якорям исходника.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  duplicateFilterName,
  filterSavedByName,
  moveSavedFilterCursor,
} from '../src/renderer/lib/pure.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');
const BAR_TS = resolve(RENDERER, 'lib', 'saved-filter-bar.ts');
const STRUCTURES_PANEL = resolve(RENDERER, 'screens', 'structures', 'filter-panel.ts');
const CHRONICLE_PANEL = resolve(RENDERER, 'screens', 'chronicle', 'filter-panel.ts');
const ACTIVITY_TS = resolve(RENDERER, 'screens', 'activity', 'activity.ts');
const ICONS_TS = resolve(RENDERER, 'lib', 'icons.ts');

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('поиск и копия сохранённых отборов (чистая логика)', () => {
  const entries = [
    { id: '1', name: 'Мысли о счетах' },
    { id: '2', name: 'Хроника за неделю' },
    { id: '3', name: 'счета клиентов' },
  ];

  it('пустой запрос возвращает весь список', () => {
    assert.equal(filterSavedByName(entries, '').length, 3);
    assert.equal(filterSavedByName(entries, '   ').length, 3);
  });

  it('поиск — по подстроке имени, регистр не важен', () => {
    assert.deepEqual(filterSavedByName(entries, 'СЧЕТ').map((e) => e.id), ['1', '3']);
    assert.deepEqual(filterSavedByName(entries, 'неделю').map((e) => e.id), ['2']);
    assert.deepEqual(filterSavedByName(entries, 'нет такого'), []);
  });

  it('имя копии — « (копия)», при занятости — с номером', () => {
    assert.equal(duplicateFilterName('Отбор', []), 'Отбор (копия)');
    assert.equal(duplicateFilterName('Отбор', ['Отбор (копия)']), 'Отбор (копия 2)');
    assert.equal(
      duplicateFilterName('Отбор', ['ОТБОР (КОПИЯ)', 'отбор (копия 2)']),
      'Отбор (копия 3)',
      'сравнение имён регистронезависимо',
    );
  });

  it('курсор диалога ходит ↑/↓ и зажат в границы', () => {
    assert.equal(moveSavedFilterCursor(0, 3, 1), 1);
    assert.equal(moveSavedFilterCursor(2, 3, 1), 2, 'ниже последней строки не уходит');
    assert.equal(moveSavedFilterCursor(0, 3, -1), 0, 'выше первой строки не уходит');
    assert.equal(moveSavedFilterCursor(1, 0, 1), -1, 'пустой список — курсора нет');
  });
});

describe('строка сохранённых отборов (задача 2ebe4206)', () => {
  it('в строке: поле «имя отбора», дискета, крестик и многоточие', () => {
    const bar = readText(BAR_TS);
    assert.match(bar, /placeholder = 'имя отбора'/, 'поле имени отбора');
    assert.match(bar, /svgIcon\('save', 15\)/, 'кнопка-дискета «записать настройки отбора»');
    assert.match(bar, /svgIcon\('x', 15\)/, 'кнопка-крестик «удалить настройки отбора»');
    assert.match(bar, /class: 'sfb-more',\s*onClick: \(\) => openPicker\(\)/, 'кнопка с многоточием «выбрать отбор»');
    assert.match(bar, /root\.append\(nameWrap, saveBtn, deleteBtn, moreBtn\)/, 'порядок элементов строки');
    const icons = readText(ICONS_TS);
    assert.match(icons, /\n {2}save:/, 'иконка дискеты объявлена в общем наборе иконок');
    assert.match(icons, /\n {2}copy:/, 'иконка копии объявлена в общем наборе иконок');
  });

  it('запись: создаёт отбор, при занятом имени — перезаписывает определение', () => {
    const bar = readText(BAR_TS);
    assert.match(
      bar,
      /const existing = entries\.find\(\(entry\) => entry\.name\.toLowerCase\(\) === name\.toLowerCase\(\)\)/,
      'имя ищется без учёта регистра',
    );
    assert.match(bar, /await opts\.store\.update\(existing\.id, \{ definition \}\)/, 'занятое имя перезаписывает определение');
    assert.match(bar, /await opts\.store\.create\(name, definition\)/, 'свободное имя создаёт отбор');
    assert.match(bar, /notice\('Введите имя отбора'\)/, 'пустое имя не записывается');
  });

  it('ошибка записи видна в UI: диалог ошибки, а не только консоль', () => {
    const bar = readText(BAR_TS);
    assert.match(
      bar,
      /\} catch \(err\) \{\n\s*errorDialog\('Сохранить отбор', err\);\n\s*return;/,
      'сбой create/update показывается диалогом «Сохранить отбор», а не глотается в консоль',
    );
    assert.match(bar, /errorDialog\('Удалить отбор', err\)/, 'сбой удаления показывается диалогом');
    assert.match(bar, /errorDialog\('Переименовать отбор', err\)/, 'сбой переименования показывается диалогом');
    assert.match(bar, /errorDialog\('Скопировать отбор', err\)/, 'сбой копии показывается диалогом');
  });

  it('удаление подтверждается и снимает выбор', () => {
    const bar = readText(BAR_TS);
    assert.match(bar, /await confirmDialog\(\s*'Удалить отбор',/, 'удаление требует подтверждения');
    assert.match(bar, /if \(opts\.selectedId\(\) === entry\.id\) opts\.setSelectedId\(null\)/, 'удалённый отбор снимает выбор');
  });
});

describe('диалог выбора сохранённого отбора (задача 2ebe4206, фасад таблицы — ae76b75e)', () => {
  it('открывается кнопкой «…», вверху — поиск по именам', () => {
    const bar = readText(BAR_TS);
    assert.match(bar, /class: 'sfb-more',\s*onClick: \(\) => openPicker\(\)/, 'кнопка «…» открывает диалог');
    assert.match(bar, /title: t\('savedFilters\.title'\)/, 'заголовок диалога — из словаря');
    assert.match(bar, /search\.placeholder = t\('actions\.search'\)/, 'единый плейсхолдер поиска — вверху списка');
    assert.match(
      bar,
      /body\.append\(search, toolbar, listHost\)/,
      'порядок правила 1–2: поиск, строка управления, список',
    );
    assert.match(bar, /onMount: \(\) => search\.focus\(\)/, 'фокус — в поле поиска');
  });

  it('список — единая таблица фасада: текущая строка, клавиатура, выбор', () => {
    const bar = readText(BAR_TS);
    assert.match(bar, /createTable<SavedFilterEntry>\(\{/, 'список собирает фасад lib/ui/table.ts');
    assert.match(bar, /rowKey: \(entry\) => entry\.id/, 'строка адресуется стабильным id');
    assert.match(bar, /onActivate: \(entry\) => pick\(entry\)/, 'Enter применяет текущую строку (решение)');
    assert.match(
      bar,
      /onDblActivate: \(entry\) => void opts\.onRename\(entry\)\.then\(render\)/,
      'двойной клик открывает редактор строки (переименование), правило 6',
    );
    // Клавиатура — от фасада: стрелки/Enter из поля поиска перенаправляются
    // таблице, чтобы текущая строка была видна.
    assert.match(
      bar,
      /table\.element\.dispatchEvent\(new KeyboardEvent\('keydown', \{ key: event\.key, bubbles: true \}\)\)/,
      'клавиатура поля поиска перенаправляется таблице',
    );
    assert.match(bar, /table\.setRows\(visible\)/, 'перерисовка списка по фильтру');
  });

  it('строка управления над списком: изменить / копировать / удалить текущей', () => {
    const bar = readText(BAR_TS);
    assert.match(bar, /type-list-toolbar sfd-toolbar/, 'под поиском — строка управления');
    assert.ok(bar.includes("t('listActions.edit')"), 'кнопка «Изменить» действует на текущую строку');
    assert.ok(bar.includes("t('listActions.copy')"), 'кнопка «Копировать»');
    assert.match(
      bar,
      /editBtn\.disabled = !has/,
      'кнопки управления гаснут без текущей строки (правило 2)',
    );
    assert.match(
      bar,
      /pendingCurrentId = id/,
      'после копии список позиционируется на новой записи (правило 7)',
    );
  });

  it('футер — решение: «Выбрать» + «Отмена»', () => {
    const bar = readText(BAR_TS);
    assert.match(bar, /label: t\('actions\.select'\)/, 'решение — «Выбрать»');
    assert.match(bar, /label: t\('actions\.cancel'\)/, 'отмена закрывает без выбора');
  });

  it('контекстное меню строки: переименовать / скопировать / удалить', () => {
    const bar = readText(BAR_TS);
    assert.ok(bar.includes("menuAction(t('savedFilters.menu.rename')"), 'команда «Переименовать» — из словаря');
    assert.ok(bar.includes("menuAction(t('savedFilters.menu.copy')"), 'команда «Скопировать» — из словаря');
    assert.ok(bar.includes("t('actions.delete')"), 'команда «Удалить» — из словаря');
    assert.match(bar, /rowMenu: \(entry\) => rowMenu\(entry\)/, 'меню строки собирает словарь lib/menu');
    assert.match(
      bar,
      /await opts\.store\.create\(copyName, entry\.definition\)/,
      'копия создаётся с определением исходного отбора',
    );
    assert.match(bar, /promptDialog\('Переименовать отбор', 'Имя', entry\.name\)/, 'переименование через диалог ввода');
  });

  it('после переименования/копии/удаления диалог перерисовывается на месте', () => {
    const bar = readText(BAR_TS);
    assert.match(bar, /opts\.onRename\(entry\)\.then\(render\)/, 'переименование обновляет список');
    assert.match(bar, /opts\.onCopy\(entry\)\.then\(\(id\) =>/, 'копия обновляет список и позиционируется');
    assert.match(bar, /opts\.onDelete\(entry\)\.then\(opts\.onRefresh\)\.then\(render\)/, 'удаление обновляет список');
  });
});

describe('однообразие: «Хроника» работает с отборами как «Структуры» (задача 2ebe4206)', () => {
  it('обе панели строят строку общим модулем, каждая со своим видом хранилища', () => {
    const structures = readText(STRUCTURES_PANEL);
    const chronicle = readText(CHRONICLE_PANEL);
    assert.match(structures, /buildSavedFilterBar\(\{/, '«Структуры» используют общую строку');
    assert.match(chronicle, /buildSavedFilterBar\(\{/, '«Хроника» использует ту же строку');
    assert.match(structures, /etn\.savedFilters\./, 'хранилище «Структур» — view=structures');
    assert.match(chronicle, /etn\.chronicleFilters\./, 'хранилище «Хроники» — view=chronicle');
    assert.match(structures, /savedBar\.root/, 'строка кладётся в футер панели «Структур»');
    assert.match(chronicle, /savedBar\.root/, 'строка кладётся в футер панели «Хроники»');
  });

  it('своего списка сохранённых отборов у экранов больше нет', () => {
    for (const path of [STRUCTURES_PANEL, CHRONICLE_PANEL]) {
      const src = readText(path);
      assert.ok(!src.includes("'st-f-saved'"), 'свой список сохранённых отборов заменён диалогом общей строки');
      assert.ok(!src.includes("'st-f-savedlist'"), 'свой контейнер списка убран');
    }
  });

  it('«События» строку сохранённых отборов не показывают осознанно', () => {
    // Решение: у «Событий» нет сохранённых отборов ни в спеке, ни на сервере
    // (`SAVED_FILTER_VIEWS = ['structures','chronicle']`). Экран подключает
    // только общий каркас (скрываемость/положение/размер), но не строку.
    const activity = readText(ACTIVITY_TS);
    assert.ok(!activity.includes('buildSavedFilterBar'), 'строка сохранённых отборов «Событиям» не подключена');
    assert.match(activity, /mountFilterPanelFrame\(\{/, 'но общий каркас панели «События» используют');
  });
});
