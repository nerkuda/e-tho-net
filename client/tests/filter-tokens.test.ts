/**
 * Тесты каталога токенов контекста редактора отбора (ошибка 50d9bf4e, пункты
 * A3–A6). Проверяется чистый слой без GUI:
 *
 *   • A3 — токены доступны не только свойствам, но и типовым операндам
 *     («Родители», «Тип мысли», «Мысль») там, где семантика допускает;
 *   • A4 — набор отсекается по природе значения (ссылке не предлагаются даты);
 *   • A5 — нет дублей, у полей мысли есть пояснения для поиска;
 *   • A6 — `$thought.[Свойство]` предлагаются для ВСЕХ свойств реестра сети.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NetworkProperty } from '@etn/shared';

import {
  defaultFilterTreeLeaf,
  type FilterTreeLeaf,
} from '../src/renderer/lib/filter-builder.js';
import {
  buildTokensForField,
  filterTokenNature,
  filterLeafTokens,
  filterTokenOptions,
} from '../src/renderer/lib/filter-tokens.js';

/** Свойство реестра — минимум полей, нужных каталогу токенов. */
function prop(name: string, value_type: NetworkProperty['value_type'], multiple = false): NetworkProperty {
  return {
    id: `p-${name}`,
    name,
    value_type,
    config: multiple ? { multiple: true } : null,
    description: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

const REGISTRY = new Map<string, NetworkProperty>([
  ['p-link', prop('Место покупки', 'link')],
  ['p-date', prop('Плановый срок', 'date')],
  ['p-text', prop('Заметка', 'text')],
  ['p-text-multi', prop('Теги', 'text', true)],
  ['p-num', prop('Вес', 'number')],
]);

/** Контекст токенов ФОКУСНОГО места (диалог отбора типа мысли, профиль «мысли»). */
const CTX = { profile: 'thoughts' as const, data: { registry: REGISTRY }, withFocusThought: true };

/** Контекст СЕТЕВОГО места того же профиля — без мысли-контекста (панель, поиск). */
const CTX_NO_FOCUS = { profile: 'thoughts' as const, data: { registry: REGISTRY } };

/** Лист-условие по операнду с оператором. */
function leaf(kind: string, operator = 'eq'): FilterTreeLeaf {
  return { ...defaultFilterTreeLeaf({ kind } as FilterTreeLeaf['entity']), operator: operator as FilterTreeLeaf['operator'] };
}

describe('каталог токенов редактора отбора (50d9bf4e A3–A6)', () => {
  it('A3: ссылочные типовые операнды получают $thought', () => {
    for (const kind of ['id', 'parents', 'children', 'targets']) {
      const texts = filterLeafTokens(leaf(kind), CTX).map((t) => t.text);
      assert.ok(texts.includes('$thought'), `${kind}: ожидался $thought`);
    }
    // «Тип мысли» — токен типа, а не id мысли.
    assert.ok(filterLeafTokens(leaf('type'), CTX).some((t) => t.text === '$thought.type'));
  });

  it('A4: природа значения отсекает нерелевантные токены', () => {
    // Свойство-связь: id мысли — да, датовые/периоды — нет.
    const linkTexts = filterLeafTokens({ ...defaultFilterTreeLeaf({ kind: 'property', property_id: 'p-link' }) }, CTX).map((t) => t.text);
    assert.ok(linkTexts.includes('$thought'));
    assert.ok(!linkTexts.includes('$today'));
    assert.ok(!linkTexts.includes('$now'));
    // Датовое свойство: поля даты мысли — да, но `$today` не дублируется (опоры даёт другой источник).
    const dateTexts = filterLeafTokens({ ...defaultFilterTreeLeaf({ kind: 'property', property_id: 'p-date' }) }, CTX).map((t) => t.text);
    assert.ok(dateTexts.includes('$thought.created'));
    assert.ok(!dateTexts.includes('$today'));
    // Числовое свойство: числовые свойства реестра — да, глобальные/датовые — нет.
    const numTexts = filterLeafTokens({ ...defaultFilterTreeLeaf({ kind: 'property', property_id: 'p-num' }) }, CTX).map((t) => t.text);
    assert.ok(numTexts.includes('$thought.[Вес]'));
    assert.ok(!numTexts.includes('$today'));
    assert.ok(!numTexts.includes('$thought.created'));
  });

  it('A5: без дублей, у полей мысли есть пояснения', () => {
    const tokens = filterLeafTokens(leaf('id'), CTX);
    const texts = tokens.map((t) => t.text);
    assert.equal(new Set(texts).size, texts.length, 'дубли токенов');
    const title = filterLeafTokens({ ...defaultFilterTreeLeaf({ kind: 'property', property_id: 'p-text' }) }, CTX).find(
      (t) => t.text === '$thought.title',
    );
    assert.ok(title !== undefined && title.label.includes('название'), 'нужно пояснение у $thought.title');
    // Живой поиск находит токен по пояснению (как датовые).
    assert.ok(
      filterTokenOptions(
        filterLeafTokens({ ...defaultFilterTreeLeaf({ kind: 'property', property_id: 'p-text' }) }, CTX),
        'синонимы',
      ).some((t) => t.text === '$thought.synonyms'),
    );
  });

  it('A6: свойства предлагаются по всему реестру сети, отсечённые по природе', () => {
    // Текстовому значению — текстовые свойства реестра; датовые/числовые отсеяны.
    const textTexts = filterLeafTokens({ ...defaultFilterTreeLeaf({ kind: 'property', property_id: 'p-text' }) }, CTX).map((t) => t.text);
    assert.ok(textTexts.includes('$thought.[Заметка]'));
    assert.ok(!textTexts.includes('$thought.[Плановый срок]'));
    // Ссылочному операнду «Мысль» — свойства-ссылки реестра.
    assert.ok(filterLeafTokens(leaf('id'), CTX).some((t) => t.text === '$thought.[Место покупки]'));
    // Множественное текстовое свойство помечено listOnly.
    const listed = buildTokensForField([], 'text', 'eq', [
      { name: 'Теги', value_type: 'text', multiple: true },
    ]).find((t) => t.text === '$thought.[Теги]');
    assert.equal(listed?.listOnly, true);
  });

  it('природа листа выводится из операнда/свойства', () => {
    assert.equal(filterTokenNature(leaf('parents'), CTX), 'thought-id');
    assert.equal(filterTokenNature(leaf('type'), CTX), 'thought-type');
    assert.equal(filterTokenNature(leaf('record_time'), CTX), 'date');
    assert.equal(
      filterTokenNature({ ...defaultFilterTreeLeaf({ kind: 'property', property_id: 'p-date' }) }, CTX),
      'date',
    );
    assert.equal(filterTokenNature(leaf('size'), CTX), 'number');
  });
});

describe('фокусные токены мысли — по признаку места (требование 3697eb65)', () => {
  it('без контекста мысли не отдаётся НИ ОДНОГО токена $thought*', () => {
    // Сетевые точки профиля «мысли» (панель «Структур», строка поиска) и
    // прочие экраны: сервер токенов мысли не разрешает, подсказка была бы
    // молча неисполнимым отбором (класс ошибки 23c7d3e9 п. C3).
    for (const kind of ['id', 'parents', 'children', 'targets', 'type']) {
      const texts = filterLeafTokens(leaf(kind), CTX_NO_FOCUS).map((t) => t.text);
      assert.equal(
        texts.filter((text) => text.startsWith('$thought')).length,
        0,
        `${kind}: фокусные токены вне мысли-контекста запрещены`,
      );
    }
    // Свойства реестра — тоже `$thought.[…]`: без фокуса их нет.
    const propTexts = filterLeafTokens(
      { ...defaultFilterTreeLeaf({ kind: 'property', property_id: 'p-text' }) },
      CTX_NO_FOCUS,
    ).map((t) => t.text);
    assert.equal(propTexts.filter((text) => text.startsWith('$thought')).length, 0);
    // Датовый лист без фокуса не оставляет и «полей даты мысли» — только пусто.
    assert.deepEqual(
      filterLeafTokens({ ...defaultFilterTreeLeaf({ kind: 'property', property_id: 'p-date' }) }, CTX_NO_FOCUS),
      [],
    );
  });

  it('с контекстом мысли отдаётся полный набор полей', () => {
    const texts = filterLeafTokens(leaf('id'), CTX).map((t) => t.text);
    assert.ok(texts.includes('$thought'), 'фокусное место: $thought на месте');
    const typeTexts = filterLeafTokens(leaf('type'), CTX).map((t) => t.text);
    assert.ok(typeTexts.includes('$thought.type'), 'фокусное место: $thought.type на месте');
  });
});
