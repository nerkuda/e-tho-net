/**
 * Единая фабрика встраивания редактора отбора (задача e5dd10ab, требование
 * 84b33a43; ТП 3e97b648 «Редактор: внедрение во все места»).
 *
 * Проверяется то, за что отвечает сборочная точка `lib/filter-editor.ts`:
 *   • профиль места применения подставляется в дерево, виджеты значений,
 *     модал под-выборки и композер фразы — ни одного места с «веткой кода»;
 *   • состав операндов, операторов и токенов соответствует реестру профилей
 *     (шесть мест: мысли, карта, публикации, дневник, события, вложения);
 *   • гранулярность времени: токены/единицы времени — только у профилей со
 *     временем (хроника, события);
 *   • колбэки хоста (apply/save/reset) и кнопки места подключены;
 *   • диагностика (записи ядра + проверки конструктора) видна в фразе и
 *     запирает применение;
 *   • `refresh` перечитывает вид из единой модели.
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FILTER_PROFILES, type FilterProfileId, type LinkType, type NetworkProperty } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

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

installShim();
const mod = await import('../src/renderer/lib/filter-editor.js');
const builder = await import('../src/renderer/lib/filter-builder.js');
const treeMod = await import('../src/renderer/lib/filter-tree.js');
const valueMod = await import('../src/renderer/lib/filter-value.js');
const diagnosticsMod = await import('../src/renderer/lib/filter-diagnostics.js');

/** Все профили реестра — шесть мест применения отбора (требование 0095daad). */
const ALL_PROFILES = Object.keys(FILTER_PROFILES) as FilterProfileId[];

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
const REGISTRY = new Map<string, NetworkProperty>([
  [CITY.id, CITY],
  [TERM.id, TERM],
]);
const DATA = { registry: REGISTRY, linkTypes: [] as LinkType[], thoughtTypes: [] };

/** Редактор одного места применения: пустая корневая группа + колбэки-шпионы. */
function buildEditor(profile: FilterProfileId, overrides: Record<string, unknown> = {}): any {
  const state = builder.defaultFilterCriteriaState();
  state.tree = builder.defaultFilterTreeGroup('and');
  const calls: string[] = [];
  const { host: hostOverrides, ...rest } = overrides as { host?: Record<string, unknown> };
  const host = {
    apply: (): void => {
      calls.push('apply');
    },
    save: (r: any): void => {
      calls.push(`save:${r.name}:${r.asCopy}`);
    },
    reset: (): void => {
      calls.push('reset');
    },
    ...(hostOverrides ?? {}),
  };
  const handle = mod.buildFilterEditor({
    profile,
    networkId: 'net-1',
    data: DATA,
    getState: () => state,
    touch: () => calls.push('touch'),
    host,
    ...rest,
  });
  return { handle, state, calls, host, root: handle.root as unknown as ShimElement };
}

/** Все потомки с точным классом. */
function all(root: ShimElement, cls: string): ShimElement[] {
  return root.findAll((n) => n.classList.contains(cls));
}

/** Первый потомок с точным классом. */
function one(root: ShimElement, cls: string): ShimElement | null {
  return all(root, cls)[0] ?? null;
}

/** Кнопка-потомок с точным текстом. */
function buttonByText(root: ShimElement, text: string): ShimElement | null {
  return (
    root
      .findAll((n) => n.tagName.toUpperCase() === 'BUTTON')
      .find((n) => n.flatText().trim() === text) ?? null
  );
}

// ---------------------------------------------------------------------------
// 1. Шесть мест применения: профиль — данные, состав — из реестра
// ---------------------------------------------------------------------------

describe('фабрика редактора: профиль места применения подставляется (84b33a43)', () => {
  it('каждое место собирает редактор своего профиля: заголовок, операнды, операторы', () => {
    for (const profile of ALL_PROFILES) {
      const { handle, root, state } = buildEditor(profile);
      assert.equal(handle.profile, profile, `${profile}: профиль в рукоятке`);

      // Профиль дошёл до дерева: заголовок «Показать <сущность> по условиям:».
      assert.equal(
        one(root, 'ft-title')?.flatText(),
        treeMod.filterTreeTitle(profile),
        `${profile}: профильный заголовок дерева`,
      );

      // «+ условие» добавляет ПЕРВЫЙ операнд профильного состава — то есть состав
      // списка «Что» идёт из реестра профилей, а не из константы места.
      const plus = one(root, 'ft-add-condition')!;
      plus.emit('click');
      const catalogue = treeMod.filterTreeOperandCatalogue(profile, DATA);
      const added = (state.tree as any).children[0];
      assert.ok(added !== undefined, `${profile}: условие добавлено`);
      assert.deepEqual(added.entity, catalogue[0]!.entity, `${profile}: первый операнд — из состава профиля`);
      assert.ok(
        builder.filterProfileOperands(profile).includes(added.entity.kind),
        `${profile}: вид операнда объявлен профилем`,
      );
    }
  });

  it('операнды сверх профиля не предлагаются: состав списка «Что» ⊆ реестр профиля', () => {
    for (const profile of ALL_PROFILES) {
      const allowed = new Set(builder.filterProfileOperands(profile));
      for (const entry of treeMod.filterTreeOperandCatalogue(profile, DATA)) {
        const kind = entry.entity.kind;
        // Свойства сети предлагаются там и только там, где профиль объявил
        // вид «property» (у хроники/событий/вложений — свой состав).
        if (kind === 'property') {
          assert.ok(allowed.has('property'), `${profile}: свойства сети не предложены без вида property`);
          continue;
        }
        assert.ok(allowed.has(kind), `${profile}: операнд ${kind} объявлен профилем`);
      }
    }
  });

  it('операторы каждого операнда — из реестра профиля (все шесть мест)', () => {
    for (const profile of ALL_PROFILES) {
      for (const entry of treeMod.filterTreeOperandCatalogue(profile, DATA)) {
        const valueType =
          entry.entity.kind === 'property'
            ? DATA.registry.get(entry.key)?.value_type
            : undefined;
        const allowed = new Set(builder.filterProfileOperators(profile, entry.entity.kind, valueType));
        const offered = treeMod
          .filterTreeOperatorMenu(profile, entry.entity.kind, valueType)
          .flatMap((section: any) => section.rows.flatMap((row: any) => row.cells.map((cell: any) => cell.op)));
        assert.ok(offered.length > 0, `${profile}/${entry.entity.kind}: операторы предложены`);
        for (const op of offered) {
          assert.ok(allowed.has(op), `${profile}/${entry.entity.kind}: ${op} допустим профилем`);
        }
      }
    }
  });

  it('гранулярность времени — свойство профиля: время только у хроники и событий', () => {
    for (const profile of ALL_PROFILES) {
      const withTime = FILTER_PROFILES[profile].withTime;
      const tokens = valueMod.filterValueTokenOptions({ profile }).map((t: any) => t.text);
      const units = valueMod.filterValueShiftUnits({ profile }).map((u: any) => u.key);
      assert.ok(tokens.includes('$today'), `${profile}: календарные токены есть везде`);
      assert.equal(tokens.includes('$now'), withTime, `${profile}: $now — по withTime`);
      assert.equal(units.includes('h'), withTime, `${profile}: часы — по withTime`);
      assert.equal(units.includes('mi'), withTime, `${profile}: минуты — по withTime`);
    }
  });

  it('ячейка значения датового листа показывает время по профилю места', () => {
    const dateEditor = (profile: FilterProfileId, kind: 'record_time' | 'created_at'): ShimElement => {
      const state = builder.defaultFilterCriteriaState();
      state.tree = builder.defaultFilterTreeGroup('and');
      state.tree.children.push({
        kind: 'leaf',
        entity: { kind },
        operator: 'gte',
        value: { kind: 'token', token: '$today' },
      });
      return buildEditor(profile, { getState: () => state }).root;
    };
    const anchorOptions = (root: ShimElement): string[] =>
      one(root, 'fv-date__anchor')!
        .findAll((n) => n.tagName.toUpperCase() === 'OPTION')
        .map((o) => o.value);

    assert.ok(
      anchorOptions(dateEditor('chronicle', 'record_time')).includes('$now'),
      'хроника: опора «сейчас» доступна',
    );
    assert.ok(
      !anchorOptions(dateEditor('thoughts', 'created_at')).includes('$now'),
      'календарное место: опоры времени нет',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Состав контейнера: дерево + сортировка + футер
// ---------------------------------------------------------------------------

describe('фабрика редактора: состав контейнера', () => {
  it('собирает дерево, секцию сортировки и футер одной точкой', () => {
    const { root } = buildEditor('thoughts');
    assert.ok(one(root, 'ft') !== null, 'дерево условий');
    assert.ok(one(root, 'fs-sort') !== null, 'секция сортировки — отдельное поле, не узел AST');
    assert.ok(one(root, 'ff') !== null, 'футер места применения');
    assert.match(root.className, /fe\b/, 'корень контейнера редактора');
  });

  it('сортировку и футер можно снять (модальные места соберут своё)', () => {
    const { root, calls } = buildEditor('thoughts', { sort: false, footer: false });
    assert.ok(one(root, 'ft') !== null, 'дерево на месте');
    assert.equal(one(root, 'fs-sort'), null, 'секции сортировки нет');
    assert.equal(one(root, 'ff'), null, 'футера нет');
    assert.deepEqual(calls, [], 'ничего лишнего не вызвано');
  });
});

// ---------------------------------------------------------------------------
// 3. Колбэки хоста и кнопки места
// ---------------------------------------------------------------------------

describe('фабрика редактора: колбэки хоста', () => {
  it('«Применить»/«Очистить» зовут колбэки хоста', () => {
    const { root, calls } = buildEditor('thoughts');
    buttonByText(root, 'Применить')!.emit('click');
    buttonByText(root, 'Очистить')!.emit('click');
    assert.deepEqual(calls, ['apply', 'reset']);
  });

  it('«Сохранить» отдаёт имя и признак копии (смена имени — копия)', () => {
    const { root, calls } = buildEditor('thoughts', {
      host: { savedName: () => 'старый отбор', getName: () => 'новый отбор' },
    });
    buttonByText(root, 'Сохранить')!.emit('click');
    assert.deepEqual(calls, ['save:новый отбор:true'], 'имя изменено — сохраняем копией');
  });

  it('кнопки места: свои кнопки вместо стандартного набора (модальные места)', () => {
    const { root, calls } = buildEditor('chronicle', {
      buttons: {
        standard: false,
        extra: [
          { id: 'done', label: 'Готово', role: 'primary', onClick: () => calls.push('done') },
          { id: 'cancel', label: 'Отмена', onClick: () => calls.push('cancel') },
        ],
      },
    });
    assert.equal(buttonByText(root, 'Применить'), null, 'стандартного набора нет');
    buttonByText(root, 'Готово')!.emit('click');
    assert.deepEqual(calls, ['done'], 'своя кнопка места работает');
  });

  it('правка дерева доходит до хоста через touch', () => {
    const { root, calls } = buildEditor('thoughts');
    one(root, 'ft-add-condition')!.emit('click');
    assert.ok(calls.includes('touch'), 'правка вида уведомляет хост');
  });
});

// ---------------------------------------------------------------------------
// 4. Диагностика: записи ядра + проверки конструктора
// ---------------------------------------------------------------------------

describe('фабрика редактора: диагностика запирает применение', () => {
  it('красная запись ядра помечает фразу и блокирует «Применить»', () => {
    const { root } = buildEditor('thoughts', {
      host: {
        issues: () => [
          {
            severity: 'error',
            source: 'server',
            code: 'entity_deleted',
            path: 'filter.children[0].entity',
            message: 'Свойство удалено из сети',
          },
        ],
      },
    });
    assert.equal(one(root, 'ff-preview')?.dataset['severity'], 'error', 'фраза окрашена');
    assert.equal(buttonByText(root, 'Применить')!.disabled, true, 'применение запрещено');
  });

  it('проверки конструктора попадают в диагностику без хоста', () => {
    // Условие без значения — проверка конструктора (не запирает применение,
    // но видна во фразе и в тултипе: причина в диагностике, а не в вёрстке).
    const state = builder.defaultFilterCriteriaState();
    state.tree = builder.defaultFilterTreeGroup('and');
    state.tree.children.push({
      kind: 'leaf',
      entity: { kind: 'property', property_id: CITY.id },
      operator: 'eq',
      value: { kind: 'none' },
    });
    const expectedIssues = diagnosticsMod.constructorFilterIssues(state.tree);
    assert.ok(expectedIssues.length > 0, 'конструктор нашёл незаполненное условие');

    const { root } = buildEditor('thoughts', { getState: () => state });
    assert.match(one(root, 'ff-preview__text')!.flatText(), /Город/, 'фраза построена');
    const tooltip = one(root, 'ff-preview')!.title;
    for (const issue of expectedIssues) {
      assert.ok(
        tooltip.includes(diagnosticsMod.filterIssueReason(issue)),
        'в тултипе фразы — причина проверки конструктора',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5. refresh: вид перечитывается из единой модели
// ---------------------------------------------------------------------------

describe('фабрика редактора: refresh из модели', () => {
  it('правка модели хостом видна после refresh', () => {
    const { handle, root, state } = buildEditor('thoughts');
    assert.equal(one(root, 'ft-row'), null, 'пока условий нет');
    state.tree.children.push({
      kind: 'leaf',
      entity: { kind: 'active' },
      operator: 'eq',
      value: { kind: 'scalar', value: true },
    });
    handle.refresh();
    assert.ok(one(root, 'ft-row') !== null, 'строка появилась');
    assert.match(one(root, 'ff-preview__text')!.flatText(), /Актуальность/, 'фраза обновилась');
  });
});
