/**
 * Сторож состояний контролов `lib/ui` (задача 0af93058, требование 5bbf9e45,
 * стандарт «Правило без теста-сторожа не считается введённым»).
 *
 * Правило: у каждого интерактивного контрола словаря `lib/ui` объявлен полный
 * набор различимых состояний — покой, `:hover`, `:active` (нажатие),
 * `:focus-visible`, `:disabled`. Фокус всегда видим (правило `:focus`/`:focus`
 * не снимает обводку без замены); микроанимации — через общий токен
 * `--transition-hover`, гасящийся при `prefers-reduced-motion`.
 *
 * **Обоснованные края (allow).** Часть классов — не контролы, и полный набор
 * у них не требуется:
 *   • `.ui-segmented` — раскладка; состояния дают сегменты-кнопки `.ui-btn`;
 *   • `.ui-popover` — панель-контейнер; фокус получают ссылки тела;
 *   • `.ui-table` — обёртка-«виджет»: у неё только `:focus-visible`, а
 *     состояния строк (`hover`, выбранная, подсвеченная) заданы вендорской
 *     сетке через карту `vaadin-tokens.css` (проверяется ниже);
 *   • `.ui-splitter--grip` — без `disabled`-контракта (разделитель не
 *     отключается), поэтому состояние недоступности не объявляется;
 *   • collapsible (`lib/ui/collapsible.ts`) — безголовый компонент: собственного
 *     CSS у него нет, вид и состояния задаёт потребитель своими классами.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assembledStylesFile } from './renderer-css.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');
const UI_ROOT = path.join(RENDERER_ROOT, 'lib', 'ui');

type StateName = 'hover' | 'active' | 'focus-visible' | 'disabled';

interface InteractiveControl {
  /** Файл словаря относительно `lib/ui`. */
  file: string;
  /** Класс-контрол. */
  selector: string;
  /** Обязательные состояния. */
  states: StateName[];
}

/** Интерактивные контролы словаря и их обязательные состояния. */
const CONTROLS: InteractiveControl[] = [
  { file: 'button.css', selector: '.ui-btn', states: ['hover', 'active', 'focus-visible', 'disabled'] },
  { file: 'field.css', selector: '.ui-input', states: ['hover', 'active', 'focus-visible', 'disabled'] },
  { file: 'field.css', selector: '.ui-color-hex', states: ['hover', 'active', 'focus-visible', 'disabled'] },
  { file: 'field.css', selector: '.ui-color-input', states: ['hover', 'active', 'focus-visible', 'disabled'] },
  { file: 'field.css', selector: '.ui-clearable-btn', states: ['hover', 'active', 'focus-visible', 'disabled'] },
  { file: 'choice-row.css', selector: '.ui-choice-row', states: ['hover', 'active', 'focus-visible', 'disabled'] },
  { file: 'toggle.css', selector: '.ui-toggle--glyph', states: ['hover', 'active', 'focus-visible', 'disabled'] },
  { file: 'tabs.css', selector: '.ui-tab', states: ['hover', 'active', 'focus-visible', 'disabled'] },
  { file: 'tree.css', selector: '.ui-tree-row', states: ['hover', 'active', 'focus-visible', 'disabled'] },
  { file: 'tree.css', selector: '.ui-tree-caret', states: ['hover', 'active', 'focus-visible', 'disabled'] },
  { file: 'tree.css', selector: '.ui-tree', states: ['focus-visible'] },
  { file: 'chip-list.css', selector: '.ui-chip-remove', states: ['hover', 'active', 'focus-visible', 'disabled'] },
  { file: 'splitter.css', selector: '.ui-splitter--grip', states: ['hover', 'active', 'focus-visible'] },
  { file: 'table.css', selector: '.ui-table', states: ['focus-visible'] },
];

const readUi = (file: string): string => fs.readFileSync(path.join(UI_ROOT, file), 'utf8');

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Есть ли в CSS правило состояния `:${state}` для указанного класса. */
function hasState(css: string, selector: string, state: StateName): boolean {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Класс целиком (не префикс другого класса) и `:state` в том же селекторе.
  const re = new RegExp(`${escapeRe(selector)}(?![\\w-])[^{}]*:${state}\\b`);
  return re.test(code);
}

/** Блоки `селектор { ... }` (плоские, без вложенных правил); комментарии сняты. */
function cssBlocks(css: string): Array<{ sel: string; body: string }> {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: Array<{ sel: string; body: string }> = [];
  for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    blocks.push({ sel: m[1]!, body: m[2]! });
  }
  return blocks;
}

describe('guard: состояния контролов lib/ui', () => {
  it('у каждого интерактивного контрола объявлен полный набор состояний', () => {
    const problems: string[] = [];
    for (const control of CONTROLS) {
      const css = readUi(control.file);
      const missing = control.states.filter((s) => !hasState(css, control.selector, s));
      if (missing.length > 0) {
        problems.push(
          `  • ${control.file} ${control.selector} — нет: ${missing.map((s) => `:${s}`).join(', ')}`,
        );
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `Неполный набор состояний контролов lib/ui (${problems.length}):\n${problems.join('\n')}\n\n` +
          'Добавь недостающие состояния (токены --accent/--focus-ring-width для кольца, ' +
          '--bg-hover/--bg-active для фона) либо обоснуй исключение в CONTROLS/шапке сторожа.',
      );
    }
  });

  it('правило :focus не снимает обводку без видимой замены', () => {
    const problems: string[] = [];
    for (const file of fs.readdirSync(UI_ROOT).filter((f) => f.endsWith('.css'))) {
      for (const block of cssBlocks(readUi(file))) {
        if (!/:focus(-visible)?\b/.test(block.sel)) continue;
        if (!/outline\s*:\s*(none|0)\b/.test(block.body)) continue;
        const replaced =
          /box-shadow\s*:/.test(block.body) ||
          /outline\s*:\s*(?!none|0)\S/.test(block.body) ||
          /border-color\s*:/.test(block.body);
        if (!replaced) {
          problems.push(`  • ${file} «${block.sel.trim()}» — outline: none без замены`);
        }
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `Фокус снят без видимой замены (${problems.length}):\n${problems.join('\n')}\n\n` +
          'Фокус обязан быть видимым: outline из --focus-ring-width/--accent, box-shadow ' +
          'или смена border-color.',
      );
    }
  });

  it('микроанимации идут через --transition-hover и гасятся при reduce-motion', () => {
    const styles = fs.readFileSync(assembledStylesFile(), 'utf8');
    if (!/--transition-hover\s*:/.test(styles)) {
      throw new Error('Токен --transition-hover не объявлен в styles.css');
    }
    if (!/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(styles)) {
      throw new Error('Нет правила prefers-reduced-motion: reduce — микроанимации не гасятся');
    }
    const reduced = styles.slice(styles.indexOf('prefers-reduced-motion'));
    if (!/--transition-hover\s*:\s*0\s*ms/.test(reduced)) {
      throw new Error(
        'При prefers-reduced-motion: reduce токен --transition-hover не обнуляется ' +
          '(переходы компонентов продолжат анимироваться).',
      );
    }
    // Интерактивные контролы (у кого есть hover) обязаны ссылаться на токен.
    const problems: string[] = [];
    for (const control of CONTROLS) {
      if (!control.states.includes('hover')) continue;
      if (!readUi(control.file).includes('var(--transition-hover)')) {
        problems.push(`  • ${control.file} ${control.selector}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `Контролы без перехода по --transition-hover (${problems.length}):\n${problems.join('\n')}`,
      );
    }
  });

  it('приглушение недоступных контролов — через --state-disabled-opacity', () => {
    const styles = fs.readFileSync(assembledStylesFile(), 'utf8');
    if (!/--state-disabled-opacity\s*:/.test(styles)) {
      throw new Error('Токен --state-disabled-opacity не объявлен в styles.css');
    }
    const problems: string[] = [];
    for (const control of CONTROLS) {
      if (!control.states.includes('disabled')) continue;
      if (!readUi(control.file).includes('var(--state-disabled-opacity)')) {
        problems.push(`  • ${control.file} ${control.selector}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `Недоступные контролы без токена приглушения (${problems.length}):\n${problems.join('\n')}\n\n` +
          'Параметр disabled — токен --state-disabled-opacity, а не литерал.',
      );
    }
  });

  it('состояния строк таблицы заданы токенами Vaadin Grid', () => {
    const vaadin = fs.readFileSync(path.join(UI_ROOT, 'vaadin-tokens.css'), 'utf8');
    const required = [
      '--vaadin-grid-row-hover-background-color',
      '--vaadin-grid-row-selected-background-color',
      '--vaadin-grid-row-highlight-background-color',
    ];
    const missing = required.filter((t) => !new RegExp(`${t}\\s*:`).test(vaadin));
    if (missing.length > 0) {
      throw new Error(
        `Состояния строк таблицы не заданы через карту Vaadin: ${missing.join(', ')}. ` +
          'У обёртки .ui-table собственных :hover/:active нет — они должны жить в ' +
          'vaadin-tokens.css.',
      );
    }
  });
});
