/**
 * Исполнение рецепта заголовков публикации (0.11.1, задача e754527d; перевод
 * на общий AST — задача ef37b01e, требование e090a63c, ADR 2ef3ed7e).
 *
 * Рецепт бывает двух форм (см. `PublicationTitleRecipe`):
 *   * **старый плоский формат** «Структур мыслей» (`SavedFilterDefinition`) —
 *     ядро компилирует его в общий AST ТЕМ ЖЕ компилятором
 *     (`compileThoughtQueryToAst`), что и панель поиска, и исполняет единым
 *     AST-исполнителем (ADR 34f6f9d6 «единый вход: критерии только из AST»).
 *     Второго пути исполнения нет: локального SQL-отбора здесь не было и нет;
 *   * **AST-форма** (`version` + `filter`) — тело отбора профиля «публикации»
 *     (операнды мыслей, в т.ч. группы И/ИЛИ, невыразимые плоской формой)
 *     исполняется явным AST-исполнителем с проверкой профиля точки применения
 *     (требование 0095daad) и красной диагностикой (требование 44d61c8a).
 *
 * **Контекст токенов.** AST-форма рецепта исполняется при КАЖДОЙ сборке (ADR
 * 2ef3ed7e, runtime-исполнение без материализации), поэтому календарные токены
 * (`$monthStart`, `$weekStart`…) осмысленны и раскрываются контекстом точки
 * применения «публикации» — те же `nowMs`/`firstDayOfWeek` сети/`userId`/
 * `withTime`, что и в прочих AST-точках (требование 0095daad, ADR 0c02ab4f;
 * замечание приёмки). Собирают контекст фасады (REST — `restTokenContext`, MCP —
 * `mcpTokenContext`) и прокидывают через домен до {@link selectRecipeIds}.
 * Неразрешимый токен (например, единица времени в профиле без времени) даёт
 * пустую выборку с пояснением в предупреждениях сборки, а не молчаливую потерю
 * условия (общее правило `unresolved`, требование b7fdab20). `compileRecipeToAst`
 * контекста НЕ принимает: компиляция строит дерево и токены не раскрывает —
 * раскрытие делает исполнитель в момент запроса.
 *
 * Модуль выделен из `publication-assembly-service.ts`, чтобы им могли
 * пользоваться обе стороны домена без циклической зависимости: сборка
 * (кандидаты/использование) и CRUD публикаций (срез принятого состояния —
 * создание, сохранение порядка). Зависит только от движка выборки.
 */

import {
  EtnError,
  PUBLICATION_EMPTY_RECIPE_WARNING,
  isPublicationTitleRecipeAst,
  parseFilterKeywords,
  type FilterAst,
  type FilterAstLeaf,
  type FilterAstNode,
  type PublicationTitleRecipe,
  type SortOrder,
  type StructureFilter,
  type StructureSort,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import {
  compileThoughtQueryToAst,
  queryThoughtIds,
  structureRequestToQuery,
  type AstTokenContext,
} from './query-service.js';
import { parseFilterAst } from './filter-ast.js';
import { parseStructureFilter } from './structure-service.js';

/**
 * Потолок числа разделов, извлекаемых из рецепта за одну сборку. Защита от
 * неограниченного отбора; превышение — предупреждение в `warnings`, а не
 * ошибка (требование 6e8bc3f0: усечение, не отказ).
 */
export const PUBLICATION_RECIPE_MAX_NODES = 20000;

/**
 * Размер страницы keyset-обхода рецепта (внутренняя деталь исполнения; не
 * связан с постраничной выдачей сборки `PUBLICATION_ASSEMBLY_PAGE_SIZE`).
 */
const RECIPE_PAGE_SIZE = 20;

/** Валидный `StructureSort` или `null`. */
function asStructureSort(value: unknown): StructureSort | null {
  return value === 'alpha' || value === 'created' || value === 'viewed' || value === 'updated'
    ? value
    : null;
}

/** Валидный `SortOrder` или `null`. */
function asSortOrder(value: unknown): SortOrder | null {
  return value === 'asc' || value === 'desc' ? value : null;
}

/** Непустая строка (после `trim`). */
function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/** Непустой массив. */
function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * «Пустой рецепт» — ни одного условия ОТБОРА (задача 7cfaba7c, п.2; ошибка
 * b9db6c0a, 0.12.1). Перечислены все поля {@link StructureFilter}, задающие
 * ВЫБОРКУ мыслей; `sort`/`order`, `keyword_scope`, `show_inactive`, а также
 * состояние `active`/`trashed` — модификаторы результата, а не критерий состава:
 * рецепт из одних модификаторов не задаёт документ. Такой рецепт больше НЕ
 * исполняется с `emptyFilterMode: 'all'` (раньше он отдавал всю сеть) — сборка
 * пустая с предупреждением.
 *
 * Почему состояние — не критерий. Рецепт публикации, попавший в движок без
 * условий состава (например, `parent_ids` задан, но пуст, и парсер его отбросил
 * — тогда остаётся один `active`), исполнялся как «вся активная сеть»: сборка
 * отдавала 255+ разделов БЕЗ предупреждения (ошибка b9db6c0a, воспроизведено на
 * живой сети). Отбор по родителю — единственное, что задаёт разделы; пустой
 * parent_ids обязан давать пустую сборку с предупреждением, а не всю сеть.
 */
export function isStructureFilterEmpty(filter: StructureFilter): boolean {
  const authorPresent = (value: string | string[] | undefined): boolean =>
    nonEmptyString(value) || nonEmptyArray(value);
  return (
    !nonEmptyString(filter.keywords) &&
    !nonEmptyArray(filter.parent_ids) &&
    !nonEmptyArray(filter.type_ids) &&
    !nonEmptyArray(filter.link_type_ids) &&
    !nonEmptyArray(filter.properties) &&
    filter.has_properties === undefined &&
    filter.has_comment === undefined &&
    filter.has_attachments === undefined &&
    filter.has_chronology === undefined &&
    !authorPresent(filter.created_by) &&
    !authorPresent(filter.updated_by) &&
    !nonEmptyString(filter.created_after) &&
    !nonEmptyString(filter.created_before) &&
    !nonEmptyString(filter.updated_after) &&
    !nonEmptyString(filter.updated_before)
  );
}

/**
 * Компилировать рецепт ЛЮБОЙ формы в общий AST (тонкая обёртка над ядром):
 *   * AST-форма — строгий `parseFilterAst` (форма wire-тела);
 *   * плоский формат — `parseStructureFilter` → `structureRequestToQuery` →
 *     `compileThoughtQueryToAst` (ТОТ ЖЕ компилятор, которым ядро переводит
 *     плоские критерии панели поиска; задача ef37b01e).
 * Пустой плоский рецепт (ни одного условия) даёт `undefined` — «нет критериев».
 * Бросает `VALIDATION_ERROR`/`NOT_FOUND` на неразбираемом рецепте.
 */
export function compileRecipeToAst(
  ndb: NetworkDb,
  recipe: PublicationTitleRecipe,
  requestId?: string,
): FilterAst | undefined {
  if (isPublicationTitleRecipeAst(recipe)) return parseFilterAst(recipe, requestId);
  // Плоский формат: тот же путь, что у панели поиска — `structureRequestToQuery`
  // (сортировка/лимит для компиляции критериев не важны) → `compileThoughtQueryToAst`.
  const query = structureRequestToQuery({
    ...parseStructureFilter(recipe as unknown as Record<string, unknown>),
    sort: 'alpha',
    order: 'asc',
    limit: 1,
    offset: 0,
  });
  return compileThoughtQueryToAst(ndb, query, requestId);
}

/**
 * «Пустой» AST-рецепт: ни одного условия СОСТАВА — рецепт дал бы всю сеть,
 * поэтому не исполняется (пустой результат + то же предупреждение, что у
 * плоского формата; обоснование — {@link isStructureFilterEmpty}).
 *
 * Проверка рекурсивна и НЕ зависит от вида группы (итерация 2, блокер
 * верификатора): лист-модификатор (`active`/`trashed` с любым оператором) —
 * не критерий; группа (`and`/`or`/`not`, любой вложенности) не несёт условий,
 * если таковы ВСЕ её дети. Так же трактуется `not`: отрицание пустого набора
 * модификаторов — по-прежнему пустой рецепт. Отключённое исполнителем «Есть
 * слова» (пустая/отсутствующая область поиска ЛИБО ни включаемых, ни
 * исключаемых слов — `keywordsLeafClause` → `AST_TRUE`) тоже не критерий: без
 * этой ветки такое тело молча собирало бы всю сеть (та же ошибка b9db6c0a).
 */
export function isAstRecipeEmpty(ast: FilterAst): boolean {
  return isNonCriterionNode(ast.filter);
}

/** Операнды-модификаторы: состояние мысли, а не критерий состава рецепта. */
const RECIPE_MODIFIER_KINDS: ReadonlySet<string> = new Set(['active', 'trashed']);

/** Узел не несёт условий состава (рекурсивно: ЛЮБАЯ группа, любая вложенность). */
function isNonCriterionNode(node: FilterAstNode): boolean {
  if ('op' in node) return node.children.every(isNonCriterionNode);
  return isNonCriterionLeaf(node);
}

/** Лист не является критерием состава (модификатор либо отключённое «Найти слова»). */
function isNonCriterionLeaf(leaf: FilterAstLeaf): boolean {
  if (RECIPE_MODIFIER_KINDS.has(leaf.entity.kind)) return true;
  if (leaf.entity.kind !== 'keywords') return false;
  if ((leaf.entity.scope ?? []).length === 0) return true;
  const value = typeof leaf.value === 'string' ? leaf.value : '';
  const { include, exclude } = parseFilterKeywords(value);
  return include.length === 0 && exclude.length === 0;
}

/**
 * Исполнить рецепт заголовков единым AST-движком выборки и вернуть id всех
 * совпавших мыслей в детерминированном порядке. Пагинация — keyset-курсором
 * (единый движок), с потолком {@link PUBLICATION_RECIPE_MAX_NODES}.
 *
 * Плоский формат идёт через ядро как раньше (его компиляцию в AST делает
 * ядро — ADR 34f6f9d6); AST-форма передаётся явным `ast` и потому получает
 * проверку профиля «публикации» и красную диагностику ядра. Обе формы
 * исполняет один и тот же исполнитель — второго пути нет.
 *
 * `tokenContext` — контекст раскрытия токенов AST (часы исполнения, первый день
 * недели сети, пользователь, профиль времени); значим только для AST-формы —
 * плоская форма токенов не несёт, её путь не меняется.
 */
export function selectRecipeIds(
  ndb: NetworkDb,
  userId: string,
  recipe: PublicationTitleRecipe,
  warnings: string[],
  tokenContext?: AstTokenContext,
): string[] {
  if (isPublicationTitleRecipeAst(recipe)) {
    return selectAstRecipeIds(ndb, userId, recipe, warnings, tokenContext);
  }
  const raw = recipe as unknown as Record<string, unknown>;
  let filter: StructureFilter;
  try {
    filter = parseStructureFilter(raw);
  } catch (err) {
    if (err instanceof EtnError) {
      warnings.push(`рецепт заголовков не исполнен: ${err.message}`);
      return [];
    }
    throw err;
  }
  const sort = asStructureSort(raw['sort']) ?? 'alpha';
  const order = asSortOrder(raw['order']) ?? 'asc';

  // Пустой рецепт (ни одного условия) → пустая сборка, а не вся сеть: иначе
  // публикация без настроенного отбора выводила бы содержимое всей мыслесети
  // (задача 7cfaba7c, п.2, решение пользователя 2026-10-03).
  if (isStructureFilterEmpty(filter)) {
    warnings.push(PUBLICATION_EMPTY_RECIPE_WARNING);
    return [];
  }

  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const query = structureRequestToQuery({
      ...filter,
      sort,
      order,
      limit: RECIPE_PAGE_SIZE,
      offset: 0,
      cursor,
    });
    const page = queryThoughtIds(ndb, userId, query, {
      emptyFilterMode: 'all',
      maxLimit: RECIPE_PAGE_SIZE,
      // Профиль точки применения «публикации» (требование 0095daad, ADR 0c02ab4f).
      profile: 'publications',
    });
    ids.push(...page.ids);
    if (!page.has_more || page.next_cursor === null) break;
    cursor = page.next_cursor;
    if (ids.length >= PUBLICATION_RECIPE_MAX_NODES) {
      warnings.push('отбор заголовков усечён по потолку узлов сборки');
      break;
    }
  }
  return ids;
}

/**
 * Исполнить AST-рецепт явным AST-путём ядра: тело отбора передаётся как `ast`,
 * поэтому его проверяет профиль точки применения «публикации» (требование
 * 0095daad) и красная диагностика (требование 44d61c8a). Пустой рецепт — тот же
 * пустой результат с предупреждением, что и у плоского формата. Неразбираемое/
 * неисполнимое тело (битая форма, невидимый операнд, удалённая сущность) —
 * предупреждение сборки и пустая выборка: сборка документа — читающий путь и не
 * должна падать из-за состояния рецепта (как и у плоского формата).
 *
 * Токены тела раскрывает `tokenContext` (как в остальных AST-точках): без него
 * календарный токен считался бы по произвольным часам, а неразрешимый —
 * молчаливо пропадал. Неразрешимые токены движок отдаёт в `page.unresolved`
 * (`ids` пуст) — превращаем их в предупреждение сборки и пустую выборку.
 */
function selectAstRecipeIds(
  ndb: NetworkDb,
  userId: string,
  recipe: PublicationTitleRecipe,
  warnings: string[],
  tokenContext?: AstTokenContext,
): string[] {
  let ast: FilterAst | undefined;
  try {
    ast = compileRecipeToAst(ndb, recipe);
  } catch (err) {
    if (err instanceof EtnError) {
      warnings.push(`рецепт заголовков не исполнен: ${err.message}`);
      return [];
    }
    throw err;
  }
  if (ast === undefined || isAstRecipeEmpty(ast)) {
    warnings.push(PUBLICATION_EMPTY_RECIPE_WARNING);
    return [];
  }

  const raw = recipe as unknown as Record<string, unknown>;
  const sort = asStructureSort(raw['sort']) ?? 'alpha';
  const order = asSortOrder(raw['order']) ?? 'asc';

  const ids: string[] = [];
  let cursor: string | undefined;
  try {
    for (;;) {
      const page = queryThoughtIds(
        ndb,
        userId,
        { sort, order, limit: RECIPE_PAGE_SIZE, offset: 0, cursor, ast },
        {
          emptyFilterMode: 'all',
          maxLimit: RECIPE_PAGE_SIZE,
          // Профиль точки применения «публикации» (требование 0095daad, ADR 0c02ab4f).
          profile: 'publications',
          ...(tokenContext !== undefined ? { tokenContext } : {}),
        },
      );
      if (page.unresolved !== undefined && page.unresolved.length > 0) {
        warnings.push(
          `рецепт заголовков не исполнен: ${page.unresolved.map((i) => i.message).join('; ')}`,
        );
        return [];
      }
      ids.push(...page.ids);
      if (!page.has_more || page.next_cursor === null) break;
      cursor = page.next_cursor;
      if (ids.length >= PUBLICATION_RECIPE_MAX_NODES) {
        warnings.push('отбор заголовков усечён по потолку узлов сборки');
        break;
      }
    }
  } catch (err) {
    if (err instanceof EtnError) {
      warnings.push(`рецепт заголовков не исполнен: ${err.message}`);
      return [];
    }
    throw err;
  }
  return ids;
}
