/**
 * Сторож общего словаря пунктов меню (задача 1d817620, требование f9ad4f53
 * «Контекстное меню карты — на общем словаре пунктов меню»; расширен задачей
 * b6fe9c42 Z9, требование f35f4d04 «Меню оставшихся экранов — на общем словаре
 * пунктов»).
 *
 * Правило: контекстные меню карты И оставшихся экранов собираются из общего
 * словаря `lib/menu.ts` (`menuAction` / `menuChoice` / `menuSubmenu` /
 * `MENU_SEPARATOR`), а не самодельными объектами-пунктами в месте сборки.
 * Проверяются два инварианта:
 *
 * 1. **Нет самодельных пунктов.** В месте сборки меню нет объектных свойств
 *    `label:` — иначе пункт снова собирается вручную (`{ label: … }`) и
 *    расходится с меню других экранов. Для карты (`canvas/context-menu.ts`,
 *    файл только про меню) сканируется весь файл; для экранов, где рядом с
 *    меню живут диалоговые кнопки/вкладки со своим `label:`, сканируются ТОЛЬКО
 *    функции сборки меню.
 * 2. **Словарь действительно используется.** Модуль импортирует конструкторы
 *    из `lib/menu.ts` — запрет (1) не обходится простым выносом подписи
 *    в переменную.
 *
 * CM6-плагины (`editor/markdown-field.ts`, `editor/wiki-link-legacy-actions.ts`,
 * `editor/wiki-link.ts`) строят меню своим механизмом CM6 — вне объёма задачи.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Единственное место сборки меню карты, которое обязан использовать словарь. */
const CANVAS_MENU = 'canvas/context-menu.ts';

/**
 * Функции сборки меню оставшихся экранов (Z9, требование f35f4d04): файл →
 * имена функций, чьё тело обязано собирать пункты только конструкторами
 * словаря. Сканируется тело функции, а не файл целиком: рядом живут
 * диалоговые кнопки/вкладки с их законными `label:`.
 */
const MENU_FUNCTIONS: Array<{ file: string; functions: string[]; requires: string[] }> = [
  {
    file: 'screens/workspace-menus.ts',
    functions: ['buildNetMenuItems', 'buildUserMenuItems', 'buildViewMenuItems'],
    requires: ['menuAction', 'MENU_SEPARATOR'],
  },
  {
    file: 'screens/layers.ts',
    functions: ['buildLayerMenuItems'],
    requires: ['menuAction', 'menuChoice', 'MENU_SEPARATOR'],
  },
  {
    file: 'screens/chronicle/chronicle.ts',
    // Меню строки хроники — `rowMenuItems` (фасад таблицы сам показывает его
    // по правому клику, задача 20ac6917; прежде — `showRowMenu`).
    functions: ['rowMenuItems', 'showTargetMenu', 'showEditorTargetMenu'],
    requires: ['menuAction', 'MENU_SEPARATOR'],
  },
  {
    file: 'screens/structures/commands.ts',
    functions: ['buildMenu'],
    requires: ['menuAction', 'MENU_SEPARATOR'],
  },
  {
    file: 'editor/attachments.ts',
    functions: ['showAttachmentMenu'],
    requires: ['menuAction'],
  },
];

/** Объектное свойство `label:` — признак самодельного пункта меню. */
const HAND_BUILT_ITEM = /[{,]\s*label\s*:/;

/** Комментарий (строчный, блочный или строка JSDoc) — не код. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * Тело функции `name` из исходника — от `{` после списка параметров до
 * парной `}`. `null` — функции нет (переименовали — сторож обязан упасть).
 */
function extractFunctionBody(source: string, name: string): string | null {
  const decl = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (decl === null) return null;
  let i = decl.index + decl[0].length - 1; // на '('
  let paren = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') paren++;
    else if (ch === ')') {
      paren--;
      if (paren === 0) break;
    }
  }
  const brace = source.indexOf('{', i);
  if (brace === -1) return null;
  let depth = 0;
  for (let j = brace; j < source.length; j++) {
    const ch = source[j];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(brace, j + 1);
    }
  }
  return null;
}

describe('guard: меню карты — на общем словаре пунктов lib/menu.ts', () => {
  it('canvas/context-menu.ts не собирает пункты локально', () => {
    assertGuardClean(
      RENDERER_ROOT,
      [
        {
          name: 'canvas-menu-not-hand-built',
          description:
            'Пункты контекстного меню карты создаются конструкторами общего словаря ' +
            '`lib/menu.ts` (`menuAction`/`menuChoice`/`menuSubmenu`/`MENU_SEPARATOR`), ' +
            'а не объектами `{ label: … }` в месте сборки (требование f9ad4f53).',
          filePattern: HAND_BUILT_ITEM,
          include: (rel) => rel === CANVAS_MENU,
          allow: (_rel, line) => isCommentLine(line),
        },
      ],
      { extensions: ['.ts'] },
    );
  });

  it('canvas/context-menu.ts строит пункты через конструкторы словаря', () => {
    const source = fs.readFileSync(path.join(RENDERER_ROOT, CANVAS_MENU), 'utf8');
    const importBlock = /import\s*\{([^}]*)\}\s*from\s*'\.\.\/lib\/menu\.js'/.exec(source);
    assert.ok(importBlock !== null, 'меню карты обязано импортировать словарь lib/menu.ts');
    const imported = importBlock[1] ?? '';
    for (const name of ['menuAction', 'menuChoice', 'menuSubmenu', 'MENU_SEPARATOR']) {
      assert.ok(
        new RegExp(`\\b${name}\\b`).test(imported),
        `словарь lib/menu.ts импортируется без «${name}» — пункты снова собираются вручную`,
      );
    }
  });
});

describe('guard: меню оставшихся экранов — на общем словаре пунктов (Z9, b6fe9c42)', () => {
  for (const { file, functions, requires } of MENU_FUNCTIONS) {
    it(`${file}: сборка меню — только через конструкторы словаря`, () => {
      const source = fs.readFileSync(path.join(RENDERER_ROOT, file), 'utf8');
      for (const fn of functions) {
        const body = extractFunctionBody(source, fn);
        assert.ok(body !== null, `${file}: функция сборки меню «${fn}» не найдена`);
        const offence = body
          .split('\n')
          .filter((line) => !isCommentLine(line))
          .find((line) => HAND_BUILT_ITEM.test(line));
        assert.equal(
          offence,
          undefined,
          `${file}: «${fn}» собирает пункт меню вручную (${offence?.trim() ?? ''}) — ` +
            'используй menuAction/menuChoice/menuSubmenu из lib/menu.ts',
        );
      }
      const importBlock = /import\s*\{([^}]*)\}\s*from\s*'[^']*lib\/menu\.js'/.exec(source);
      assert.ok(importBlock !== null, `${file}: обязан импортировать словарь lib/menu.ts`);
      const imported = importBlock[1] ?? '';
      for (const name of requires) {
        assert.ok(
          new RegExp(`\\b${name}\\b`).test(imported),
          `${file}: словарь lib/menu.ts импортируется без «${name}»`,
        );
      }
    });
  }
});
