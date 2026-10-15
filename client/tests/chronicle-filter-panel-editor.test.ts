/**
 * Тесты панели отбора «Дневника» после пересборки на единый редактор
 * (задача 608ecb79, требование 0582f863, ADR fc23f9c1).
 *
 * Доказательства требуемого поведения:
 *   * панель собирается общей фабрикой редактора с профилем `chronicle`
 *     (со временем) — спец-полей «Период»/«Цели» в экране нет;
 *   * период читается и пишется строкой «Время записи» дерева (календарь и
 *     диалог даты работают через `chroniclePeriod`/`setChroniclePeriod`);
 *   * прежний ПЛОСКИЙ отбор «Дневника» (definition v1) читается компиляцией:
 *     период → «Время записи», `targets` → под-выборка «Цели в выборке»
 *     (единый конвертер мыслей), автор → «Автор записи», `keywords` →
 *     двухпутевая группа ИЛИ (текст записи ИЛИ мысли-цели) — решение
 *     оркестратора 2026-10-12;
 *   * запрос уходит ДЕРЕВОМ (`ast`), плоских критериев рядом нет: тело-дерево и
 *     плоские поля вместе сервер отвергает (XOR), а период подменяется В ДЕРЕВЕ.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { buildChronicleKeywordGroup, type StructureKeywordScope } from '@etn/shared';

import { filterTreeToAst, type FilterTreeNode } from '../src/renderer/lib/filter-builder.js';

const RENDERER = 'src/renderer';

type Leaf = {
  kind: 'leaf';
  entity: { kind: string; scope?: string[] };
  operator: string;
  value: { kind: string; value?: unknown; items?: unknown[]; node?: TreeNode; operator?: string };
  mode?: string;
};
type Group = { kind: 'group'; op: string; children: TreeNode[] };
type TreeNode = Leaf | Group;

function leaves(node: TreeNode | null | undefined, out: Leaf[] = []): Leaf[] {
  if (node === null || node === undefined) return out;
  if (node.kind === 'leaf') out.push(node);
  else for (const child of node.children) leaves(child, out);
  return out;
}

async function panelModule(): Promise<typeof import('../src/renderer/screens/chronicle/filter-panel.js')> {
  return import('../src/renderer/screens/chronicle/filter-panel.js');
}

/** Группа ключевых слов (ИЛИ) в корне дерева отбора. */
function keywordGroupOf(tree: unknown): Group {
  const root = tree as Group | null | undefined;
  assert.equal(root?.kind, 'group', 'корень — группа');
  const group = root!.children.find(
    (child): child is Group => child.kind === 'group' && child.op === 'or',
  );
  assert.notEqual(group, undefined, 'группа ИЛИ ключевых слов собрана');
  return group!;
}

/** Тело панели (сериализованное дерево) → узел AST для сверки с конструктором. */
function astOf(node: unknown): ReturnType<typeof filterTreeToAst> {
  return filterTreeToAst(node as FilterTreeNode);
}

describe('панель «Дневника» — единый редактор отбора (задача 608ecb79)', () => {
  it('вид строит общая фабрика с профилем `chronicle` (со временем)', async () => {
    const panel = await panelModule();
    assert.equal(panel.FILTER_PROFILE, 'chronicle');
    const fs = await import('node:fs');
    const src = fs.readFileSync(`${RENDERER}/screens/chronicle/filter-panel.ts`, 'utf8');
    assert.match(src, /buildFilterEditor\(\{/, 'панель собирается фабрикой');
    for (const gone of ['periodSection', 'targetsParentsSection', 'buildPeriodEditor', "mode: 'presets'"]) {
      assert.ok(!src.includes(gone), `спец-поле «${gone}» из экрана убрано`);
    }
  });

  it('период живёт строкой «Время записи»: чтение и запись из дерева', async () => {
    const panel = await panelModule();
    let state = panel.getFilterState();
    state = panel.applyChroniclePeriod(state, '$monthStart', '$monthEnd');
    assert.deepEqual(panel.chroniclePeriod(state), { from: '$monthStart', to: '$monthEnd' });
    const rows = leaves(state.tree);
    const time = rows.filter((leaf) => leaf.entity.kind === 'record_time');
    assert.equal(time.length, 1, 'условие времени одно');
    assert.equal(time[0]!.operator, 'between');
    // Одиночная граница — `gte`, обе пустые — условия времени нет.
    assert.deepEqual(panel.chroniclePeriod(panel.applyChroniclePeriod(state, '$today', '')), {
      from: '$today',
      to: '',
    });
    assert.deepEqual(panel.chroniclePeriod(panel.applyChroniclePeriod(state, '', '')), {
      from: '',
      to: '',
    });
  });

  it('запрос уходит деревом: AST есть, плоских критериев нет, период подменяется в дереве', async () => {
    const panel = await panelModule();
    let state = panel.getFilterState();
    state = panel.applyChroniclePeriod(state, '$monthStart', '$monthEnd');
    const saved = { ...state };
    // Панель хранит состояние в модели — определения строятся из него чистыми
    // функциями (в тесте состояние не меняется глобально: проверяем helpers).
    const flatKeys = ['date_from', 'date_to', 'keywords', 'targets'];
    // Определение для запроса/сохранения несёт ТОЛЬКО дерево и порядок: плоских
    // критериев рядом нет (сервер отвергает `ast` и плоские поля одновременно).
    const def = panel.chronicleDefinition();
    assert.notEqual(def.ast, undefined, 'отбор уходит телом-деревом');
    for (const key of flatKeys) {
      assert.ok(!Object.prototype.hasOwnProperty.call(def, key), `плоское поле «${key}» не отправляется`);
    }
    assert.deepEqual(Object.keys(def).sort(), ['ast', 'order'], 'в теле только дерево и порядок');
    assert.ok(saved.tree !== undefined, 'период остался в дереве модели');
  });

  it('прежний плоский отбор (v1) читается компиляцией: период, цели-подвыборка, автор, слова', async () => {
    const panel = await panelModule();
    const restored = panel.readFilterDefinition({
      date_from: '$monthStart',
      date_to: '$monthEnd',
      created_by: '00000000-0000-4000-8000-0000000000aa',
      keywords: 'кофе* -чай',
      keyword_scope: ['title', 'synonyms'],
      targets: {
        parent_ids: ['11111111-1111-4111-8111-111111111111'],
        type_ids: ['22222222-2222-4222-8222-222222222222'],
      },
      order: 'desc',
    });
    const rows = leaves(restored.tree);
    const time = rows.find((leaf) => leaf.entity.kind === 'record_time');
    assert.equal(time?.operator, 'between');
    assert.deepEqual(time?.value.items, ['$monthStart', '$monthEnd']);
    const author = rows.find((leaf) => leaf.entity.kind === 'record_author');
    assert.equal(author?.value.value, '00000000-0000-4000-8000-0000000000aa');

    // Цели — строка «в выборке» с под-выборкой мыслей (единый конвертер мыслей).
    const goals = rows.find((leaf) => leaf.entity.kind === 'targets');
    assert.equal(goals?.operator, 'in', 'семантика «хотя бы одна цель удовлетворяет»');
    assert.equal(goals?.value.kind, 'subquery');
    const goalRows = leaves(goals?.value.node ?? null);
    assert.ok(
      goalRows.some(
        (leaf) => leaf.entity.kind === 'parents' && leaf.operator === 'in_hierarchy',
      ),
      'прежние «Родительские мысли» целей → строка «в иерархии»',
    );
    assert.ok(goalRows.some((leaf) => leaf.entity.kind === 'type'), 'типы мыслей целей на месте');

    // Ключевые слова — двухпутевая группа ИЛИ. Области ['title','synonyms'] в
    // комментарий не входят, поэтому ТЕКСТОВЫЙ путь Б (тело/заголовок записи)
    // выключен — остаётся только мыслевый путь А (БЛОКЕР 1, задача 608ecb79).
    const orGroup = keywordGroupOf(restored.tree);
    const textPath = leaves(orGroup).filter(
      (leaf) => leaf.entity.kind === 'record_body' || leaf.entity.kind === 'record_title',
    );
    assert.equal(textPath.length, 0, 'без области comment пути Б (текст записи) нет');
    const thoughtPath = leaves(orGroup).find((leaf) => leaf.entity.kind === 'targets');
    const innerKeywords = leaves(thoughtPath?.value.node ?? null).find(
      (leaf) => leaf.entity.kind === 'keywords',
    );
    assert.equal(innerKeywords?.value.value, 'кофе* -чай', 'путь А: слова по мыслям-целям');
    assert.deepEqual(innerKeywords?.entity.scope, ['title', 'synonyms'], 'области поиска перенесены');
    // Тело конструктора панели для этих слов/областей — РОВНО общий конструктор
    // ключевых слов, который исполняет серверный тест паритета
    // (chronicle-panel-parity): панель и плоское тело дают один набор.
    assert.deepEqual(
      astOf(orGroup),
      buildChronicleKeywordGroup('кофе* -чай', ['title', 'synonyms']),
      'тело конструктора панели = общий конструктор ключевых слов',
    );
    assert.equal(restored.order, 'desc', 'направление ленты прочитано');
  });

  it('период записи — неудаляемая строка: определение без листа времени не теряет её (ошибка 68023851 п.3)', async () => {
    const panel = await panelModule();
    // Определение без листа `record_time` (легаси/импорт): читатель периода не несёт.
    const noPeriod = panel.readFilterDefinition({ trashed: false, order: 'desc' });
    assert.deepEqual(panel.chroniclePeriod(noPeriod), { from: '', to: '' }, 'периода в определении нет');
    // Восстанавливаем текущие границы — строка-замок периода не пропадает.
    const restored = panel.ensureChroniclePeriod(noPeriod, '$monthStart', '$today');
    assert.deepEqual(
      panel.chroniclePeriod(restored),
      { from: '$monthStart', to: '$today' },
      'строка периода восстановлена из текущих границ',
    );
    // Определение С периодом сохраняет своё значение, а текущее его не перебивает.
    const withPeriod = panel.readFilterDefinition({ date_from: '$weekStart', date_to: '$today' });
    const kept = panel.ensureChroniclePeriod(withPeriod, '$monthStart', '$monthEnd');
    assert.deepEqual(
      panel.chroniclePeriod(kept),
      { from: '$weekStart', to: '$today' },
      'период определения не подменяется текущим',
    );
  });

  it('БЛОКЕР 1: текстовый путь включается областью comment (пустой набор — все)', async () => {
    const panel = await panelModule();
    const cases: Array<[string, StructureKeywordScope[]]> = [
      ['продукты', ['comment']],
      ['продукты', []],
      ['продукты', ['title', 'synonyms']],
    ];
    const bodyOf = (scope: StructureKeywordScope[]): number =>
      leaves(keywordGroupOf(panel.readFilterDefinition({ keywords: 'продукты', keyword_scope: scope }).tree)).filter(
        (leaf) => leaf.entity.kind === 'record_body',
      ).length;
    assert.ok(bodyOf(['comment']) > 0, 'область comment — путь Б есть');
    assert.ok(bodyOf([]) > 0, 'пустой набор = все области — путь Б есть');
    assert.equal(bodyOf(['title', 'synonyms']), 0, 'набор без comment путь Б выключает');
    // Во всех трёх случаях панель строит РОВНО общий конструктор.
    for (const [keywords, scope] of cases) {
      const group = keywordGroupOf(panel.readFilterDefinition({ keywords, keyword_scope: scope }).tree);
      assert.deepEqual(astOf(group), buildChronicleKeywordGroup(keywords, scope), `области ${JSON.stringify(scope)}`);
    }
  });

  it('БЛОКЕР 2: пословная группировка — на каждое слово ИЛИ(тело, заголовок), исключение НЕ(...)', async () => {
    const panel = await panelModule();
    const group = keywordGroupOf(
      panel.readFilterDefinition({ keywords: 'кофе* -чай', keyword_scope: ['comment'] }).tree,
    );
    assert.deepEqual(astOf(group), buildChronicleKeywordGroup('кофе* -чай', ['comment']));
    const bodyLeaves = leaves(group).filter((leaf) => leaf.entity.kind === 'record_body');
    assert.deepEqual(
      bodyLeaves.map((leaf) => leaf.value.value),
      ['кофе*', 'чай'],
      'на каждое слово — свой лист (а не одно общее значение на оба пути)',
    );
    assert.ok(
      bodyLeaves.every((leaf) => leaf.operator === 'matches' && leaf.entity.scope === undefined),
      'слово пути Б — «есть слова» без областей',
    );
    assert.ok(
      leaves(group).some((leaf) => leaf.entity.kind === 'targets' && leaf.operator === 'not_empty'),
      'путь Б привязан к «цели не пусты»',
    );
  });

  it('AST-форма определения читается единым конвертером (повторное открытие)', async () => {
    const panel = await panelModule();
    const flat = panel.readFilterDefinition({ date_from: '$today', date_to: '$today' });
    const astState = panel.readFilterDefinition({
      version: 1,
      filter: {
        op: 'and',
        children: [
          {
            entity: { kind: 'record_time' },
            operator: 'between',
            value: ['2026-10-01', '2026-10-31'],
          },
        ],
      },
    });
    assert.deepEqual(panel.chroniclePeriod(astState), { from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(panel.chroniclePeriod(flat), { from: '$today', to: '$today' });
  });

  it('пустое дерево: отбор без условий, но AST валиден (пустая группа И)', async () => {
    const panel = await panelModule();
    const state = panel.getFilterState();
    assert.equal(panel.chroniclePeriod(state).from, '');
    assert.deepEqual(panel.chroniclePeriod(state).to, '');
    assert.equal(state.tree?.kind, 'group');
  });

  it('собственная форма записи {ast, order} читается деревом (дефект a6609741)', async () => {
    const panel = await panelModule();
    // Панель ПИШЕТ определение как `{ast, order}` (chronicleDefinition). До фикса
    // чтение отдавало пустое дерево: условие терялось, и сохранённый/L4-отбор
    // «Дневника» открывался без условий — красная диагностика не находила строку.
    const written = {
      order: 'desc',
      ast: {
        version: 1,
        filter: {
          op: 'and',
          children: [
            {
              entity: { kind: 'targets' },
              operator: 'in',
              value: {
                query: {
                  op: 'and',
                  children: [
                    {
                      entity: { kind: 'property', property: 'Несуществующее свойство' },
                      operator: 'eq',
                      value: 'x',
                      labels: { entity: 'Несуществующее свойство' },
                    },
                  ],
                },
                operator: 'in',
              },
            },
          ],
        },
      },
    };
    const restored = panel.readFilterDefinition(written);
    assert.equal(
      leaves(restored.tree).length,
      1,
      'условие «Цели в выборке» восстановлено из формы {ast, order}',
    );
    assert.equal(leaves(restored.tree)[0]!.entity.kind, 'targets');
    assert.equal(restored.order, 'desc', 'направление ленты прочитано');
    // Прямая AST-форма (`{version, filter}`) читается тем же путём.
    assert.equal(leaves(panel.readFilterDefinition(written.ast).tree).length, 1);
  });

  it('диагностика ядра доходит до строк редактора: warnings выборки и красное ошибки', async () => {    const panel = await panelModule();
    // Жёлтая/красная диагностика из УСПЕШНОЙ выборки (`meta.warnings`) —
    // тот же путь, что у «Структур»: контракт хроники её несёт (требование 44d61c8a).
    const fromResult = panel.filterIssuesFromQueryResult({
      warnings: [
        {
          severity: 'warning',
          code: 'property_detached',
          path: 'filter.children[0].entity',
          label: 'Город',
          message: 'свойство отвязано от типа',
        },
      ],
    });
    assert.equal(fromResult.length, 1);
    assert.equal(fromResult[0]!.severity, 'warning');
    assert.equal(fromResult[0]!.path, 'filter.children[0].entity');
    // Ошибка запроса (`VALIDATION_ERROR details.diagnostics`) — красная строка.
    const { EtnError } = await import('@etn/shared');
    const fromError = panel.filterIssuesFromQueryError(
      new EtnError('VALIDATION_ERROR', 'отбор нельзя применить', {
        reason: 'filter_entity_deleted',
        diagnostics: [
          {
            severity: 'error',
            code: 'entity_deleted',
            path: 'filter.children[0].entity',
            label: 'Город',
            message: 'Свойство «Город» удалено из сети — отбор нельзя применить.',
          },
        ],
      }),
    );
    assert.equal(fromError.length, 1);
    assert.equal(fromError[0]!.severity, 'error');
    assert.equal(fromError[0]!.label, 'Город');
  });
});

describe('футер «Дневника»: единообразие с «Структурами» (ошибка 4258e694 п.2)', () => {
  const SOURCE = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'chronicle', 'filter-panel.ts'),
    'utf8',
  );

  it('«Отборы…» — нижний ряд футера (place: "name") рядом с полем имени', () => {
    const body = SOURCE.slice(SOURCE.indexOf('function footerExtraButtons'));
    const spec = body.slice(body.indexOf("id: 'saved'"), body.indexOf('onClick'));
    assert.match(
      spec,
      /place:\s*'name'/,
      'кнопка «Отборы…» обязана идти в нижний ряд (place: "name"), как в «Структурах»',
    );
  });
});
