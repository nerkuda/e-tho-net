/**
 * Композер фразы-превью отбора (задача 3cb50258, элемент ca905fbc; сценарии
 * 2a7648d8/3e97b648). Юнит-тесты чистых функций: лист, группы всех трёх
 * коннекций, вложенность со скобками, под-выборка свёрткой, хвост сортировки,
 * обрезка; плюс подключение к футеру (`preview` по умолчанию из композера).
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`): композер DOM не
 * трогает, но его соседи (конструктор модели, фасады футера) читают
 * `document`/`window` при сборке.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LinkType, NetworkProperty } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Минимальный DOM/window-шим, которого требуют фасады и модуль. */
function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win['innerWidth'] = 1200;
  win['innerHeight'] = 800;
  win['setTimeout'] = (fn: () => void) => {
    fn();
    return 1;
  };
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['matchMedia'] = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

type PhraseModule = typeof import('../src/renderer/lib/filter-phrase.js');

installShim();
const mod: PhraseModule = await import('../src/renderer/lib/filter-phrase.js');

// ---------------------------------------------------------------------------
// Данные сети
// ---------------------------------------------------------------------------

function prop(id: string, name: string, valueType: NetworkProperty['value_type']): NetworkProperty {
  return {
    id,
    network_id: 'n',
    name,
    value_type: valueType,
    config: null,
    description: null,
    created_at: '',
    updated_at: '',
  } as unknown as NetworkProperty;
}

const CITY = prop('p-city', 'Город', 'text');
const TERM = prop('p-term', 'Срок', 'date');
const PLACE = prop('p-place', 'Место', 'link');

/** Контекст композера: реестр свойств, без связей и типов мыслей. */
function ctx(overrides: Record<string, unknown> = {}): any {
  return {
    registry: new Map<string, NetworkProperty>([
      [CITY.id, CITY],
      [TERM.id, TERM],
      [PLACE.id, PLACE],
    ]),
    linkTypes: [] as LinkType[],
    ...overrides,
  };
}

/** Лист модели: операнд/оператор/значение. */
function leaf(entity: any, operator: any, value: any = { kind: 'none' }, extra: any = {}): any {
  return { kind: 'leaf', entity, operator, value, ...extra };
}

/** Группа модели. */
function group(op: 'and' | 'or' | 'not', children: any[]): any {
  return { kind: 'group', op, children };
}

// ---------------------------------------------------------------------------
// 1. Лист: операнд, оператор, значение
// ---------------------------------------------------------------------------

describe('композер фразы: лист условия', () => {
  it('свойство, булево и датовый диапазон читаются человекочитаемо', () => {
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'property', property_id: CITY.id }, 'eq', { kind: 'scalar', value: 'Москва' }), ctx()),
      'Город = Москва',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'active' }, 'eq', { kind: 'scalar', value: true }), ctx()),
      'Актуальность = да',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'property', property_id: TERM.id }, 'between', {
        kind: 'list',
        items: [{ token: '$monthStart' }, { token: '$monthEnd' }],
      }), ctx()),
      'Срок между начало месяца и конец месяца',
      'пара границ соединяется «и»',
    );
  });

  it('значение не требуется — фраза заканчивается оператором', () => {
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'attachments' }, 'not_empty'), ctx()),
      'Есть вложения заполнено',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'active' }, 'is_empty'), ctx()),
      'Актуальность не заполнено',
    );
  });

  it('предикат БЕЗ значения: «равно»/«не равно» не печатается (ошибка 696b3c3b п.9)', () => {
    // «Есть вложения равно И …» читалось как ошибка — у предиката без значения
    // оператор сравнения не выводится; операторы со смыслом в себе остаются.
    assert.equal(mod.filterPhraseLeaf(leaf({ kind: 'attachments' }, 'eq'), ctx()), 'Есть вложения');
    assert.equal(mod.filterPhraseLeaf(leaf({ kind: 'attachments' }, 'ne'), ctx()), 'Есть вложения');
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'attachments' }, 'not_empty'), ctx()),
      'Есть вложения заполнено',
      '«заполнено» — смысл оператора, он остаётся',
    );
  });

  it('состояния рёбер: полный набор — без суффикса, иначе список выбранных', () => {
    // Требование 60db9614: формат суффикса закрепляется здесь.
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'incoming_links' }, 'not_empty'), ctx()),
      'Есть входящие связи заполнено',
      'отсутствие states = все состояния — без суффикса',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'incoming_links', states: [] }, 'not_empty'), ctx()),
      'Есть входящие связи заполнено',
      'пустой states = все состояния — без суффикса',
    );
    assert.equal(
      mod.filterPhraseLeaf(
        leaf({ kind: 'incoming_links', states: ['active', 'inactive', 'trashed', 'not_trashed'] }, 'not_empty'),
        ctx(),
      ),
      'Есть входящие связи заполнено',
      'все четыре состояния — полный набор, без суффикса',
    );
    assert.equal(
      mod.filterPhraseLeaf(
        leaf({ kind: 'incoming_links', states: ['active', 'inactive', 'not_trashed'] }, 'not_empty'),
        ctx(),
      ),
      'Есть входящие связи заполнено (связи: актуальные, не актуальные, не в корзине)',
      'UI-дефолт виден во фразе',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'outgoing_links', states: ['trashed'] }, 'is_empty'), ctx()),
      'Есть исходящие связи не заполнено (связи: в корзине)',
      'выбранные состояния идут в порядке общего словаря',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'outgoing_links', states: ['inactive', 'active'] }, 'not_empty'), ctx()),
      'Есть исходящие связи заполнено (связи: актуальные, не актуальные)',
      'порядок суффикса не зависит от порядка в массиве',
    );
  });

  it('«Найти слова»: оператор не дублируется, области видны', () => {
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'keywords', scope: ['title'] }, 'matches', { kind: 'scalar', value: 'расход' }), ctx()),
      'Найти слова расход (в именах)',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'keywords', scope: ['title', 'synonyms'] }, 'matches', { kind: 'scalar', value: 'счёт' }), ctx()),
      'Найти слова счёт (в именах)',
      '«в именах» = имена и синонимы вместе, во фразе не дублируется',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'keywords', scope: [] }, 'matches', { kind: 'scalar', value: 'счёт' }), ctx()),
      'Найти слова счёт (области не выбраны)',
      'ни одной области — условие отключено, это видно во фразе',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'keywords', scope: ['diary'] }, 'matches', { kind: 'scalar', value: 'проект' }), ctx()),
      'Найти слова проект (в дневниках)',
      'новая область «в дневниках» (ошибка 2bc251de) отражается во фразе',
    );
    assert.equal(
      mod.filterPhraseLeaf(
        leaf({ kind: 'keywords', scope: ['comment', 'diary'] }, 'matches', { kind: 'scalar', value: 'проект' }),
        ctx(),
      ),
      'Найти слова проект (в комментарии, в дневниках)',
      'области идут в порядке словаря',
    );
  });

  it('режим обхода и количество видны во фразе', () => {
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'children' }, 'gt', { kind: 'scalar', value: 3 }), ctx()),
      'Потомки больше 3',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'parents' }, 'in_hierarchy', { kind: 'scalar', value: 't-1' }, { mode: 'all_links' }), ctx()),
      'Родители в иерархии t-1 (по всем связям)',
    );
  });

  it('под-выборка сворачивается: оператор листа не дублируется', () => {
    const inner = group('and', [
      leaf({ kind: 'property', property_id: CITY.id }, 'eq', { kind: 'scalar', value: 'Москва' }),
      leaf({ kind: 'active' }, 'eq', { kind: 'scalar', value: true }),
    ]);
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'parents' }, 'in', { kind: 'subquery', operator: 'in', node: inner }), ctx()),
      'Родители в выборке (2 условия)',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'parents' }, 'not_in', { kind: 'subquery', operator: 'not_in', node: inner }), ctx()),
      'Родители не в выборке (2 условия)',
    );
    const one = group('and', [leaf({ kind: 'active' }, 'eq', { kind: 'scalar', value: true })]);
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'targets' }, 'in', { kind: 'subquery', operator: 'all_in', node: one }), ctx()),
      'Цели записи все в выборке (1 условие)',
      'согласование числа условий',
    );
  });

  it('длинный набор значений сворачивается с остатком', () => {
    const long = leaf({ kind: 'property', property_id: CITY.id }, 'in', {
      kind: 'list',
      items: ['Москва', 'Питер', 'Казань', 'Сочи', 'Тверь'],
    });
    assert.equal(mod.filterPhraseLeaf(long, ctx()), 'Город в Москва, Питер, Казань и ещё 2');
  });
});

// ---------------------------------------------------------------------------
// 1б. Имена значений вместо id (ошибка 4258e694 п.12б)
// ---------------------------------------------------------------------------

describe('композер фразы: значения-ссылки — именами, а не id', () => {
  const TYPE_PROJECT = { id: 'tt-1', name: 'Проект' } as any;
  const TYPE_TASK = { id: 'tt-2', name: 'Задача развития проекта с очень длинным названием' } as any;
  const LINK_TYPE = { id: 'lt-1', name_forward: 'включает', name_reverse: 'входит' } as any;

  it('тип мысли и тип связи — имя из каталога контекста', () => {
    const c = ctx({ thoughtTypes: [TYPE_PROJECT], linkTypes: [LINK_TYPE] });
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'type' }, 'eq', { kind: 'scalar', value: 'tt-1' }), c),
      'Тип мысли = Проект',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'link_type' }, 'eq', { kind: 'scalar', value: 'lt-1' }), c),
      'Тип связи = включает',
    );
  });

  it('длинное имя обрезается по пределу с «…», не длиннее предела', () => {
    const c = ctx({ thoughtTypes: [TYPE_TASK] });
    const phrase = mod.filterPhraseLeaf(
      leaf({ kind: 'type' }, 'eq', { kind: 'scalar', value: 'tt-2' }),
      c,
    );
    assert.equal(phrase, 'Тип мысли = Задача развития проекта с…');
    assert.ok(phrase.includes('…'), 'обрезка помечена');
    // Имя во фразе не длиннее предела.
    const name = phrase.slice('Тип мысли = '.length);
    assert.ok(name.length <= mod.FILTER_PHRASE_NAME_LIMIT, `имя ${name.length} ≤ предела`);

    // Обрезка по границе слова; одиночное длинное слово — жёстко.
    assert.equal(mod.truncateFilterName('короткое имя'), 'короткое имя');
    assert.equal(mod.truncateFilterName('а'.repeat(40)), `${'а'.repeat(31)}…`);
    assert.equal(mod.truncateFilterName('а'.repeat(40)).length, 32);
  });

  it('снапшот labels.value сильнее каталога (прочитанное определение)', () => {
    const c = ctx({ thoughtTypes: [TYPE_PROJECT] });
    assert.equal(
      mod.filterPhraseLeaf(
        leaf({ kind: 'type' }, 'eq', { kind: 'scalar', value: 'tt-1' }, { labels: { value: 'Снимок имени' } }),
        c,
      ),
      'Тип мысли = Снимок имени',
    );
  });

  it('id мысли без резолвера имён — fallback остаётся id (деградация вызовов вне редактора)', () => {
    assert.equal(
      mod.filterPhraseLeaf(
        leaf({ kind: 'id' }, 'eq', { kind: 'scalar', value: '11111111-2222-3333-4444-555555555555' }),
        ctx(),
      ),
      'Мысль = 11111111-2222-3333-4444-5555555…',
      'резолвера нет — id тоже обрезается по пределу',
    );
    assert.equal(
      mod.filterPhraseLeaf(
        leaf({ kind: 'id' }, 'eq', { kind: 'scalar', value: '11111111-2222-3333-4444-555555555555' }, { labels: { value: 'Мысль про расход' } }),
        ctx(),
      ),
      'Мысль = Мысль про расход',
      'снапшот даёт человекочитаемое имя',
    );
  });

  it('ссылка на мысль — имя из резолвера thoughtName, а не UUID (ошибка d17a8bfd)', () => {
    const ID = '11111111-2222-3333-4444-555555555555';
    const c = ctx({ thoughtName: (id: string) => (id === ID ? 'Бюджет на квартал' : null) });
    // Все операнды-ссылки на мысль показываются именем.
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'id' }, 'eq', { kind: 'scalar', value: ID }), c),
      'Мысль = Бюджет на квартал',
    );
    assert.equal(
      mod.filterPhraseLeaf(
        leaf({ kind: 'parents' }, 'in_hierarchy', { kind: 'scalar', value: ID }, { mode: 'all_links' }),
        c,
      ),
      'Родители в иерархии Бюджет на квартал (по всем связям)',
      'условие из legacy-конверсии (parent_ids → «Родители в иерархии») без снапшотов',
    );
    assert.equal(
      mod.filterPhraseLeaf(leaf({ kind: 'targets' }, 'eq', { kind: 'scalar', value: ID }), c),
      'Цели записи = Бюджет на квартал',
    );
    // Список id мыслится каждым элементом.
    assert.equal(
      mod.filterPhraseLeaf(
        leaf({ kind: 'children' }, 'in', { kind: 'list', items: [ID, 'unknown-id-2'] }, { labels: { values: {} } }),
        c,
      ),
      'Потомки в Бюджет на квартал, без названия',
    );
  });

  it('значение свойства-ссылки (link|thought_ref) — тоже именем мысли', () => {
    const ID = '11111111-2222-3333-4444-555555555555';
    const c = ctx({ thoughtName: (id: string) => (id === ID ? 'Проект Альфа' : null) });
    // PLACE — свойство с value_type: link (см. ctx()).
    assert.equal(
      mod.filterPhraseLeaf(
        leaf({ kind: 'property', property_id: PLACE.id }, 'eq', { kind: 'scalar', value: ID }),
        c,
      ),
      'Место = Проект Альфа',
    );
    // Текстовое свойство именем мысли не подменяется (значение — свободный текст).
    assert.equal(
      mod.filterPhraseLeaf(
        leaf({ kind: 'property', property_id: CITY.id }, 'eq', { kind: 'scalar', value: 'Москва' }),
        c,
      ),
      'Город = Москва',
    );
  });

  it('резолвер есть, а имени нет — плейсхолдер без ID (требование 9d5e3c4e)', () => {
    // Ни сырого, ни обрезанного UUID во фразе быть не должно.
    const phrase = mod.filterPhraseLeaf(
      leaf({ kind: 'id' }, 'eq', { kind: 'scalar', value: '11111111-2222-3333-4444-555555555555' }),
      ctx({ thoughtName: () => null }),
    );
    assert.equal(phrase, 'Мысль = без названия');
    assert.ok(!/11111111|2222/.test(phrase), 'в фразе нет фрагментов UUID');
    assert.equal(
      mod.filterPhraseLeaf(
        leaf({ kind: 'parents' }, 'in_hierarchy', { kind: 'scalar', value: '56ce57bd-0000-0000-0000-000000000000' }),
        ctx({ thoughtName: () => null }),
      ),
      'Родители в иерархии без названия',
    );
  });

  it('снапшот labels.values сильнее резолвера (сохранённая подпись не подменяется)', () => {
    const ID = '11111111-2222-3333-4444-555555555555';
    assert.equal(
      mod.filterPhraseLeaf(
        leaf({ kind: 'id' }, 'eq', { kind: 'scalar', value: ID }, { labels: { values: { [ID]: 'Снимок мысли' } } }),
        ctx({ thoughtName: () => 'Свежее имя' }),
      ),
      'Мысль = Снимок мысли',
    );
  });

  it('список типов — имена каждого элемента', () => {
    const c = ctx({ thoughtTypes: [TYPE_PROJECT, { id: 'tt-3', name: 'Задача' }] });
    assert.equal(
      mod.filterPhraseLeaf(
        leaf({ kind: 'type' }, 'in', { kind: 'list', items: ['tt-1', 'tt-3'] }),
        c,
      ),
      'Тип мысли в Проект, Задача',
    );
  });

  it('карта labels.values даёт имя КАЖДОМУ значению набора (ошибка 4258e694 п.12б)', () => {
    // Множественный выбор мыслей набирается без каталога имён — имена берутся
    // из карты снапшотов; отсутствующий в карте id — fallback на id.
    assert.equal(
      mod.filterPhraseLeaf(
        leaf(
          { kind: 'id' },
          'in',
          { kind: 'list', items: ['aaa', 'bbb', 'ccc'] },
          { labels: { values: { aaa: 'Первая мысль', bbb: 'Вторая мысль' } } },
        ),
        ctx(),
      ),
      'Мысль в Первая мысль, Вторая мысль, ccc',
    );
  });

  it('карта labels.values читается из определения отбора (parseFilterDefinition)', () => {
    const definition = {
      version: 1,
      filter: {
        entity: { kind: 'id' },
        operator: 'in',
        value: ['aaa', 'bbb'],
        labels: { values: { aaa: 'Альфа', bbb: 'Браво' } },
      },
    };
    assert.equal(
      mod.composeFilterPhraseFromDefinition(definition, ctx()),
      'Мысль в Альфа, Браво',
    );
  });
});

// ---------------------------------------------------------------------------
// 1б. Пользователи — ИМЕНАМИ, а не id (ошибка 23c7d3e9 п. A1)
// ---------------------------------------------------------------------------

describe('композер фразы: пользователи показываются именами, а не id', () => {
  const IVAN = '867d98ad-2663-481b-b563-105ef7e00001';
  const PETR = '11112222-3333-4444-5555-666677778888';
  /** Кэш пользователей-заглушка: id → имя (без сети, как `lib/users.ts`). */
  const userCtx = (extra: Record<string, unknown> = {}): any =>
    ctx({
      userName: (id: string): string | null =>
        new Map([
          [IVAN, 'Иван Петров'],
          [PETR, 'Пётр Сидоров'],
        ]).get(id) ?? null,
      ...extra,
    });

  it('матрица операндов: автор, редактор, автор/редактор записи, автор события', () => {
    const cases: Array<{ entity: any; operator: any; value: any; expected: string }> = [
      { entity: { kind: 'author' }, operator: 'eq', value: { kind: 'scalar', value: IVAN }, expected: 'Автор = Иван Петров' },
      { entity: { kind: 'editor' }, operator: 'ne', value: { kind: 'scalar', value: PETR }, expected: 'Редактор ≠ Пётр Сидоров' },
      { entity: { kind: 'record_author' }, operator: 'eq', value: { kind: 'scalar', value: IVAN }, expected: 'Автор записи = Иван Петров' },
      { entity: { kind: 'record_editor' }, operator: 'eq', value: { kind: 'scalar', value: PETR }, expected: 'Редактор записи = Пётр Сидоров' },
      { entity: { kind: 'user' }, operator: 'eq', value: { kind: 'scalar', value: IVAN }, expected: 'Автор события = Иван Петров' },
    ];
    for (const item of cases) {
      assert.equal(
        mod.filterPhraseLeaf(leaf(item.entity, item.operator, item.value), userCtx()),
        item.expected,
        `id не должен просачиваться во фразу (${item.entity.kind})`,
      );
    }
  });

  it('набор пользователей и сохранённое определение — имена каждого значения', () => {
    assert.equal(
      mod.filterPhraseLeaf(
        leaf({ kind: 'author' }, 'in', { kind: 'list', items: [IVAN, PETR] }),
        userCtx(),
      ),
      'Автор в Иван Петров, Пётр Сидоров',
    );
    // Сохранённый отбор (фраза строится из wire-определения, без живого редактора).
    const definition = {
      version: 1,
      filter: { entity: { kind: 'editor' }, operator: 'eq', value: IVAN },
    };
    assert.equal(
      mod.composeFilterPhraseFromDefinition(definition, userCtx()),
      'Редактор = Иван Петров',
    );
  });

  it('без источника имён (резолвера нет) остаётся id — как было', () => {
    assert.match(
      mod.filterPhraseLeaf(
        leaf({ kind: 'author' }, 'eq', { kind: 'scalar', value: IVAN }),
        ctx(),
      ),
      /^Автор = 867d98ad/,
      'резолвера нет — прежняя деградация (id)',
    );
  });

  it('кэш есть, а участника в нём нет — плейсхолдер без ID (требование 9d5e3c4e)', () => {
    const phrase = mod.filterPhraseLeaf(
      leaf({ kind: 'author' }, 'eq', { kind: 'scalar', value: 'aabbccdd-0000-1111-2222-333344445555' }),
      userCtx(),
    );
    assert.equal(phrase, 'Автор = без имени');
    assert.ok(!/aabbccdd/.test(phrase), 'в фразе нет фрагмента UUID участника');
  });

  it('снапшот labels сильнее кэша, а токен `$user` печатается своим именем (не id)', () => {
    assert.equal(
      mod.filterPhraseLeaf(
        leaf(
          { kind: 'author' },
          'eq',
          { kind: 'scalar', value: IVAN },
          { labels: { value: 'Снимок автора' } },
        ),
        userCtx(),
      ),
      'Автор = Снимок автора',
      'сохранённая подпись значения не подменяется свежим кэшем',
    );
    assert.equal(
      mod.filterPhraseLeaf(
        leaf({ kind: 'author' }, 'eq', { kind: 'token', token: '$user' }),
        userCtx(),
      ),
      'Автор = $user',
      'токен читается токеном: подстановка в id пользователя здесь не участвует',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Группы: коннекции, вложенность, скобки
// ---------------------------------------------------------------------------

describe('композер фразы: группы и вложенность', () => {
  const a = leaf({ kind: 'active' }, 'eq', { kind: 'scalar', value: true });
  const b = leaf({ kind: 'trashed' }, 'eq', { kind: 'scalar', value: false });

  it('«И», «ИЛИ» и «НЕ» — операторы коннекции в верхнем регистре', () => {
    assert.equal(
      mod.filterPhraseNode(group('and', [a, b]), ctx()),
      'Актуальность = да И Помечено на удаление = нет',
    );
    assert.equal(
      mod.filterPhraseNode(group('or', [a, b]), ctx()),
      'Актуальность = да ИЛИ Помечено на удаление = нет',
    );
    assert.equal(mod.filterPhraseNode(group('not', [a]), ctx()), 'НЕ Актуальность = да');
    // Служебных префиксов «все условия»/«любое условие» больше нет (ошибка 4258e694 п.12а).
    for (const op of ['and', 'or'] as const) {
      assert.doesNotMatch(mod.filterPhraseNode(group(op, [a, b]), ctx()), /все условия|любое условие/);
    }
    // Одиночный ребёнок оператора не получает: группа без коннектора.
    assert.equal(mod.filterPhraseNode(group('and', [a]), ctx()), 'Актуальность = да');
  });

  it('вложенная группа с другой коннекцией берётся в скобки', () => {
    const nested = group('and', [group('or', [a, b]), leaf({ kind: 'comment' }, 'not_empty')]);
    assert.equal(
      mod.filterPhraseNode(nested, ctx()),
      '(Актуальность = да ИЛИ Помечено на удаление = нет) И Есть комментарий заполнено',
    );
    // Та же коннекция — без лишних скобок.
    const same = group('and', [group('and', [a, b]), leaf({ kind: 'comment' }, 'not_empty')]);
    assert.equal(
      mod.filterPhraseNode(same, ctx()),
      'Актуальность = да И Помечено на удаление = нет И Есть комментарий заполнено',
    );
  });

  it('пустая группа фразы не даёт', () => {
    assert.equal(mod.filterPhraseNode(group('and', []), ctx()), '');
    assert.equal(mod.composeFilterPhrase({ tree: group('and', []) }, ctx()), '');
    assert.equal(mod.composeFilterPhrase({ tree: null }, ctx()), '');
  });
});

// ---------------------------------------------------------------------------
// 3. Сортировка, обрезка, определение отбора
// ---------------------------------------------------------------------------

describe('композер фразы: хвост сортировки, обрезка и определение', () => {
  it('сортировка идёт хвостом через «;»', () => {
    assert.equal(
      mod.filterPhraseSort([
        { key: 'title', order: 'asc' },
        { key: 'created_at', order: 'desc' },
        { key: 'unknown_key', order: 'asc' },
      ]),
      'сортировка: по названию, по дате создания (убыв.), unknown_key',
    );
    assert.equal(mod.filterPhraseSort([]), '');
    assert.equal(mod.filterPhraseSort(undefined), '');
    // A7 (ошибка 50d9bf4e): ключ сортировки-свойство — его UUID, во фразе
    // показывается НАЗВАНИЕ свойства из реестра, а не id.
    assert.equal(
      mod.filterPhraseSort([{ key: CITY.id, order: 'asc' }], ctx().registry),
      'сортировка: Город',
    );
    const tree = group('and', [leaf({ kind: 'active' }, 'eq', { kind: 'scalar', value: true })]);
    assert.equal(
      mod.composeFilterPhrase({ tree, sortKeys: [{ key: 'created_at', order: 'desc' }] }, ctx()),
      'Актуальность = да; сортировка: по дате создания (убыв.)',
    );
  });

  it('длинная фраза обрезается по пределу с «…» (по границе слова)', () => {
    const tree = group('and', [
      leaf({ kind: 'property', property_id: CITY.id }, 'eq', { kind: 'scalar', value: 'Москва' }),
      leaf({ kind: 'property', property_id: TERM.id }, 'eq', { kind: 'scalar', value: '2026-01-31' }),
    ]);
    const full = mod.composeFilterPhrase({ tree }, ctx());
    const short = mod.composeFilterPhrase({ tree }, ctx({ limit: 30 }));
    assert.ok(short.length <= 30, 'предел соблюдён');
    assert.ok(short.endsWith('…'), 'обрезка помечена');
    assert.ok(full.startsWith(short.slice(0, -1).trimEnd()), 'обрезана именно та же фраза');
    assert.equal(mod.truncateFilterPhrase('короткая фраза', 50), 'короткая фраза');
    assert.equal(mod.truncateFilterPhrase('один два три четыре', 10), 'один два…');
  });

  it('фраза строится и из wire-определения отбора', () => {
    const definition = {
      version: 1,
      filter: {
        op: 'and',
        children: [
          { entity: { kind: 'active' }, operator: 'eq', value: true },
          { entity: { kind: 'property', property_id: CITY.id }, operator: 'eq', value: 'Москва' },
        ],
      },
      sort: [{ key: 'title', order: 'asc' }],
    };
    assert.equal(
      mod.composeFilterPhraseFromDefinition(definition, ctx()),
      'Актуальность = да И Город = Москва; сортировка: по названию',
    );
    assert.equal(mod.composeFilterPhraseFromDefinition(null, ctx()), '');
    assert.equal(mod.composeFilterPhraseFromDefinition({}, ctx()), '');
  });
});

// ---------------------------------------------------------------------------
// 4. Потребитель: футер — preview по умолчанию из композера
// ---------------------------------------------------------------------------

describe('композер фразы: футер берёт preview из композера', () => {
  it('фраза рисуется в превью футера, пустой отбор превью не подписывает', async () => {
    const { buildFilterFooter } = await import('../src/renderer/lib/filter-footer.js');
    const state: any = { tree: null, sortKeys: [] };
    const handle = buildFilterFooter({
      getName: () => 'мой отбор',
      setName: () => undefined,
      savedName: () => null,
      baseline: () => null,
      current: () => state,
      phrase: { state: () => state, phrase: ctx() },
      onSave: () => undefined,
      onApply: () => undefined,
      onClear: () => undefined,
    });
    const root = handle.root as unknown as ShimElement;
    const text = () => root.findAll((n) => n.classList.contains('ff-preview__text'))[0]!;
    assert.equal(text().flatText(), '', 'пустой отбор — превью не подписано');

    state.tree = group('and', [
      leaf({ kind: 'property', property_id: CITY.id }, 'eq', { kind: 'scalar', value: 'Москва' }),
    ]);
    state.sortKeys = [{ key: 'title', order: 'asc' }];
    handle.refresh();
    assert.equal(text().flatText(), 'Город = Москва; сортировка: по названию');

    state.tree = null;
    state.sortKeys = [];
    handle.refresh();
    assert.equal(text().flatText(), '', 'очистка отбора снимает фразу');
  });

  it('явный preview хоста сильнее композера', async () => {
    const { buildFilterFooter } = await import('../src/renderer/lib/filter-footer.js');
    const state: any = { tree: group('and', [leaf({ kind: 'active' }, 'eq', { kind: 'scalar', value: true })]) };
    const handle = buildFilterFooter({
      getName: () => '',
      setName: () => undefined,
      savedName: () => null,
      baseline: () => null,
      current: () => state,
      preview: () => ({ text: 'фраза хоста' }),
      phrase: { state: () => state, phrase: ctx() },
      onSave: () => undefined,
      onApply: () => undefined,
      onClear: () => undefined,
    });
    const root = handle.root as unknown as ShimElement;
    assert.equal(root.findAll((n) => n.classList.contains('ff-preview__text'))[0]!.flatText(), 'фраза хоста');
  });
});

// ---------------------------------------------------------------------------
// 4б. Разметка раскраски: операторы И/ИЛИ/НЕ и скобки уровней
// (правка заказчика 2026-10-14, п.12в; задача 58f77990)
// ---------------------------------------------------------------------------

describe('композер фразы: разметка раскраски (задача 58f77990)', () => {
  const a = leaf({ kind: 'active' }, 'eq', { kind: 'scalar', value: true });
  const b = leaf({ kind: 'trashed' }, 'eq', { kind: 'scalar', value: false });
  const comment = leaf({ kind: 'comment' }, 'not_empty');

  it('операторы и скобки — отдельные токены, а текст фразы не меняется', () => {
    const nested = group('and', [group('or', [a, b]), comment]);
    const tokens = mod.filterPhraseTokens({ tree: nested }, ctx());
    // Текстовая версия — конкатенация токенов: одна модель, две проекции.
    assert.equal(
      tokens.map((t) => t.text).join(''),
      '(Актуальность = да ИЛИ Помечено на удаление = нет) И Есть комментарий заполнено',
    );
    assert.equal(tokens.map((t) => t.text).join(''), mod.composeFilterPhrase({ tree: nested }, ctx()));
    const operators = tokens.filter((t) => t.kind === 'operator');
    assert.deepEqual(operators.map((t) => t.operator), ['or', 'and'], 'коннекторы — токены-операторы');
    assert.deepEqual(operators.map((t) => t.text), [' ИЛИ ', ' И ']);
    const parens = tokens.filter((t) => t.kind === 'paren');
    assert.deepEqual(parens.map((t) => t.text), ['(', ')'], 'скобка — самостоятельный токен');
    // Уровень вложенности группы — на скобках (тон считает представление,
    // источник цикла тонов — `lib/filter-tree.ts`).
    assert.deepEqual(parens.map((t) => t.depth), [1, 1], 'скобки несут уровень вложенности группы');
  });

  it('«НЕ» — оператор-префикс, у одиночного ребёнка коннектора нет', () => {
    const tokens = mod.filterPhraseTokens({ tree: group('not', [a]) }, ctx());
    assert.deepEqual(tokens[0], { kind: 'operator', text: 'НЕ ', operator: 'not' });
    assert.equal(tokens.map((t) => t.text).join(''), 'НЕ Актуальность = да');
    // Одиночный ребёнок группы «И» оператора не получает (п.12а).
    const single = mod.filterPhraseTokens({ tree: group('and', [a]) }, ctx());
    assert.deepEqual(single.map((t) => t.kind), ['text']);
  });

  it('скобки несут уровень вложенности, уровни растут по дереву', () => {
    // Пять уровней вложенности разных коннекций: каждая вложенная группа берётся
    // в скобки, уровень пары — глубина группы в дереве.
    let node: any = a;
    for (const op of ['and', 'or', 'and', 'or', 'and'] as const) node = group(op, [node]);
    const tokens = mod.filterPhraseTokens({ tree: node }, ctx());
    const opens = tokens.filter((t) => t.kind === 'paren' && t.text === '(').map((t) => t.depth);
    assert.deepEqual(opens, [1, 2, 3, 4], 'уровень вложенности растёт по дереву');
    // Открывающая и закрывающая скобки пары — один уровень (стек-алгоритм).
    const stack: number[] = [];
    for (const token of tokens) {
      if (token.kind !== 'paren') continue;
      if (token.text === '(') stack.push(token.depth!);
      else assert.equal(stack.pop(), token.depth, 'скобки пары — одного уровня');
    }
    assert.deepEqual(stack, [], 'все пары закрыты');
  });

  it('обрезка: токены режутся ДО раскраски, текстовый предел тот же', () => {
    const tree = group('and', [
      leaf({ kind: 'property', property_id: CITY.id }, 'eq', { kind: 'scalar', value: 'Москва' }),
      leaf({ kind: 'property', property_id: TERM.id }, 'eq', { kind: 'scalar', value: '2026-01-31' }),
    ]);
    const short = mod.composeFilterPhrase({ tree }, ctx({ limit: 30 }));
    const tokens = mod.filterPhraseTokens({ tree }, ctx({ limit: 30 }));
    assert.equal(tokens.map((t) => t.text).join(''), short, 'текст токенов = обрезанная фраза');
    assert.ok(short.length <= 30, 'предел соблюдён и в токенах');
    assert.ok(short.endsWith('…'), 'обрезка помечена');
    assert.equal(tokens[tokens.length - 1]!.text, '…', 'многоточие — свой токен, не часть тега');
    assert.equal(
      tokens.every((t) => t.kind === 'text' || t.text.length > 0),
      true,
      'пустых/разорванных токенов нет',
    );
    // Не обрезанная фраза: последний токен — не многоточие.
    const full = mod.filterPhraseTokens({ tree }, ctx());
    assert.notEqual(full[full.length - 1]!.text, '…');
  });

  it('вредоносное имя значения остаётся ТЕКСТОМ токена — разметки модель не несёт', () => {
    const evil = '<img src=x onerror="alert(1)">';
    const tokens = mod.filterPhraseTokens(
      {
        tree: group('and', [
          leaf({ kind: 'property', property_id: CITY.id }, 'eq', { kind: 'scalar', value: evil }),
        ]),
      },
      ctx(),
    );
    assert.equal(tokens.map((t) => t.text).join(''), `Город = ${evil}`);
    assert.deepEqual(tokens.map((t) => t.kind), ['text'], 'пользовательские данные — только текст');
  });

  it('сохранённое определение отбора тоже даёт токены раскраски', () => {
    const definition = {
      version: 1,
      filter: {
        op: 'and',
        children: [
          { entity: { kind: 'active' }, operator: 'eq', value: true },
          { entity: { kind: 'property', property_id: CITY.id }, operator: 'eq', value: 'Москва' },
        ],
      },
    };
    const tokens = mod.filterPhraseTokensFromDefinition(definition, ctx());
    assert.equal(
      tokens.map((t) => t.text).join(''),
      mod.composeFilterPhraseFromDefinition(definition, ctx()),
    );
    assert.deepEqual(tokens.filter((t) => t.kind === 'operator').map((t) => t.operator), ['and']);
    assert.deepEqual(mod.filterPhraseTokensFromDefinition(null, ctx()), []);
  });
});

// ---------------------------------------------------------------------------
// 5. Сбор id мыслей для догрузки имён (ошибка d17a8bfd)
// ---------------------------------------------------------------------------

describe('композер фразы: сбор id мыслей для догрузки имён', () => {
  it('собирает значения операндов-ссылок и свойств-ссылок, пропускает текст и токены', () => {
    const tree = group('and', [
      leaf({ kind: 'id' }, 'in', { kind: 'list', items: ['id-1', 'id-2'] }),
      leaf({ kind: 'parents' }, 'in_hierarchy', { kind: 'scalar', value: 'id-3' }),
      // Свойство-ссылка (PLACE — value_type: link) — id мысли.
      leaf({ kind: 'property', property_id: PLACE.id }, 'eq', { kind: 'scalar', value: 'id-4' }),
      // Текстовое свойство — свободный текст, не id мысли.
      leaf({ kind: 'property', property_id: CITY.id }, 'eq', { kind: 'scalar', value: 'Москва' }),
      // Тип мысли — каталог, не мысль.
      leaf({ kind: 'type' }, 'eq', { kind: 'scalar', value: 'tt-1' }),
      // Токен — не id.
      leaf({ kind: 'created_at' }, 'gte', { kind: 'token', token: '$monthStart' }),
    ]);
    assert.deepEqual(
      mod.filterPhraseThoughtIds({ tree }, ctx().registry).sort(),
      ['id-1', 'id-2', 'id-3', 'id-4'],
    );
  });

  it('заходит в под-выборку и схлопывает дубли; пустое дерево — пусто', () => {
    const inner = group('and', [leaf({ kind: 'id' }, 'in', { kind: 'list', items: ['id-9'] })]);
    const tree = group('and', [
      leaf({ kind: 'targets' }, 'in', { kind: 'subquery', operator: 'in', node: inner }),
      leaf({ kind: 'id' }, 'eq', { kind: 'scalar', value: 'id-9' }),
      leaf({ kind: 'id' }, 'eq', { kind: 'scalar', value: '' }),
    ]);
    assert.deepEqual(mod.filterPhraseThoughtIds({ tree }, ctx().registry), ['id-9']);
    assert.deepEqual(mod.filterPhraseThoughtIds({ tree: null }, ctx().registry), []);
    assert.deepEqual(mod.filterPhraseThoughtIds({}, ctx().registry), []);
  });
});
