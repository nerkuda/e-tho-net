/**
 * Рецепт заголовков публикаций на общий AST (задача ef37b01e; требование
 * e090a63c, ADR 2ef3ed7e; сценарий b0a50833).
 *
 * Покрытие DoD:
 *   * старый плоский формат компилируется в общий AST тем же компилятором ядра
 *     (`compileRecipeToAst`);
 *   * AST-форма рецепта (группы И/ИЛИ, невыразимые плоской формой) исполняется
 *     единым AST-исполнителем; идёт через сборку документа;
 *   * пустой AST-рецепт не отдаёт всю сеть (предупреждение + пустая сборка);
 *   * невидимый в профиле «публикации» операнд: чтение — предупреждение и пустая
 *     сборка, запись — `VALIDATION_ERROR`;
 *   * идентичность: плоский рецепт даёт те же id, что прежний путь (независимая
 *     реализация прежнего кода в тесте);
 *   * wire: REST принимает и возвращает AST-рецепт (паритет форм).
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  EtnError,
  FILTER_AST_VERSION,
  PUBLICATION_EMPTY_RECIPE_WARNING,
  type FilterAst,
  type FilterAstLeaf,
  type FilterAstNode,
} from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createPublication } from '../src/domain/publication-service.js';
import {
  compileRecipeToAst,
  isAstRecipeEmpty,
  isStructureFilterEmpty,
  selectRecipeIds,
} from '../src/domain/publication-recipe.js';
import { assemblePublication } from '../src/domain/publication-assembly-service.js';
import { queryThoughtIds, structureRequestToQuery } from '../src/domain/query-service.js';
import { parseStructureFilter } from '../src/domain/structure-service.js';
import {
  apiCreateThought,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

const skip = !nativeAvailable();
const USER = 'u';
const NOW = '2024-01-01T00:00:00Z';
/** Размер страницы прежнего пути рецепта (как в домене до задачи). */
const LEGACY_PAGE_SIZE = 20;

/** Seed a thought directly (no type) and return its id. */
function seedThought(
  ndb: NetworkDb,
  title: string,
  typeId: string | null = null,
  createdAt: string = NOW,
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, 0, 0, 1, ?, ?, ?, ?)`,
    )
    .run(id, ndb.layerId, title, title.toLowerCase(), typeId, createdAt, USER, createdAt, USER);
  return id;
}

/** Seed an untyped (structural) link source → target. */
function seedUntypedLink(ndb: NetworkDb, source: string, target: string, position: number): void {
  ndb
    .prepare(
      `INSERT INTO links (id, layer_id, deleted, base_version, source_id, target_id, type_id,
                          position, active, marked_for_deletion, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, 0, 0, ?, ?, NULL, ?, 1, 0, 1, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), ndb.layerId, source, target, position, NOW, NOW, USER, USER);
}

/** Плоский рецепт «Структур мыслей». */
function flatRecipe(filter: Record<string, unknown>) {
  return { ...filter, sort: 'alpha' as const, order: 'asc' as const };
}

/** AST-тело рецепта. */
function recipeAst(filter: FilterAstNode): FilterAst {
  return { version: FILTER_AST_VERSION, filter };
}

/** Лист отбора: операнд (`{entity:{kind}}`) + оператор + (опц.) значение. */
function leaf(partial: { entity: Record<string, unknown> }, operator: string, value?: unknown): FilterAstNode {
  const out: Record<string, unknown> = { entity: partial.entity, operator };
  if (value !== undefined) out['value'] = value;
  return out as unknown as FilterAstNode;
}

/** Все листья дерева (для проверок компилятора). */
function leaves(node: FilterAstNode, out: FilterAstLeaf[] = []): FilterAstLeaf[] {
  if ('op' in node) {
    for (const child of node.children) leaves(child, out);
    return out;
  }
  out.push(node);
  return out;
}

/**
 * НЕЗАВИСИМАЯ реализация ПРЕЖНЕГО пути рецепта (до задачи ef37b01e): тот же
 * плоский конвейер, что был в `selectRecipeIds`, — для проверки идентичности.
 */
function legacySelectIds(
  ndb: NetworkDb,
  userId: string,
  recipe: Record<string, unknown>,
  pageSize = LEGACY_PAGE_SIZE,
): string[] {
  const filter = parseStructureFilter(recipe);
  if (isStructureFilterEmpty(filter)) return [];
  // Сортировка — из самого рецепта, как в домене.
  const sort = recipe['sort'] === 'created' || recipe['sort'] === 'updated' || recipe['sort'] === 'viewed'
    ? (recipe['sort'] as 'created' | 'updated' | 'viewed')
    : 'alpha';
  const order = recipe['order'] === 'desc' ? 'desc' : 'asc';
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const query = structureRequestToQuery({
      ...filter,
      sort,
      order,
      limit: pageSize,
      offset: 0,
      cursor,
    });
    const page = queryThoughtIds(ndb, userId, query, {
      emptyFilterMode: 'all',
      maxLimit: pageSize,
      profile: 'publications',
    });
    ids.push(...page.ids);
    if (!page.has_more || page.next_cursor === null) return ids;
    cursor = page.next_cursor;
  }
}

/** Разделы документа (pre-order). */
function sectionIds(sections: Array<{ thought_id: string; children: unknown[] }>): string[] {
  const out: string[] = [];
  const walk = (list: Array<{ thought_id: string; children: unknown[] }>): void => {
    for (const s of list) {
      out.push(s.thought_id);
      walk(s.children as Array<{ thought_id: string; children: unknown[] }>);
    }
  };
  walk(sections);
  return out;
}

describe('рецепт заголовков публикаций на общий AST (задача ef37b01e)', { skip }, () => {
  it('compileRecipeToAst: плоский рецепт компилируется в AST тем же компилятором ядра', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const ast = compileRecipeToAst(
        ndb,
        flatRecipe({ type_ids: [type.id], keywords: 'дом', has_comment: true }),
      );
      assert.ok(ast !== undefined, 'непустой рецепт → AST');
      assert.equal(ast.version, FILTER_AST_VERSION);
      const byKind = new Map(leaves(ast.filter).map((l) => [l.entity.kind, l]));
      // Актуальность/корзина — дефолты компилятора ядра (как у панели поиска).
      assert.equal(byKind.get('active')?.operator, 'eq');
      assert.equal(byKind.get('trashed')?.operator, 'eq');
      // «Найти слова» c дефолтной областью.
      assert.equal(byKind.get('keywords')?.operator, 'matches');
      // «Тип» компилируется в «в иерархии» (требование f7f93c32) — подтипы
      // раскрывает исполнитель, не компилятор.
      assert.equal(byKind.get('type')?.operator, 'in_hierarchy');
      // «Есть комментарий» → операнд comment.
      assert.equal(byKind.get('comment')?.operator, 'not_empty');
      // Пустой плоский рецепт компилируется в AST из ОДНИХ модификаторов
      // (дефолты active/trashed) — «условий состава» нет; поэтому тот же пустой
      // результат отдаёт и страж `isStructureFilterEmpty` в исполнителе.
      const emptyCompiled = compileRecipeToAst(ndb, flatRecipe({}));
      assert.ok(emptyCompiled !== undefined);
      assert.ok(isAstRecipeEmpty(emptyCompiled), 'нет условий состава → пустой рецепт');
    } finally {
      ndb.close();
    }
  });

  it('токены календаря AST-рецепта раскрываются контекстом точки «публикации»', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const doc = createThoughtType(ndb, { name: 'Doc' }, USER);
      // Даты мыслей — исторические константы: границу месяца/недели задаёт
      // контекст, а не реальные часы прогона.
      const jan = seedThought(ndb, 'январь', doc.id, '2024-01-05T10:00:00Z');
      const feb = seedThought(ndb, 'февраль', doc.id, '2024-02-05T10:00:00Z');
      const sat = seedThought(ndb, 'сб', doc.id, '2024-02-10T10:00:00Z');
      const sun = seedThought(ndb, 'вс', doc.id, '2024-02-11T10:00:00Z');
      const mon = seedThought(ndb, 'пн', doc.id, '2024-02-12T10:00:00Z');

      const monthRecipe = recipeAst({
        op: 'and',
        children: [
          leaf({ entity: { kind: 'type' } }, 'in_hierarchy', [doc.id]),
          leaf({ entity: { kind: 'created_at' } }, 'gte', { token: '$monthStart' }),
        ],
      });
      // Часы исполнения — 15 февраля 2024: граница месяца = 2024-02-01.
      const ctx = {
        nowMs: Date.UTC(2024, 1, 15, 12),
        userId: USER,
        firstDayOfWeek: 1,
        withTime: false,
      };
      const warnings: string[] = [];
      const monthIds = [...selectRecipeIds(ndb, USER, monthRecipe, warnings, ctx)].sort();
      assert.deepEqual(monthIds, [feb, sat, sun, mon].sort(), 'граница месяца из контекста фактически применена');
      assert.ok(!monthIds.includes(jan), 'январь вне границы февраля — не вся сеть');
      assert.deepEqual(warnings, []);
      assert.ok(!selectRecipeIds(ndb, USER, monthRecipe, []).includes(feb), 'мутация: без контекста граница месяца — не февраля 2024');

      // «Первый день недели» сети: $weekStart от воскресенья (7) — 2024-02-11,
      // от понедельника (1) — 2024-02-12; часы — среда 14 февраля.
      const weekRecipe = recipeAst({
        op: 'and',
        children: [
          leaf({ entity: { kind: 'type' } }, 'in_hierarchy', [doc.id]),
          leaf({ entity: { kind: 'created_at' } }, 'gte', { token: '$weekStart' }),
        ],
      });
      const wed = Date.UTC(2024, 1, 14, 9);
      const idsSunday = selectRecipeIds(ndb, USER, weekRecipe, [], {
        ...ctx,
        nowMs: wed,
        firstDayOfWeek: 7,
      });
      const idsMonday = selectRecipeIds(ndb, USER, weekRecipe, [], {
        ...ctx,
        nowMs: wed,
        firstDayOfWeek: 1,
      });
      assert.deepEqual([...idsSunday].sort(), [sun, mon].sort(), 'неделя с воскресенья');
      assert.deepEqual([...idsMonday].sort(), [mon].sort(), 'неделя с понедельника');
      assert.notDeepEqual(idsSunday, idsMonday, 'настройка сети влияет на границу недели');

      // Профиль «публикации» — без времени: единица времени ($now) неразрешима.
      // Пустая выборка с пояснением, а не тихая потеря условия (требование b7fdab20).
      const timeRecipe = recipeAst({
        op: 'and',
        children: [
          leaf({ entity: { kind: 'type' } }, 'in_hierarchy', [doc.id]),
          leaf({ entity: { kind: 'created_at' } }, 'gte', { token: '$now' }),
        ],
      });
      const timeWarnings: string[] = [];
      assert.deepEqual(selectRecipeIds(ndb, USER, timeRecipe, timeWarnings, ctx), []);
      assert.equal(timeWarnings.length, 1, 'неразрешимый токен — предупреждение сборки');
      assert.match(timeWarnings[0]!, /рецепт заголовков не исполнен/);

      // Сборка документа видит тот же контекст (сценарий b0a50833): разделы —
      // только февраль 2024, а не вся сеть и не текущий месяц.
      const pub = createPublication(ndb, { title: 'Февраль', title_recipe: monthRecipe }, USER, ctx);
      const assembled = assemblePublication(ndb, pub.id, USER, { tokenContext: ctx });
      assert.deepEqual(
        sectionIds(assembled.sections).sort(),
        [feb, sat, sun, mon].sort(),
        'сборка применяет границу месяца',
      );

      // Мутация «tokenContext не прокинут»: то же тело без контекста собирает
      // ДРУГОЙ месяц (реальный) — набор расходится.
      const pubNoCtx = createPublication(
        ndb,
        { title: 'Без контекста', title_recipe: monthRecipe },
        USER,
      );
      assert.deepEqual(sectionIds(assemblePublication(ndb, pubNoCtx.id, USER).sections), []);
    } finally {
      ndb.close();
    }
  });

  it('AST-рецепт: группы И/ИЛИ выразимы — разделы объединяются (сценарий b0a50833)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const doc = createThoughtType(ndb, { name: 'Doc' }, USER);
      const other = createThoughtType(ndb, { name: 'Other' }, USER);
      const a = seedThought(ndb, 'A', doc.id);
      const b = seedThought(ndb, 'B', doc.id);
      const z = seedThought(ndb, 'Особый', other.id);

      // ИЛИ: «тип Doc» ЛИБО «есть слово Особый». Плоская форма такого не выражает
      // (её критерии — только AND), поэтому z попадает в разделы.
      const ast = recipeAst({
        op: 'or',
        children: [
          leaf({ entity: { kind: 'type' } }, 'in_hierarchy', [doc.id]),
          leaf({ entity: { kind: 'keywords', scope: ['title'] } }, 'matches', 'Особый'),
        ],
      });
      const pub = createPublication(ndb, { title: 'Док', title_recipe: ast }, USER);
      const assembled = assemblePublication(ndb, pub.id, USER);
      assert.deepEqual(
        sectionIds(assembled.sections).sort(),
        [a, b, z].sort(),
        'ИЛИ объединяет ветви',
      );

      // Плоский эквивалент «Doc И Особый» — AND, пересечение пусто: доказывает,
      // что AST действительно даёт группу ИЛИ, а не то же самое.
      const flatPub = createPublication(
        ndb,
        { title: 'Док2', title_recipe: flatRecipe({ type_ids: [doc.id], keywords: 'Особый' }) },
        USER,
      );
      assert.deepEqual(sectionIds(assemblePublication(ndb, flatPub.id, USER).sections), []);
    } finally {
      ndb.close();
    }
  });

  it('пустой AST-рецепт не отдаёт всю сеть (предупреждение + пустая сборка)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const doc = createThoughtType(ndb, { name: 'Doc' }, USER);
      const a = seedThought(ndb, 'A', doc.id);
      const b = seedThought(ndb, 'B', doc.id);

      const empty = recipeAst({ op: 'and', children: [] });
      assert.ok(isAstRecipeEmpty(empty), 'пустая группа — пустой рецепт');
      const warnings: string[] = [];
      assert.deepEqual(selectRecipeIds(ndb, USER, empty, warnings), []);
      assert.deepEqual(warnings, [PUBLICATION_EMPTY_RECIPE_WARNING]);

      // Только модификаторы состояния (active/trashed) — тоже не критерий состава.
      const modifiersOnly = recipeAst({
        op: 'and',
        children: [
          leaf({ entity: { kind: 'active' } }, 'eq', true),
          leaf({ entity: { kind: 'trashed' } }, 'eq', false),
        ],
      });
      assert.ok(isAstRecipeEmpty(modifiersOnly), 'только модификаторы — пустой рецепт');
      const pub = createPublication(ndb, { title: 'Док', title_recipe: empty }, USER);
      const assembled = assemblePublication(ndb, pub.id, USER);
      assert.deepEqual(assembled.sections, [], 'пустая сборка, а не вся сеть');
      assert.ok(assembled.warnings.includes(PUBLICATION_EMPTY_RECIPE_WARNING));

      // Итерация 2 (блокер верификатора): модификаторы под ЛЮБОЙ группой и на
      // любой вложенности — тоже пустой рецепт (иначе такое тело молча собирает
      // всю сеть — возврат ошибки b9db6c0a).
      const modifierOnlyForms: Array<[string, FilterAst]> = [
        ['or[active]', recipeAst({ op: 'or', children: [leaf({ entity: { kind: 'active' } }, 'eq', true)] })],
        [
          'or[active,trashed]',
          recipeAst({
            op: 'or',
            children: [
              leaf({ entity: { kind: 'active' } }, 'eq', true),
              leaf({ entity: { kind: 'trashed' } }, 'eq', false),
            ],
          }),
        ],
        ['not[trashed]', recipeAst({ op: 'not', children: [leaf({ entity: { kind: 'trashed' } }, 'eq', false)] })],
        [
          'and[or[active]]',
          recipeAst({
            op: 'and',
            children: [{ op: 'or', children: [leaf({ entity: { kind: 'active' } }, 'eq', true)] } as FilterAstNode],
          }),
        ],
        ['leaf active', recipeAst(leaf({ entity: { kind: 'active' } }, 'eq', true))],
      ];
      for (const [name, ast] of modifierOnlyForms) {
        assert.ok(isAstRecipeEmpty(ast), `${name}: только модификаторы — пустой рецепт`);
        const w: string[] = [];
        assert.deepEqual(selectRecipeIds(ndb, USER, ast, w), [], `${name}: пустая выборка`);
        assert.deepEqual(w, [PUBLICATION_EMPTY_RECIPE_WARNING], `${name}: предупреждение`);
        const p = createPublication(ndb, { title: `Док-${name}`, title_recipe: ast }, USER);
        const doc2 = assemblePublication(ndb, p.id, USER);
        assert.deepEqual(doc2.sections, [], `${name}: сборка пуста, а не вся сеть`);
        assert.ok(doc2.warnings.includes(PUBLICATION_EMPTY_RECIPE_WARNING), `${name}: warning сборки`);
      }

      // Условие-модификатор рядом с СОДЕРЖАТЕЛЬНЫМ листом рецепт пустым не делает.
      const withContent = recipeAst({
        op: 'and',
        children: [
          leaf({ entity: { kind: 'active' } }, 'eq', true),
          leaf({ entity: { kind: 'type' } }, 'in_hierarchy', [doc.id]),
        ],
      });
      assert.equal(isAstRecipeEmpty(withContent), false, 'модификатор + тип — не пустой рецепт');
      const contentPub = createPublication(ndb, { title: 'Док-контент', title_recipe: withContent }, USER);
      assert.deepEqual(
        sectionIds(assemblePublication(ndb, contentPub.id, USER).sections).sort(),
        [a, b].sort(),
        'содержательный рецепт отбирает мысли',
      );

      // Отключённое исполнителем «Найти слова» (пустая область ИЛИ нет слов) —
      // тоже не критерий состава: лист даёт AST_TRUE, т.е. «вся сеть».
      const disabledKeywords: Array<[string, FilterAst]> = [
        [
          'keywords без области',
          recipeAst(leaf({ entity: { kind: 'keywords' } }, 'matches', 'Дом')),
        ],
        [
          'keywords с пустым значением',
          recipeAst(leaf({ entity: { kind: 'keywords', scope: ['title'] } }, 'matches', '')),
        ],
      ];
      for (const [name, ast] of disabledKeywords) {
        assert.ok(isAstRecipeEmpty(ast), `${name}: условие отключено — пустой рецепт`);
        const w: string[] = [];
        assert.deepEqual(selectRecipeIds(ndb, USER, ast, w), [], `${name}: пустая выборка`);
      }
    } finally {
      ndb.close();
    }
  });

  it('невидимый в профиле «публикации» операнд: чтение — предупреждение, запись — отказ', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      seedThought(ndb, 'A', type.id);

      // «Заголовок записи дневника» виден только профилю хроники.
      const foreign = recipeAst(leaf({ entity: { kind: 'record_title' } }, 'matches', 'a'));
      const warnings: string[] = [];
      assert.deepEqual(selectRecipeIds(ndb, USER, foreign, warnings), []);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /не соответствует профилю|не виден/);

      // Запись отвергается (требование 0095daad).
      assert.throws(
        () => createPublication(ndb, { title: 'Док', title_recipe: foreign }, USER),
        (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
      );

      // Красная диагностика на записи: ссылка на удалённое свойство.
      const deletedProp = recipeAst(
        leaf({ entity: { kind: 'property', property_id: randomUUID() } }, 'is_empty'),
      );
      assert.throws(
        () => createPublication(ndb, { title: 'Док', title_recipe: deletedProp }, USER),
        (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
      );
    } finally {
      ndb.close();
    }
  });

  it('идентичность: плоский рецепт даёт те же id, что прежний путь', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const root = seedThought(ndb, 'Корень', type.id);
      const a = seedThought(ndb, 'Альфа', type.id);
      const b = seedThought(ndb, 'Бета', type.id);
      const other = seedThought(ndb, 'Гамма');
      seedUntypedLink(ndb, root, a, 0);
      seedUntypedLink(ndb, a, b, 0);

      const recipes: Array<Record<string, unknown>> = [
        flatRecipe({ type_ids: [type.id] }),
        flatRecipe({ keywords: 'а' }),
        flatRecipe({ parent_ids: [root] }),
        flatRecipe({ has_comment: true }),
        flatRecipe({ type_ids: [type.id], parent_ids: [root] }),
        flatRecipe({}),
      ];
      for (const recipe of recipes) {
        const warnings: string[] = [];
        const got = selectRecipeIds(ndb, USER, recipe as never, warnings);
        const legacy = legacySelectIds(ndb, USER, recipe);
        assert.deepEqual(got, legacy, `идентичность: ${JSON.stringify(recipe)}`);
      }
      // Контроль полноты сценария: отбор по типу действительно что-то отобрал.
      assert.deepEqual(legacySelectIds(ndb, USER, flatRecipe({ type_ids: [type.id] })).sort(), [
        a,
        b,
        root,
      ].sort());
      assert.ok(other.length > 0);
    } finally {
      ndb.close();
    }
  });
});

describe('рецепт заголовков публикаций: wire (REST)', { skip }, () => {
  let ctx: RestTestContext;

  it('REST принимает и возвращает AST-рецепт; невидимый операнд — 422', async () => {
    ctx = await buildRestContext();
    try {
      const ast = recipeAst(
        leaf({ entity: { kind: 'trashed' } }, 'eq', false),
      );
      const created = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/publications`,
        headers: { authorization: `Bearer ${ctx.adminKey}` },
        payload: { title: 'Док', title_recipe: ast },
      });
      assert.equal(created.statusCode, 201, created.body);
      const pub = created.json().data as { id: string; title_recipe: unknown };
      assert.deepEqual(pub.title_recipe, ast, 'AST-рецепт сохранён и возвращён как есть');

      const fetched = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/publications/${pub.id}`,
        headers: { authorization: `Bearer ${ctx.adminKey}` },
      });
      assert.equal(fetched.statusCode, 200, fetched.body);
      assert.deepEqual((fetched.json().data as { title_recipe: unknown }).title_recipe, ast);

      const bad = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/publications`,
        headers: { authorization: `Bearer ${ctx.adminKey}` },
        payload: {
          title: 'Плохой',
          title_recipe: recipeAst(leaf({ entity: { kind: 'record_title' } }, 'matches', 'a')),
        },
      });
      assert.equal(bad.statusCode, 422, 'невидимый операнд → 422');
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('REST: пустой рецепт (плоский и AST or[active]) — симметрично: принят, сборка пуста', async () => {
    ctx = await buildRestContext();
    try {
      // Плоский «пустой» рецепт — эталон поведения: запись принимается, пустоту
      // ловит сборка предупреждением (задача 7cfaba7c) — не 422.
      const flat = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/publications`,
        headers: { authorization: `Bearer ${ctx.adminKey}` },
        payload: { title: 'Плоский пустой', title_recipe: flatRecipe({}) },
      });
      assert.equal(flat.statusCode, 201, flat.body);
      const flatId = (flat.json().data as { id: string }).id;

      // AST-рецепт из одних модификаторов под OR: поведение обязано быть тем же —
      // принят (201), а не молча собирает всю сеть.
      const orActive = recipeAst({ op: 'or', children: [leaf({ entity: { kind: 'active' } }, 'eq', true)] });
      const created = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/publications`,
        headers: { authorization: `Bearer ${ctx.adminKey}` },
        payload: { title: 'AST or[active]', title_recipe: orActive },
      });
      assert.equal(created.statusCode, 201, created.body);
      const astId = (created.json().data as { id: string }).id;

      for (const [name, id] of [
        ['плоский', flatId],
        ['AST or[active]', astId],
      ] as const) {
        const assembly = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/publications/${id}/assembly`,
          headers: { authorization: `Bearer ${ctx.adminKey}` },
        });
        assert.equal(assembly.statusCode, 200, assembly.body);
        const doc = assembly.json().data as { sections: unknown[]; warnings: string[] };
        assert.deepEqual(doc.sections, [], `${name}: пустая сборка, а не вся сеть`);
        assert.ok(
          doc.warnings.includes(PUBLICATION_EMPTY_RECIPE_WARNING),
          `${name}: предупреждение о пустом рецепте`,
        );
      }
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('REST: единица времени ($now) в AST-рецепте — профиль «публикации» без времени', async () => {
    ctx = await buildRestContext();
    try {
      // Мысль в сети: до фикса «created_at lte $now» без контекста профиля
      // разворачивался по произвольным часам и отбирал всю сеть (класс b9db6c0a).
      const seeded = await apiCreateThought(ctx, { title: 'Мысль' });
      assert.equal(seeded.statusCode, 201, JSON.stringify(seeded.data));

      const nowRecipe = recipeAst(
        leaf({ entity: { kind: 'created_at' } }, 'lte', { token: '$now' }),
      );
      const created = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/publications`,
        headers: { authorization: `Bearer ${ctx.adminKey}` },
        payload: { title: 'Со $now', title_recipe: nowRecipe },
      });
      assert.equal(created.statusCode, 201, created.body);
      const id = (created.json().data as { id: string }).id;

      const assembly = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/publications/${id}/assembly`,
        headers: { authorization: `Bearer ${ctx.adminKey}` },
      });
      assert.equal(assembly.statusCode, 200, assembly.body);
      const doc = assembly.json().data as { sections: unknown[]; warnings: string[] };
      assert.deepEqual(doc.sections, [], '$now неразрешим в профиле без времени — пусто, не вся сеть');
      assert.ok(
        doc.warnings.some((w) => w.startsWith('рецепт заголовков не исполнен')),
        `сборка поясняет неразрешимый токен: ${JSON.stringify(doc.warnings)}`,
      );
    } finally {
      await closeRestContext(ctx);
    }
  });
});
