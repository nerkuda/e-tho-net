/**
 * Сторож общего словаря пунктов меню (задача 1d817620, требование f9ad4f53
 * «Контекстное меню карты — на общем словаре пунктов меню»).
 *
 * Правило: контекстное меню карты мыслей собирается из общего словаря
 * `lib/menu.ts` (`menuAction` / `menuChoice` / `menuSubmenu` / `MENU_SEPARATOR`),
 * а не самодельными объектами-пунктами в месте сборки. Проверяются два
 * инварианта:
 *
 * 1. **Нет самодельных пунктов.** В `canvas/context-menu.ts` нет объектных
 *    свойств `label:` — иначе пункт снова собирается вручную (`{ label: … }`)
 *    и расходится с меню других экранов.
 * 2. **Словарь действительно используется.** Модуль импортирует конструкторы
 *    из `lib/menu.ts` — запрет (1) не обходится простым выносом подписи
 *    в переменную.
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

/** Объектное свойство `label:` — признак самодельного пункта меню. */
const HAND_BUILT_ITEM = /[{,]\s*label\s*:/;

/** Комментарий (строчный, блочный или строка JSDoc) — не код. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
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
