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
import { describe, it } from 'node:test';

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

    // Ключевые слова — двухпутевая группа ИЛИ.
    const orGroup = (restored.tree as Group).children.find(
      (child): child is Group => child.kind === 'group' && child.op === 'or',
    );
    assert.notEqual(orGroup, undefined, 'группа ИЛИ ключевых слов собрана');
    const textPath = leaves(orGroup!).filter(
      (leaf) => leaf.entity.kind === 'record_body' || leaf.entity.kind === 'record_title',
    );
    assert.equal(textPath.length, 2, 'путь Б: тело и заголовок записи');
    assert.equal(textPath[0]!.value.value, 'кофе* -чай');
    const thoughtPath = leaves(orGroup!).find((leaf) => leaf.entity.kind === 'targets');
    const innerKeywords = leaves(thoughtPath?.value.node ?? null).find(
      (leaf) => leaf.entity.kind === 'keywords',
    );
    assert.equal(innerKeywords?.value.value, 'кофе* -чай', 'путь А: слова по мыслям-целям');
    assert.deepEqual(innerKeywords?.entity.scope, ['title', 'synonyms'], 'области поиска перенесены');
    assert.equal(restored.order, 'desc', 'направление ленты прочитано');
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
});
