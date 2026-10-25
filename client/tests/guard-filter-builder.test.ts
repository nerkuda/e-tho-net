/**
 * Сторож стандарта «Клиент: условия отбора — только через общий конструктор»
 * (S4, задача 48b59d00 вехи 5 версии 0.8.2; ADR «условия отбора строит один
 * конструктор с одной моделью состояния»; расширен на единый редактор
 * 0.13.1 — задача c8c384e2, требование 73a84029 «Сторож общего редактора
 * расширен; вторая модель состояния запрещена»).
 *
 * Правила:
 * 1. Словарь операторов по виду значения объявляется ТОЛЬКО в
 *    `lib/filter-builder.ts` (`const OPS_BY_TYPE … = {`): второй словарь
 *    операторов вне конструктора запрещён.
 * 2. Словарь операторов авторства объявляется ТОЛЬКО там же
 *    (`const AUTHOR_OP_LABELS … = {`): прежде было 4 копии.
 * 3. Набор сортировок отбора объявляется ТОЛЬКО там же: константа
 *    `*SORT*`-массив с литералом `'alpha'`, либо сборка списка `<option>`/
 *    `for (const opt of […)` из литералов сортировок — признак второго
 *    набора, который разойдётся с исполнителем (ошибка 33a3e285).
 * 4. Вторая МОДЕЛЬ состояния отбора в экранах запрещена
 *    (`ChronicleFilterState`, `ActivityFilterState`, `SearchOptions`,
 *    `DialogCriteriaState`): критерии выражаются общей моделью
 *    `FilterCriteriaState`; экранное расширение допустимо только как
 *    `interface X extends FilterCriteriaState`, а собственный объектный тип
 *    (`type FakeFilterState = { … }`) — вторая модель.
 * 5. Второй конвертер/парсер отбора в экранах запрещён (`toDefinition`,
 *    `fromDefinition`, `buildChronicleWire`, `parseChronicleCriteria`,
 *    `buildActivityQueryPlan`, `compileActivityCriteriaToAst`,
 *    `parseActivityCriteriaTree`, …, а также `buildFilterAst`/`filterAstToTree`
 *    как СВОИ объявления): и чтение сохранённого, и запись в wire живут в
 *    `lib/filter-builder.ts`. Общие функции экран лишь ВЫЗЫВАЕТ.
 * 6. Исполнитель отбора (`canvas/focus-filter-strip.ts`) не ведёт своего мнения
 *    о сортировках: гейт `isFilterSort`/`STRUCTURE_SORTS`/`readSavedSort` и
 *    собственный разбор `sort`/`order` в нём запрещены — сохранённую
 *    сортировку читает сервер из определения отбора (ADR 23fab347, задача
 *    46eba874; ошибки 33a3e285/119b314f).
 * 7. Дублирующие словари состава отбора запрещены: матрицы операторов
 *    (`*OPERATOR_SETS`, `OPS_BY_*`), наборы операндов/токенов вне
 *    `lib/filter-builder.ts` — состав операндов/операторов/токенов задаёт
 *    общий реестр `@etn/shared` (требование 0095daad, ADR 23fab347).
 * 8. Место применения не держит отдельной спец-секции для бывшей функции
 *    отбора: её строки-условия строит единый редактор (ADR fc23f9c1 «судьба
 *    спец-секций»). Каркас диагност/дерево/футер и правило «лист вне профиля»
 *    проверяются и положительно — иначе они пропадут молча.
 * 9. Подписи операндов — из словаря единого конструктора: служебная формулировка
 *    «Ссылка на мысль по id» в UI запрещена (операнд id подписан «Мысль»;
 *    решение заказчика 2026-10-14, задача a577875b).
 *
 * Сторож вводится зелёным — в том же изменении, которое сводит все места
 * применения к одному модулю (мета-стандарт «Правило без теста-сторожа
 * не считается введённым»).
 *
 * Смежные сторожа (не дублируют эти правила, а дополняют): `guard-dataset-names`
 * (имена `dataset` рендерера), `guard-filter-issue-fix` (классы строки
 * диагностики и переход «исправить»), `guard-filter-panel-frame` (каркас панели
 * и строка сохранённых отборов).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, collectViolations, listSourceFiles } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/** Файл единого конструктора — единственное разрешённое место словарей. */
const BUILDER = 'lib/filter-builder.ts';

/** Исполнитель отбора — полоса отборов под мыслью в фокусе. */
const STRIP = 'canvas/focus-filter-strip.ts';

/** Экраны и строка поиска — места применения конструктора, а не его копии. */
const APPLY_SITES = (rel: string): boolean => rel.startsWith('screens/') || rel.startsWith('search/');

/**
 * Известные места единого редактора (версия 0.13.1): диалог отбора типа мысли,
 * панели «Структур»/«Дневника», лента «Событий», строка поиска карты (пятое
 * место; задача 8f3b2cf2 — снято прежнее исключение строки поиска из правил
 * спец-секций) и вкладка «Рецепты» редактора публикаций (шестое место; задача
 * a0c071f8 — пересборка рецепта заголовков на дерево).
 */
const EDITOR_PLACE_FILES: ReadonlySet<string> = new Set([
  'screens/thought-type/filter-dialog.ts',
  'screens/structures/filter-panel.ts',
  'screens/chronicle/filter-panel.ts',
  'screens/activity/activity.ts',
  'search/search.ts',
  'screens/publications/recipe.ts',
]);

/**
 * Авто-обнаружение мест: любой файл рендерера, монтирующий единый редактор
 * (`buildFilterEditor(`), становится местом применения и попадает под правила
 * автоматически — новое место не нужно вписывать руками (требование 73a84029).
 */
function discoverEditorPlaces(): Set<string> {
  const out = new Set<string>();
  for (const abs of listSourceFiles(RENDERER_ROOT)) {
    const rel = path.relative(RENDERER_ROOT, abs).replace(/\\/g, '/');
    if (rel.startsWith('lib/') || rel.startsWith('tests/')) continue;
    if (/buildFilterEditor\s*\(/.test(fs.readFileSync(abs, 'utf8'))) out.add(rel);
  }
  return out;
}

/** Места применения редактора, обнаруженные в дереве на момент прогона. */
const DISCOVERED_PLACES: ReadonlySet<string> = discoverEditorPlaces();

/** Является ли файл местом применения единого редактора. */
const isEditorPlace = (rel: string): boolean =>
  EDITOR_PLACE_FILES.has(rel) || DISCOVERED_PLACES.has(rel);

/** Тонкие обёртки-делегаты диалога отбора типа мысли (логики в них нет). */
const DELEGATING_WRAPPERS = new Set(['screens/thought-type/filter-dialog-pure.ts']);

/**
 * Места монтажа редактора, профиль которых НЕ отбирает по свойствам: живой
 * справочник свойств им не нужен, допустима пустая карта.
 */
const EMPTY_REGISTRY_PLACES: ReadonlyMap<string, string> = new Map([
  ['screens/activity/activity.ts', 'профиль «события» не отбирает по свойствам'],
  ['search/search.ts', 'строка поиска не отбирает по свойствам'],
]);

/**
 * Место получает справочник параметром (`opts.registry`) — живой источник
 * проверяется у его владельца, карточки публикации.
 */
const REGISTRY_FROM_OPTIONS = 'screens/publications/recipe.ts';

/** Признак собственной модели критериев отбора. */
const OWN_MODEL_NAMES =
  /^(?:export\s+)?interface\s+(?:ChronicleFilterState|ActivityFilterState|SearchOptions|DialogCriteriaState|FilterCriteriaState|FilterState)\s*(?:extends\b|\{)/;

/** Признак собственной модели-объекта (`type X = { … }`) в экране. */
const OWN_MODEL_TYPE_LITERAL =
  /^(?:export\s+)?type\s+(?:Chronicle|Activity|Search|Dialog|Filter)[A-Za-z_]*\s*=\s*\{/;

/** Признак собственного конвертера/парсера отбора. */
const OWN_CONVERTER =
  /^(?:export\s+)?(?:function|const)\s+(?:toDefinition|fromDefinition|buildWireFilter|buildChronicleWire|parseChronicleCriteria|parseFilterDefinition|buildActivityQueryPlan|parseActivityCriteria|parseSearchCriteria|buildWireDefinition|parseViewDefinition|compileActivityCriteriaToAst|parseActivityCriteriaTree|parseActivityCriteriaTreeDetailed|parseFilterDefinitionTree|parseFilterAstState|compileFlatCriteriaToAst|buildFilterAst|filterAstToTree|compileActivityCriteria)\b/;

/** Признак своей сборки флажка-пилюли словаря или её CSS-класса в экране. */
const OWN_PILL_ELEMENT = /(?:function\s+build\w*Pill\w*\s*\(|['"][a-z][a-z-]*-pills?['"])/;

/** Бывшие спец-секции отбора: их строки-условия строит единый редактор. */
const DISSOLVED_SECTION_BUILDER =
  /buildParentThoughtsSection|buildConditionsSection|buildExtrasSection|buildAuthorshipSection|buildAuthorConditionSection|buildDatesSection|buildSortSection|buildEntityChipSection|buildPillGroupSection|buildTriRow|buildTrashedRow|buildDateRangeRow/;

/** Строка — комментарий (правило к исполняемому коду, не к пояснениям). */
function isComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Правило «своя сборка флажков-пилюль в экране запрещена» (ошибка 83f6028e). */
const NO_LOCAL_PILLS = {
  name: 'no-local-pill-element',
  description:
    'Флажок-пилюля словаря панели отбора строится общим каркасом ' +
    '`buildPillGroupSection` в lib/filter-form.ts, а не в экране: своя сборка ' +
    'не восстанавливала применённый отбор из модели — флажки показывались ' +
    'снятыми при непустом отборе, и непустая лента «Событий» выглядела как ' +
    '«события не сохраняются» (ошибка 83f6028e, задача 3742dd59).',
  filePattern: new RegExp(OWN_PILL_ELEMENT.source, 'g'),
  include: APPLY_SITES,
};

/** Правило «исполнитель не ведёт своего мнения о сортировках» (ADR 23fab347). */
const NO_STRIP_SORT_GATE = {
  name: 'no-strip-sort-gate',
  description:
    'Полоса отборов (canvas/focus-filter-strip.ts) не сверяет и не ' +
    'подменяет сортировку: словарь/гейт/чтение сортировок (' +
    '`isFilterSort`/`STRUCTURE_SORTS`/`unsupportedSort`/`ViewSortOrder`/' +
    '`readSavedSort`) в исполнителе запрещены — сохранённую сортировку читает ' +
    'сервер из определения (ADR 23fab347, задача 46eba874).',
  pattern: /isFilterSort|STRUCTURE_SORTS|unsupportedSort|ViewSortOrder|readSavedSort/,
  include: (rel: string) => rel === STRIP,
  // Упоминания в комментариях (карта модуля) — не код: имя сортировочной
  // функции в пояснении «читает сервер» оставляем, запрет — на вызов/объявление.
  allow: (_rel: string, line: string) => isComment(line),
};

/** Правило «вторая модель состояния отбора в экране» (задача 3742dd59). */
const NO_SECOND_MODEL = {
  name: 'no-second-criteria-model',
  description:
    'Своя модель критериев отбора в экране (`ChronicleFilterState`, ' +
    '`ActivityFilterState`, `SearchOptions`, …) запрещена: критерии ' +
    'выражаются общей `FilterCriteriaState`; экранное расширение — только ' +
    '`interface X extends FilterCriteriaState` (задача 3742dd59).',
  pattern: OWN_MODEL_NAMES,
  include: APPLY_SITES,
  allow: (rel: string, line: string) =>
    DELEGATING_WRAPPERS.has(rel) || line.includes('extends FilterCriteriaState'),
};

/** Правило «вторая модель-объект в экране» (`type X = { … }`). */
const NO_SECOND_MODEL_LITERAL = {
  name: 'no-second-criteria-model-literal',
  description:
    'Объектный тип критериев отбора в экране (`type X = { … }`) — вторая ' +
    'модель состояния: критерии выражаются общей `FilterCriteriaState` ' +
    '(требование 73a84029; интерфейсная форма ловится правилом выше).',
  pattern: OWN_MODEL_TYPE_LITERAL,
  include: APPLY_SITES,
};

/** Правило «второй конвертер/парсер отбора в экране» (задача 3742dd59). */
const NO_SECOND_CONVERTER = {
  name: 'no-second-wire-converter',
  description:
    'Свой конвертер состояния отбора в wire или свой парсер сохранённого ' +
    'определения в экране запрещён (`toDefinition`/`fromDefinition`/' +
    '`buildChronicleWire`/`parseChronicleCriteria`/`buildActivityQueryPlan`/' +
    '`compileActivityCriteriaToAst`/`parseActivityCriteriaTree`/…): и запись, ' +
    'и чтение живут в lib/filter-builder.ts. Общие функции экран лишь вызывает.',
  pattern: OWN_CONVERTER,
  include: APPLY_SITES,
  allow: (rel: string) => DELEGATING_WRAPPERS.has(rel),
};

/** Правило «слово-место не строит бывшую спец-секцию» (ADR fc23f9c1). */
const NO_LOCAL_SPECIAL_SECTION = {
  name: 'no-local-special-section',
  description:
    'Место применения не держит отдельной спец-секции для бывшей функции ' +
    'отбора (`buildParentThoughtsSection`/`buildAuthorshipSection`/' +
    '`buildConditionsSection`/`buildDatesSection`/`buildSortSection`/…): её ' +
    'строки-условия строит единый редактор (ADR fc23f9c1 «судьба спец-секций»). ' +
    'Живая строка поиска «Дневника» (общий `buildKeywordsSection`) — отдельное ' +
    'решение оркестратора 2026-10-12, не бывшая спец-секция.',
  pattern: DISSOLVED_SECTION_BUILDER,
  include: isEditorPlace,
};

/** Правила «состав отбора — из реестра @etn/shared, а не из дублей». */
const NO_SECOND_OPERATOR_MATRIX = {
  name: 'no-second-operator-matrix',
  description:
    'Матрица операторов по операнду/виду значения (`*OPERATOR_SETS`, ' +
    '`OPS_BY_*`) объявляется только в реестре @etn/shared и его клиентских ' +
    'обёртках: вторая матрица разойдётся с исполнителем (требование 0095daad, ' +
    'ADR 23fab347).',
  pattern: /^(?:export\s+)?const\s+(?:[A-Z_]*OPERATOR_SETS[A-Z_]*|OPS_BY_[A-Z_]+)\s*[:=]/,
  include: (rel: string) => !rel.startsWith('lib/'),
};

/** Набор операндов/токенов, объявленный вне единого конструктора. */
const NO_SECOND_OPERAND_SET = {
  name: 'no-second-operand-set',
  description:
    'Свой набор операндов/токенов отбора вне lib/filter-builder.ts запрещён: ' +
    'состав даёт общий реестр @etn/shared (`filterProfileOperands`/' +
    '`filterProfileOperators`; требование 0095daad).',
  pattern:
    /^(?:export\s+)?const\s+[A-Z_]*TOKENS?\s*(?::[^=]+)?=\s*(?:new\s+Set\s*\(\s*)?\[|^(?:export\s+)?const\s+[A-Z_]*OPERANDS?\s*(?::[^=]+)?=\s*(?:new\s+Set\s*\(\s*)?\[/,
  include: (rel: string) => !rel.startsWith('lib/'),
};

/** Правило «подпись операнда id — „Мысль“» (решение заказчика 2026-10-14, a577875b). */
const NO_LEGACY_ID_OPERAND_LABEL = {
  name: 'no-legacy-id-operand-label',
  description:
    'Подпись операнда id — «Мысль» (словарь OPERAND_KIND_LABELS единого ' +
    'конструктора): служебная формулировка «Ссылка на мысль по id» ' +
    'просачивалась в UI, хотя значение задаётся чип-полем мыслей и ID ' +
    'пользователь не видит (решение заказчика 2026-10-14, задача a577875b).',
  // Присвоение подписи в словаре конструктора (упоминания в пояснениях —
  // не нарушение): ср. законные «Ссылка на мысль по id» в doc-комментариях про
  // wiki-ссылки (`[[#<id>]]`).
  pattern: /^\s*id:\s*['"]Ссылка на мысль по id['"]/,
  include: (rel: string) => rel === BUILDER,
};

/** Файл-композер фразы — единственное место её словарей. */
const PHRASE_MODULE = 'lib/filter-phrase.ts';

/**
 * Правило «фразу отбора собирает ОДИН композер» (ошибка d17a8bfd).
 *
 * Строку-представление отбора (фраза-превью футера, тултипы мест) собирает
 * только `lib/filter-phrase.ts`. Второй словарь коннекторов/операторов
 * под-выборки, литерал хвоста сортировки или собственные плейсхолдеры вне него
 * — признак ВТОРОЙ сборки фразы, которая разойдётся с композером (ID/имена,
 * коннекции, формат). Упоминания в пояснениях — не нарушение.
 */
const NO_SECOND_PHRASE_BUILDER = {
  name: 'no-second-phrase-builder',
  description:
    'Фразу-представление отбора собирает единственный композер ' +
    '`lib/filter-phrase.ts` (ошибка d17a8bfd): второй словарь коннекторов ' +
    'И/ИЛИ/НЕ (`GROUP_SEPARATOR`), операторов под-выборки («в выборке»/…) или ' +
    'литерал «сортировка:» вне него запрещены — новое место обязано звать ' +
    '`composeFilterPhrase`.',
  pattern:
    /['"`]сортировка:|['"`](?:все условия|любое условие|в выборке|не в выборке|все в выборке)['"`]|^(?:export\s+)?const\s+GROUP_SEPARATOR\b/,
  include: (rel: string) => rel !== PHRASE_MODULE,
  allow: (_rel: string, line: string) => isComment(line),
};

/**
 * Точки СБОРКИ фразы — вызов любого экспорта композера, собирающего фразу
 * (строка, токены раскраски, определение отбора):
 *   • `composeFilterPhrase` / `composeFilterPhraseFromDefinition` — текстовая фраза;
 *   • `filterPhraseTokens` / `filterPhraseTokensFromDefinition` — токены (задача 58f77990);
 *   • `filterPhraseNodeTokens` — токены узла дерева.
 * Вспомогательные экспорты композера (`filterPhraseToken`, `filterPhraseValue`,
 * `filterPhraseThoughtIds` — подписи значений и сбор id) сюда НЕ входят: их
 * зовут и виджеты значения (`lib/filter-value.ts`), это не сборка фразы.
 */
const PHRASE_BUILDER_CALL =
  /(?:composeFilterPhrase|filterPhraseTokens|filterPhraseNodeTokens)\w*\s*\(/;

/**
 * Потребители композера — файлы, собирающие фразу вызовом композера
 * ({@link PHRASE_BUILDER_CALL}). Их ровно два: фабрика редактора и футер. Новое
 * место обязано звать композер, а не строить фразу само (ошибка d17a8bfd).
 */
function phraseComposerCallers(): string[] {
  const out: string[] = [];
  for (const abs of listSourceFiles(RENDERER_ROOT)) {
    const rel = path.relative(RENDERER_ROOT, abs).replace(/\\/g, '/');
    if (rel === PHRASE_MODULE) continue;
    if (PHRASE_BUILDER_CALL.test(fs.readFileSync(abs, 'utf8'))) out.push(rel);
  }
  return out.sort();
}

/** Читает модуль общего каркаса редактора. */
function readLib(file: string): string {
  return fs.readFileSync(path.join(RENDERER_ROOT, 'lib', file), 'utf8');
}

describe('guard: условия отбора строятся только общим конструктором', () => {
  it('второй словарь операторов (OPS_BY_TYPE) вне lib/filter-builder.ts запрещён', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-second-ops',
        description:
          'Словарь операторов по виду значения объявляется только в ' +
          'lib/filter-builder.ts (стандарт S4, ADR «условия отбора строит один ' +
          'конструктор…»); вторая копия разойдётся с сервером и второй панелью.',
        pattern: /^(?:export\s+)?const\s+OPS_BY_TYPE\s*[:=]/,
        allow: (rel) => rel === BUILDER,
      },
    ]);
  });

  it('второй словарь операторов авторства (AUTHOR_OP_LABELS) вне lib/filter-builder.ts запрещён', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-second-author-labels',
        description:
          'Словарь подписей операторов авторства объявляется только в ' +
          'lib/filter-builder.ts (стандарт S4); прежде копий было четыре.',
        pattern: /^(?:export\s+)?const\s+AUTHOR_OP_LABELS\s*[:=]/,
        allow: (rel) => rel === BUILDER,
      },
    ]);
  });

  it('второй набор сортировок отбора вне lib/filter-builder.ts запрещён', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-second-sort-set',
        description:
          'Набор сортировок отбора объявляется только в lib/filter-builder.ts: ' +
          'константа-массив с *SORT* в имени, содержащая литерал сортировки, ' +
          'или сборка списка опций `for (const opt of […)` из литералов ' +
          'сортировок — второй набор разойдётся с исполнителем (ошибка 33a3e285).',
        filePattern: /const\s+[A-Za-z_]*SORT[A-Za-z_]*\s*(?::[^=]+)?=\s*\[[\s\S]{0,400}?['"]alpha['"]/g,
        allow: (rel) => rel === BUILDER,
      },
      {
        name: 'no-second-sort-options',
        description:
          'Сборка списка опций сортировки из литералов (`for (const opt of [` с ' +
          '`\'alpha\'`/`\'created\'`/…) разрешена только в lib/filter-builder.ts — ' +
          'списки `<option>` обоих отборов собираются из единого FILTER_SORTS.',
        filePattern: /for\s*\(\s*const\s+opt\s+of\s+\[[\s\S]{0,400}?['"]alpha['"]/g,
        allow: (rel) => rel === BUILDER,
      },
    ]);
  });

  it('второй словарь состава отбора из реестра (@etn/shared) запрещён', () => {
    assertGuardClean(RENDERER_ROOT, [NO_SECOND_OPERATOR_MATRIX, NO_SECOND_OPERAND_SET]);
  });

  it('вторая модель состояния отбора в экранах запрещена', () => {
    assertGuardClean(RENDERER_ROOT, [NO_SECOND_MODEL, NO_SECOND_MODEL_LITERAL]);
  });

  it('второй конвертер/парсер отбора в экранах запрещён', () => {
    assertGuardClean(RENDERER_ROOT, [NO_SECOND_CONVERTER]);
  });

  it('исполнитель отбора не ведёт своего мнения о сортировках (ADR 23fab347)', () => {
    // Полоса отборов — ИСПОЛНИТЕЛЬ, а не второй конструктор: она не фильтрует
    // состав сортировок и не подменяет сохранённую (ADR «условия отбора строит
    // один конструктор…», запрет «фильтровать состав сортировок на стороне
    // исполнителя»). Сохранённую сортировку (плоскую пару или `ast.sort`, в т.ч.
    // по свойству реестра) читает сервер из определения отбора — полоса не
    // разбирает её и не передаёт в тело `run`. Прежний свой гейт `isFilterSort`
    // с деградацией к `alpha` и сообщением «неподдерживаемое значение» молча
    // терял сортировки (ошибки 33a3e285/119b314f, задача 46eba874).
    //
    // ВНИМАНИЕ: правило ловит и `readSavedSort` (замечание независимой проверки
    // коммита c888c4c2: `return readSavedSort(value)` в полосе оставлял сторож
    // зелёным). Упоминания в комментариях допущены осознанно.
    assertGuardClean(RENDERER_ROOT, [NO_STRIP_SORT_GATE]);
  });

  it('место применения не строит бывших спец-секций отбора (ADR fc23f9c1)', () => {
    assertGuardClean(RENDERER_ROOT, [NO_LOCAL_SPECIAL_SECTION]);
  });

  it('своя сборка флажков-пилюль словаря в экране запрещена', () => {
    assertGuardClean(RENDERER_ROOT, [NO_LOCAL_PILLS]);
  });

  it('флажок-пилюля словаря строится с применённым отбором (ошибка 83f6028e)', () => {
    // Обратная сторона правила выше: сам каркас обязан строить флажок из
    // модели. Экранов «Событий» теперь много на один каркас, а поведение у
    // них одно — начальное состояние флажка читается из состояния отбора.
    const src = readLib('filter-form.ts');
    const builder =
      /export function buildPillGroupSection[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    assert.notEqual(builder, '', 'buildPillGroupSection обязан жить в lib/filter-form.ts');
    assert.match(
      builder,
      /\.checked\s*=\s*opts\.get\(\)/,
      'флажок обязан создаваться со значением из модели (`input.checked = opts.get()…`): ' +
        'иначе применённый отбор скрыт от пользователя и пустая лента выглядит как ' +
        'потеря событий (ошибка 83f6028e)',
    );
  });

  it('места применения монтируют единый редактор (авто-обнаружение новых мест)', () => {
    // Новое место не вписывается руками: любой файл с `buildFilterEditor(`
    // становится местом и попадает под правила. Проверяем, что механизм
    // обнаружения находит все известные места и не «протух» (требование 73a84029).
    const discovered = [...DISCOVERED_PLACES].sort();
    const expected = [...EDITOR_PLACE_FILES].sort();
    assert.deepEqual(
      discovered,
      expected,
      `авто-обнаружение мест разошлось с известным набором: ` +
        `найдено [${discovered.join(', ')}], ожидалось [${expected.join(', ')}]`,
    );
  });

  it('места монтажа редактора читают живой справочник свойств (6d25c224)', () => {
    // Источник `data.registry` у каждого места обязан быть ЖИВЫМ справочником
    // (`lib/property-catalogue.ts`), а не собственным снимком реестра: иначе
    // создание/переименование/удаление свойства сети не видно в уже открытой
    // панели до перезапуска клиента (ошибка 6d25c224). Пустая карта допустима
    // только там, где профиль места не отбирает по свойствам; новое место
    // обязано либо читать общий справочник, либо быть вписано с обоснованием.
    const violations: string[] = [];
    for (const rel of [...DISCOVERED_PLACES].sort()) {
      const src = fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');
      if (EMPTY_REGISTRY_PLACES.has(rel)) {
        if (!/registry:\s*new Map\(\)/.test(src)) {
          violations.push(`${rel}: ожидался явный пустой реестр (место без операндов-свойств)`);
        }
        continue;
      }
      if (rel === REGISTRY_FROM_OPTIONS) {
        if (!/registry:\s*opts\.registry/.test(src)) {
          violations.push(`${rel}: справочник обязан приходить параметром opts.registry`);
        }
        continue;
      }
      if (!/propertyCatalogue(?:Rows|WithSides)\s*\(/.test(src)) {
        violations.push(`${rel}: data.registry не из общего живого справочника lib/property-catalogue.ts`);
      }
      if (/etn\.propertyRegistry\.list\s*\(/.test(src)) {
        violations.push(`${rel}: собственное чтение реестра свойств — снимок вместо живого справочника`);
      }
    }
    // Живой источник справочника для рецепта публикации — карточка публикации:
    // она же передаёт прочитанные строки общему справочнику.
    const card = fs.readFileSync(path.join(RENDERER_ROOT, 'editor/publication-card.ts'), 'utf8');
    if (!/propertyCatalogueWithSides\s*\(/.test(card)) {
      violations.push('editor/publication-card.ts: рецепт не получает живой справочник');
    }
    if (!/putPropertyCatalogueRows\s*\(/.test(card)) {
      violations.push('editor/publication-card.ts: строки реестра не передаются общему справочнику');
    }
    // Конструктор обязан подписываться на изменение живой карты — иначе
    // обновления справочника невидимы в уже смонтированных условиях.
    const editor = readLib('filter-editor.ts');
    if (!/isLivePropertyCatalogue\(data\.registry\)/.test(editor)) {
      violations.push('lib/filter-editor.ts: нет проверки живого справочника у data.registry');
    }
    if (!/subscribePropertyCatalogue\(opts\.networkId/.test(editor)) {
      violations.push('lib/filter-editor.ts: нет подписки на изменения общего справочника');
    }
    assert.deepEqual(violations, [], violations.join('\n'));
  });

  it('каркас редактора собирает дерево, сортировку, футер и диагностику из общих модулей', () => {
    // Положительная сторона: общий каркас обязан нести все части редактора —
    // иначе место соберёт свою разметку или потеряет переход «исправить» молча
    // (требования ca905fbc «Футер», 0fd1dc5d «Диагностика строк»).
    const editor = readLib('filter-editor.ts');
    assert.match(editor, /buildFilterTree\(\{/, 'редактор собирает дерево условий каркасом');
    assert.match(editor, /buildFilterFooter\(\{/, 'редактор собирает футер каркасом');
    assert.match(
      editor,
      /mergeFilterIssues\(|constructorFilterIssues\(/,
      'редактор сводит общий список диагностики (ядро + проверки конструктора)',
    );
  });

  it('состав операндов/операторов берётся из реестра @etn/shared, а не из места', () => {
    // Положительная сторона правила «дублирующие словари запрещены»: состав
    // редактора читается из реестра профилей, а не объявляется в местах.
    const tree = readLib('filter-tree.ts');
    assert.match(tree, /filterProfileOperands\(/, 'операнды — из реестра профилей');
    assert.match(tree, /filterProfileOperators\(/, 'операторы — из реестра профилей');
    const builder = readLib('filter-builder.ts');
    assert.match(builder, /getFilterProfile\(/, 'реестр профилей — общий источник состава');
  });

  it('лист вне профиля отсекается общим правилом splitLeavesByProfile (16899243)', () => {
    // Правило «лист вне профиля» (коммит 30e42f35): миграция плоского пресета
    // пропускает лишь листья, чей операнд И оператор допустимы профилем точки
    // применения (реестр @etn/shared). Пропажа правила вернёт `VALIDATION_ERROR`
    // на ленте «Событий» (например, `user is_empty`).
    const builder = readLib('filter-builder.ts');
    assert.match(builder, /function splitLeavesByProfile\(/, 'правило обязано жить в конструкторе');
    assert.match(
      builder,
      /splitLeavesByProfile\(candidates, 'events'\)/,
      'компилятор «Событий» обязан отсекать листья вне профиля «события»',
    );
    const body = /function splitLeavesByProfile[\s\S]*?\n\}/.exec(builder)?.[0] ?? '';
    assert.notEqual(body, '', 'тело splitLeavesByProfile не найдено');
    assert.match(body, /filterProfileOperands\(/, 'профиль определяет допустимые операнды');
    assert.match(body, /filterProfileOperators\(/, 'профиль определяет допустимые операторы');
  });

  it('операнд id подписан «Мысль» и допускает «в иерархии»/«не в иерархии» (a577875b)', async () => {
    // Положительная сторона решения заказчика 2026-10-14: служебная подпись
    // «Ссылка на мысль по id» заменена на «Мысль» (ID пользователь не видит), а
    // операнд несёт иерархические операторы — их состав даёт реестр @etn/shared.
    const builder = await import('../src/renderer/lib/filter-builder.js');
    assert.equal(
      builder.OPERAND_KIND_LABELS['id'],
      'Мысль',
      'операнд id обязан подписываться «Мысль» — служебная подпись вида условия в UI недопустима',
    );
    assert.equal(builder.astOperatorLabel('in_hierarchy'), 'в иерархии');
    assert.equal(builder.astOperatorLabel('not_in_hierarchy'), 'не в иерархии');
    const idOps = builder.filterProfileOperators('thoughts', 'id');
    for (const op of ['eq', 'ne', 'in', 'not_in', 'in_hierarchy', 'not_in_hierarchy'] as const) {
      assert.ok(idOps.includes(op), `операнд «Мысль» обязан нести оператор ${op} (реестр @etn/shared)`);
    }
  });

  it('описания операторов и датовые пары — из общего словаря (ошибка 4258e694, п.7в/8)', async () => {
    // Словарь описаний назначения операторов живёт в реестре @etn/shared рядом с
    // профилями (тултипы списка операторов — п.7в); второй копии нет. Датовые
    // пары границ — «больше|меньше», «больше или равно|меньше или равно»,
    // «между|не между» (п.8).
    const shared = await import('@etn/shared');
    const builder = await import('../src/renderer/lib/filter-builder.js');
    const tree = await import('../src/renderer/lib/filter-tree.js');
    const described = shared.AST_OPERATOR_DESCRIPTIONS as Record<string, string>;
    const ops = [...shared.FILTER_AST_OPERATORS] as string[];
    for (const op of ops) {
      assert.ok(
        typeof described[op] === 'string' && described[op]!.trim() !== '',
        `у оператора ${op} обязано быть краткое описание назначения`,
      );
    }
    assert.deepEqual(
      Object.keys(described).sort(),
      [...ops].sort(),
      'словарь описаний покрывает РОВНО словарь операторов ядра',
    );
    assert.equal(described['eq'], 'проверяет точное соответствие заданному значению');
    // Формулировки заказчика 2026-10-14 (п.7б).
    assert.equal(builder.astOperatorLabel('any_of'), 'любой из');
    assert.equal(builder.astOperatorLabel('none_of'), 'ни одного из');

    const date = tree.filterTreeOperatorMenu('thoughts', 'created_at', 'date');
    assert.deepEqual(
      date[0]!.rows.map((row: { cells: Array<{ op: string }> }) => row.cells.map((cell) => cell.op)),
      [
        ['eq', 'ne'],
        ['gt', 'lt'],
        ['gte', 'lte'],
        ['between', 'not_between'],
      ],
      'датовые пары читаются «мин|макс» (п.8), равенство добавлено ошибкой e219112e',
    );
    for (const cell of date[0]!.rows.flatMap((row) => row.cells)) {
      assert.equal(cell.description, described[cell.op], `ячейка ${cell.op} несёт описание-тултип`);
    }
  });

  it('старая подпись «Ссылка на мысль по id» в словаре подписей запрещена', () => {
    assertGuardClean(RENDERER_ROOT, [NO_LEGACY_ID_OPERAND_LABEL]);
  });

  it('фразу отбора собирает один композер (lib/filter-phrase.ts)', () => {
    // Негативная часть: второго словаря коннекторов/операторов под-выборки и
    // литерала «сортировка:» вне композера быть не должно.
    assertGuardClean(RENDERER_ROOT, [NO_SECOND_PHRASE_BUILDER]);
    // Позитивная часть: фразу собирают РОВНО два потребителя — фабрика редактора
    // (футер места) и сам футер. Новое место обязано звать композер
    // (`filterPhraseTokens`/`composeFilterPhrase`), а не строить фразу само
    // (ошибка d17a8bfd, задача 58f77990).
    assert.deepEqual(phraseComposerCallers(), ['lib/filter-editor.ts', 'lib/filter-footer.ts']);
  });

  it('правила краснеют на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-filter-'));
    try {
      fs.mkdirSync(path.join(dir, 'screens', 'fake'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'canvas'), { recursive: true });
      // Для красного прогона правила мест применяем ко ВСЕМУ дереву: реальное
      // место вычисляется авто-обнаружением, фикстура его не монтирует.
      const allPlaces = (): boolean => true;
      const rules = [
        { ...NO_SECOND_MODEL, include: allPlaces },
        { ...NO_SECOND_MODEL_LITERAL, include: allPlaces },
        { ...NO_SECOND_CONVERTER, include: allPlaces },
        { ...NO_SECOND_OPERATOR_MATRIX, include: allPlaces },
        { ...NO_SECOND_OPERAND_SET, include: allPlaces },
        { ...NO_LOCAL_SPECIAL_SECTION, include: allPlaces },
        { ...NO_LOCAL_PILLS, include: allPlaces },
        { ...NO_STRIP_SORT_GATE },
        { ...NO_LEGACY_ID_OPERAND_LABEL, include: allPlaces },
        { ...NO_SECOND_PHRASE_BUILDER },
      ];
      fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'lib', 'filter-builder.ts'),
        ["const OPERAND_KIND_LABELS = {", "  id: 'Ссылка на мысль по id',", '};'].join('\n'),
        'utf8',
      );
      fs.writeFileSync(
        path.join(dir, 'screens', 'fake', 'panel.ts'),
        [
          'export interface ChronicleFilterState {',
          '  keywords: string;',
          '}',
          'export type FilterFakeState = {',
          '  keywords: string;',
          '};',
          'export function toDefinition(state: ChronicleFilterState): unknown {',
          '  return state;',
          '}',
          'const EVENT_OPERATOR_SETS = { occurred_at: ["gte"] };',
          'const ACTIVITY_OPERANDS = ["occurred_at", "action"];',
          'buildAuthorshipSection(ctx, {});',
          'function buildPill(value: string): HTMLElement {',
          "  const label = el('label', 'activity-pill');",
          '  return label;',
          '}',
          "const phraseTail = 'сортировка: ' + key;",
        ].join('\n'),
        'utf8',
      );
      fs.writeFileSync(
        path.join(dir, 'canvas', 'focus-filter-strip.ts'),
        [
          'if (!isFilterSort(sort)) return null; // свой гейт сортировок у исполнителя',
          'return readSavedSort(value); // чтение сортировки у исполнителя',
        ].join('\n'),
        'utf8',
      );
      const names = new Set(collectViolations(dir, rules).map((v) => v.rule));
      assert.ok(names.has('no-second-criteria-model'), 'своя модель обязана попадать в нарушение');
      assert.ok(
        names.has('no-second-criteria-model-literal'),
        'модель-объект (`type X = { … }`) обязана попадать в нарушение',
      );
      assert.ok(names.has('no-second-wire-converter'), 'свой конвертер обязана попадать в нарушение');
      assert.ok(
        names.has('no-second-operator-matrix'),
        'вторая матрица операторов обязана попадать в нарушение',
      );
      assert.ok(
        names.has('no-second-operand-set'),
        'свой набор операндов обязан попадать в нарушение',
      );
      assert.ok(
        names.has('no-local-special-section'),
        'бывшая спец-секция в месте обязана попадать в нарушение',
      );
      assert.ok(names.has('no-local-pill-element'), 'своя сборка пилюль обязана попадать в нарушение');
      assert.ok(
        names.has('no-legacy-id-operand-label'),
        'присвоение служебной подписи «Ссылка на мысль по id» обязано попадать в нарушение',
      );
      assert.ok(
        names.has('no-second-phrase-builder'),
        'второй литерал фразы («сортировка:») вне композера обязан попадать в нарушение',
      );
      const stripViolations = collectViolations(dir, rules).filter(
        (v) => v.rule === 'no-strip-sort-gate',
      );
      assert.ok(
        stripViolations.some((v) => /readSavedSort/.test(v.text)),
        'чтение сортировки (`readSavedSort`) у исполнителя обязано попадать в нарушение',
      );
      assert.ok(
        stripViolations.some((v) => /isFilterSort/.test(v.text)),
        'гейт сортировок у исполнителя обязана попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Сторож новых операндов наличия рёбер (требование 60db9614): у КАЖДОГО
 * операнда профиля мыслей обязан быть непустой набор операторов и подпись в
 * словаре редактора, а словарь состояний ребра — один на клиент, сервер и
 * справку (`@etn/shared`).
 */
describe('guard: операнды профиля мыслей — операторы и подписи (60db9614)', () => {
  it('каждый операнд профиля мыслей имеет непустые операторы и подпись', async () => {
    const shared = await import('@etn/shared');
    const builder = await import('../src/renderer/lib/filter-builder.js');
    const profile = shared.FILTER_PROFILES.thoughts;
    for (const kind of profile.operands) {
      const ops = profile.operand_operators?.[kind] ?? [];
      assert.ok(ops.length > 0, `операнд «${kind}» обязан иметь непустой набор операторов`);
      // «Свойство» подписывается именем из реестра сети/снапшота — служебной
      // подписи у него нет по устройству профиля. Проверяем тот же путь
      // подписи, которым пользуется редактор: реестр пуст, значит обязан
      // сработать снапшот `labels.entity`, а не пустая строка/id.
      const snapshotLabel = 'Подпись свойства из снапшота';
      const label =
        kind === 'property'
          ? builder.filterOperandLabel(
              {
                kind: 'leaf',
                entity: { kind: 'property', property_id: 'guard-property' },
                operator: 'eq',
                value: '',
                labels: { entity: snapshotLabel },
              } as unknown as Parameters<typeof builder.filterOperandLabel>[0],
              { registry: new Map() },
            )
          : builder.OPERAND_KIND_LABELS[kind];
      assert.ok(
        typeof label === 'string' && label.trim() !== '',
        `операнд «${kind}» обязан иметь непустую подпись`,
      );
      if (kind === 'property') {
        assert.equal(label, snapshotLabel, 'property: подпись берётся из снапшота, а не из id');
      }
    }
    for (const kind of ['incoming_links', 'outgoing_links'] as const) {
      assert.ok(profile.operands.includes(kind), `${kind}: доступен в профиле мыслей`);
      assert.deepEqual(
        [...(profile.operand_operators?.[kind] ?? [])],
        ['is_empty', 'not_empty'],
        `${kind}: только наличие/отсутствие`,
      );
    }
  });

  it('словарь состояний ребра общий; UI-дефолт — явный массив без корзины', async () => {
    const shared = await import('@etn/shared');
    assert.deepEqual(
      [...shared.FILTER_LINK_EDGE_STATES],
      ['active', 'inactive', 'trashed', 'not_trashed'],
      'порядок и состав состояний — общий словарь',
    );
    for (const state of shared.FILTER_LINK_EDGE_STATES) {
      const label = shared.FILTER_LINK_EDGE_STATE_LABELS[state];
      assert.ok(typeof label === 'string' && label.trim() !== '', `подпись состояния ${state}`);
    }
    assert.deepEqual(
      [...shared.FILTER_LINK_EDGE_STATE_UI_DEFAULT],
      ['active', 'inactive', 'not_trashed'],
      'UI-дефолт: корзина не учитывается',
    );
  });
});
