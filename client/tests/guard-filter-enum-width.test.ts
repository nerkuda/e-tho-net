/**
 * Сторож перечислений редактора отбора (ошибка 1f3f0df5 «На экране "События"
 * не отображаются значения для отбора "Тип действия"», ревизия № 2 от
 * 2026-10-19: заказчик не принял ни первый, ни второй фикс).
 *
 * Образец — условие «Тип мысли»/«Тип связи», а не свободный чип-редактор
 * значения и не собственный чип-лист: набор перечисления ЗАКРЫТЫЙ, поэтому
 * ячейка строится стандартным `buildEntityChipField` (`lib/entity-picker.ts`):
 * рамка `.entity-chip-field` > `.link-value-wrap` > `.st-f-chipfield`, чипы с
 * крестиками, поле `.entity-chip-input` («Добавить значение…»), угловой «✕»
 * очистки и выпадашка «Значения» с ЧЕКБОКСАМИ; список не закрывается при
 * нескольких отметках, повторная отметка снимает значение.
 *
 * Значение в модели — КОДЫ словаря (`created`/`thought`/`file`), подписи — только
 * отображение. Сторож проверяет: выбор чекбоксом пишет код, снятие чипа/повторная
 * отметка/угловой крестик удаляют код, свободный текст и неизвестный код в AST
 * не попадают; прежних компонентов (`.value-chips-input`, `.ui-chip-list`,
 * «Выбрать значения…») нет; ячейка получает ширину колонки значения.
 *
 * DOM-пробы — на общем `tests/dom-shim.ts` (jsdom в проекте нет), мутации CSS
 * доказывают, что правило ширины краснеет. Входит в обычный
 * `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ShimElement } from './dom-shim.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STYLESHEET = path.join(CLIENT_ROOT, 'src', 'renderer', 'styles', 'filter-tree.css');
const FILTER_VALUE_SRC = path.join(CLIENT_ROOT, 'src', 'renderer', 'lib', 'filter-value.ts');

/** Селектор растяжения ячейки значения с перечислением. */
const ENUM_CELL_SELECTOR = '.ft-row__value .fv:has(> .fv-enum)';
/** Селектор заполнения ширины обёрткой перечисления. */
const ENUM_WRAP_SELECTOR = '.ft-row__value .fv-enum';
/** Селектор снятия пола `.link-value-wrap` в узкой колонке значения. */
const ENUM_WRAP_FIELD_SELECTOR = '.ft-row__value .fv-enum .link-value-wrap';
/** Чип перечисления: компактные зазоры/паддинги. */
const ENUM_CHIP_SELECTOR = '.fv-enum .prop-ref-cloud';
/** Пустой слот значка чипа перечисления — не занимает места. */
const ENUM_CHIP_ICON_SELECTOR = '.fv-enum .prop-ref-cloud .mini-icon:empty';
/** Подпись чипа: ellipsis и сжатие до остатка ширины. */
const ENUM_CHIP_TITLE_SELECTOR = '.fv-enum .prop-ref-cloud .prc-title';
/** Чип-поле перечисления: запас справа под одну угловую кнопку. */
const ENUM_CHIP_FIELD_SELECTOR = '.ft-row__value .fv-enum .link-value-field';

// ---------------------------------------------------------------------------
// CSS: ширина ячейки значения
// ---------------------------------------------------------------------------

interface CssRule {
  readonly selector: string;
  readonly declarations: ReadonlyMap<string, string>;
}

/** Блочные комментарии → пробелы (структура CSS не меняется). */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

/** Разобрать CSS в плоский список правил «селектор → объявления». */
function parseRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(stripComments(css))) !== null) {
    const [, selectors = '', body = ''] = match;
    const declarations = new Map<string, string>();
    for (const decl of body.matchAll(/([a-zA-Z-]+)\s*:\s*([^;]+);?/g)) {
      const [, key = '', rawValue = ''] = decl;
      declarations.set(key.trim().toLowerCase(), rawValue.trim());
    }
    for (const selector of selectors.split(',')) {
      rules.push({ selector: selector.trim(), declarations });
    }
  }
  return rules;
}

/** Объединить объявления набора правил (позднее перекрывает раннее). */
function mergedDeclarations(rules: readonly CssRule[]): Map<string, string> {
  const merged = new Map<string, string>();
  for (const rule of rules) {
    for (const [key, value] of rule.declarations) merged.set(key, value);
  }
  return merged;
}

/** Нормализовать пробелы селектора для сравнения. */
function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, ' ').trim();
}

/** Объявления последнего правила с точным селектором (слияние всех вхождений). */
function declarationsOf(rules: readonly CssRule[], selector: string): Map<string, string> {
  return mergedDeclarations(rules.filter((rule) => normalizeSelector(rule.selector) === selector));
}

/**
 * Нарушения правила ширины ячейки-перечисления. Пустой массив — правило
 * соблюдено.
 */
export function collectEnumWidthViolations(css: string): string[] {
  const violations: string[] = [];
  const rules = parseRules(css);

  // 1. Ячейка `.fv` с перечислением растягивается на ширину колонки значения:
  //    иначе стандартное чип-поле схлопывается при shrink-to-fit.
  const cellRules = rules.filter(
    (rule) => normalizeSelector(rule.selector) === ENUM_CELL_SELECTOR,
  );
  if (cellRules.length === 0) {
    violations.push(`нет правила «${ENUM_CELL_SELECTOR}» — ячейка перечисления не растягивается`);
  } else {
    const cell = mergedDeclarations(cellRules);
    if (cell.get('align-self') !== 'stretch') {
      violations.push(`у «${ENUM_CELL_SELECTOR}» нет align-self: stretch`);
    }
    if (cell.get('min-width') !== '0') {
      violations.push(`у «${ENUM_CELL_SELECTOR}» нет min-width: 0`);
    }
  }

  // 2. Обёртка перечисления заполняет растянутую ячейку целиком.
  const wrapRules = rules.filter(
    (rule) => normalizeSelector(rule.selector) === ENUM_WRAP_SELECTOR,
  );
  if (wrapRules.length === 0) {
    violations.push(`нет правила «${ENUM_WRAP_SELECTOR}» — обёртка не заполняет ширину ячейки`);
  } else {
    const wrap = mergedDeclarations(wrapRules);
    if (wrap.get('width') !== '100%') {
      violations.push(`у «${ENUM_WRAP_SELECTOR}» нет width: 100%`);
    }
    if (wrap.get('min-width') !== '0') {
      violations.push(`у «${ENUM_WRAP_SELECTOR}» нет min-width: 0`);
    }
  }

  // 3. Пол `.link-value-wrap` (220px в `legacy.css`) снят в узкой колонке
  //    значения: иначе стандартное чип-поле выходит за край панели.
  const field = declarationsOf(rules, ENUM_WRAP_FIELD_SELECTOR);
  if (field.size === 0) {
    violations.push(`нет правила «${ENUM_WRAP_FIELD_SELECTOR}» — пол поля не снят`);
  } else if (field.get('min-width') !== '0') {
    violations.push(`у «${ENUM_WRAP_FIELD_SELECTOR}» нет min-width: 0`);
  }

  // 4. Подпись чипа получает остаток ширины в узкой колонке (ревизия № 3):
  //    пустой слот значка скрыт, чип компактнее, поле резервирует место под
  //    ОДНУ угловую кнопку «✕», подпись сжимается с ellipsis.
  const iconSlot = declarationsOf(rules, ENUM_CHIP_ICON_SELECTOR);
  if (iconSlot.get('display') !== 'none') {
    violations.push(
      `«${ENUM_CHIP_ICON_SELECTOR}» не скрывает пустой слот — он съедает ширину подписи`,
    );
  }
  const chip = declarationsOf(rules, ENUM_CHIP_SELECTOR);
  if (chip.size === 0) {
    violations.push(`нет правила «${ENUM_CHIP_SELECTOR}» — чип не приведён к компактному виду`);
  } else if (chip.get('gap') === undefined) {
    violations.push(`у «${ENUM_CHIP_SELECTOR}» не уменьшен зазор (gap)`);
  }
  const chipTitle = declarationsOf(rules, ENUM_CHIP_TITLE_SELECTOR);
  if (chipTitle.get('min-width') !== '0') {
    violations.push(`у «${ENUM_CHIP_TITLE_SELECTOR}» нет min-width: 0 — подпись не сжимается`);
  }
  const chipField = declarationsOf(rules, ENUM_CHIP_FIELD_SELECTOR);
  const padRight = Number.parseFloat(chipField.get('padding-right') ?? '');
  if (!Number.isFinite(padRight) || padRight >= 56) {
    violations.push(
      `у «${ENUM_CHIP_FIELD_SELECTOR}» не снят запас 56px под две угловые кнопки`,
    );
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Исходник: перечисление строит стандартное поле закрытого набора
// ---------------------------------------------------------------------------

/** Исходник без комментариев — проверяются только исполняемые строки. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Тело функции `name` (от сигнатуры до закрывающей строки). */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `ожидалось объявление function ${name}(`);
  const stop = source.indexOf('\n}\n', start);
  assert.ok(stop > start, `${name}: тело не закрыто`);
  return source.slice(start, stop);
}

// ---------------------------------------------------------------------------
// DOM-шим (jsdom в проекте нет — общий `./dom-shim.js`)
// ---------------------------------------------------------------------------

type FilterValueModule = typeof import('../src/renderer/lib/filter-value.js');
type AnyRecord = Record<string, unknown>;

/** Минимальный DOM/window-шим, которого требуют фасады и чип-поле. */
function installShim(): void {
  (globalThis as AnyRecord)['document'] = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelector: () => null,
  };
  const win = ((globalThis as AnyRecord)['window'] ??= {}) as AnyRecord;
  win['innerWidth'] = 1200;
  win['innerHeight'] = 800;
  win['setTimeout'] = (fn: () => void) => {
    fn();
    return 1;
  };
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['matchMedia'] = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  // `window.etn` — контракт preload: чип-поле читает его на этапе сборки.
  win['etn'] = etnStub();
}

/** Разрешающий заглушечный `window.etn`: любой путь — вызываемое значение. */
function etnStub(): unknown {
  const target = async (): Promise<unknown[]> => [];
  return new Proxy(target as unknown as AnyRecord, {
    get: (obj, prop) =>
      prop === 'then'
        ? undefined
        : prop in obj
          ? (obj as AnyRecord)[prop as string]
          : etnStub(),
    apply: () => Promise.resolve([]),
  });
}

installShim();
const mod: FilterValueModule = await import('../src/renderer/lib/filter-value.js');
const { dispatchKeyEvent } = await import('../src/renderer/lib/keymap.js');

/** Все потомки с точным классом. */
function all(root: ShimElement, cls: string): ShimElement[] {
  return root.findAll((node) => node.classList.contains(cls));
}

/** Первый потомок с точным классом. */
function one(root: ShimElement, cls: string): ShimElement | null {
  return all(root, cls)[0] ?? null;
}

/** `<body>` шима — сюда общая выпадашка кладёт список. */
function body(): ShimElement {
  return ((globalThis as AnyRecord)['document'] as AnyRecord)['body'] as ShimElement;
}

/** Строки открытого списка `type-combo-item` (последний список в `<body>`). */
function rows(): ShimElement[] {
  const lists = body().children.filter((child) => child.classList.contains('type-combo-list'));
  const list = lists.at(-1);
  if (list === undefined) return [];
  return list.children.filter((child) => child.classList.contains('type-combo-item'));
}

/** Подпись строки списка (шим не склеивает текст потомков — читаем `label`). */
function rowLabel(row: ShimElement): string {
  return (one(row, 'type-combo-label')?.textContent ?? '').trim();
}

/** Строка списка по подписи. */
function rowByLabel(label: string): ShimElement | undefined {
  return rows().find((row) => rowLabel(row) === label);
}

/** Лист модели: виды вложения (`kind`) — словарь самого модуля. */
function leaf(operator: string, value: unknown = { kind: 'none' }): AnyRecord {
  return { kind: 'leaf', entity: { kind: 'kind' }, operator, value };
}

/** Контекст ячейки значения (сеть и данные каркаса). */
function context(): AnyRecord {
  return {
    networkId: 'net-1',
    profile: 'thoughts',
    data: { registry: new Map(), linkTypes: [], thoughtTypes: [] },
  };
}

/** API слота: запоминает записанные значения. */
function slot(): { api: AnyRecord; writes: unknown[] } {
  const writes: unknown[] = [];
  return {
    api: {
      setValue: (value: unknown) => writes.push(value),
      setStructuralValue: (value: unknown) => writes.push(value),
    },
    writes,
  };
}

/**
 * Собрать ячейку перечисления. Запись значения в шиме «живая»: API слота
 * обновляет лист модели, как настоящий `api.setValue` каркаса — чип-поле
 * перерисовывает чипы из `getValues()` сразу после `onChange`.
 */
function renderEnum(leafNode: AnyRecord, api: AnyRecord): ShimElement {
  const live: AnyRecord = { ...api };
  const write = (value: unknown, via: 'setValue' | 'setStructuralValue'): void => {
    leafNode['value'] = value;
    const fn = api[via];
    if (typeof fn === 'function') (fn as (value: unknown) => void)(value);
  };
  live['setValue'] = (value: unknown) => write(value, 'setValue');
  if (typeof api['setStructuralValue'] === 'function') {
    live['setStructuralValue'] = (value: unknown) => write(value, 'setStructuralValue');
  }
  return mod.renderFilterValue(leafNode as never, live as never, context() as never) as unknown as ShimElement;
}

/** Дать отработать микротаскам выпадашки. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Поле ввода чип-поля. */
function inputOf(root: ShimElement): ShimElement {
  const input = one(root, 'entity-chip-input');
  assert.ok(input !== null, 'поле ввода `.entity-chip-input`');
  return input;
}

/** Открыть выпадашку фокусом на поле (источник вариантов `always`). */
async function openDropdown(root: ShimElement): Promise<void> {
  // Списки прошлых ячеек живут в общем `<body>` шима — снимаем их, чтобы
  // проба читала список ЭТОГО поля.
  body().replaceChildren();
  inputOf(root).emit('focus');
  await flush();
}

/** Клик по строке списка (множественный выбор). */
async function clickRow(label: string): Promise<void> {
  const row = rowByLabel(label);
  assert.ok(row !== undefined, `строка «${label}» в выпадашке`);
  row.emit('click');
  await flush();
}

/** Событие клавиатуры для диспетчера (DOM-шим события не даёт). */
function keyEvent(init: { key: string; code: string }): AnyRecord {
  return {
    key: init.key,
    code: init.code,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  };
}

/** Зафиксировать свободный текст клавиатурной командой поля (Enter). */
async function commitFreeText(root: ShimElement, text: string): Promise<void> {
  const field = one(root, 'st-f-chipfield');
  assert.ok(field !== null, 'рамка чип-поля');
  inputOf(root).value = text;
  field.emit('focusin', {});
  try {
    dispatchKeyEvent(keyEvent({ key: 'Enter', code: 'Enter' }) as never);
  } finally {
    field.emit('focusout', {});
  }
  await flush();
}

// ---------------------------------------------------------------------------
// Проверки
// ---------------------------------------------------------------------------

describe('guard: перечисления редактора отбора — стандартное поле закрытого набора (1f3f0df5)', () => {
  const css = fs.readFileSync(STYLESHEET, 'utf8');
  const source = withoutComments(fs.readFileSync(FILTER_VALUE_SRC, 'utf8'));
  const enumBody = functionBody(source, 'enumControl');

  it('ячейка-перечисление получает ширину колонки значения (нулевых ширин нет)', () => {
    assert.deepEqual(collectEnumWidthViolations(css), []);
  });

  it('правило краснеет, если перечисление перестало растягиваться', () => {
    const withoutCell = css.replace(ENUM_CELL_SELECTOR, '.fv-enum-mutated');
    assert.ok(
      collectEnumWidthViolations(withoutCell).some((v) => v.includes('не растягивается')),
      'без растяжения ячейки чип-поле снова схлопнется',
    );

    const withoutStretch = css.replace(
      /(\.ft-row__value \.fv:has\(> \.fv-enum\)[^{]*\{)([\s\S]*?)(\n\})/,
      (_all, head: string, bodyText: string, tail: string) =>
        `${head}${bodyText.replace(/\s*align-self:\s*stretch;/, '')}${tail}`,
    );
    assert.notEqual(withoutStretch, css, 'мутация обязана менять CSS');
    assert.ok(
      collectEnumWidthViolations(withoutStretch).some((v) => v.includes('align-self: stretch')),
      'потеря align-self: stretch обязана краснеть',
    );
  });

  it('правило краснеет, если обёртка перестала заполнять ширину или вернулся пол 220px', () => {
    const withoutWrap = css.replace(ENUM_WRAP_SELECTOR, '.fv-enum-mutated');
    assert.ok(
      collectEnumWidthViolations(withoutWrap).some((v) => v.includes('не заполняет ширину')),
      'без width: 100% чип-поле не получает ширину колонки',
    );

    const withoutFloor = css.replace(ENUM_WRAP_FIELD_SELECTOR, '.fv-enum-field-mutated');
    assert.ok(
      collectEnumWidthViolations(withoutFloor).some((v) => v.includes('пол поля не снят')),
      'без снятия пола `.link-value-wrap` поле выходит за узкую колонку',
    );
  });

  it('enumControl строит buildEntityChipField закрытого набора, без прежних компонентов', () => {
    assert.ok(enumBody.includes('buildEntityChipField('), 'перечисление — чип-поле закрытого набора');
    assert.ok(enumBody.includes("optionsHeader: 'Значения'"), 'выпадашка — группа «Значения»');
    assert.ok(enumBody.includes('initialOptions'), 'каталог заполняет подписи чипов сразу');
    assert.ok(enumBody.includes('loadOptions'), 'живой поиск по каталогу');
    assert.ok(enumBody.includes('knownCodes.has'), 'в AST попадают только коды словаря');
    for (const forbidden of [
      'buildValueEditor',
      'value-chips-input',
      'ui-chip-list',
      'chipList',
      'Выбрать значения…',
    ]) {
      assert.ok(
        !enumBody.includes(forbidden),
        `в enumControl не должно быть «${forbidden}» — образец «Тип мысли/связи»`,
      );
    }
  });

  it('ячейка — разметка buildEntityChipField: поле, чипы, угловой крестик, без прежних', () => {
    const box = renderEnum(leaf('in'), slot().api);
    assert.equal(box.dataset['editor'], 'enum');
    assert.ok(one(box, 'fv-enum') !== null, 'обёртка ячейки перечисления');
    assert.ok(one(box, 'entity-chip-field') !== null, 'чип-поле закрытого набора');
    assert.ok(one(box, 'entity-chip-field-inner') !== null, 'рамка чип-поля');
    assert.equal(inputOf(box).placeholder, 'Добавить значение…', 'приглашение поля');
    assert.ok(one(box, 'link-value-corner') !== null, 'угол поля');
    assert.ok(one(box, 'link-value-corner-btn') !== null, 'угловой крестик очистки');
    assert.equal(all(box, 'ui-chip-list').length, 0, 'своего чип-листа нет');
    assert.equal(all(box, 'value-chips-input').length, 0, 'свободного чип-редактора нет');
    assert.ok(!(box.textContent ?? '').includes('Выбрать значения…'), 'чеклист-кнопки нет');
  });

  it('фокус открывает выпадашку «Значения» с чекбоксами во всех строках', async () => {
    const box = renderEnum(leaf('in'), slot().api);
    await openDropdown(box);
    const list = body().children.find((child) => child.classList.contains('type-combo-list'));
    assert.ok(list !== undefined, 'список открыт');
    const header = one(list!, 'type-combo-empty');
    assert.equal(header?.textContent, 'Значения', 'заголовок группы вариантов');
    const listRows = rows();
    assert.deepEqual(
      listRows.map(rowLabel),
      ['Файл', 'Ссылка'],
      'каталог вида вложения целиком',
    );
    for (const row of listRows) {
      const check = one(row, 'type-combo-check');
      assert.ok(check !== null, 'чекбокс в строке списка');
      assert.equal((check as unknown as { type: string }).type, 'checkbox');
      assert.equal((check as unknown as { checked: boolean }).checked, false);
    }
  });

  it('чекбокс добавляет код, повторная отметка снимает; список не закрывается', async () => {
    const { api, writes } = slot();
    const box = renderEnum(leaf('in'), api);
    await openDropdown(box);

    await clickRow('Файл');
    assert.deepEqual(writes[0], { kind: 'list', items: ['file'] }, 'в AST — код, не подпись');
    assert.equal(all(box, 'prop-ref-cloud').length, 1, 'чип появился');
    assert.equal(one(box, 'prc-title')?.textContent, 'Файл', 'чип показывает подпись');
    // Код перечисления — не мысль: значок не рисуется, а пустой слот скрыт CSS
    // (проверка правила — выше, в `collectEnumWidthViolations`). Видимым
    // пустой значок НЕ закрепляем: в узкой колонке он съедал ширину подписи
    // (ревизия № 3 ошибки 1f3f0df5).
    assert.equal(one(box, 'mini-icon')?.children.length, 0, 'значок не нарисован (слот пуст)');
    // Угловой крестик очистки появляется у заполненного поля.
    assert.equal(
      (one(box, 'link-value-corner-btn') as unknown as { hidden: boolean }).hidden,
      false,
      'угловой крестик доступен',
    );
    assert.ok(body().children.some((c) => c.classList.contains('type-combo-list')), 'список не закрылся');

    await clickRow('Ссылка');
    assert.deepEqual(writes[1], { kind: 'list', items: ['file', 'url'] }, 'второй код добавлен');
    assert.equal(all(box, 'prop-ref-cloud').length, 2, 'два чипа');
    assert.ok(body().children.some((c) => c.classList.contains('type-combo-list')), 'список всё ещё открыт');

    // Повторная отметка отмеченной строки снимает значение.
    await clickRow('Файл');
    assert.deepEqual(writes[2], { kind: 'list', items: ['url'] }, 'повторная отметка — код снят');
    assert.equal(all(box, 'prop-ref-cloud').length, 1);
  });

  it('устаревший код вне словаря сохраняется при отметке и снятии (ревизия № 3)', async () => {
    const { api, writes } = slot();
    const box = renderEnum(leaf('in', { kind: 'list', items: ['archived', 'file'] }), api);
    assert.deepEqual(
      all(box, 'prc-title').map((node) => node.textContent),
      ['archived', 'Файл'],
      'код вне словаря виден подписью-кодом',
    );

    await openDropdown(box);
    await clickRow('Ссылка');
    assert.deepEqual(
      writes[0],
      { kind: 'list', items: ['archived', 'file', 'url'] },
      'новый код добавлен, устаревший сохранён',
    );

    const legacy = all(box, 'prop-ref-cloud').find(
      (chip) => one(chip, 'prc-title')?.textContent === 'archived',
    );
    assert.ok(legacy !== undefined, 'чип устаревшего кода на месте');
    const remove = one(legacy!, 'st-f-clear-inline');
    assert.ok(remove !== null, 'крестик чипа устаревшего кода');
    remove!.emit('click', { stopPropagation: () => undefined });
    await flush();
    assert.deepEqual(
      writes[1],
      { kind: 'list', items: ['file', 'url'] },
      'снятие чипа убирает только устаревший код',
    );
  });

  it('крестик чипа и угловой крестик удаляют коды; свободный текст не попадает', async () => {
    const { api, writes } = slot();
    const box = renderEnum(leaf('in', { kind: 'list', items: ['file', 'url'] }), api);
    assert.equal(all(box, 'prop-ref-cloud').length, 2, 'сохранённые коды — чипами');
    assert.deepEqual(
      all(box, 'prc-title').map((node) => node.textContent),
      ['Файл', 'Ссылка'],
      'подписи из словаря',
    );

    const chipRemove = one(all(box, 'prop-ref-cloud')[0]!, 'st-f-clear-inline');
    assert.ok(chipRemove !== null, 'крестик чипа');
    chipRemove!.emit('click', { stopPropagation: () => undefined });
    await flush();
    assert.deepEqual(writes[0], { kind: 'list', items: ['url'] }, 'крестик чипа снял код');

    const clear = one(box, 'link-value-corner-btn');
    assert.ok(clear !== null, 'угловой крестик');
    clear!.emit('click');
    await flush();
    assert.deepEqual(writes[1], { kind: 'none' }, 'угловой крестик очистил набор');

    // Свободный текст: клавиатурная команда поля пыталась бы добавить значение.
    const free = renderEnum(leaf('in'), slot().api);
    await commitFreeText(free, 'Придуманный текст');
    assert.equal(all(free, 'prop-ref-cloud').length, 0, 'чип из свободного текста не появился');
  });

  it('свободный текст не пишется в AST, даже когда набор не пуст', async () => {
    const { api, writes } = slot();
    const box = renderEnum(leaf('in', { kind: 'list', items: ['file'] }), api);
    await commitFreeText(box, 'ещё текст');
    assert.deepEqual(writes.at(-1), { kind: 'list', items: ['file'] }, 'набор кодов не изменился');
    assert.ok(
      writes.every((value) => !JSON.stringify(value).includes('ещё текст')),
      'свободный текст в модель не попал',
    );
  });
});
