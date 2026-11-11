/**
 * Строка дневниковой записи: адаптеры транспортных DTO в единую view-модель
 * (0.15.4, тех.проект 43329662, задача 33ed043c, элемент 554e3129,
 * ADR 8f0e9412).
 *
 * Контракт адаптеров: условная логика двух форматов (поиск — `SearchChronoHit`,
 * вкладка «Упоминания» — `RecordHit`) снимается ОДИН раз здесь, поэтому
 * разметка и клики строки одинаковы на обеих поверхностях. Различие форматов
 * ровно одно: владелец записи у поиска лежит в `owner`/`owner_id` хита, у
 * backlinks/mentions — в `owner_type`/`owner_id` самой строки.
 *
 * Рендер строки (разметка, чипы, «+N», список выбора, клики) проверяется GUI-
 * стендом: под Node экранные модули импортируются частично. Здесь — чистые
 * адаптеры, они не требуют DOM.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChronicleTarget, RecordHit, SearchChronoHit } from '@etn/shared';

import {
  createRecordRow,
  recordRowFromChronoHit,
  recordRowFromRecordHit,
} from '../src/renderer/lib/record-row.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const OWNER = '55555555-5555-4555-8555-555555555555';
const COMMENT = '66666666-6666-4666-8666-666666666666';
const FROM = '2026-11-10T09:15:00.000Z';
const TO = '2026-11-10T10:45:00.000Z';

/** Минимальная привязка-мысль — адаптеры её не разбирают, передают как есть. */
const TARGETS: ChronicleTarget[] = [
  {
    kind: 'thought',
    thought: {
      id: OWNER,
      title: 'Владелец записи',
      type_id: null,
      icon: null,
      icon_kind: 'emoji',
      icon_attachment_id: null,
      active: true,
      marked_for_deletion: false,
      fg_color: null,
      bg_color: null,
      font_bold: null,
      font_italic: null,
      font_underline: null,
      font_strike: null,
    },
  },
];

/** Хит группы «Найдено в хронологии». */
function chronoHit(overrides: Partial<SearchChronoHit> = {}): SearchChronoHit {
  return {
    owner: 'thought',
    owner_id: OWNER,
    comment_id: COMMENT,
    valid_from: FROM,
    valid_to: TO,
    use_time: true,
    snippet: 'zzchrono запись [[#' + OWNER + ']]',
    highlights: [],
    targets: TARGETS,
    ...overrides,
  };
}

/** Строка-запись ответа backlinks/mentions. */
function recordHit(overrides: Partial<RecordHit> = {}): RecordHit {
  return {
    kind: 'record',
    comment_id: COMMENT,
    valid_from: FROM,
    valid_to: TO,
    use_time: true,
    snippet: 'zzchrono запись [[#' + OWNER + ']]',
    targets: TARGETS,
    owner_type: 'thought',
    owner_id: OWNER,
    ...overrides,
  };
}

describe('адаптеры строки-записи (задача 33ed043c)', () => {
  it('хроно-хит поиска: владелец берётся из `owner`/`owner_id` хита', () => {
    const model = recordRowFromChronoHit(chronoHit({ owner: 'link', owner_id: 'link-owner' }));

    assert.deepEqual(model, {
      commentId: COMMENT,
      validFrom: FROM,
      validTo: TO,
      useTime: true,
      snippet: 'zzchrono запись [[#' + OWNER + ']]',
      targets: TARGETS,
      ownerType: 'link',
      ownerId: 'link-owner',
    });
  });

  it('строка backlinks/mentions: владелец берётся из `owner_type`/`owner_id` строки', () => {
    const model = recordRowFromRecordHit(recordHit({ owner_type: 'link', owner_id: 'link-owner' }));

    assert.deepEqual(model, {
      commentId: COMMENT,
      validFrom: FROM,
      validTo: TO,
      useTime: true,
      snippet: 'zzchrono запись [[#' + OWNER + ']]',
      targets: TARGETS,
      ownerType: 'link',
      ownerId: 'link-owner',
    });
  });

  it('оба формата дают ОДНУ view-модель (различие DTO снято адаптером)', () => {
    assert.deepEqual(
      recordRowFromChronoHit(chronoHit()),
      recordRowFromRecordHit(recordHit()),
      'одинаковые данные двух форматов описываются одинаково — разметка строки общая',
    );
  });

  it('пустые привязки не подменяются владельцем (контракт 0.15.4)', () => {
    const model = recordRowFromRecordHit(recordHit({ targets: [] }));

    assert.deepEqual(model.targets, [], 'targets — как в ответе; владелец отдельным полем');
    assert.equal(model.ownerId, OWNER, 'владелец записи всё равно известен');
  });
});

/**
 * Минимальный DOM-шим для сборки строки: разметка, классы и конвейер сниппета
 * не требуют ни раскладки, ни меню. Привязок нет — облачка не строятся
 * (их вид проверяется GUI-стендом).
 */
function installMinimalDom(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  (globalThis as any).window = (globalThis as any).window ?? {};
}

describe('разметка строки-записи (0.15.4, задача 33ed043c)', () => {
  it('период — отдельный элемент с ТЕКСТОМ периода (а не имя класса вместо него)', () => {
    installMinimalDom();
    const handle = createRecordRow(
      {
        commentId: COMMENT,
        validFrom: FROM,
        validTo: TO,
        useTime: false,
        snippet: 'Текст записи без автоссылок.',
        targets: [],
        ownerType: 'thought',
        ownerId: OWNER,
      },
      {
        networkId: '00000000-0000-4000-8000-00000000000a',
        visibility: { homeId: null, showInactive: false, showTrash: false },
        onOpen: () => undefined,
      },
    );

    const period = handle.el.querySelector('.record-row-period');
    assert.ok(period !== null, 'класс `record-row-period` на элементе периода');
    const text = (period.textContent ?? '').trim();
    assert.ok(text !== '', 'период показан, а не пуст');
    assert.notEqual(
      text,
      'record-row-period',
      'текст периода — дата записи, а не имя класса (перепутанные аргументы span)',
    );
    assert.equal(handle.el.classList.contains('record-row'), true, 'корень строки — `.record-row`');
    handle.destroy();
  });

  it('сниппет выводится общим рендерером (`<mark>` подсветки сохраняется)', () => {
    installMinimalDom();
    const snippet = 'Проба <mark>zzchrono</mark> записи.';
    const handle = createRecordRow(
      {
        commentId: COMMENT,
        validFrom: FROM,
        validTo: TO,
        useTime: false,
        snippet,
        targets: [],
        ownerType: 'thought',
        ownerId: OWNER,
      },
      {
        networkId: '00000000-0000-4000-8000-00000000000a',
        visibility: { homeId: null, showInactive: false, showTrash: false },
        onOpen: () => undefined,
      },
    );

    const node = handle.el.querySelector('.record-row-snippet') as ShimElement | null;
    assert.ok(node !== null, 'класс `record-row-snippet` на элементе сниппета');
    assert.match(
      node.innerHTML,
      /<mark>zzchrono<\/mark>/u,
      'разметка серверного сниппета на месте',
    );
    handle.destroy();
  });
});
