/**
 * Сторож UI подсистемы «Публикации» (0.11.1, задача a3cfc018; элемент
 * интерфейса 1eecd988, стандарт «Клиентский UI — только из дизайн-системы»).
 *
 * Правило: экран библиотеки (`screens/publications/**`) и карточка публикации
 * (`editor/publication-card.ts`) собираются ИЗ ФАСАДОВ `lib/ui` и `lib/dialog`:
 *
 * 1. **Не заводят собственных классов под роли `lib/ui`.** Словарные роли
 *    (кнопки `ui-btn*`, поля `ui-field*`, таблицы `ui-table*`, вкладки
 *    `ui-tab*`, состояния `ui-empty*`/`ui-state*`, чипы `ui-chip*`, сегменты
 *    `ui-segmented*`, выборы `ui-choice*`, бейджи `ui-badge*`, дерево
 *    `ui-tree*`) берутся только из фасадов; в код модулей их литералы не
 *    проникают — иначе элемент строится мимо фасада и расходится с
 *    дизайн-системой.
 * 2. **Вендор — только внутри `lib/ui`.** Голые `wa-*`/`vaadin-*` и импорты
 *    вендорских пакетов в этих модулях запрещены (дублирует общий сторож
 *    `guard-ui-facades`, но здесь с явным сообщением о подсистеме).
 * 3. **Диалоги — через `lib/dialog.ts`.** Самодельных окон (`dialog-box`) нет.
 *
 * Дополнительно проверяется положительный факт: списки библиотеки обновляются
 * инкрементально (`reconcileKeyed`) — без этого карточки/строки пересобирались
 * бы целиком (стандарт «Списки рендерятся инкрементально»).
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

/** Файлы подсистемы «Публикации» (относительно рендерера). */
const PUBLICATIONS_SCOPE = (rel: string): boolean =>
  rel.startsWith('screens/publications/') || rel === 'editor/publication-card.ts';

/** Комментарий (JS/CSS) — упоминание в пояснении не является использованием. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('#')
  );
}

/** Литерал класса словарной роли `lib/ui`. */
const UI_ROLE_CLASS =
  /\bui-(?:btn|button|field|table|tab|empty|state|comment|popover|chip|segmented|choice|badge|tree|toggle|splitter)\b/;

/** Литерал имени вендорского custom element (`wa-button`, `vaadin-grid`). */
const VENDOR_ELEMENT = /['"`](?:wa|vaadin)-[a-z][\w-]*['"`]/;

/** Импорт вендорского пакета. */
const VENDOR_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]@(?:awesome\.me\/webawesome|vaadin\/[\w-]+)/;

describe('guard: UI публикаций (a3cfc018)', () => {
  it('экраны публикаций не заводят собственных классов ролей lib/ui', () => {
    assertGuardClean(
      RENDERER_ROOT,
      [
        {
          name: 'no-ui-role-class-literals',
          description:
            'Модули «Публикаций» не содержат литералов классов ролей `lib/ui` ' +
            '(кнопки/поля/таблицы/вкладки/состояния/чипы/сегменты): ' +
            'соответствующие элементы строятся только фасадами `lib/ui`.',
          pattern: UI_ROLE_CLASS,
          include: PUBLICATIONS_SCOPE,
          allow: (_rel, line) => isCommentLine(line),
        },
      ],
    );
  });

  it('вендорские элементы и пакеты не проникают в модули публикаций', () => {
    assertGuardClean(
      RENDERER_ROOT,
      [
        {
          name: 'no-vendor-elements',
          description: 'Вендорские custom elements (`wa-*`/`vaadin-*`) в модулях «Публикаций» запрещены.',
          pattern: VENDOR_ELEMENT,
          include: PUBLICATIONS_SCOPE,
          allow: (_rel, line) => isCommentLine(line),
        },
        {
          name: 'no-vendor-imports',
          description: 'Вендорские пакеты импортируются только фасадами `lib/ui`.',
          filePattern: VENDOR_IMPORT,
          include: PUBLICATIONS_SCOPE,
        },
      ],
    );
  });

  it('диалоги публикаций идут через lib/dialog.ts, а не своим окном', () => {
    assertGuardClean(
      RENDERER_ROOT,
      [
        {
          name: 'no-own-dialog-box',
          description: 'Самодельное окно диалога (`dialog-box`) в модулях «Публикаций» запрещено.',
          pattern: /dialog-box/,
          include: PUBLICATIONS_SCOPE,
          allow: (_rel, line) => isCommentLine(line),
        },
      ],
    );
  });

  it('списки библиотеки обновляются инкрементально (reconcileKeyed)', () => {
    const source = fs.readFileSync(
      path.join(RENDERER_ROOT, 'screens', 'publications', 'publications.ts'),
      'utf8',
    );
    assert.ok(
      source.includes('reconcileKeyed'),
      'library lists must be reconciled incrementally with reconcileKeyed',
    );
    assert.ok(
      !source.includes('replaceChildren('),
      'library screen must not rebuild collections with replaceChildren',
    );
  });
});
