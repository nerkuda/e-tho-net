/**
 * Тесты записи редактора типа мысли (ошибка 51732f9b «При создании нового
 * типа мысли не доступно добавление отборов»).
 *
 * Что закрепляем:
 *   1. `buildTypePatchInput` — минимальный PATCH существующего типа: оба
 *      способа записи («Записать» и «Применить и закрыть») шлют ОДИН payload,
 *      повторная запись без изменений не пишет ничего (пустой патч), пустые
 *      описание/шаблон нормализуются в `null`.
 *   2. `typeRowRevealIds` — цепочка предков, которую нужно развернуть, чтобы
 *      строка отредактированного типа стала видимой в списке (понятие
 *      «текущая строка»).
 *   3. Структурные якоря `type-manager.ts`: кнопка «Записать» стоит между
 *      «Отмена» и «Применить и закрыть», записывает без закрытия диалога
 *      (`apply('stay', …)`) и после успешной записи обновляет содержимое
 *      (вкладка «Отборы», метаданные, шапка), а список типов делает строку
 *      записанного типа текущей (`currentRowId`, класс `selected`).
 *
 * Чистая логика + структурные проверки — без jsdom, по принятому в клиенте
 * соглашению (см. `type-manager-name-sync.test.ts`, `type-editor-tabs.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { ThoughtType } from '@etn/shared';

import {
  buildTypePatchInput,
  typeRowRevealIds,
  type ThoughtTypeDraft,
} from '../src/renderer/screens/type-manager.js';

const SOURCE_PATH = resolve(
  import.meta.dirname,
  '..',
  'src',
  'renderer',
  'screens',
  'type-manager.ts',
);

function source(): string {
  return readFileSync(SOURCE_PATH, 'utf8');
}

function thoughtType(overrides: Partial<ThoughtType> = {}): ThoughtType {
  return {
    id: 'tt-1',
    name: 'Тип',
    parent_id: null,
    is_root: false,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    comment_template_md: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u-1',
    ...overrides,
  };
}

function draft(overrides: Partial<ThoughtTypeDraft> = {}): ThoughtTypeDraft {
  return {
    name: 'Тип',
    parent_id: null,
    description: '',
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    ...overrides,
  };
}

describe('buildTypePatchInput — запись редактора типа (51732f9b)', () => {
  it('без изменений патч пуст: повторная запись ничего не шлёт', () => {
    const current = thoughtType({ name: 'Тип', description: 'описание' });
    assert.deepEqual(
      buildTypePatchInput(current, draft({ name: 'Тип', description: 'описание' }), 'описание', null),
      {},
    );
  });

  it('уходит только то, что изменилось (имя, описание, родитель, оформление)', () => {
    const current = thoughtType({ name: 'Старое', parent_id: null, description: 'было' });
    const patch = buildTypePatchInput(
      current,
      draft({
        name: 'Новое',
        parent_id: 'parent-1',
        fg_color: '#ff0000',
        font_bold: true,
      }),
      'стало',
      null,
    );
    assert.deepEqual(patch, {
      name: 'Новое',
      parent_id: 'parent-1',
      fg_color: '#ff0000',
      font_bold: true,
      description: 'стало',
    });
  });

  it('очистка описания и шаблона шлёт null (значение снимается)', () => {
    const current = thoughtType({ description: 'было', comment_template_md: '## Шаблон' });
    assert.deepEqual(
      buildTypePatchInput(current, draft({ description: '' }), '', null),
      { description: null, comment_template_md: null },
    );
  });

  it('иконка уходит парой icon + icon_kind', () => {
    const current = thoughtType();
    assert.deepEqual(
      buildTypePatchInput(current, draft({ icon: '🦀', icon_kind: 'emoji' }), '', null),
      { icon: '🦀', icon_kind: 'emoji' },
    );
  });

  it('после применения патча повторный вызов пуст — запись идемпотентна', () => {
    const current = thoughtType({ name: 'Тип', description: null });
    const next = thoughtType({ ...current, description: 'новое' });
    buildTypePatchInput(current, draft({ description: 'новое' }), 'новое', null); // первый раз — правка
    assert.deepEqual(
      buildTypePatchInput(next, draft({ description: 'новое' }), 'новое', null),
      {},
      'после сохранённого изменения повторная запись не должна слать патч',
    );
  });
});

describe('typeRowRevealIds — текущая строка списка типов (51732f9b)', () => {
  const root = thoughtType({ id: 'root', name: 'Основной', is_root: true, parent_id: null });
  const parent = thoughtType({ id: 'a', name: 'A', parent_id: 'root' });
  const child = thoughtType({ id: 'b', name: 'B', parent_id: 'a' });
  const types = [root, parent, child];

  it('вложенный тип: разворачивается вся цепочка предков, сам тип — нет', () => {
    assert.deepEqual(typeRowRevealIds(types, 'b'), ['a', 'root']);
  });

  it('тип у корня: раскрывать нечего', () => {
    assert.deepEqual(typeRowRevealIds(types, 'a'), ['root']);
  });

  it('корневой тип и пустой id: пустой список', () => {
    assert.deepEqual(typeRowRevealIds(types, 'root'), []);
    assert.deepEqual(typeRowRevealIds(types, null), []);
  });

  it('неизвестный тип: пустой список (список не разворачивается зря)', () => {
    assert.deepEqual(typeRowRevealIds(types, 'нет-такого'), []);
  });
});

describe('type-manager — кнопка «Записать» и текущая строка (51732f9b)', () => {
  it('«Записать» объявлена между «Отмена» и «Применить и закрыть»', () => {
    const src = source();
    const applyIdx = src.indexOf("'Применить и закрыть'");
    assert.ok(applyIdx > 0, 'кнопка «Применить и закрыть» не найдена');
    const cancelIdx = src.lastIndexOf("label: 'Отмена'", applyIdx);
    const saveIdx = src.indexOf("label: 'Записать'");
    assert.ok(cancelIdx > 0, 'кнопка «Отмена» не найдена');
    assert.ok(saveIdx > 0, 'кнопка «Записать» не найдена');
    assert.ok(
      cancelIdx < saveIdx && saveIdx < applyIdx,
      '«Записать» должна стоять между «Отмена» и «Применить и закрыть»',
    );
  });

  it('«Записать» пишет без закрытия диалога (apply(«stay») + keepOpen)', () => {
    const src = source();
    const saveIdx = src.indexOf("label: 'Записать'");
    const applyIdx = src.indexOf("'Применить и закрыть'");
    const saveBlock = src.slice(saveIdx, applyIdx);
    assert.ok(saveBlock.includes('keepOpen: true'), '«Записать» не должна закрывать диалог');
    assert.ok(
      saveBlock.includes("apply('stay'"),
      '«Записать» должна вызывать apply в режиме «stay»',
    );
    assert.ok(
      src.slice(applyIdx, applyIdx + 400).includes("apply('close'"),
      '«Применить и закрыть» должна вызывать apply в режиме «close»',
    );
  });

  it('после записи обновляется содержимое диалога и текущая строка списка', () => {
    const src = source();
    assert.ok(src.includes('viewsTab.refresh()'), 'вкладка «Отборы» не перечитывается после записи');
    assert.ok(src.includes('renderMetadataPane()'), '«Метаданные» не обновляются после записи');
    assert.ok(src.includes('syncDialogTitle()'), 'шапка диалога не обновляется после записи');
    assert.ok(src.includes('onChanged(current.id)'), 'список не получает id записанного типа');
  });

  it('список типов ведёт понятие текущей строки', () => {
    const src = source();
    assert.ok(src.includes('currentRowId'), 'нет понятия текущей строки');
    assert.ok(
      src.includes("tr.classList.add('selected')"),
      'текущая строка не подсвечивается классом selected',
    );
    assert.ok(
      src.includes('typeRowRevealIds(types, currentRowId)'),
      'цепочка предков текущей строки не разворачивается',
    );
    assert.ok(src.includes('scrollIntoView'), 'список не прокручивается к текущей строке');
  });
});
