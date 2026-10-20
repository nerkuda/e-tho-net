/**
 * Сторож перечислений редактора отбора (ошибка 1f3f0df5 «На экране "События"
 * не отображаются значения для отбора "Тип действия"», ревизия 2026-10-19:
 * заказчик не принял первый фикс).
 *
 * Первый фикс `6030b5d9` лечил ШИРИНУ чип-листа `lib/ui/chip-list` (режим
 * `checklist`). Заказчик требует не ширину, а ДРУГОЙ КОМПОНЕНТ: тот же
 * стандартный редактор значения, что у «Типа места» и строковых свойств с
 * `config.options` + `multiple`, — `buildValueEditor` ветки `text`:
 * рамка `.st-f-chipfield`, поле `.value-chips-input` с живым поиском и
 * подсказкой «+ ещё одно значение», каретка «▾». Своего чип-листа, чеклиста и
 * кнопки «Выбрать значения…» у перечислений быть не должно.
 *
 * AST хранит КОДЫ (`created`/`thought`/`file`), редактор — ПОДПИСИ словаря.
 * Перевод — единый адаптер `filterValueEnumCodec`: сторож проверяет и выбор
 * (подпись → код в AST), и снятие (чип → удаление кода), и отбрасывание
 * неизвестного свободного текста.
 *
 * Сторож краснеет на умышленном нарушении (самопроверка мутациями CSS), входит
 * в обычный прогон `npm -w @etn/client test`.
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

  // 2. Обёртка перечисления заполняет растянутую ячейку целиком — чип-поле
  //    получает ширину колонки и переносит чипы на узкой панели.
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

  return violations;
}

// ---------------------------------------------------------------------------
// Исходник: перечисление строит общий редактор значения
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

/** Минимальный DOM/window-шим, которого требуют фасады и общий редактор. */
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
  // `window.etn` — контракт preload: редактор читает его на этапе сборки поля.
  // Разрешающая заглушка: любой вызов — пустой список (проверяется разметка).
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

/** Все потомки с точным классом. */
function all(root: ShimElement, cls: string): ShimElement[] {
  return root.findAll((node) => node.classList.contains(cls));
}

/** Первый потомок с точным классом. */
function one(root: ShimElement, cls: string): ShimElement | null {
  return all(root, cls)[0] ?? null;
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

/** API слота: запоминает записанные значения и путь записи. */
function slot(): { api: AnyRecord; writes: Array<{ via: string; value: unknown }> } {
  const writes: Array<{ via: string; value: unknown }> = [];
  return {
    api: {
      setValue: (value: unknown) => writes.push({ via: 'setValue', value }),
      setStructuralValue: (value: unknown) => writes.push({ via: 'structural', value }),
    },
    writes,
  };
}

/** Собрать ячейку перечисления. */
function renderEnum(leafNode: unknown, api: unknown): ShimElement {
  return mod.renderFilterValue(leafNode as never, api as never, context() as never) as unknown as ShimElement;
}

/** Дать отработать промису сохранения (`save` вызывается через микротаску). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Добавить чип вводом текста и Enter (как пользователь). */
async function typeAndEnter(root: ShimElement, text: string): Promise<void> {
  const input = one(root, 'value-chips-input');
  assert.ok(input !== null, 'поле добавления значения в чип-поле');
  (input as unknown as { value: string }).value = text;
  input.dispatch('keydown', {
    key: 'Enter',
    defaultPrevented: false,
    preventDefault: () => undefined,
  });
  await flush();
}

// ---------------------------------------------------------------------------
// Проверки
// ---------------------------------------------------------------------------

describe('guard: перечисления редактора отбора — общий редактор значения (1f3f0df5)', () => {
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
      (_all, head: string, body: string, tail: string) =>
        `${head}${body.replace(/\s*align-self:\s*stretch;/, '')}${tail}`,
    );
    assert.notEqual(withoutStretch, css, 'мутация обязана менять CSS');
    assert.ok(
      collectEnumWidthViolations(withoutStretch).some((v) => v.includes('align-self: stretch')),
      'потеря align-self: stretch обязана краснеть',
    );
  });

  it('правило краснеет, если обёртка перестала заполнять ширину', () => {
    const withoutWrap = css.replace(ENUM_WRAP_SELECTOR, '.fv-enum-mutated');
    assert.ok(
      collectEnumWidthViolations(withoutWrap).some((v) => v.includes('не заполняет ширину')),
      'без width: 100% чип-поле не получает ширину колонки',
    );
  });

  it('enumControl строит общий редактор значения и не заводит своего чип-листа', () => {
    assert.ok(enumBody.includes('buildValueEditor('), 'перечисление — общий редактор значения');
    assert.ok(enumBody.includes('textListAsArray: true'), 'значения редактора — дискретный массив');
    assert.ok(enumBody.includes("commitOn: 'change'"), 'запись значения — по изменению');
    assert.ok(enumBody.includes('filterValueEnumCodec('), 'перевод код ↔ подпись — единый адаптер');
    for (const forbidden of ['chipList', 'ui-chip-list', 'checklist', 'Выбрать значения…']) {
      assert.ok(
        !enumBody.includes(forbidden),
        `в enumControl не должно быть «${forbidden}» — используется стандартное чип-поле`,
      );
    }
    assert.ok(
      !/from '\.\/ui\/chip-list\.js'/.test(source),
      'модуль не импортирует собственный чип-лист',
    );
  });

  it('адаптер перечисления: подпись → код, снятие → удаление, чужой текст отброшен', () => {
    const codec = mod.filterValueEnumCodec([
      { value: 'file', label: 'Файл' },
      { value: 'url', label: 'Ссылка' },
    ]);
    assert.deepEqual(codec.toLabels(['file', 'url']), ['Файл', 'Ссылка'], 'в редактор — подписи');
    // Выбор подписи в редакторе даёт код в AST.
    assert.deepEqual(codec.toCodes(['Файл', 'Ссылка']), { codes: ['file', 'url'], dropped: false });
    // Снятие чипа: редактор отдаёт оставшиеся подписи — код снятого не остаётся.
    assert.deepEqual(codec.toCodes(['Ссылка']), { codes: ['url'], dropped: false });
    // Неизвестный свободный текст в AST не попадает.
    assert.deepEqual(codec.toCodes(['Файл', 'Придуманный текст']), { codes: ['file'], dropped: true });
    // Устаревший код вне словаря показывается как есть и переживает правку.
    assert.deepEqual(codec.toLabels(['archived']), ['archived']);
    assert.deepEqual(codec.toCodes(['archived'], ['archived']), {
      codes: ['archived'],
      dropped: false,
    });
  });

  it('ячейка перечисления — стандартные классы общего редактора, без чеклиста', () => {
    const box = renderEnum(leaf('in', { kind: 'list', items: ['file'] }), slot().api);
    assert.equal(box.dataset['editor'], 'enum');
    assert.ok(one(box, 'fv-enum') !== null, 'обёртка ячейки перечисления');
    assert.ok(one(box, 'st-f-chipfield') !== null, 'стандартное чип-поле общего редактора');
    assert.ok(one(box, 'value-chips-input') !== null, 'поле ввода с живым поиском');
    // Каретка «▾» — полный список вариантов.
    assert.ok(
      box.findAll((node) => (node.textContent ?? '').trim() === '▾').length > 0,
      'каретка «▾» открывает полный список',
    );
    // Чип стандартного редактора — облачко `profile: chip` (фабрика мысли).
    assert.equal(all(box, 'prop-ref-cloud').length, 1, 'выбранное значение — чип с подписью');
    assert.equal(one(box, 'prc-title')?.textContent, 'Файл', 'чип показывает подпись, а не код');
    assert.equal(all(box, 'ui-chip-list').length, 0, 'своего чип-листа у перечисления нет');
    assert.ok(!(box.textContent ?? '').includes('Выбрать значения…'), 'чеклист-кнопки нет');
  });

  it('выбор значения пишет код в AST, снятие чипа убирает код', async () => {
    // Выбор: пустая ячейка + ввод подписи → в AST код.
    const fresh = slot();
    const box = renderEnum(leaf('in'), fresh.api);
    await typeAndEnter(box, 'Файл');
    assert.deepEqual(fresh.writes, [{ via: 'setValue', value: { kind: 'list', items: ['file'] } }]);

    // Снятие: чип «Ссылка» убирает только свой код.
    const selected = slot();
    const filled = renderEnum(leaf('in', { kind: 'list', items: ['file', 'url'] }), selected.api);
    const removes = filled.findAll((node) => node.classList.contains('st-f-clear-inline'));
    assert.equal(removes.length, 2, 'у каждого чипа есть крестик снятия');
    removes[1]!.fire('click', { stopPropagation: () => undefined });
    await flush();
    assert.deepEqual(selected.writes, [
      { via: 'setValue', value: { kind: 'list', items: ['file'] } },
    ]);
  });

  it('неизвестный свободный текст в AST не попадает и чип снимается пересборкой', async () => {
    const { api, writes } = slot();
    const box = renderEnum(leaf('in'), api);
    await typeAndEnter(box, 'Придуманный текст');
    assert.deepEqual(
      writes,
      [{ via: 'structural', value: { kind: 'none' } }],
      'чужой текст отброшен, строка пересобрана из модели',
    );
  });
});
