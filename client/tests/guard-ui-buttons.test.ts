/**
 * Сторож словаря кнопок `lib/ui` (задача 56f1dcb2, требование edc5faea,
 * ADR 03eb2c61).
 *
 * Правило: у кнопок клиента ОДИН словарь ролей, и он живёт в `lib/ui`.
 * Проверяются три запрета:
 *
 * 1. **Старые классы кнопок.** Два разошедшихся набора (`btn*`, `dialog-btn*`)
 *    и самодельные иконочные классы (`icon-btn`, `sfb-btn`, `tb-btn`,
 *    `dialog-close`, `view-btn`) в разметке рендерера не встречаются.
 * 2. **Обход словаря.** Литерал класса словаря (`ui-btn`) встречается только
 *    в модуле-определении `lib/ui/button.ts` — роли и состояния нельзя
 *    навесить строкой в обход API.
 * 3. **Самодельные кнопки.** Прямое создание `<button>` (`button(...)` из
 *    `lib/dom.js` и `el('button', …)`) допустимо только с классом
 *    компонента-владельца из явного allow-списка ниже. Это «края», которые
 *    НЕ являются кнопками-действиями и принадлежат своим компонентам
 *    (вкладки, меню, фильтры, навигация, текстовые ссылки-кнопки): их
 *    переводит на профильный компонент соответствующая задача, а не словарь
 *    кнопок. Кнопка-действие обязана собираться через `uiButton` /
 *    `iconButton`.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, listSourceFiles } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/**
 * Классы кнопок-компонентов, которым разрешено создавать `<button>` напрямую:
 * элемент принадлежит другому компоненту (вкладке/меню/фильтру/навигации),
 * а не словарю кнопок. Список намеренно явный и минимальный.
 */
const ALLOWED_RAW_BUTTON_CLASSES = [
  'tab', // вкладки (tabs.ts, editor-tab, type-editor-tab, icon-tab, diff-tab)
  'menu-item', // строки меню (lib/menu.ts)
  'st-f-', // контролы фильтров (filter-form, filter-panel, thought-cloud)
  'st-more', // «показать ещё» в структурах
  'sfd-row', // строка списка сохранённых отборов
  'selection-menu-btn', // кнопка меню выделения
  'settings-nav-item', // навигация диалога настроек
  'settings-md-tab', // вкладки markdown-настроек
  'icon-type-cell', // ячейки выбора иконки
  'emoji-cell', // ячейки эмодзи
  'notice-close', // крестик уведомления (компонент сообщений, T6)
  'history-more', // «остальная история» (компонент истории)
  'pinned-more', // «остальные закреплённые»
  'link-trash-badge', // метка корзины на связи (карта/мини-граф)
  'user-multi-x', // снятие чипа пользователя
  'editor-icon-box', // квадрат иконки редактора
  'editor-trash-mark', // метка корзины в заголовке редактора
  'link-value-corner-btn', // угловые кнопки поля значения
  'entity-combo-pick', // «…» комбо сущности
  'link-btn', // текстовая ссылка-кнопка
  'canvas-filter-strip-btn', // полоса фильтров холста
];

/** Класс разрешён, если содержит любой из токенов allow-списка. */
function isAllowedRawClass(cls: string): boolean {
  return ALLOWED_RAW_BUTTON_CLASSES.some((token) => cls.includes(token));
}

const BS = String.fromCharCode(92);

/** Индекс закрывающей скобки вызова, начинающегося в `open` (учёт строк/вложенности). */
function findCallClose(source: string, open: number): number {
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (escaped) { escaped = false; continue; }
    if (c === BS) { escaped = true; continue; }
    if (inString !== null) { if (c === inString) inString = null; continue; }
    if (c === "'" || c === '"' || c === '`') { inString = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Аргументы вызова верхнего уровня. */
function splitArgs(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  let current = '';
  for (const c of inner) {
    if (escaped) { current += c; escaped = false; continue; }
    if (c === BS) { current += c; escaped = true; continue; }
    if (inString !== null) { current += c; if (c === inString) inString = null; continue; }
    if (c === "'" || c === '"' || c === '`') { current += c; inString = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += c;
  }
  parts.push(current.trim());
  return parts.filter((p) => p !== '');
}

/** Прямое создание кнопок в рендерере, класс которых не разрешён allow-списком. */
interface RawButton {
  file: string;
  line: number;
  text: string;
}

function findRawButtons(): RawButton[] {
  const violations: RawButton[] = [];
  for (const abs of listSourceFiles(RENDERER_ROOT)) {
    const rel = path.relative(RENDERER_ROOT, abs).replace(/\\/g, '/');
    if (rel.startsWith('lib/ui/')) continue; // словарь — здесь и определяется
    const source = fs.readFileSync(abs, 'utf8');
    const callRe = /\b(?:button|el)\s*\(/g;
    for (const match of source.matchAll(callRe)) {
      const start = match.index ?? 0;
      const name = match[0].startsWith('el') ? 'el' : 'button';
      const open = source.indexOf('(', start);
      // `el('button', …)` — только создание кнопки; прочие `el` игнорируем.
      if (name === 'el') {
        const after = source.slice(open + 1, open + 12);
        if (!/^\s*'button'/.test(after)) continue;
      } else {
        // `foo.button(` (метод) и объявление функции не считаем.
        if (/[\w.]/.test(source[start - 1] ?? '')) continue;
        if (/function\s+$/.test(source.slice(Math.max(0, start - 24), start))) continue;
      }
      const close = findCallClose(source, open);
      if (close < 0) continue;
      const args = splitArgs(source.slice(open + 1, close));
      const classArg = name === 'el' ? args[1] : args[2];
      const literal = classArg !== undefined && /^['"`][^'"`]*['"`]$/.test(classArg);
      if (!literal) continue; // динамический/константный класс — владелец-компонент
      const cls = classArg.slice(1, -1);
      if (isAllowedRawClass(cls)) continue;
      const lineNo = source.slice(0, start).split('\n').length;
      const lineText = source.split('\n')[lineNo - 1]!.trim();
      violations.push({ file: rel, line: lineNo, text: lineText });
    }
  }
  return violations;
}

describe('guard: словарь кнопок lib/ui', () => {
  it('старых классов кнопок (`btn*`, `dialog-btn*`, `icon-btn`, `sfb-btn`, `tb-btn`) нет в разметке', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-legacy-button-classes',
        description:
          'Старые наборы классов кнопок упразднены (требование edc5faea): ' +
          'кнопку собирают через uiButton/iconButton из lib/ui/button.ts, ' +
          'а не классом btn*/dialog-btn*/icon-btn/sfb-btn/tb-btn/view-btn.',
        pattern:
          /['"](?:btn|dialog-btn|dialog-close|icon-btn|sfb-btn|tb-btn|view-btn)(?:['"\s])/,
      },
    ]);
  });

  it('классы словаря (`ui-btn*`) объявляются только в lib/ui/button.ts', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'ui-btn-defined-only-in-dictionary',
        description:
          'Литерал класса словаря в обход API запрещён: роли и состояния ' +
          'навешивает uiButton/iconButton/setButtonActive (lib/ui/button.ts).',
        pattern: /['"][^'"]*ui-btn/,
        include: (rel) => !rel.startsWith('lib/ui/button'),
      },
    ]);
  });

  it('кнопки-действия создаются через словарь, а не напрямую', () => {
    const violations = findRawButtons();
    if (violations.length === 0) return;
    const list = violations.map((v) => `  • ${v.file}:${v.line} — ${v.text}`).join('\n');
    throw new Error(
      `Прямое создание кнопки вне словаря lib/ui (${violations.length}):\n${list}\n\n` +
        'Кнопка-действие обязана собираться через uiButton/iconButton ' +
        '(lib/ui/button.ts). Если элемент принадлежит другому компоненту ' +
        '(вкладка, меню, фильтр, ссылка-кнопка), его класс должен быть в ' +
        'ALLOWED_RAW_BUTTON_CLASSES сторожа guard-ui-buttons.test.ts.',
    );
  });
});
