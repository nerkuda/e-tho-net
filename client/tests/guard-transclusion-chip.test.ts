/**
 * Сторож чипа-шапки и поповера правки ссылки трансклюзии и удаления режимной
 * механики (0.12.1, ТП `fcde7c55`, задача `68591b8a`).
 *
 * Правила, которые обязан удерживать код:
 *   1. режимов «правка ссылки» (сворачивание блока в сырой markdown) и
 *      «свёрнутая ссылка» больше НЕТ: в исходнике `transclusion.ts` нет
 *      `setCollapsed`, `pruneCollapsed`, `collapsedEntered`, `linkEditMode`,
 *      `TransclusionLinkWidget`, `TRANSCLUSION_LINK_CLASS`,
 *      `TRANSCLUSION_CHANGE_CLASS`, пункта меню `transclusion.changeLink` и
 *      ховер-кнопки «Редактировать ссылку» (`comment.transclusion.editLink`);
 *   2. чип-шапка и поповер присутствуют и переиспользуют общие модули
 *      (`createTransclusionHead`, `openTransclusionLinkPopover`,
 *      `decorateViewTransclusionChips`, замена ссылки ОДНОЙ транзакцией
 *      `transclusionLinkChange` через `formatTransclusionRef`);
 *   3. создание ссылки не тронуто: атомарный виджет `#id` при вводе
 *      (`TransclusionIdWidget`) на месте.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { listSourceFiles } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
const TRANSCLUSION = fs.readFileSync(
  path.join(RENDERER_ROOT, 'editor', 'transclusion.ts'),
  'utf8',
);
const COMMENT_COMMANDS = fs.readFileSync(
  path.join(RENDERER_ROOT, 'editor', 'comment-commands.ts'),
  'utf8',
);
const RU = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'locales', 'ru.ts'), 'utf8');

/** Исходники рендерера БЕЗ каталога локалей — места фактического использования ключей. */
const RENDERER_SOURCES = listSourceFiles(RENDERER_ROOT, { exclude: ['lib/locales'] })
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');

/** Удалённые режимные идентификаторы (в исходнике не должно быть вовсе). */
const REMOVED = [
  'setCollapsed',
  'pruneCollapsed',
  'collapsedEntered',
  'linkEditMode',
  'TransclusionLinkWidget',
  'TRANSCLUSION_LINK_CLASS',
  'TRANSCLUSION_CHANGE_CLASS',
];

describe('guard: чип-шапка и поповер вместо режимов ссылки (68591b8a)', () => {
  it('режимная механика свёрнутой/правки ссылки удалена из transclusion.ts', () => {
    for (const name of REMOVED) {
      assert.ok(
        !TRANSCLUSION.includes(name),
        `в transclusion.ts остался удалённый режимный идентификатор «${name}»`,
      );
    }
  });

  it('пункт меню «Изменить ссылку» и его подпись удалены', () => {
    assert.ok(
      !COMMENT_COMMANDS.includes('transclusion.changeLink'),
      'в словаре команд остался пункт transclusion.changeLink',
    );
    assert.ok(
      !COMMENT_COMMANDS.includes('comment.transclusion.menu.changeLink'),
      'словарь команд ещё ссылается на подпись «Изменить ссылку»',
    );
    assert.ok(
      !RU.includes('comment.transclusion.menu.changeLink'),
      'в каталоге ru осталась подпись «Изменить ссылку»',
    );
    assert.ok(
      !RU.includes('comment.transclusion.editLink'),
      'в каталоге ru осталась подпись ховер-кнопки «Редактировать ссылку»',
    );
  });

  it('чип-шапка, поповер и разметка просмотра присутствуют', () => {
    for (const name of [
      'createTransclusionHead',
      'openTransclusionLinkPopover',
      'decorateViewTransclusionChips',
      'transclusionLinkChange',
      'TRANSCLUSION_HEAD_CLASS',
      'TRANSCLUSION_CHIP_CLASS',
    ]) {
      assert.ok(TRANSCLUSION.includes(name), `в transclusion.ts нет «${name}»`);
    }
    assert.ok(
      TRANSCLUSION.includes('formatTransclusionRef'),
      'замена ссылки обязана строиться единым домом конструкции (formatTransclusionRef)',
    );
  });

  it('создание ссылки не тронуто: атомарный виджет #id при вводе на месте', () => {
    assert.ok(
      TRANSCLUSION.includes('class TransclusionIdWidget'),
      'атомарный виджет #<id> при вводе ссылки удалён — создание ссылки сломано',
    );
  });

  it('нет осиротевших ключей локали блока трансклюзии (c11b82ee)', () => {
    const keys = [...RU.matchAll(/'((?:comment\.transclusion)\.[A-Za-z.]+)'/g)].map((m) => m[1]!);
    assert.ok(keys.length > 0, 'в каталоге ru не найдено ни одного ключа трансклюзий');
    for (const key of keys) {
      assert.ok(
        RENDERER_SOURCES.includes(key),
        `ключ локали «${key}» не используется в коде — осиротел`,
      );
    }
  });
});
