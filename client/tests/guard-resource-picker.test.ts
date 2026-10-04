/**
 * Сторож универсального диалога выбора ресурса (задача d1a56d76, DoD п.3).
 *
 * Правило: диалог выбора ресурса (иконка мысли/типа, обложка публикации,
 * будущие картинки в полях) собирается ТОЛЬКО каркасом
 * `editor/resource-picker.ts` (`createResourcePicker` + источники
 * `emojiSourceTab`/`thoughtIconSourceTab`/`urlSourceTab`/`fileImageSourceTab`).
 * Второй самодельный диалог под ту же роль — нарушение.
 *
 * Что проверяется грепом:
 *  1. Системный выбор картинки (`etn.system.pickImage`) — только в источнике
 *     «Файл» универсального компонента: второй такой вызов означает вторую
 *     реализацию выбора.
 *  2. Набор эмодзи (`EMOJI_GROUPS`) подключается только источником «Эмодзи».
 *  3. Фабрики источников зовут только каркас и адаптеры (icon-dialog,
 *     publication-card); новый потребитель обязан быть осознанной правкой
 *     списка.
 *  4. Оба прежних диалога (иконка, обложка) собраны через `createResourcePicker`.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { assertGuardClean } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
const PICKER = 'editor/resource-picker.ts';

/** Файлы, которым разрешено пользоваться фабриками источников ресурса. */
const SOURCE_CONSUMERS = new Set([PICKER, 'editor/icon-dialog.ts', 'editor/publication-card.ts']);

function source(rel: string): string {
  return fs.readFileSync(path.join(RENDERER_ROOT, ...rel.split('/')), 'utf8');
}

describe('сторож: единый диалог выбора ресурса (d1a56d76)', () => {
  it('системный выбор картинки — только в универсальном компоненте', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'single-image-picker',
        description:
          '`etn.system.pickImage` — только в источнике «Файл» универсального ' +
          'диалога выбора ресурса (editor/resource-picker.ts). Второй вызов — ' +
          'вторая реализация выбора картинки: соберите источник в компоненте.',
        pattern: /pickImage/,
        allow: (rel) => rel === PICKER,
      },
    ]);
  });

  it('набор эмодзи подключает только источник «Эмодзи» компонента', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'single-emoji-grid',
        description:
          '`EMOJI_GROUPS` используется только источником «Эмодзи» ' +
          '(editor/resource-picker.ts) и объявляется в lib/emoji-data.ts.',
        pattern: /EMOJI_GROUPS/,
        allow: (rel) => rel === PICKER || rel === 'lib/emoji-data.ts',
      },
    ]);
  });

  it('фабрики источников зовут только каркас и его адаптеры', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'single-resource-sources',
        description:
          '`createResourcePicker`/`emojiSourceTab`/`thoughtIconSourceTab`/' +
          'urlSourceTab`/`fileImageSourceTab` — API универсального диалога; ' +
          'второй потребитель вне каркаса и адаптеров — второе семейство диалогов.',
        pattern: /createResourcePicker|emojiSourceTab|thoughtIconSourceTab|urlSourceTab|fileImageSourceTab/,
        allow: (rel) => SOURCE_CONSUMERS.has(rel),
      },
    ]);
  });

  it('оба прежних диалога собраны через универсальный каркас', () => {
    assert.match(source(PICKER), /export function createResourcePicker\(/, 'каркас объявлен');
    assert.match(
      source('editor/icon-dialog.ts'),
      /createResourcePicker\(/,
      'пикер иконки — адаптер универсального компонента',
    );
    assert.match(
      source('editor/publication-card.ts'),
      /createResourcePicker\(/,
      'диалог обложки — адаптер универсального компонента',
    );
  });

  it('второго `showDialog` под выбор ресурса вне компонента нет', () => {
    // Диалог обложки больше не несёт собственного `showDialog` для выбора
    // обложки — только каркас компонента. Прежний вариант с вкладками
    // attachments/url и `applySelection` не должен вернуться.
    assert.doesNotMatch(
      source('editor/publication-card.ts'),
      /function applySelection\(/,
      'собственная apply-логика диалога обложки должна жить в источнике компонента',
    );
    assert.doesNotMatch(
      source('editor/icon-dialog.ts'),
      /showDialog\(/,
      'пикер иконки не открывает диалог сам — это делает каркас',
    );
  });
});
