/**
 * Двухпутевой критерий ключевых слов панели «Дневника» на общий AST
 * (задача 608ecb79; требование 9e9d14dc; ADR 3301223f).
 *
 * Прежнее ПЛОСКОЕ тело хроники (`keywords` + `keyword_scope`) сервер компилирует
 * в AST двумя путями и объединяет их по ИЛИ (`chronicle-service.compileChronicleToAst`):
 *
 *   • путь А — «мысли-цели»: хотя бы одна цель записи удовлетворяет операнду
 *     «Есть слова» с областями поиска;
 *   • путь Б — «текст самой записи»: тело/заголовок записи, на каждое слово
 *     `ИЛИ(тело, заголовок)`, исключающие слова — `НЕ(ИЛИ(...))`. Путь Б
 *     включается ТОЛЬКО когда в областях есть `comment` (пустой набор — все
 *     области), и требует хотя бы одну цель (`targets not_empty`).
 *
 * Панель строит своё дерево тем же критерием — иначе сохранённый панелью отбор
 * давал бы не тот результат, что прежнее плоское тело. Чтобы семантика не
 * разъехалась (дефект паритета задачи 608ecb79), критерий собран РОВНО здесь,
 * одним конструктором, общим для клиентского конструктора и серверного теста
 * паритета.
 */

import { STRUCTURE_KEYWORD_SCOPES, type StructureKeywordScope } from './enums.js';
import { parseFilterKeywords } from './keywords.js';
import type { FilterAstLeaf, FilterAstNode } from './types/filter-ast.js';

/**
 * Включена ли область `comment`. Пустой/отсутствующий набор — прежнее поведение
 * «все области»; иначе область должна быть названа явно (требование 9e9d14dc).
 * Одна точка правды для пути Б — тот же предикат использует серверный
 * компилятор плоского тела (`chronicle-service`).
 */
export function commentScopeEnabled(scope: readonly StructureKeywordScope[] | undefined): boolean {
  return scope === undefined || scope.length === 0 || scope.includes('comment');
}

/**
 * Лист «Есть слова» профиля мыслей с ЯВНЫМ непустым списком областей. В AST
 * пустой `scope` означает ОТКЛЮЧЁННОЕ условие (требование 0882f8d5), поэтому
 * «все области» выписывается тремя значениями, а не опускается.
 */
function keywordsLeaf(text: string, scope: readonly StructureKeywordScope[]): FilterAstLeaf {
  return { entity: { kind: 'keywords', scope: [...scope] }, operator: 'matches', value: text };
}

/**
 * Области мыслевого пути: пустой/неизвестный набор — все три (`title`,
 * `synonyms`, `comment`), порядок словаря сети. Пустой набор в панели означает
 * «все области» (поведение до 0.10.1), а не отключённое условие.
 */
function thoughtScope(
  scope: readonly StructureKeywordScope[] | undefined,
): StructureKeywordScope[] {
  const known = STRUCTURE_KEYWORD_SCOPES.filter((name) => scope?.includes(name) === true);
  return known.length > 0 ? [...known] : [...STRUCTURE_KEYWORD_SCOPES];
}

/**
 * Группа текста записи (путь Б): на каждое слово `ИЛИ(тело, заголовок)`,
 * исключающее слово — `НЕ(ИЛИ(тело, заголовок))`; слова соединены по И.
 * `null` — слов нет. Форма повторяет `recordTextGroupNode` серверного компилятора.
 */
function recordTextGroup(
  include: readonly string[],
  exclude: readonly string[],
): FilterAstNode | null {
  const wordNode = (word: string): FilterAstNode => ({
    op: 'or',
    children: [
      { entity: { kind: 'record_body' }, operator: 'matches', value: word },
      { entity: { kind: 'record_title' }, operator: 'matches', value: word },
    ],
  });
  const children: FilterAstNode[] = [];
  for (const word of include) children.push(wordNode(word));
  for (const word of exclude) children.push({ op: 'not', children: [wordNode(word)] });
  if (children.length === 0) return null;
  return children.length === 1 ? children[0]! : { op: 'and', children };
}

/** «Цели не пусты» — путь Б привязан к записи, у которой есть хотя бы одна цель. */
function targetsNotEmpty(): FilterAstLeaf {
  return { entity: { kind: 'targets' }, operator: 'not_empty' };
}

/** «Хотя бы одна цель удовлетворяет „Есть слова“» с областями поиска. */
function targetsKeywordSubquery(
  text: string,
  scope: readonly StructureKeywordScope[],
): FilterAstLeaf {
  return {
    entity: { kind: 'targets' },
    operator: 'in',
    value: { query: keywordsLeaf(text, scope), operator: 'in' },
  };
}

/**
 * Собрать группу ключевых слов панели «Дневника» тем же критерием, что
 * компилятор плоского тела: `ИЛИ(путь А, путь Б)`; ветвь, которой нет, не
 * появляется.
 *
 * `keywords` — строка мини-синтаксиса (`*` — любые символы, `-слово` —
 * исключение), `scope` — отмеченные области мыслевого пути (пустой — все три).
 * Возвращается ГРУППА `or` даже с одним ребёнком: это маркер группы ключевых
 * слов в дереве панели.
 */
export function buildChronicleKeywordGroup(
  keywords: string,
  scope: readonly StructureKeywordScope[] | undefined,
): FilterAstNode {
  const { include, exclude } = parseFilterKeywords(keywords);
  const parts: FilterAstNode[] = [];

  const text = recordTextGroup(include, exclude);
  if (commentScopeEnabled(scope) && text !== null) {
    parts.push({ op: 'and', children: [text, targetsNotEmpty()] });
  }
  // Путь А — только при включающих словах: исключающие слова выражает путь Б,
  // как и в компиляторе плоского тела.
  if (include.length > 0) parts.push(targetsKeywordSubquery(keywords, thoughtScope(scope)));

  // Ни текстового пути (комментарии выключены или слов нет), ни пути А — как и
  // компилятор отдаём «цели не пусты», а не пустое/ложное условие.
  if (parts.length === 0) parts.push(targetsNotEmpty());
  return { op: 'or', children: parts };
}
