/**
 * Сторож требования 9d5e3c4e «Списки выбора редактора отбора: представления
 * сущностей, без ID и технических кодов» (ошибка ba32a57a, часть 2) и
 * требования 3697eb65 «Где клиент вправе ПРЕДЛАГАТЬ `$thought*`».
 *
 * Правила:
 * 1. Подписи каталога токенов — представления предметной области: НЕТ слова
 *    `id`, нет UUID/сырых идентификаторов, нет технических кодов вида значения
 *    (`value_type`) — тип значения подаётся словарём `VALUE_TYPE_LABELS`.
 *    Проверяется ТОЧНЫЙ ожидаемый набор подписей полей мысли (а не подстрока
 *    «id»): так тест не хрупок к русским словам и ловит любую подмену текста.
 * 2. Фокусные токены мысли (`$thought*`) выдаются только при
 *    `withFocusThought` (признак МЕСТА) — юнит выше в `filter-tokens.test.ts`;
 *    здесь — сторож исходников: `withFocusThought: true` включается ТОЛЬКО в
 *    диалоге отбора типа мысли, единственном месте, исполняющем отбор
 *    относительно мысли-контекста.
 *
 * Сторож вводится зелёным (мета-стандарт «Правило без теста-сторожа
 * не считается введённым»).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { NetworkProperty } from '@etn/shared';

import { VALUE_TYPE_LABELS } from '../src/renderer/lib/property-list.js';
import {
  defaultFilterTreeLeaf,
  type FilterTreeLeaf,
} from '../src/renderer/lib/filter-builder.js';
import { filterLeafTokens } from '../src/renderer/lib/filter-tokens.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/** Единственное место, вправе предлагать токены `$thought*` (3697eb65). */
const FOCUS_PLACE = 'screens/thought-type/filter-dialog.ts';

/** Свойство реестра — минимум полей, нужных каталогу токенов. */
function prop(name: string, value_type: NetworkProperty['value_type']): NetworkProperty {
  return {
    id: `p-${name}`,
    name,
    value_type,
    config: null,
    description: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

const REGISTRY = new Map<string, NetworkProperty>([
  ['p-link', prop('Связь стенда', 'link')],
  ['p-num', prop('Вес стенда', 'number')],
  ['p-text', prop('Заметка стенда', 'text')],
]);

/** Контекст фокусного места (диалог отбора типа мысли). */
const CTX = { profile: 'thoughts' as const, data: { registry: REGISTRY }, withFocusThought: true };

/** Лист-условие по операнду. */
function leaf(kind: string): FilterTreeLeaf {
  return defaultFilterTreeLeaf({ kind } as FilterTreeLeaf['entity']);
}

/** Точный ожидаемый набор подписей полей мысли (требование 9d5e3c4e). */
const EXPECTED_FIELD_LABELS: readonly string[] = [
  '$thought — мысль-контекст отбора',
  '$thought.title — название мысли-контекста',
  '$thought.synonyms — синонимы мысли одной строкой',
  '$thought.type — тип мысли-контекста',
  '$thought.active — актуальность мысли-контекста',
  '$thought.author — автор мысли-контекста',
  '$thought.editor — последний редактор мысли',
  '$thought.created — дата создания мысли',
  '$thought.updated — дата изменения мысли',
];

describe('guard: подписи каталога токенов — представления, без ID и кодов (9d5e3c4e)', () => {
  it('точный набор подписей полей мысли (фокусное место)', () => {
    // Природа «context» (свойство вне реестра) отдаёт полный набор полей мысли.
    const unknownProperty = defaultFilterTreeLeaf({
      kind: 'property',
      property_id: 'нет-такого-свойства',
    });
    const fieldLabels = filterLeafTokens(unknownProperty, CTX)
      .filter((t) => t.text.startsWith('$thought') && !t.text.includes('['))
      .map((t) => t.label);
    assert.deepEqual(fieldLabels, EXPECTED_FIELD_LABELS);
  });

  it('ссылочный операнд несёт ровно фокусную мысль и свойства-ссылки', () => {
    const labels = filterLeafTokens(leaf('id'), CTX).map((t) => t.label);
    assert.deepEqual(labels, [
      '$thought — мысль-контекст отбора',
      '$thought.[Связь стенда] — значение свойства «Связь стенда», связь',
    ]);
    // «Тип мысли» — ровно один токен, и он подписан «тип мысли-контекста».
    assert.deepEqual(
      filterLeafTokens(leaf('type'), CTX).map((t) => t.label),
      ['$thought.type — тип мысли-контекста'],
    );
  });

  it('в подписях каталога нет слова «id», UUID и технических кодов вида значения', () => {
    // Широкий проход: все операнды профиля мыслей + свойства всех видов.
    const kinds = [
      'id',
      'parents',
      'children',
      'targets',
      'owner',
      'entity_id',
      'type',
      'link_type',
      'author',
      'editor',
      'created_at',
      'updated_at',
      'name',
      'kind',
      'size',
      'active',
    ];
    const labels: string[] = [];
    for (const kind of kinds) {
      for (const ctx of [CTX, { ...CTX, withFocusThought: false }]) {
        for (const token of filterLeafTokens(leaf(kind), ctx)) labels.push(token.label);
      }
    }
    for (const id of ['p-link', 'p-num', 'p-text']) {
      labels.push(
        ...filterLeafTokens(
          defaultFilterTreeLeaf({ kind: 'property', property_id: id }),
          CTX,
        ).map((t) => t.label),
      );
    }
    assert.ok(labels.length > 0, 'каталог токенов не должен быть пустым');
    for (const label of labels) {
      assert.doesNotMatch(label, /\bid\b/i, `в подписи «${label}» есть слово «id»`);
      assert.doesNotMatch(
        label,
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
        `в подписи «${label}» сырой UUID`,
      );
    }
  });

  it('тип значения свойства подан словарём VALUE_TYPE_LABELS, а не кодом', () => {
    const linkToken = filterLeafTokens(
      defaultFilterTreeLeaf({ kind: 'property', property_id: 'p-link' }),
      CTX,
    ).find((t) => t.text === '$thought.[Связь стенда]');
    assert.ok(linkToken !== undefined, 'токен свойства-связи обязан быть');
    assert.ok(
      linkToken.label.includes(VALUE_TYPE_LABELS.link),
      `подпись обязана несть человеческий тип «${VALUE_TYPE_LABELS.link}»`,
    );
    assert.ok(!linkToken.label.includes('(link)'), 'код value_type в подписи недопустим');
  });
});

describe('guard: фокусные токены включаются только фокусным местом (3697eb65)', () => {
  it('`withFocusThought: true` только в диалоге отбора типа мысли', async () => {
    const { collectViolations } = await import('./guard-helpers.js');
    const violations = collectViolations(RENDERER_ROOT, [
      {
        name: 'focus-thought-only-in-type-dialog',
        description:
          'Признак места `withFocusThought: true` включается только в диалоге ' +
          'отбора типа мысли — единственном месте, где сервер исполняет отбор ' +
          'относительно мысли-контекста (требование 3697eb65)',
        pattern: /\bwithFocusThought\s*:\s*true\b/,
        include: (rel) => rel !== FOCUS_PLACE,
      },
    ]);
    assert.deepEqual(violations, []);
  });
});
