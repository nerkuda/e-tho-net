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
 *   * `$today` / `$now` — текущая дата (YYYY-MM-DD) / момент (ISO-8601);
 *   * `$user` — id текущего пользователя.
 *
 * Арифметика — только над датами и только в днях: `$today+7d`,
 * `$thought.[Плановый срок]-3d`. Шаблон: `$TOKEN±Nd`, где N — целое,
 * `d` — литерал. Никаких часов, недель, месяцев и составных выражений.
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
  /** Смещение в днях: `+N` или `-N`; `undefined` — без арифметики. */
  daysOffset?: number;
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
 *   * `today` / `now` / `user` — глобальные.
 *
 * Вариант «`thought.foo`» НЕ совпадёт ни с одной веткой → попадёт в
 * {@link POTENTIAL_TOKEN_RE} как неизвестный токен.
 */
const TOKEN_HEAD_RE =
  /\$(thought(?:\.(?:id|title|synonyms|type|active|author|editor|created|updated))?(?:\.\[[^\]]+\])?|today|now|user)/g;

/**
 * Хвостовая арифметика дат: `+7d`, `-3d`. Только целые и только `d`. Пробелы
 * недопустимы — `$today + 7d` останется двумя фрагментами и второй уйдёт
 * валидатору как «мусор после токена».
 *
 * Якорь `$` намеренно опущен: `tail` после головы токена содержит хвост
 * строки, и нужно проверить только префикс `+Nd`. С `$` на конце регулярка
 * совпала бы только при пустом tail после арифметики, что для всех
 * реальных строк ложно — баг найден на этапе 20b2fca0 (тест
 * «распознаёт хвостовую арифметику ±Nd» в thought-type-view-tokens.test.ts).
 */
const ARITHMETIC_RE = /^([+-])(\d+)d/;

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

/**
 * Списковые операции условий свойства. Для них множественный токен
 * допустим — резолвер вернёт массив.
 */
const LIST_OPS: ReadonlySet<string> = new Set(['in', 'not_in']);

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
    let totalEnd = headEnd;
    // Хвост после головы — пробуем трактовать как арифметику `±Nd`.
    const tail = s.slice(headEnd);
    const arithMatch = ARITHMETIC_RE.exec(tail);
    if (arithMatch !== null) {
      daysOffset = Number.parseInt(arithMatch[2]!, 10) * (arithMatch[1] === '-' ? -1 : 1);
      totalEnd = headEnd + arithMatch[0].length;
      // Сдвигаем lastIndex, чтобы при следующем проходе не зациклиться на пустом
      // совпадении после `d`.
      TOKEN_HEAD_RE.lastIndex = totalEnd;
    }
    const token: ParsedToken = {
      raw: s.slice(m.index, totalEnd),
      start: m.index,
      end: totalEnd,
      kind: classifyHead(head),
      daysOffset,
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

function classifyHead(head: string): TokenKind {
  if (head === 'today' || head === 'now' || head === 'user') return 'global';
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
  | 'empty_value';

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
   * Метаданные свойств типа отбора: имена, флаг `multiple`, `value_type`.
   * `null`/отсутствует — тип ещё не связан, валидируем только синтаксис
   * и глобальные токены (для удобства валидации при редактировании
   * отбора без указания типа — крайний случай, оставлено для гибкости).
   */
  thoughtType?: { properties: PropertyMeta[] } | null;
  /**
   * Если `false` (по умолчанию) — функция бросает `EtnError` на первой
   * же проблеме. Если `true` — собирает ВСЕ проблемы и тоже бросает
   * (с `details.issues: TokenIssue[]`); удобно для UI, чтобы подсветить
   * все битые токены сразу.
   */
  collectAll?: boolean;
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

  walkDefinitionStrings(definition, (value, path) => {
    const { known, unknown } = scanStringForTokens(value);
    for (const u of unknown) {
      issues.push({
        path,
        token: u.raw,
        reason: 'unknown_token',
        message: `Неизвестный токен «${u.raw}»: разрешены только $today, $now, $user, $thought.* и $thought.[имя свойства].`,
      });
    }
    // Проверка совместимости операций и множественных свойств — только для
    // условий по свойствам (`properties[i].value`).
    if (/^properties\[\d+\]\.value$/.test(path)) {
      const opPath = path.replace(/\.value$/, '.op');
      const op = readPath(definition, opPath);
      if (typeof op === 'string') {
        for (const tok of known) {
          if (tok.kind !== 'thought_property') continue;
          const prop = findProperty(opts.thoughtType, tok.propertyName ?? '');
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

  // Второй проход — проверка существования свойств в типе.
  if (opts.thoughtType !== undefined && opts.thoughtType !== null) {
    walkDefinitionStrings(definition, (value, path) => {
      const { known } = scanStringForTokens(value);
      for (const tok of known) {
        if (tok.kind !== 'thought_property') continue;
        const prop = findProperty(opts.thoughtType, tok.propertyName ?? '');
        if (prop === null) {
          issues.push({
            path,
            token: tok.raw,
            reason: 'unknown_property',
            message: `Свойство «${tok.propertyName}» не подключено к типу отбора.`,
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
  thoughtType: { properties: PropertyMeta[] } | null | undefined,
  key: string,
): PropertyMeta | null {
  if (thoughtType === undefined || thoughtType === null) return null;
  for (const p of thoughtType.properties) {
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
  switch (tok.kind) {
    case 'thought_field':
      return resolveThoughtField(tok, ctx, now, unresolved, path);
    case 'thought_property':
      return resolveThoughtProperty(tok, ctx, unresolved, path);
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

function resolveThoughtProperty(
  tok: ParsedToken,
  ctx: ResolveContext,
  unresolved: TokenIssue[],
  path: string,
): string | number | boolean | string[] | null {
  const propName = tok.propertyName ?? '';
  const prop = ctx.properties.get(propName);
  if (prop === undefined) {
    unresolved.push({
      path,
      token: tok.raw,
      reason: 'unknown_property',
      message: `Свойство «${propName}» не подключено к типу мысли.`,
    });
    return null;
  }
  return prop.value;
}

function resolveGlobal(
  tok: ParsedToken,
  ctx: ResolveContext,
  now: () => Date,
  unresolved: TokenIssue[],
  path: string,
): string | number | boolean | string[] | null {
  const head = tok.raw.slice(1).split(/[+\-]/)[0]!;
  let raw: string | number | boolean;
  if (head === 'today') raw = todayIso(now());
  else if (head === 'now') raw = now().toISOString();
  else if (head === 'user') raw = ctx.userId;
  else return null;
  return applyDateArithmetic(tok, raw, head, ctx, now, unresolved, path);
}

/**
 * Применить суффикс `±Nd` к дате/дате-времени. Для не-дат — ошибка
 * `syntax_error` в списке неразрешённых. Поддерживает `$today`,
 * `$now`, `$thought.created`, `$thought.updated`,
 * `$thought.[<свойство даты>]`. В остальных случаях арифметика
 * бессмысленна — фиксируем как неразрешимый.
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
  if (tok.daysOffset === undefined) {
    if (Array.isArray(raw)) return raw;
    return raw;
  }
  // Арифметика только над датами.
  if (typeof raw !== 'string') {
    unresolved.push({
      path,
      token: tok.raw,
      reason: 'incompatible_operation',
      message: `Арифметика дней применима только к датам; «${tok.raw}» указывает на ${source}.`,
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
  const shifted = new Date(base);
  shifted.setUTCDate(shifted.getUTCDate() + tok.daysOffset);
  // `$today±Nd` остаётся YYYY-MM-DD, `$now±Nd` и `created/updated` — ISO-8601.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
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
    const m = /^([^\[]+)?(\[(\d+)\])?$/.exec(part);
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
  return ctx;
}
