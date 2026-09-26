/**
 * Сторож стандарта «Клиент: выбор сущности — только через общий пикер» (S3,
 * задача a1f5141b вехи 3 версии 0.8.2; ADR «выбор сущности — один пикер на
 * типы мыслей, типы связей и мысли»).
 *
 * Правила:
 * 1. `<select>` из типов мыслей или типов связей не собирается вне пикера:
 *    чтение каталога (`store.state.thoughtTypes` / `store.state.linkTypes`)
 *    или дерева типов (`orderedTypeRows(store.state…`), за которым в пределах
 *    окна следует создание `<option>` — признак ручной сборки выпадающего
 *    списка из каталога. Такие списки строит только
 *    `lib/entity-picker.ts` (встроенное комбо — через общую выпадашку).
 * 2. Новый модальный чек-лист выбора сущностей не пишется вне пикера:
 *    классы чек-листа пикера (`st-f-checks` / `st-f-check`) встречаются
 *    только в `lib/entity-picker.ts`.
 * 3. Строка списка типов (`type-combo-item`) собирается только общим
 *    модулем выпадашки `lib/suggest-dropdown.ts`: оба пикера (общее комбо и
 *    прежний `type-combobox`) обязаны делегировать строки ему, а не рисовать
 *    собственную копию (задача ae0d4ffb, веха 3 версии 0.8.2).
 * 4. Рамка поля ОДИНОЧНОГО выбора сущности (`entity-combo-field`) собирается
 *    только `lib/entity-picker.ts`: собственное поле выбора типа мысли/связи
 *    вне общего компонента — это второй ввод рядом с облачком значения
 *    (баг ba2f57d3).
 *
 * Сторож вводится зелёным — в том же изменении, которое переводит все
 * модальные чек-листы типов и голые `<select>` на общий пикер
 * (мета-стандарт «Правило без теста-сторожа не считается введённым»).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, collectViolations, DEFAULT_GUARD_EXTENSIONS, type GuardRule } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/** Максимальный разрыв между чтением каталога типов и созданием `<option>`:
 *  дальше конструкция уже не «сборка списка из каталога». */
const SELECT_FROM_CATALOGUE_WINDOW = 1500;

/** Строка списка типов (`type-combo-item`) собирается только общим модулем
 *  выпадашки: `div`/`el` с этим классом (класс может быть с доп. токенами),
 *  первым или вторым аргументом. */
const ITEM_BUILD_RULE: GuardRule = {
  name: 'no-own-type-combo-item',
  description:
    'Строка списка типов (класс type-combo-item) собирается только общим модулем ' +
    'выпадашки lib/suggest-dropdown.ts: собственная копия строки каталога вне него ' +
    'запрещена (S3, ADR «одна выпадашка-подсказчик»).',
  pattern: /\b(?:div|el)\(\s*(?:'(?:[^'\\]|\\.)*'\s*,\s*)?'[^']*\btype-combo-item\b/,
  allow: (rel) => rel === 'lib/suggest-dropdown.ts',
};

/** Рамка поля ОДИНОЧНОГО выбора сущности (`entity-combo-field`) собирается
 *  только общим пикером: собственная копия поля выбора типа мысли/связи вне
 *  него — это второй ввод рядом с облачком значения (баг ba2f57d3). */
const FIELD_BUILD_RULE: GuardRule = {
  name: 'no-own-entity-combo-field',
  description:
    'Рамка поля одиночного выбора сущности (класс entity-combo-field) собирается ' +
    'только общим пикером lib/entity-picker.ts: собственная копия поля выбора типа ' +
    'мысли/связи вне него запрещена (баг ba2f57d3, ADR «выбор сущности — один пикер ' +
    'на типы мыслей, типы связей и мысли»).',
  pattern: /\b(?:div|el)\(\s*(?:'(?:[^'\\]|\\.)*'\s*,\s*)?'[^']*\bentity-combo-field\b/,
  allow: (rel) => rel === 'lib/entity-picker.ts',
};

/** Классы поглощённого поля свойства-связи (`lib/link-property-field.ts`)
 *  запрещены: поле выбора свойства-связи строит только четвёртый источник
 *  общего пикера — та же рамка, что у поля «Тип мысли» (требование cdb6b52f,
 *  ошибка a7abe50e). Хвост `(?![\w.])` не даёт правилу ловить упоминание
 *  удалённого модуля `…-field.ts` в комментариях. */
const LEGACY_LINK_PROPERTY_RULE: GuardRule = {
  name: 'no-legacy-link-property-classes',
  description:
    'Классы прежнего отдельного поля свойства-связи (link-property-field/-input/-pick/' +
    '-picker/-option/-empty/-search) запрещены: поле строит только общий пикер ' +
    'lib/entity-picker.ts (требование cdb6b52f, ошибка a7abe50e).',
  pattern: /\blink-property-(?:field|input|pick|picker|option|empty|search)(?![\w.])/,
};

/** Расширения сканирования с CSS: классы-самоделки могут жить в стилях. */
const GUARD_EXTENSIONS_WITH_CSS = [...DEFAULT_GUARD_EXTENSIONS, '.css'];

describe('guard: выбор сущности делается только общим пикером', () => {
  it('<select> не собирается из типов мыслей или типов связей', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-type-select',
        description:
          'Сборка <select> из каталога типов (store.state.thoughtTypes/linkTypes ' +
          'или orderedTypeRows(store.state…)) запрещена: такие списки строит только ' +
          'lib/entity-picker.ts (S3).',
        filePattern: new RegExp(
          `store\\.state\\.(?:thoughtTypes|linkTypes)[\\s\\S]{0,${SELECT_FROM_CATALOGUE_WINDOW}}?el\\(\\s*['"]option['"]`,
          'g',
        ),
      },
      {
        name: 'no-type-select-tree',
        description:
          'Сборка <select> из дерева типов (orderedTypeRows(store.state…)) запрещена: ' +
          'иерархию строит lib/type-tree.ts, список — lib/entity-picker.ts (S3).',
        filePattern: new RegExp(
          `orderedTypeRows\\(\\s*store\\.state\\.[\\s\\S]{0,${SELECT_FROM_CATALOGUE_WINDOW}}?el\\(\\s*['"]option['"]`,
          'g',
        ),
      },
    ]);
  });

  it('модальный чек-лист выбора сущностей не пишется вне пикера', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-modal-checklist',
        description:
          'Классы чек-листа пикера (st-f-checks/st-f-check) встречаются только в ' +
          'lib/entity-picker.ts: новый модальный чек-лист выбора сущностей вне пикера ' +
          'запрещён (S3).',
        pattern: /\bst-f-checks?\b/,
        allow: (rel) => rel === 'lib/entity-picker.ts',
      },
    ]);
  });

  it('строка списка типов собирается только общим модулем выпадашки', () => {
    assertGuardClean(RENDERER_ROOT, [ITEM_BUILD_RULE]);
  });

  it('рамка поля одиночного выбора сущности собирается только общим пикером', () => {
    assertGuardClean(RENDERER_ROOT, [FIELD_BUILD_RULE]);
  });

  it('поле выбора свойства-связи — только общий пикер, прежних классов нет', () => {
    // Четвёртый источник («свойство связи») — в том же комбо; отдельного поля
    // и его классов (`link-property-field/-input/-pick/-option/…`) нет нигде,
    // включая styles.css (требование cdb6b52f, ошибка a7abe50e).
    assertGuardClean(RENDERER_ROOT, [LEGACY_LINK_PROPERTY_RULE], {
      extensions: GUARD_EXTENSIONS_WITH_CSS,
    });
  });

  it('модуль отдельного поля свойства-связи удалён', () => {
    const legacy = path.join(RENDERER_ROOT, 'lib', 'link-property-field.ts');
    assert.equal(
      fs.existsSync(legacy),
      false,
      'lib/link-property-field.ts удалён: поле поглощено четвёртым источником общего пикера',
    );
  });

  it('правило про классы поля свойства-связи краснеет на умышленной копии', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-picker-'));
    try {
      fs.writeFileSync(path.join(dir, 'fake.css'), '.link-property-field-box { padding: 0 }', 'utf8');
      fs.writeFileSync(
        path.join(dir, 'fake.ts'),
        "import { fieldInput } from './lib/ui/field.js';\nconst i = fieldInput({ extraClass: 'link-property-input' });\nvoid i;",
        'utf8',
      );
      const violations = collectViolations(dir, [LEGACY_LINK_PROPERTY_RULE], {
        extensions: GUARD_EXTENSIONS_WITH_CSS,
      });
      assert.ok(
        violations.some((v) => v.rule === 'no-legacy-link-property-classes'),
        'класс прежнего поля свойства-связи обязан попадать в нарушение',
      );
      // Упоминание удалённого модуля в комментарии нарушением НЕ считается.
      fs.writeFileSync(path.join(dir, 'note.ts'), '// поглощён: lib/link-property-field.ts', 'utf8');
      const clean = collectViolations(dir, [LEGACY_LINK_PROPERTY_RULE], {
        exclude: ['fake.css', 'fake.ts'],
        extensions: GUARD_EXTENSIONS_WITH_CSS,
      });
      assert.equal(clean.length, 0, 'имя удалённого модуля в комментарии — не нарушение');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('чип-поля каталогов фильтруют выпадашку по вводу (ошибка 698800be)', () => {
    // Контракт SuggestSource.load(query) требует, чтобы источник сам сужал
    // список. `loadOptions: () => <полный каталог типов/пользователей>` без
    // параметра query возвращал каталог целиком при любом вводе. Обёртка —
    // filterEntityOptions(options, query) из lib/entity-picker.ts.
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-unfiltered-catalogue-load',
        description:
          'loadOptions чип-поля каталога (типы мыслей/связей, пользователи) обязан ' +
          'принимать query и фильтровать через filterEntityOptions: источник без фильтра ' +
          'показывает весь каталог при любом вводе (ошибка 698800be).',
        pattern:
          /loadOptions:\s*\(\s*\)\s*=>\s*(?:thoughtTypeEntityOptions|linkTypeEntityOptions|usersEntityOptions)\s*\(/,
      },
    ]);
  });

  it('правило про type-combo-item краснеет на умышленно добавленной копии', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-picker-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'fake-combo.ts'),
        [
          "import { div } from './lib/dom.js';",
          "const row = div('type-combo-item');",
          'void row;',
        ].join('\n'),
        'utf8',
      );
      const violations = collectViolations(dir, [ITEM_BUILD_RULE]);
      assert.ok(
        violations.some((v) => v.rule === 'no-own-type-combo-item'),
        'собственная копия строки списка типов обязана попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('правило про entity-combo-field краснеет на умышленно добавленной копии', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-picker-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'fake-field.ts'),
        [
          "import { div } from './lib/dom.js';",
          "const field = div('st-f-chipfield entity-combo-field');",
          'void field;',
        ].join('\n'),
        'utf8',
      );
      const violations = collectViolations(dir, [FIELD_BUILD_RULE]);
      assert.ok(
        violations.some((v) => v.rule === 'no-own-entity-combo-field'),
        'собственная копия рамки поля одиночного выбора обязана попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('правило про нефильтрованный каталог краснеет на loadOptions без query', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-picker-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'fake-load.ts'),
        [
          "import { thoughtTypeEntityOptions } from './lib/entity-picker.js';",
          "import { store } from './state.js';",
          'const opts = { loadOptions: () => thoughtTypeEntityOptions(store.state.thoughtTypes) };',
          'void opts;',
        ].join('\n'),
        'utf8',
      );
      const violations = collectViolations(dir, [
        {
          name: 'no-unfiltered-catalogue-load',
          description: '',
          pattern:
            /loadOptions:\s*\(\s*\)\s*=>\s*(?:thoughtTypeEntityOptions|linkTypeEntityOptions|usersEntityOptions)\s*\(/,
        },
      ]);
      assert.ok(
        violations.some((v) => v.rule === 'no-unfiltered-catalogue-load'),
        'loadOptions без query обязан попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
