/**
 * Подстановка токенов в значениях условий отбора типа мысли
 * (тех.проект 918833e3 «Отборы для типов мыслей», задача 20b2fca0).
 *
 * Пространство имён и синтаксис зафиксированы в ADR 7c1c5bf5
 * «Токены отбора — закрытое пространство имён, а не язык выражений»:
 * валидация при сохранении отбора, разрешение при исполнении — на
 * сервере, иначе результат на холсте и в MCP разойдётся. Грамматика
 * закрытая — функций, скобок вызова и произвольной арифметики нет.
 *
 * Покрывает требования:
 *   * 3697eb65 — токены разрешаются сервером относительно мысли-контекста;
 *   * b7fdab20 — неразрешимый токен даёт пустой результат с пояснением;
 *   * 12fccde9 — множественное свойство подставляется списком и
 *     допустимо только в операциях «в списке» / «не в списке»;
 *   * 00eb824b — операции условий зависят от типа значения.
 *
 * Токены:
 *
 *   * `$thought` / `$thought.id` — id мысли-контекста (псевдоним);
 *   * `$thought.title` / `$thought.synonyms` / `$thought.type` /
 *     `$thought.active` / `$thought.author` / `$thought.editor` /
 *     `$thought.created` / `$thought.updated` — поля мысли;
 *   * `$thought.[<имя свойства>]` — значение свойства мысли;
 *   * `$today` — текущая дата (YYYY-MM-DD);
 *   * `$weekStart` / `$weekEnd` — начало / конец текущей недели (неделя = 7
 *     суток; начало недели задаёт настройка сети «первый день недели»);
 *   * `$monthStart` / `$monthEnd` — первый / последний день текущего месяца;
 *   * `$yearStart` / `$yearEnd` — первое / последнее число текущего года;
 *   * `$user` — id текущего пользователя;
 *   * `$now` / `$hourStart` / `$hourEnd` — текущий момент (ISO-8601) и границы
 *     текущего часа — ТОЛЬКО в контекстах/профилях со временем.
 *
 * Легаси-синонимы границ недели/месяца/года (`$week.start`, `$month.end`,
 * `$year.start` и парные) принимаются наравне с каноническими именами —
 * их продолжает слать клиент периода хроники (0.10.1) и хранят сохранённые
 * отборы; канон из ADR «профили контекста отбора» — camelCase.
 *
 * Арифметика — только над датами: `$today+7d`,
 * `$thought.[Плановый срок]-3d`, `$weekStart-1w`, `$monthEnd+1mo`,
 * `$yearStart-1y`. Шаблон: `$TOKEN±<N><unit>`, где N — целое, unit — `d`
 * (дни), `w` (недели, ровно 7 суток), `mo` (календарные месяцы, день при
 * переполнении прижимается к концу месяца), `y` (календарные годы = 12
 * месяцев) — во всех контекстах, либо `h` (часы), `mi` (минуты) — только в
 * контекстах со временем. Никаких составных выражений.
 *
 * **Границы недели и первый день недели.** Начало недели берётся из настройки
 * сети (`first_day_of_week`, ISO 1=пн … 7=вс); по умолчанию — понедельник.
 * `$weekEnd` — начало + 6 суток.
 *
 * **Контекст со временем.** Токены `$now`/`$hourStart`/`$hourEnd` и единицы
 * `h`/`mi` допустимы только там, где у значения есть время (профиль/контекст
 * отбора со временем, ADR «профили контекста отбора»); в датовом контексте они
 * дают неразрешимость (при сохранении — `422`, при исполнении — структурированный
 * `unresolved`).
 */

import { EtnError, type PropertyValueType } from '@etn/shared';

// ---------------------------------------------------------------------------
// Token syntax
// ---------------------------------------------------------------------------

/**
 * Зарезервированные имена полей мысли (ADR 7c1c5bf5). Сравнение регистрозависимое
 * — именно эти лексемы после `$thought.` распознаются как поле; всё прочее
 * валится как неизвестный токен.
 */
export type ThoughtField =
  | 'id'
  | 'title'
  | 'synonyms'
  | 'type'
  | 'active'
  | 'author'
  | 'editor'
  | 'created'
  | 'updated';

/** Конечный список имён полей мысли — для строгой валидации при парсинге. */
export const THOUGHT_FIELDS: readonly ThoughtField[] = [
  'id',
  'title',
  'synonyms',
  'type',
  'active',
  'author',
  'editor',
  'created',
  'updated',
];

/** Три категории токенов — нужны как для резолвера, так и для валидатора. */
export type TokenKind = 'thought_field' | 'thought_property' | 'global';

/**
 * Один распарсенный токен. Содержит координаты в исходной строке — это даёт
 * отчёту об ошибке точный путь до значения условия (`properties[i].value`).
 */
export interface ParsedToken {
  /** Совпадение as-is (включая `$`). */
  raw: string;
  /** Индекс первого символа в исходной строке. */
  start: number;
  /** Индекс символа после совпадения. */
  end: number;
  kind: TokenKind;
  /** Заполнен при `kind: 'thought_field'`. */
  field?: ThoughtField;
  /** Заполнен при `kind: 'thought_property'`. */
  propertyName?: string;
  /** Смещение в днях: `+N` или `-N`; `undefined` — без арифметики в днях. */
  daysOffset?: number;
  /** Смещение в неделях (`±Nw`); `undefined` — без недельной арифметики. */
  weeksOffset?: number;
  /**
   * Смещение в календарных месяцах (`±Nmo`); `undefined` — без месячной
   * арифметики. Месяц при переполнении прижимается к концу месяца.
   */
  monthsOffset?: number;
  /**
   * Смещение в календарных годах (`±Ny`); `undefined` — без годовой
   * арифметики. Год = 12 календарных месяцев (прижимание дня к концу месяца).
   */
  yearsOffset?: number;
  /** Смещение в часах (`±Nh`); только контексты со временем. */
  hoursOffset?: number;
  /** Смещение в минутах (`±Nmi`); только контексты со временем. */
  minutesOffset?: number;
}

// ---------------------------------------------------------------------------
// Регулярки. Каждая — отдельно, чтобы было видно, что именно мы ищем.
// ---------------------------------------------------------------------------

/**
 * Голова известного токена — без `$` и без хвостовой арифметики.
 *
 * Альтернативы:
 *   * `thought` — псевдоним `$thought.id`;
 *   * `thought.<id|title|synonyms|type|active|author|editor|created|updated>`;
 *   * `thought.[<любой текст без `]`>]` — свойство;
 *   * `today` / `now` / `user` — глобальные;
 *   * `weekStart`/`weekEnd` / `monthStart`/`monthEnd` / `yearStart`/`yearEnd` —
 *     границы текущих недели/месяца/года (канон camelCase);
 *   * `week.start`/`week.end` и парные — легаси-синонимы той же семантики;
 *   * `hourStart`/`hourEnd` — границы текущего часа (только контексты со временем).
 *
 * Вариант «`thought.foo`» НЕ совпадёт ни с одной веткой → попадёт в
 * {@link POTENTIAL_TOKEN_RE} как неизвестный токен.
 */
const TOKEN_HEAD_RE =
  /\$(thought(?:\.(?:id|title|synonyms|type|active|author|editor|created|updated))?(?:\.\[[^\]]+\])?|today|now|user|weekStart|weekEnd|monthStart|monthEnd|yearStart|yearEnd|hourStart|hourEnd|week\.(?:start|end)|month\.(?:start|end)|year\.(?:start|end))/g;

/**
 * Хвостовая арифметика дат: `+7d`, `-3d`, `+1w`, `-1mo`, `+2y`, `+1h`, `-30mi`.
 * Единицы: `d` (дни), `w` (недели = 7 суток), `mo` (календарные месяцы),
 * `y` (календарные годы = 12 месяцев) — везде; `h` (часы), `mi` (минуты) —
 * только контексты со временем. Порядок альтернатив: двухбуквенные `mo`/`mi`
 * раньше однобуквенных, иначе `m` не существует — важно лишь то, что обе
 * двухбуквенные идут первыми. Пробелы недопустимы — `$today + 7d` останется
 * двумя фрагментами и второй уйдёт валидатору как «мусор после токена».
 *
 * Якорь `$` намеренно опущен: `tail` после головы токена содержит хвост
 * строки, и нужно проверить только префикс `+N<unit>`. С `$` на конце
 * регулярка совпала бы только при пустом tail после арифметики, что для всех
 * реальных строк ложно — баг найден на этапе 20b2fca0 (тест
 * «распознаёт хвостовую арифметику ±Nd» в thought-type-view-tokens.test.ts).
 */
const ARITHMETIC_RE = /^([+-])(\d+)(mo|mi|y|w|d|h)/;

/**
 * Канонические глобальные токены (camelCase) и их легаси-синонимы с точкой
 * (0.10.1, период хроники). Семантика общая; синонимы принимаются, чтобы
 * сохранённые отборы и клиент периода не сломались.
 */
const GLOBAL_HEAD_ALIASES: Readonly<Record<string, string>> = {
  'week.start': 'weekStart',
  'week.end': 'weekEnd',
  'month.start': 'monthStart',
  'month.end': 'monthEnd',
  'year.start': 'yearStart',
  'year.end': 'yearEnd',
};

/**
 * Глобальные токены, доступные ТОЛЬКО в контекстах/профилях со временем
 * (ADR «профили контекста отбора» 0c02ab4f). В датовом контексте — неразрешимы.
 */
const TIME_GLOBAL_HEADS: ReadonlySet<string> = new Set(['now', 'hourStart', 'hourEnd']);

/** Привести голову токена к каноническому имени (снять легаси-синоним). */
function canonicalGlobalHead(head: string): string {
  return GLOBAL_HEAD_ALIASES[head] ?? head;
}

/** Голова токена несёт время (момент/границы часа)? */
function isTimeGlobalHead(head: string): boolean {
  return TIME_GLOBAL_HEADS.has(canonicalGlobalHead(head));
}

/** У токена есть часовая/минутная арифметика (только контексты со временем)? */
function hasTimeArithmetic(tok: ParsedToken): boolean {
  return tok.hoursOffset !== undefined || tok.minutesOffset !== undefined;
}

/**
 * Несёт ли токен время — либо сам (`$now`/`$hourStart`/`$hourEnd`), либо через
 * арифметику `±Nh`/`±Nmi`. Используется валидатором и резолвером для запрета
 * токенов времени в датовом контексте.
 */
export function tokenRequiresTime(tok: ParsedToken): boolean {
  return hasTimeArithmetic(tok) || (tok.kind === 'global' && isTimeGlobalHead(headOf(tok)));
}

/**
 * Любой фрагмент, начинающийся с `$<буква>` — кандидат в токен.
 * Совпадения, перекрывающиеся с известными токенами, игнорируются.
 * `$100` и `$тест` не сматчатся (`[A-Za-z]` отвергает цифру и кириллицу).
 */
const POTENTIAL_TOKEN_RE = /\$[A-Za-z][A-Za-z0-9_.[\]\-+]*/g;

// ---------------------------------------------------------------------------
// Property / op meta для валидации
// ---------------------------------------------------------------------------

/**
 * Метаданные одного свойства, которые интересуют валидатор токенов.
 * Берётся из `listEffectiveTypeProperties` или `getEffectiveProperties`-аналога
 * и подаётся в {@link validateDefinitionForTokens}.
 */
export interface PropertyMeta {
  /** Имя свойства в реестре — то, что пользователь увидит и введёт в
   *  `$thought.[...]`. По нему же резолвер находит значение мысли. */
  key: string;
  /** `config.multiple === true` → подставляется списком. */
  multiple: boolean;
  value_type: PropertyValueType;
}

/**
 * Скалярные операции условий свойства. Для них множественный токен — `422`.
 * `in`/`not_in` допускают список, `is_empty`/`not_empty` операнда не читают.
 */
const SCALAR_OPS: ReadonlySet<string> = new Set([
  'eq',
  'ne',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
]);


// ---------------------------------------------------------------------------
// Парсинг токенов в строке
// ---------------------------------------------------------------------------

/**
 * Распарсить все известные токены в одной строке. Неизвестные `$…` —
 * игнорируются (их поймает отдельный проход в {@link scanStringForTokens}).
 */
function parseKnownTokens(s: string): ParsedToken[] {
  const out: ParsedToken[] = [];
  TOKEN_HEAD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_HEAD_RE.exec(s)) !== null) {
    const head = m[1]!;
    const headStart = m.index + 1; // пропустили ведущий `$`
    const headEnd = headStart + head.length;
    let daysOffset: number | undefined;
    let weeksOffset: number | undefined;
    let monthsOffset: number | undefined;
    let yearsOffset: number | undefined;
    let hoursOffset: number | undefined;
    let minutesOffset: number | undefined;
    let totalEnd = headEnd;
    // Хвост после головы — пробуем трактовать как арифметику `±N<unit>`.
    const tail = s.slice(headEnd);
    const arithMatch = ARITHMETIC_RE.exec(tail);
    if (arithMatch !== null) {
      const count = Number.parseInt(arithMatch[2]!, 10) * (arithMatch[1] === '-' ? -1 : 1);
      const unit = arithMatch[3]!;
      if (unit === 'd') daysOffset = count;
      else if (unit === 'w') weeksOffset = count;
      else if (unit === 'y') yearsOffset = count;
      else if (unit === 'h') hoursOffset = count;
      else if (unit === 'mi') minutesOffset = count;
      else monthsOffset = count;
      totalEnd = headEnd + arithMatch[0].length;
      // Сдвигаем lastIndex, чтобы при следующем проходе не зациклиться на пустом
      // совпадении после единицы.
      TOKEN_HEAD_RE.lastIndex = totalEnd;
    }
    const token: ParsedToken = {
      raw: s.slice(m.index, totalEnd),
      start: m.index,
      end: totalEnd,
      kind: classifyHead(head),
      daysOffset,
      weeksOffset,
      monthsOffset,
      yearsOffset,
      hoursOffset,
      minutesOffset,
    };
    if (token.kind === 'thought_field') {
      token.field = extractField(head) ?? 'id';
    } else if (token.kind === 'thought_property') {
      token.propertyName = extractPropertyName(head) ?? '';
    }
    out.push(token);
  }
  return out;
}

/** Голова токена: часть `raw` после `$` до первого `+`/`-` (без арифметики). */
function headOf(tok: ParsedToken): string {
  return tok.raw.slice(1).split(/[+-]/)[0]!;
}

function classifyHead(head: string): TokenKind {
  if (
    head === 'today' ||
    head === 'now' ||
    head === 'user' ||
    head === 'weekStart' ||
    head === 'weekEnd' ||
    head === 'monthStart' ||
    head === 'monthEnd' ||
    head === 'yearStart' ||
    head === 'yearEnd' ||
    head === 'hourStart' ||
    head === 'hourEnd'
  ) {
    return 'global';
  }
  if (head.startsWith('week.') || head.startsWith('month.') || head.startsWith('year.')) {
    return 'global';
  }
  if (head === 'thought') return 'thought_field';
  if (head.startsWith('thought.')) {
    const after = head.slice('thought.'.length);
    if (after.startsWith('[')) return 'thought_property';
    return 'thought_field';
  }
  // Теоретически не достижимо: TOKEN_HEAD_RE строит только из перечисленных веток.
  return 'global';
}

function extractField(head: string): ThoughtField | null {
  if (head === 'thought') return 'id';
  if (head.startsWith('thought.')) {
    const after = head.slice('thought.'.length);
    const known = THOUGHT_FIELDS as readonly string[];
    if (known.includes(after)) return after as ThoughtField;
  }
  return null;
}

function extractPropertyName(head: string): string | null {
  if (!head.startsWith('thought.[')) return null;
  const prefix = 'thought.[';
  const closing = head.indexOf(']');
  if (closing < 0) return null;
  return head.slice(prefix.length, closing);
}

/**
 * Пометить байты, занятые известными токенами, чтобы фильтр-проход
 * {@link POTENTIAL_TOKEN_RE} не считал их «неизвестными».
 */
function indexKnownTokens(s: string, known: ParsedToken[]): Uint8Array {
  const mask = new Uint8Array(s.length);
  for (const t of known) {
    for (let i = t.start; i < t.end; i += 1) mask[i] = 1;
  }
  return mask;
}

/**
 * Собрать все токены в строке: известные классифицируются, неизвестные
 * (валидная форма `$<letter>…`, но не из закрытого пространства имён)
 * возвращаются отдельным массивом для валидатора.
 */
export function scanStringForTokens(s: string): {
  known: ParsedToken[];
  unknown: { raw: string; start: number; end: number }[];
} {
  const known = parseKnownTokens(s);
  const mask = indexKnownTokens(s, known);
  const unknown: { raw: string; start: number; end: number }[] = [];
  POTENTIAL_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = POTENTIAL_TOKEN_RE.exec(s)) !== null) {
    let allKnown = true;
    for (let i = m.index; i < POTENTIAL_TOKEN_RE.lastIndex; i += 1) {
      if (mask[i] !== 1) {
        allKnown = false;
        break;
      }
    }
    if (!allKnown) {
      unknown.push({ raw: m[0], start: m.index, end: POTENTIAL_TOKEN_RE.lastIndex });
    }
  }
  return { known, unknown };
}

// ---------------------------------------------------------------------------
// Issue / reason
// ---------------------------------------------------------------------------

/**
 * Причина, по которой токен отвергнут при валидации или помечен
 * неразрешимым при исполнении. Закрытое множество — фронт и MCP
 * превращают это в сообщения и подсветку поля.
 */
export type TokenIssueReason =
  | 'unknown_token'
  | 'syntax_error'
  | 'unknown_property'
  | 'incompatible_operation'
  | 'empty_value'
  /** Токен/единица времени (`$now`, `$hourStart/$hourEnd`, `h`/`mi`) в контексте без времени. */
  | 'time_context_required';

/**
 * Пометка о проблеме с токеном: где нашли, что нашли, почему плохо.
 * `path` — JSON-путь до строкового значения условия в `definition`; для
 * резолвера — путь до подставленного значения в новом объекте.
 */
export interface TokenIssue {
  path: string;
  token: string;
  reason: TokenIssueReason;
  message: string;
}

// ---------------------------------------------------------------------------
// Валидация при сохранении отбора
// ---------------------------------------------------------------------------

export interface ValidationOptions {
  /**
   * Метаданные свойств РЕЕСТРА СЕТИ: имена, флаг `multiple`, `value_type`.
   *
   * **Свойство резолвится по реестру сети, независимо от привязки к типу
   * отбора** (ошибка 50d9bf4e, пункт A6): токен `$thought.[Имя]` принимается,
   * если такое свойство определено в сети, даже если оно не подключено к типу
   * этого отбора. Свойство вне типа — не ошибка токена: при исполнении, если у
   * оцениваемой мысли значения нет, подставляется пустое значение
   * (семантика отбора), см. {@link resolveTokensInDefinition}. Ранее здесь был
   * список свойств ЦЕПОЧКИ ТИПА и свойство вне типа отвергалось `unknown_property`
   * (требование 3697eb65 в прежней редакции — уточнено 0.13.1).
   *
   * `null`/отсутствует — валидируем только синтаксис и глобальные токены
   * (для валидации при редактировании без доступа к реестру — крайний случай).
   */
  properties?: readonly PropertyMeta[] | null;
  /**
   * Если `false` (по умолчанию) — функция бросает `EtnError` на первой
   * же проблеме. Если `true` — собирает ВСЕ проблемы и тоже бросает
   * (с `details.issues: TokenIssue[]`); удобно для UI, чтобы подсветить
   * все битые токены сразу.
   */
  collectAll?: boolean;
  /**
   * Контекст/профиль отбора: `false` — профиль БЕЗ времени, токены
   * `$now`/`$hourStart`/`$hourEnd` и единицы `h`/`mi` отвергаются
   * (`time_context_required`), ADR 0c02ab4f. Отсутствие/`true` — контекст со
   * временем (историческая совместимость: `$now` доступен, как раньше).
   */
  withTime?: boolean;
}

/**
 * Проверить `definition` отбора: все токены известны, свойства — из цепочки
 * типа, множественные — в списковых операциях. Бросает `VALIDATION_ERROR`
 * (`422`) на первой проблеме либо со сводкой — по `collectAll`.
 */
export function validateDefinitionForTokens(
  definition: Record<string, unknown>,
  opts: ValidationOptions = {},
  requestId?: string,
): void {
  const issues: TokenIssue[] = [];
  const noTimeContext = opts.withTime === false;

  walkDefinitionStrings(definition, (value, path) => {
    const { known, unknown } = scanStringForTokens(value);
    for (const u of unknown) {
      issues.push({
        path,
        token: u.raw,
        reason: 'unknown_token',
        message: `Неизвестный токен «${u.raw}»: разрешены только $today, $now, $user, $weekStart/$weekEnd ($week.start/$week.end), $monthStart/$monthEnd, $yearStart/$yearEnd, $hourStart/$hourEnd, $thought.* и $thought.[имя свойства].`,
      });
    }
    // Токены и единицы времени — только в контексте со временем (ADR 0c02ab4f,
    // требование «Первый день недели…»/«Токены отбора…»).
    if (noTimeContext) {
      for (const tok of known) {
        if (tokenRequiresTime(tok)) {
          issues.push({
            path,
            token: tok.raw,
            reason: 'time_context_required',
            message: `Токен «${tok.raw}» содержит время ($now/$hourStart/$hourEnd или единицы h/mi) и допустим только в отборе со временем.`,
          });
        }
      }
    }
    // Проверка совместимости операций и множественных свойств — только для
    // условий по свойствам (`properties[i].value`). Свойство берётся из реестра
    // СЕТИ (A6), а не из цепочки типа.
    if (/^properties\[\d+\]\.value$/.test(path)) {
      const opPath = path.replace(/\.value$/, '.op');
      const op = readPath(definition, opPath);
      if (typeof op === 'string') {
        for (const tok of known) {
          if (tok.kind !== 'thought_property') continue;
          const prop = findProperty(opts.properties, tok.propertyName ?? '');
          if (prop === null) continue; // отдельная ошибка `unknown_property` ниже
          if (prop.multiple && SCALAR_OPS.has(op)) {
            issues.push({
              path,
              token: tok.raw,
              reason: 'incompatible_operation',
              message: `Свойство «${prop.key}» множественное — операция «${op}» недопустима, используйте in/not_in.`,
            });
          }
        }
      }
    }
  });

  // Второй проход — существование свойства в РЕЕСТРЕ СЕТИ (A6). Свойство,
  // определённое в сети, но не подключённое к типу отбора, — НЕ ошибка токена:
  // оно резолвится по реестру, а при отсутствии значения у мысли даёт пустое
  // значение (семантика отбора).
  if (opts.properties !== undefined && opts.properties !== null) {
    walkDefinitionStrings(definition, (value, path) => {
      const { known } = scanStringForTokens(value);
      for (const tok of known) {
        if (tok.kind !== 'thought_property') continue;
        const prop = findProperty(opts.properties, tok.propertyName ?? '');
        if (prop === null) {
          issues.push({
            path,
            token: tok.raw,
            reason: 'unknown_property',
            message: `Свойство «${tok.propertyName}» не найдено в реестре сети.`,
          });
        }
      }
    });
  }

  if (issues.length === 0) return;
  if (opts.collectAll === true) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'В definition обнаружены ошибки в токенах.',
      { field: 'definition', issues },
      requestId,
    );
  }
  const first = issues[0]!;
  throw new EtnError('VALIDATION_ERROR', first.message, {
    field: 'definition',
    path: first.path,
    token: first.token,
    reason: first.reason,
  }, requestId);
}

function findProperty(
  properties: readonly PropertyMeta[] | null | undefined,
  key: string,
): PropertyMeta | null {
  if (properties === undefined || properties === null) return null;
  for (const p of properties) {
    if (p.key === key) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Резолвер при исполнении
// ---------------------------------------------------------------------------

/**
 * Узел свойства, подготовленный резолвером: имя, тип, флаг `multiple`,
 * скалярное значение или массив (для `multiple`). Резолверу всё равно,
 * откуда взялось значение — мысль-контекст в момент исполнения подменяется
 * актуальным. Для множественных свойств значение приходит уже как `string[]`
 * (по одному элементу на каждую заполненную ячейку).
 */
export interface ResolvedProperty {
  key: string;
  value_type: PropertyValueType;
  multiple: boolean;
  /** Скалярное значение или массив строк (для `multiple`). */
  value: string | number | boolean | string[];
}

/**
 * Контекст, в котором резолвятся токены. Собирается из мысли, её свойств и
 * id пользователя, от имени которого исполняется отбор.
 *
 * `now` — часы для подстановки `$today`/`$now`; вынесено в функцию,
 * чтобы тесты были детерминированными. По умолчанию `() => new Date()`.
 */
export interface ResolveContext {
  thought: {
    id: string;
    title: string;
    synonyms: string[];
    type_id: string | null;
    active: boolean;
    created_by: string;
    updated_by: string;
    created_at: string;
    updated_at: string;
  };
  /** Имя свойства → значение мысли в удобной для резолвера форме. */
  properties: Map<string, ResolvedProperty>;
  /** Id пользователя, от имени которого исполняется отбор. */
  userId: string;
  /** Переопределение часов; используется в тестах. */
  now?: () => Date;
  /**
   * Первый день недели сети (`first_day_of_week`, ISO 1=пн … 7=вс). Влияет на
   * `$weekStart`/`$weekEnd`/`$week.*`. По умолчанию — понедельник (1).
   */
  firstDayOfWeek?: number;
  /**
   * Контекст/профиль отбора (ADR 0c02ab4f). `false` — профиль БЕЗ времени:
   * `$now`, `$hourStart`/`$hourEnd` и единицы `h`/`mi` дают `unresolved`
   * (`time_context_required`). Отсутствие/`true` — контекст со временем
   * (историческая совместимость: `$now` доступен, как раньше).
   */
  withTime?: boolean;
}

export interface ResolveDefinitionResult {
  /** Новый объект `definition` с подставленными значениями; входной не
   *  мутируется (иммутабельный обход через JSON-клон). Формально `unknown`,
   *  потому что обход по строкам может заменить строку массивом
   *  (множественное свойство) на любом уровне JSON. */
  definition: unknown;
  /** Неразрешённые токены — пустой массив означает «всё разрешено». */
  unresolved: TokenIssue[];
}

/**
 * Подставить токены в строковых полях `definition`. Неразрешимые токены
 * не подменяются молча — собираются в `unresolved`, и движок отбора
 * должен вернуть пустой результат с пояснением (требование b7fdab20).
 */
export function resolveTokensInDefinition(
  definition: Record<string, unknown>,
  ctx: ResolveContext,
): ResolveDefinitionResult {
  const unresolved: TokenIssue[] = [];
  const nowFn = ctx.now ?? ((): Date => new Date());

  // Обход с подстановкой: на каждой строке — resolveString. Входной объект
  // не мутируется — это уже копия из вызывающего кода (для run-флоу мы
  // делаем `JSON.parse(JSON.stringify(...))` снаружи, чтобы резолвер был
  // чистой функцией).
  const out = walkAndReplaceStrings(definition, (value, path) => {
    return resolveString(value, path, ctx, nowFn, unresolved);
  });

  return { definition: out, unresolved };
}

/**
 * Результат {@link resolveThoughtTokensInAst}.
 */
export interface ResolveThoughtAstResult {
  /** Новое определение с раскрытыми токенами контекста мысли (вход не мутируется). */
  definition: unknown;
  /** Неразрешимые токены контекста мысли; непусто — исполнять отбор нельзя. */
  unresolved: TokenIssue[];
}

/** Значение-литерал AST, которым заменяется `{ token: … }` (сохраняет природу). */
type AstLiteral = string | number | boolean | string[];

/**
 * Раскрыть в AST-определении отбора ТОЛЬКО токены контекста мысли
 * (`$thought`, `$thought.<поле>`, `$thought.[<свойство>]` с арифметикой даты).
 *
 * **Зачем отдельная функция.** Движок отбора AST (`query-service`) раскрывает
 * токены по `tokenContext` — часам, пользователю и настройкам сети; контекста
 * МЫСЛИ в сетевом запросе нет, и `$thought.*` он честно считает неразрешимым
 * (`resolveGlobalDateTokens`). Отбор ТИПА исполняется «относительно мысли»
 * (`runViewForThought`), где контекст есть, — поэтому раскрытие делает сервис,
 * у которого есть мысль, ДО передачи определения движку. Иначе условие «Мысль
 * в иерархии $thought» на карте давало необъяснимый пустой результат (ошибка
 * 23c7d3e9 п. C3).
 *
 * **Почему структурный обход, а не {@link resolveTokensInDefinition}.** В AST
 * токен — это объект-значение `{ token: "$today" }`, а не строка внутри
 * выражения: подстановка строки ВНУТРЬ такого объекта превратила бы валидный
 * токен в мусорный (`{ token: "<uuid>" }` → `unknown_token`). Поэтому
 * заменяется ВЕСЬ объект-значение, и только когда он несёт токен контекста
 * мысли. Глобальные токены (`$today`, `$user`, `$weekStart`, арифметика по ним)
 * остаются движку: он раскрывает их по `tokenContext` точки применения, и
 * второй резолвер тех же токенов здесь не заводится.
 *
 * Природа значения сохраняется: `$thought.active` → булево, `$thought.synonyms`
 * и множественное `$thought.[…]` → массив, даты/строки — строкой. Значение
 * свойства без заполненной ячейки (по семантике A6) — ПУСТАЯ строка без записи
 * в `unresolved`, как и у плоского резолвера.
 */
export function resolveThoughtTokensInAst(
  definition: unknown,
  ctx: ResolveContext,
): ResolveThoughtAstResult {
  const unresolved: TokenIssue[] = [];
  const nowFn = ctx.now ?? ((): Date => new Date());
  const definition2 = walkAndResolveThoughtTokens(definition, '', ctx, nowFn, unresolved);
  return { definition: definition2, unresolved };
}

/**
 * Рекурсивный обход AST: объект-значение `{ token: '…' }` заменяется
 * вычисленным литералом (когда токен относится к контексту мысли), прочие узлы
 * обходятся как есть. `path` — JSON-путь до узла (для диагностики).
 */
function walkAndResolveThoughtTokens(
  node: unknown,
  path: string,
  ctx: ResolveContext,
  now: () => Date,
  unresolved: TokenIssue[],
): unknown {
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (let index = 0; index < node.length; index += 1) {
      const resolved = walkAndResolveThoughtTokens(node[index], `${path}[${index}]`, ctx, now, unresolved);
      // Токен множественного свойства (`$thought.[<multi>]`, `$thought.synonyms`)
      // раскрывается СПИСКОМ — в списке-значении его элементы разворачиваются,
      // иначе получился бы вложенный список (невалидное значение AST).
      if (Array.isArray(resolved)) out.push(...resolved);
      else out.push(resolved);
    }
    return out;
  }
  if (node === null || typeof node !== 'object') return node;
  const token = (node as Record<string, unknown>)['token'];
  if (typeof token === 'string' && Object.keys(node as Record<string, unknown>).length === 1) {
    const resolved = resolveAstThoughtToken(token, path, ctx, now, unresolved);
    // Не токен контекста мысли — узел остаётся движку как есть.
    return resolved === null ? node : resolved;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    out[key] = walkAndResolveThoughtTokens(value, childPath, ctx, now, unresolved);
  }
  return out;
}

/**
 * Раскрыть один токен-объект AST. `null` — токен НЕ относится к контексту мысли
 * (глобальный или неизвестный: его судьбу решает движок отбора).
 */
function resolveAstThoughtToken(
  token: string,
  path: string,
  ctx: ResolveContext,
  now: () => Date,
  unresolved: TokenIssue[],
): AstLiteral | null {
  const { known, unknown } = scanStringForTokens(token);
  const thoughtTokens = known.filter((tok) => tok.kind !== 'global');
  // Глобальные токены и строки без токенов — не наша забота.
  if (thoughtTokens.length === 0) return null;
  // Смешанный/непонятный набор оставляем движку: он даст штатную диагностику
  // (`unknown_token`) — второй диагностики за него здесь не пишем.
  if (unknown.length > 0) return null;
  // Чистый одиночный токен контекста мысли — ЗНАЧЕНИЕ с его природой.
  if (thoughtTokens.length === 1 && known.length === 1 && token === thoughtTokens[0]!.raw) {
    const value = resolveOneToken(thoughtTokens[0]!, ctx, now, unresolved, path);
    if (value === null) return token;
    // Пустое множество (у мысли нет синонимов, множественное свойство не
    // заполнено) — ПУСТОЕ значение по семантике A6, а не неразрешимый токен:
    // пустой список движок отбора отвергает валидацией, поэтому пустое
    // множество отдаётся пустой строкой (условие не совпадёт ни с чем).
    if (Array.isArray(value) && value.length === 0) return '';
    return value as AstLiteral;
  }
  // Текст с токеном (нормально валидацией не пропускается) — как у плоского
  // резолвера: строка, собранная из кусков.
  const resolved = resolveString(token, path, ctx, now, unresolved);
  return Array.isArray(resolved) ? resolved : resolved;
}

/**
 * Результат {@link resolveGlobalDateTokens}.
 */
export interface GlobalTokenResolveResult {
  /** Строка с подставленными глобальными токенами (без изменений при ошибке). */
  value: string;
  /** Неразрешимые токены; непусто — строку использовать нельзя. */
  unresolved: TokenIssue[];
}

/**
 * Раскрыть в одной строке только глобальные токены (`$today`/`$now`/`$user`,
 * `$week.start`/`$week.end`, `$month.start`/`$month.end`,
 * `$year.start`/`$year.end`) и арифметику `±Nd`/`±Nw`/`±Nmo`/`±Ny`.
 * Токены контекста мысли (`$thought.*`, `$thought.[…]`)
 * неразрешимы без мысли и попадают в `unresolved` — вызывающий решает, что
 * делать (период хроники отвергает их `VALIDATION_ERROR`, требование 91f8d8dd:
 * «период принимает динамические токены дат, язык — из отбора мыслей»).
 *
 * Живёт здесь, а не в хронике, чтобы синтаксис и семантика токенов не
 * дублировались (ADR 7c1c5bf5 «Токены отбора — закрытое пространство имён»).
 */
export function resolveGlobalDateTokens(
  value: string,
  opts: {
    now?: () => Date;
    userId?: string;
    firstDayOfWeek?: number;
    withTime?: boolean;
  } = {},
): GlobalTokenResolveResult {
  const { known, unknown } = scanStringForTokens(value);
  const unresolved: TokenIssue[] = [];
  for (const u of unknown) {
    unresolved.push({
      path: '',
      token: u.raw,
      reason: 'unknown_token',
      message: `Неизвестный токен «${u.raw}».`,
    });
  }
  for (const tok of known) {
    if (tok.kind !== 'global') {
      unresolved.push({
        path: '',
        token: tok.raw,
        reason: 'unknown_token',
        message: `Токен «${tok.raw}» требует контекста мысли и в периоде недопустим; доступны $today/$now, $weekStart/$weekEnd, $monthStart/$monthEnd, $yearStart/$yearEnd, $hourStart/$hourEnd и арифметика ±Nd/±Nw/±Nmo/±Ny/±Nh/±Nmi.`,
      });
    }
  }
  if (unresolved.length > 0) return { value, unresolved };

  const nowFn = opts.now ?? ((): Date => new Date());
  // Контекст-заглушка: глобальные токены мысль и свойства не читают.
  const ctx: ResolveContext = {
    thought: {
      id: '',
      title: '',
      synonyms: [],
      type_id: null,
      active: true,
      created_by: '',
      updated_by: '',
      created_at: '',
      updated_at: '',
    },
    properties: new Map(),
    userId: opts.userId ?? '',
    now: nowFn,
  };
  if (opts.firstDayOfWeek !== undefined) ctx.firstDayOfWeek = opts.firstDayOfWeek;
  if (opts.withTime !== undefined) ctx.withTime = opts.withTime;
  const out = resolveString(value, '', ctx, nowFn, unresolved);
  return { value: Array.isArray(out) ? out.join(', ') : out, unresolved };
}

/**
 * Подставить токены в одной строке. На неразрешимом токене возвращаем
 * исходный фрагмент (`$thought.[…]`) — чтобы ничего не молча подменялось.
 *
 * Если в строке были и текст, и массивный токен — текстовые куски
 * склеиваются через `, ` с массивом. Чистый массивный токен без
 * обрамляющего текста возвращается массивом (его flatten-ит
 * {@link walkAndReplaceStrings} на уровне узла JSON).
 */
function resolveString(
  s: string,
  path: string,
  ctx: ResolveContext,
  now: () => Date,
  unresolved: TokenIssue[],
): string | string[] {
  const { known, unknown } = scanStringForTokens(s);
  if (known.length === 0 && unknown.length === 0) return s;

  for (const u of unknown) {
    unresolved.push({
      path,
      token: u.raw,
      reason: 'unknown_token',
      message: `Неизвестный токен «${u.raw}».`,
    });
  }

  // Собираем «куски»: текст или массив (от множественного токена).
  // Если все куски — массивы и текста не было, отдадим массив массивов —
  // внешний обход сам развернёт.
  const pieces: (string | string[])[] = [];
  let cursor = 0;
  let hasText = false;
  for (const tok of known) {
    if (tok.start > cursor) {
      pieces.push(s.slice(cursor, tok.start));
      hasText = true;
    }
    const resolved = resolveOneToken(tok, ctx, now, unresolved, path);
    if (resolved === null) {
      pieces.push(tok.raw);
      hasText = true;
    } else if (Array.isArray(resolved)) {
      pieces.push(resolved);
    } else {
      pieces.push(stringifyScalar(resolved));
      hasText = true;
    }
    cursor = tok.end;
  }
  if (cursor < s.length) {
    pieces.push(s.slice(cursor));
    hasText = true;
  }

  if (!hasText) {
    // Все куски — массивы. Сливаем в один массив.
    const flat: string[] = [];
    for (const p of pieces) {
      if (Array.isArray(p)) flat.push(...p);
      else flat.push(p);
    }
    return flat;
  }
  // Текст смешан с массивами — соединяем через `, ` (на крайний случай,
  // нормально валидация такие комбинации не пропустит).
  const parts: string[] = [];
  for (const p of pieces) {
    if (Array.isArray(p)) parts.push(p.join(', '));
    else parts.push(p);
  }
  return parts.join('');
}

function resolveOneToken(
  tok: ParsedToken,
  ctx: ResolveContext,
  now: () => Date,
  unresolved: TokenIssue[],
  path: string,
): string | number | boolean | string[] | null {
  // Токены/единицы времени — только в контексте со временем (ADR 0c02ab4f).
  // Запрет включается явным `withTime: false` (профиль без времени); при
  // отсутствии флага сохраняется историческое поведение (`$now` доступен).
  if (ctx.withTime === false && tokenRequiresTime(tok)) {
    unresolved.push({
      path,
      token: tok.raw,
      reason: 'time_context_required',
      message: `Токен «${tok.raw}» содержит время ($now/$hourStart/$hourEnd или единицы h/mi) и допустим только в отборе со временем.`,
    });
    return null;
  }
  switch (tok.kind) {
    case 'thought_field':
      return resolveThoughtField(tok, ctx, now, unresolved, path);
    case 'thought_property':
      return resolveThoughtProperty(tok, ctx, now, unresolved, path);
    case 'global':
      return resolveGlobal(tok, ctx, now, unresolved, path);
  }
}

function resolveThoughtField(
  tok: ParsedToken,
  ctx: ResolveContext,
  now: () => Date,
  unresolved: TokenIssue[],
  path: string,
): string | number | boolean | string[] | null {
  const field = tok.field ?? 'id';
  let raw: string | number | boolean | string[];
  switch (field) {
    case 'id':
      raw = ctx.thought.id;
      break;
    case 'title':
      raw = ctx.thought.title;
      break;
    case 'synonyms':
      raw = ctx.thought.synonyms;
      break;
    case 'type':
      raw = ctx.thought.type_id ?? '';
      break;
    case 'active':
      raw = ctx.thought.active;
      break;
    case 'author':
      raw = ctx.thought.created_by;
      break;
    case 'editor':
      raw = ctx.thought.updated_by;
      break;
    case 'created':
      raw = ctx.thought.created_at;
      break;
    case 'updated':
      raw = ctx.thought.updated_at;
      break;
  }
  return applyDateArithmetic(tok, raw, field, ctx, now, unresolved, path);
}

/**
 * Подставить значение свойства мысли по имени токена. Свойства нет в контексте
 * — это НЕ ошибка токена (ошибка 50d9bf4e, пункт A6): свойство резолвится по
 * реестру сети независимо от привязки к типу, и если у оцениваемой мысли
 * значения нет (или свойство не подключено к типу), по семантике отбора это
 * ПУСТОЕ значение. Возвращаем пустую строку без записи в `unresolved`, чтобы
 * условие сравнивалось с пустотой, а не давало «неразрешимый токен».
 *
 * Арифметика даты в хвосте (`$thought.[Дата]+7d`) применяется к значению
 * свойства тем же {@link applyDateArithmetic}, что и к типовым датовым токенам
 * (`$today+7d`, `$thought.created+7d`) — ошибка 9beab3a5: раньше смещение молча
 * терялось и условие работало как без него. Пустое значение остаётся пустым
 * (смещать нечего) — без записи в `unresolved`, как и требует A6.
 */
function resolveThoughtProperty(
  tok: ParsedToken,
  ctx: ResolveContext,
  now: () => Date,
  unresolved: TokenIssue[],
  path: string,
): string | number | boolean | string[] | null {
  const propName = tok.propertyName ?? '';
  const prop = ctx.properties.get(propName);
  if (prop === undefined) return '';
  if (prop.value === '') return '';
  return applyDateArithmetic(tok, prop.value, `свойство «${propName}»`, ctx, now, unresolved, path);
}

function resolveGlobal(
  tok: ParsedToken,
  ctx: ResolveContext,
  now: () => Date,
  unresolved: TokenIssue[],
  path: string,
): string | number | boolean | string[] | null {
  const head = canonicalGlobalHead(headOf(tok));
  let raw: string | number | boolean;
  if (head === 'today') raw = todayIso(now());
  else if (head === 'now') raw = now().toISOString();
  else if (head === 'user') raw = ctx.userId;
  else if (head === 'weekStart') raw = weekStartIso(now(), ctx.firstDayOfWeek);
  else if (head === 'weekEnd') raw = addDaysIso(weekStartIso(now(), ctx.firstDayOfWeek), 6);
  else if (head === 'hourStart') raw = hourBoundIso(now(), 'start');
  else if (head === 'hourEnd') raw = hourBoundIso(now(), 'end');
  else if (
    head === 'monthStart' ||
    head === 'monthEnd' ||
    head === 'yearStart' ||
    head === 'yearEnd'
  ) {
    // Месячную/годовую арифметику применяем к ЯКОРЮ месяца/года, а не к его
    // последнему дню: `$monthEnd-1mo` — последний день прошлого месяца, а не
    // «минус месяц от последнего дня» (иначе 30 сентября −1 мес дало бы
    // 30 августа). Год = 12 календарных месяцев.
    const monthsTotal = (tok.monthsOffset ?? 0) + (tok.yearsOffset ?? 0) * 12;
    const isYear = head === 'yearStart' || head === 'yearEnd';
    const edge = head === 'monthStart' || head === 'yearStart' ? 'start' : 'end';
    const anchor = isYear
      ? yearBoundIso(now(), monthsTotal, edge)
      : monthBoundIso(now(), monthsTotal, edge);
    return applyDateArithmetic(
      { ...tok, monthsOffset: undefined, yearsOffset: undefined },
      anchor,
      head,
      ctx,
      now,
      unresolved,
      path,
    );
  } else return null;
  return applyDateArithmetic(tok, raw, head, ctx, now, unresolved, path);
}

/**
 * Граница года, сдвинутого на `nMonths` календарных месяцев от даты `d`
 * (UTC): `start` — 1 января, `end` — 31 декабря. Год = 12 месяцев, поэтому
 * `±Ny` приходит сюда как `nMonths = N*12`.
 */
function yearBoundIso(d: Date, nMonths: number, edge: 'start' | 'end'): string {
  const year = d.getUTCFullYear() + Math.floor(nMonths / 12);
  const monthShift = ((nMonths % 12) + 12) % 12;
  if (edge === 'start') {
    return new Date(Date.UTC(year, monthShift, 1)).toISOString().slice(0, 10);
  }
  // Конец года — последний день 12-месячного периода от начала.
  return new Date(Date.UTC(year, monthShift + 12, 0)).toISOString().slice(0, 10);
}

/**
 * Начало недели даты `d` (UTC) при первом дне недели `firstDay` (ISO 1=пн … 7=вс).
 * Без настройки (`undefined`/вне диапазона) — понедельник (1). Неделя — ровно
 * 7 суток, поэтому `$weekEnd` = начало + 6 суток.
 */
function weekStartIso(d: Date, firstDay?: number): string {
  const day = todayIso(d);
  const isoWd = ((new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7) + 1; // 1..7, пн=1
  const first = firstDay !== undefined && firstDay >= 1 && firstDay <= 7 ? firstDay : 1;
  const back = (isoWd - first + 7) % 7;
  return addDaysIso(day, -back);
}

/**
 * Граница текущего часа даты `d` (UTC): `start` — начало часа (миллисекунды 0),
 * `end` — последняя миллисекунда часа (`…:59:59.999Z`). Значения — ISO-8601;
 * как и `$monthEnd`/`$yearEnd`, границы включительны (требование «Токены
 * отбора…»: границы сравниваются включительно).
 */
function hourBoundIso(d: Date, edge: 'start' | 'end'): string {
  const start = new Date(d);
  start.setUTCMinutes(0, 0, 0);
  if (edge === 'start') return start.toISOString();
  return new Date(start.getTime() + 3_600_000 - 1).toISOString();
}

/**
 * Граница месяца, сдвинутого на `n` календарных месяцев от даты `d` (UTC):
 * `start` — первое число, `end` — последнее.
 */
function monthBoundIso(d: Date, n: number, edge: 'start' | 'end'): string {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + n; // может выйти за 0..11 — Date нормализует
  if (edge === 'start') return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  return new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
}

/** Сдвиг даты `YYYY-MM-DD` на сутки в UTC (пустая строка — вход не разобран). */
function addDaysIso(day: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (m === null) return day;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

/** Сдвиг даты на `n` календарных месяцев с прижатием дня к концу месяца. */
function addMonthsClamped(d: Date, n: number): Date {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const targetMonth = month + n;
  // Последний день целевого месяца: нулевой день следующего.
  const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, targetMonth, Math.min(day, lastDay)));
}

/**
 * Применить суффикс арифметики (`±Nd` / `±Nw` / `±Nmo` / `±Ny`) к дате/дате-времени.
 * Для не-дат — ошибка `syntax_error` в списке неразрешённых. Поддерживает
 * `$today`, `$now`, `$week.*`, `$month.*`, `$year.*`, `$thought.created`,
 * `$thought.updated`, `$thought.[<свойство даты>]`. В остальных случаях
 * арифметика бессмысленна — фиксируем как неразрешимый.
 */
function applyDateArithmetic(
  tok: ParsedToken,
  raw: string | number | boolean | string[],
  source: string,
  ctx: ResolveContext,
  now: () => Date,
  unresolved: TokenIssue[],
  path: string,
): string | number | boolean | string[] | null {
  const hasArithmetic =
    tok.daysOffset !== undefined ||
    tok.weeksOffset !== undefined ||
    tok.monthsOffset !== undefined ||
    tok.yearsOffset !== undefined ||
    tok.hoursOffset !== undefined ||
    tok.minutesOffset !== undefined;
  if (!hasArithmetic) {
    if (Array.isArray(raw)) return raw;
    return raw;
  }
  // Арифметика только над датами.
  if (typeof raw !== 'string') {
    unresolved.push({
      path,
      token: tok.raw,
      reason: 'incompatible_operation',
      message: `Арифметика дат применима только к датам; «${tok.raw}» указывает на ${source}.`,
    });
    return null;
  }
  // Поддерживаем и `$today+7d` (YYYY-MM-DD) и `$now+1d` (ISO-8601).
  let base: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    base = new Date(`${raw}T00:00:00.000Z`);
  } else {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      unresolved.push({
        path,
        token: tok.raw,
        reason: 'empty_value',
        message: `Значение «${raw}» не разбирается как дата.`,
      });
      return null;
    }
    base = parsed;
  }
  let shifted = new Date(base);
  // Дни и недели — линейный сдвиг; месяцы и годы — календарный (с прижатием дня).
  const dayShift = (tok.daysOffset ?? 0) + (tok.weeksOffset ?? 0) * 7;
  if (dayShift !== 0) shifted.setUTCDate(shifted.getUTCDate() + dayShift);
  const monthShift = (tok.monthsOffset ?? 0) + (tok.yearsOffset ?? 0) * 12;
  if (monthShift !== 0) {
    shifted = addMonthsClamped(shifted, monthShift);
  }
  // Часы и минуты — линейный сдвиг по времени; выполняется после календарного,
  // чтобы `±Nmo`-прижатие дня не «съедалось» часовым сдвигом.
  const hoursShift = tok.hoursOffset ?? 0;
  const minutesShift = tok.minutesOffset ?? 0;
  if (hoursShift !== 0 || minutesShift !== 0) {
    shifted = new Date(shifted.getTime() + hoursShift * 3_600_000 + minutesShift * 60_000);
  }
  // `$today±Nd`/`$weekStart`/`$month*` без единиц времени остаются YYYY-MM-DD;
  // `$now±…`, `created/updated` и любая арифметика с `h`/`mi` — ISO-8601.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && hoursShift === 0 && minutesShift === 0) {
    return todayIso(shifted);
  }
  return shifted.toISOString();
}

/**
 * Скаляр → строка для подстановки в условие. Булевы и числа — без кавычек,
 * строки — как есть. JSON-литералы строковому полю условия не нужны:
 * парсер `parsePropertyCondition` ожидает «голый» скаляр, а не литерал.
 */
function stringifyScalar(v: string | number | boolean): string {
  return typeof v === 'string' ? v : String(v);
}

/** YYYY-MM-DD в UTC. */
function todayIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Обход definition (JSON-пути)
// ---------------------------------------------------------------------------

/**
 * Обойти все строковые поля `definition` и вызвать `cb(value, path)` для
 * каждого. Пути — в формате `keywords`, `properties[0].value`,
 * `properties[1].property_id`. Числа и булевы не обходятся (токены в них
 * не подставляются — это даёт `422` ещё на сохранении, а резолвер их и
 * так не трогает).
 */
function walkDefinitionStrings(
  root: unknown,
  cb: (value: string, path: string) => void,
  current: string = '',
): void {
  if (root === null || root === undefined) return;
  if (typeof root === 'string') {
    cb(root, current);
    return;
  }
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i += 1) {
      walkDefinitionStrings(root[i], cb, `${current}[${i}]`);
    }
    return;
  }
  if (typeof root === 'object') {
    for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
      const next = current === '' ? k : `${current}.${k}`;
      walkDefinitionStrings(v, cb, next);
    }
  }
}

/**
 * То же, что {@link walkDefinitionStrings}, но `cb` возвращает новое значение
 * (строку или массив — для множественных свойств). Числа/булевы/null/object
 * проходят как есть. Используется в резолвере.
 */
function walkAndReplaceStrings(
  root: unknown,
  cb: (value: string, path: string) => string | string[],
  current: string = '',
): unknown {
  if (root === null || root === undefined) return root;
  if (typeof root === 'string') return cb(root, current);
  if (Array.isArray(root)) {
    const out: unknown[] = [];
    for (let i = 0; i < root.length; i += 1) {
      const item = root[i];
      const childPath = `${current}[${i}]`;
      if (typeof item === 'string') {
        const res = cb(item, childPath);
        if (Array.isArray(res)) out.push(...res);
        else out.push(res);
      } else if (item !== null && typeof item === 'object') {
        out.push(walkAndReplaceStrings(item, cb, childPath));
      } else {
        out.push(item);
      }
    }
    return out;
  }
  if (typeof root === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
      const next = current === '' ? k : `${current}.${k}`;
      if (typeof v === 'string') {
        out[k] = cb(v, next);
      } else if (v !== null && typeof v === 'object') {
        out[k] = walkAndReplaceStrings(v, cb, next);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return root;
}

function readPath(root: unknown, path: string): unknown {
  // Простой JSON-pointer: `properties[0].op` → root.properties[0].op.
  if (path === '') return root;
  const parts = path.split('.');
  let cur: unknown = root;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    const m = /^([^[]+)?(\[(\d+)\])?$/.exec(part);
    if (m === null) return undefined;
    const key = m[1];
    const idx = m[3];
    if (key !== undefined && key !== '') cur = (cur as Record<string, unknown>)[key];
    if (idx !== undefined) cur = (cur as unknown[])[Number(idx)];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Построение контекста из БД (используется в thought-type-views-service)
// ---------------------------------------------------------------------------

/**
 * Свойство мысли с метаданными — нужно резолверу, чтобы знать `multiple`.
 * Узкое подмножество `getPropertyValues`, не зависящее от всего DTO.
 *
 * `null`-значения `getPropertyValues` сюда не доходят — резолверу нечего
 * подставлять вместо пустоты (требование b7fdab20 «пустой результат с
 * пояснением»), и сервис отборов такие свойства в мапу не кладёт.
 */
export interface ThoughtPropertyValue {
  /** Имя свойства в реестре (registry `properties.name`). */
  key: string;
  value_type: PropertyValueType;
  multiple: boolean;
  value: string | number | boolean | string[];
}

/**
 * Собрать {@link ResolveContext} для конкретной мысли: её поля + значения
 * свойств. `properties` отдаются в виде массива (часто удобнее читать
 * сервису отборов), резолвер сам построит из них Map.
 */
export function buildResolveContext(
  thought: ResolveContext['thought'],
  properties: ThoughtPropertyValue[],
  userId: string,
  now?: () => Date,
  extra?: { firstDayOfWeek?: number; withTime?: boolean },
): ResolveContext {
  const map = new Map<string, ResolvedProperty>();
  for (const p of properties) {
    map.set(p.key, {
      key: p.key,
      value_type: p.value_type,
      multiple: p.multiple,
      value: p.value,
    });
  }
  const ctx: ResolveContext = { thought, properties: map, userId };
  if (now !== undefined) ctx.now = now;
  if (extra?.firstDayOfWeek !== undefined) ctx.firstDayOfWeek = extra.firstDayOfWeek;
  if (extra?.withTime !== undefined) ctx.withTime = extra.withTime;
  return ctx;
}
