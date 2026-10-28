/**
 * Сторож единственного источника строки «Not connected…» (ошибка f803afb6,
 * круги 2–8).
 *
 * Канонический отказ main до установки соединения — `NOT_CONNECTED_ERROR_TEXT`
 * и `NOT_CONNECTED_NETWORK_ERROR_TEXT` из `@etn/shared`. До этого литерал был
 * продублирован в `ipc/handlers.ts` (шесть мест), `ipc/connection-lifecycle.ts`,
 * регэкспе `renderer/lib/dom.ts` и в тестах: смена формулировки в main
 * проходила `npm test`, потому что тест сравнивал с СВОИМ литералом, а не с
 * источником.
 *
 * Правило: полного литерала `Not connected: call etn.server.connect…` нет нигде,
 * кроме `shared/src/errors.ts`. Main, renderer и тесты берут константу из
 * shared — поэтому «тест сравнивает с собственным литералом» тоже краснит
 * сторож. Исключения задаются АБСОЛЮТНЫМИ путями: относительный
 * `rel === 'src/errors.ts'` разрешал одноимённый файл в каждом корне
 * сканирования, и `client/src/errors.ts` с литералом проходил сторожем
 * (замечание верификатора круга 2, закрыто в круге 3).
 *
 * Строки-комментарии разрешены по СОСТОЯНИЮ ЛЕКСЕРА, а не по первому символу
 * строки: продолжение шаблонной строки, начинающееся с `*`, — код, и дубль в
 * нём краснит сторож (замечание проверки круга 3, дефект с круга 2; закрыто в
 * круге 4). Расширения файлов сканируются без учёта регистра (`.TS` — тот же
 * исходник): это правка общего `guard-helpers.ts`, тоже круг 4.
 *
 * Лексер различает регулярные литералы `/…/` (круг 5): без этого `\/` плюс
 * закрывающий `/` давали `//` и съедали дубль на той же строке, а `/*` внутри
 * класса открывал блочный комментарий до `*\/`/EOF. Эвристика и её границы —
 * в комментарии `commentRanges`.
 *
 * Круг 6: `++`/`--` после значения — постфиксные, а TS non-null `!` после
 * значения — не оператор, поэтому `/` после них деление (на `6b31c7d1` такие
 * строки краснили настоящий `//`-комментарий с литералом). Перевод строки в
 * состоянии `code` сбрасывает `prev`: регулярка в начале строки после `}`
 * распознаётся. Последствие границы «после значения» — `/*` нераспознанной
 * регулярки открывает блочный комментарий до EOF и глушит остаток файла
 * (подробно — в `commentRanges`); на дофиксовой базе регулярки не разбирались
 * вовсе, так что дыра не расширена.
 *
 * Круг 7: `//`-комментарий потребляет свой `\n`, поэтому сброс `prev` в
 * состоянии `code` не срабатывал, и строка после комментария, начавшаяся с
 * `/[/*]/`, читалась как деление — `/*` открывал блочный комментарий до EOF и
 * глушил дубль. Теперь `line` сбрасывает `prev` при закрытии, а многострочный
 * `block` — при `*\/` ниже строки `/*` (до `*\/` на последней строке кода не
 * было). Обратная сторона — ASI-граница «деление в начале строки-продолжения»,
 * описана в `commentRanges`.
 *
 * Круг 8: закрыты замечания проверки круга 7. Кейс с `*\/` в начале новой
 * строки проверяет границу сброса, кейс с делением после однострочного `*\/`
 * (`} /* x *\/ / 2;`) защищает условие `lastIndexOf`: без него `//` на той же
 * строке съедался нераспознанной регуляркой и давал ложное нарушение.
 *
 * Мутации, которые краснят: вернуть `throw new Error('Not connected: …')` в
 * `client/src/main/ipc/handlers.ts` или `connection-lifecycle.ts`; вернуть
 * литерал в любой тест; вернуть широкий `rel`-allow; вернуть эвристику
 * «комментарий — по первому символу строки»; вернуть регистрозависимое
 * сравнение расширения в `guard-helpers.ts`; выключить распознавание
 * регулярок (`startsRegex` → `false`); сломать класс `[…]` (закрывать
 * литерал по любому `/`); трактовать все `++`/`--`/`!` как префиксные;
 * убрать сброс `prev` на переводе строки; убрать сброс `prev` при закрытии
 * `//`-комментария или многострочного `/* *\/`; сбрасывать `prev` после любого
 * `*\/`, включая однострочный.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, collectViolations, type GuardRule } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_ROOT = path.resolve(CLIENT_ROOT, '..', 'shared');

/** Полная каноническая строка: в коде допустима только в shared-источнике. */
const LITERAL_RE = /Not connected: call etn\.server\.connect/;

/** Диапазон комментария в содержимом файла: `[start, end)`. */
interface CommentRange {
  start: number;
  end: number;
}

/** Режим кадра лексера. */
type LexMode = 'code' | 'template' | 'single' | 'double' | 'line' | 'block' | 'regex';

/** Кадр стека лексера: режим, глубина `{…}` интерполяции и начало комментария. */
interface LexFrame {
  mode: LexMode;
  /** Для `code` внутри `${…}`: сколько `{` ещё не закрыто (стартует с 1). */
  braces: number;
  /** Для `line`/`block`: смещение начала комментария; иначе -1. */
  commentStart: number;
  /** Для `code`: последний значимый токен — слово или одиночный символ. */
  prev: string;
  /** Для `code`: накопленный идентификатор — станет `prev` на не-словесном символе. */
  word: string;
  /** Для `regex`: внутри класса `[…]` — там `/` не закрывает литерал. */
  inClass: boolean;
}

/** Новый кадр в начальном состоянии. */
function createFrame(mode: LexMode): LexFrame {
  return { mode, braces: 0, commentStart: -1, prev: '', word: '', inClass: false };
}

/**
 * Символы, после которых `/` — начало регулярного литерала, а не деление:
 * операторы и открывающие скобки.
 */
const REGEX_PREFIX_CHARS = new Set('([{,;=:!&|?+-*%<>');

/** Ключевые слова, после которых `/` — начало регулярного литерала. */
const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'instanceof',
]);

/** Символ идентификатора (ASCII): для ключевых слов эвристики достаточно. */
const WORD_CHAR = /[A-Za-z0-9_$]/;

/**
 * Начинается ли в позиции `/` регулярный литерал: по предыдущему значимому
 * токену — начало файла/строки (`prev` сбрасывается на переводе строки в
 * состоянии `code`), оператор, открывающая скобка или ключевое слово из
 * {@link REGEX_PREFIX_KEYWORDS}. После значения (идентификатор, число, `)`,
 * `]`, `}`, литерал, результат деления) `/` — деление. Постфиксные `++`/`--`
 * и TS non-null `!` значение не меняют, поэтому тоже оставляют деление.
 */
function startsRegex(prev: string): boolean {
  return prev === '' || REGEX_PREFIX_CHARS.has(prev) || REGEX_PREFIX_KEYWORDS.has(prev);
}

/**
 * Завершает ли `prev` значение: тогда `/` после него — деление, а `++`/`--`
 * (постфиксные) и `!` (TS non-null) выбор не меняют. Начало файла/строки
 * значением не считается.
 */
function endsValue(prev: string): boolean {
  return prev !== '' && !startsRegex(prev);
}

/**
 * Диапазоны комментариев файла — по состоянию лексера, а не по первому символу
 * строки. Различаются `//`, `/* … *\/`, строки `'…'`/`"…"`, шаблоны `` `…` ``
 * с экранированием и вложенными `${…}` (в интерполяции комментарии настоящие)
 * и регулярные литералы `/…/`.
 *
 * Регулярка распознаётся эвристикой по предыдущему значимому токену (см.
 * {@link startsRegex}): `/` открывает литерал в начале файла/строки (`prev`
 * сбрасывается на переводе строки в состоянии `code`), после оператора или
 * открывающей скобки (`(`, `[`, `{`, `,`, `;`, `=`, `:`, `!`, `&`, `|`, `?`,
 * `+`, `-`, `*`, `%`, `<`, `>`) и после ключевых слов `return`, `typeof`,
 * `case`, `do`, `else`, `in`, `of`, `new`, `delete`, `void`, `throw`,
 * `instanceof`. Внутри литерала учитываются класс `[…]` (там `/` не
 * закрывает), экранирование `\` и флаги после закрывающего `/`.
 *
 * Границы эвристики. После значения — идентификатора, числа, `)`, `]`, `}`,
 * `'…'`, `"…"`, `` `…` ``, другого литерала, результата деления — `/`
 * считается делением, поэтому регулярка сразу после `)` (`if (ok) /re/.test(s)`)
 * не распознаётся. Последствие неровное: `//` в такой нераспознанной регулярке
 * завершает строку, а `/*` открывает блочный комментарий до `*\/`/EOF и глушит
 * ВЕСЬ остаток файла — дубль пропускается не только на своей строке. До круга 5
 * регулярки не разбирались вовсе (тот же эффект давала любая `/…/`), так что
 * эвристика дыру не расширила, а сузила. Признанная регулярка переводом строки
 * завершается (ветка `regex`), поэтому ошибка эвристики не глушит файл до EOF.
 * Обратная сторона сброса `prev` на переводе строки (он же происходит при
 * закрытии `//`-комментария и многострочного `/* … *\/`): деление в начале
 * строки-продолжения (`const half = total`, перевод строки, `  / count;`)
 * читается как начало литерала, `//` внутри него съедается литералом, и
 * литерал в этом «комментарии» даёт ложное нарушение. Осознанная граница:
 * prettier ставит бинарный оператор в конце строки, в дереве таких строк нет,
 * а пропуск дубля (обратное направление ошибки) дороже ложного красного.
 * Постфиксные `++`/`--` после значения и TS non-null `!` значение не меняют:
 * `/` после них — деление. Класс `[…]` разбирается без вложенности и без
 * особого случая `]` первым символом. Форматы данных (`.json`) сторож не
 * сканирует: литерал прозой в сценарии — вне области правила (осознанное
 * ограничение). Строки и шаблоны считаются кодом — литерал в них нарушение,
 * а не цитата.
 */
function commentRanges(content: string): CommentRange[] {
  const ranges: CommentRange[] = [];
  const stack: LexFrame[] = [createFrame('code')];
  const top = (): LexFrame => stack[stack.length - 1]!;
  /** Закрывает строку/шаблон/регулярку: следующий `/` — деление, а не литерал. */
  const popLiteral = (): void => {
    stack.pop();
    top().prev = ')';
  };
  let i = 0;
  while (i < content.length) {
    const frame = top();
    const ch = content[i]!;
    switch (frame.mode) {
      case 'line':
        if (ch === '\n') {
          stack.pop();
          ranges.push({ start: frame.commentStart, end: i });
          // Строка комментария закончилась: следующая начинается как начало
          // файла. `\n` потреблён этим кадром, поэтому ветка `\n` в `code`
          // сброс не сделает (замечание проверки круга 6).
          top().prev = '';
        }
        i += 1;
        break;
      case 'block':
        if (ch === '*' && content[i + 1] === '/') {
          stack.pop();
          ranges.push({ start: frame.commentStart, end: i + 2 });
          // Многострочный комментарий оставляет `*/` на новой строке: до него
          // на этой строке кода не было, поэтому `prev` — как в начале строки.
          if (content.lastIndexOf('\n', i) > frame.commentStart) top().prev = '';
          i += 2;
        } else {
          i += 1;
        }
        break;
      case 'single':
      case 'double':
        if (ch === '\\') {
          i += 2;
        } else {
          if (ch === (frame.mode === 'single' ? "'" : '"')) popLiteral();
          i += 1;
        }
        break;
      case 'template':
        if (ch === '\\') {
          i += 2;
        } else if (ch === '`') {
          popLiteral();
          i += 1;
        } else if (ch === '$' && content[i + 1] === '{') {
          const nested = createFrame('code');
          nested.braces = 1;
          stack.push(nested);
          i += 2;
        } else {
          i += 1;
        }
        break;
      case 'regex':
        if (ch === '\\') {
          i += 2; // экранированный символ, в том числе `\/`
        } else if (ch === '[' && !frame.inClass) {
          frame.inClass = true;
          i += 1;
        } else if (ch === ']' && frame.inClass) {
          frame.inClass = false;
          i += 1;
        } else if (ch === '/' && !frame.inClass) {
          popLiteral();
          i += 1;
          while (i < content.length && /[A-Za-z]/.test(content[i]!)) i += 1; // флаги
        } else if (ch === '\n') {
          // Признанная регулярка не переживает перевод строки: выходим, не
          // съедая его, чтобы ошибка эвристики не глушила файл до EOF. У
          // нераспознанной (после значения) `/*` открывает блочный комментарий
          // до EOF — см. границы в doc-комментарии `commentRanges`.
          popLiteral();
        } else {
          i += 1;
        }
        break;
      case 'code':
        // Слово закончилось: последний значимый токен — это оно.
        if (frame.word !== '' && !WORD_CHAR.test(ch)) {
          frame.prev = frame.word;
          frame.word = '';
        }
        if (ch === '/' && content[i + 1] === '/') {
          const nested = createFrame('line');
          nested.commentStart = i;
          stack.push(nested);
          i += 2;
        } else if (ch === '/' && content[i + 1] === '*') {
          const nested = createFrame('block');
          nested.commentStart = i;
          stack.push(nested);
          i += 2;
        } else if (ch === "'") {
          stack.push(createFrame('single'));
          i += 1;
        } else if (ch === '"') {
          stack.push(createFrame('double'));
          i += 1;
        } else if (ch === '`') {
          stack.push(createFrame('template'));
          i += 1;
        } else if (ch === '/') {
          // `/` — литерал или деление: решает предыдущий значимый токен.
          if (startsRegex(frame.prev)) stack.push(createFrame('regex'));
          else frame.prev = '/';
          i += 1;
        } else if (ch === '{') {
          frame.prev = '{';
          if (frame.braces > 0) frame.braces += 1;
          i += 1;
        } else if (ch === '}') {
          if (frame.braces > 0) {
            frame.braces -= 1;
            if (frame.braces === 0) stack.pop();
          } else {
            frame.prev = '}';
          }
          i += 1;
        } else if ((ch === '+' || ch === '-') && content[i + 1] === ch) {
          // `++`/`--`: после значения — постфиксные, выбор «деление» остаётся;
          // перед значением — префиксный оператор, после которого `/` открывает
          // литерал.
          if (!endsValue(frame.prev)) frame.prev = ch;
          i += 2;
        } else if (ch === '!' && endsValue(frame.prev)) {
          // TS non-null assertion после значения: `prev` остаётся значением,
          // поэтому `/` после `!` — деление. `!` перед значением — префиксный
          // оператор и попадает в общую ветку ниже.
          i += 1;
        } else if (WORD_CHAR.test(ch)) {
          frame.word += ch;
          i += 1;
        } else if (ch === '\n') {
          // Перевод строки — начало новой строки: `/` в её начале снова может
          // открыть литерал (например, регулярка после `}` на предыдущей).
          // ASI-случаи («деление в начале строки») эвристика не различает —
          // осознанное ограничение.
          frame.prev = '';
          i += 1;
        } else if (/\s/.test(ch)) {
          i += 1;
        } else {
          frame.prev = ch;
          i += 1;
        }
        break;
    }
  }
  // Комментарий, не закрытый до конца файла: `line` без перевода строки или
  // `block` без `*/` — тянется до EOF.
  const last = top();
  if (last.mode === 'line' || last.mode === 'block') {
    ranges.push({ start: last.commentStart, end: content.length });
  }
  return ranges;
}

/**
 * Все совпадения литерала на строке `lineNo` лежат внутри комментариев файла
 * (одна строка может содержать и цитату в комментарии, и дубль в коде — тогда
 * нарушение есть).
 */
function isOnlyInComments(content: string, lineNo: number, line: string): boolean {
  const ranges = commentRanges(content);
  let lineStart = 0;
  for (let n = 1; n < lineNo; n += 1) {
    const newline = content.indexOf('\n', lineStart);
    if (newline === -1) return false; // строка за пределами содержимого — не наша
    lineStart = newline + 1;
  }
  const matches = [...line.matchAll(new RegExp(LITERAL_RE.source, 'g'))];
  if (matches.length === 0) return false;
  return matches.every((match) => {
    const offset = lineStart + (match.index ?? 0);
    return ranges.some((range) => offset >= range.start && offset < range.end);
  });
}

/**
 * Ключ абсолютного пути для сравнения исключений: на Windows регистр не
 * значим (путь от `readdir` и от `import.meta.url` может отличаться регистром
 * диска или каталога).
 */
function pathKey(file: string): string {
  const abs = path.resolve(file);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * Правила для одного корня сканирования.
 *
 * @param root — корень сканирования (относительные пути helper'а считаются от него)
 * @param sourceFile — абсолютный путь единственного разрешённого источника строки
 * @param exemptFiles — абсолютные пути файлов, цитирующих литерал в объявлении правила
 */
function rulesFor(root: string, sourceFile: string, exemptFiles: readonly string[] = []): GuardRule[] {
  const allowedFiles = new Set([sourceFile, ...exemptFiles].map(pathKey));
  return [
    {
      name: 'not-connected-single-source',
      description:
        'канонический отказ «Not connected…» живёт только в shared/src/errors.ts; ' +
        'main, renderer и тесты обязаны брать NOT_CONNECTED_ERROR_TEXT/' +
        'NOT_CONNECTED_NETWORK_ERROR_TEXT, а не собственный литерал',
      pattern: LITERAL_RE,
      allow: (rel, line, lineNo, content) =>
        allowedFiles.has(pathKey(path.resolve(root, rel))) ||
        isOnlyInComments(content, lineNo, line),
    },
  ];
}

/** Единственный источник строки и файл, цитирующий её в объявлении правила. */
const SOURCE_FILE = path.resolve(SHARED_ROOT, 'src', 'errors.ts');
const GUARD_FILE = fileURLToPath(import.meta.url);

function rules(root: string): GuardRule[] {
  return rulesFor(root, SOURCE_FILE, [GUARD_FILE]);
}

describe('guard: строка «Not connected…» — один источник (f803afb6)', () => {
  it('в client и shared нет дубля литерала', () => {
    assertGuardClean(CLIENT_ROOT, rules(CLIENT_ROOT));
    assertGuardClean(SHARED_ROOT, rules(SHARED_ROOT));
  });

  it('ловит дубль, но пропускает источник и комментарий', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-'));
    mkdirSync(path.join(dir, 'src'));
    // Источник: единственное разрешённое место.
    writeFileSync(
      path.join(dir, 'src', 'errors.ts'),
      "export const NOT_CONNECTED_ERROR_PREFIX = 'Not connected: call etn.server.connect';\n",
    );
    // Дубль в коде — нарушение.
    writeFileSync(
      path.join(dir, 'src', 'handlers.ts'),
      "throw new Error('Not connected: call etn.server.connect first');\n",
    );
    // Цитата в комментарии — не источник строки.
    writeFileSync(
      path.join(dir, 'src', 'note.ts'),
      '/** Цитата: Not connected: call etn.server.connect first */\nexport const ok = 1;\n',
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/handlers.ts:1'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('ловит литерал на строке продолжения шаблона, начинающейся с *', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-template-'));
    mkdirSync(path.join(dir, 'src'));
    // Строка продолжения шаблонной строки начинается с `*`: эвристика «первый
    // символ строки» принимала её за JSDoc и пропускала дубль (дыра круга 2).
    writeFileSync(
      path.join(dir, 'src', 'template.ts'),
      'const message = `\n * Not connected: call etn.server.connect first`;\n',
    );
    // Настоящий комментарий рядом остаётся разрешённым — правка не расширяет запрет.
    writeFileSync(
      path.join(dir, 'src', 'note.ts'),
      '/** Цитата: Not connected: call etn.server.connect first */\nexport const ok = 1;\n',
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/template.ts:2'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('регулярка /^https?:\\/\\// не превращает остаток строки в комментарий', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-regex-slash-'));
    mkdirSync(path.join(dir, 'src'));
    // `\/` + закрывающий `/` дают `//`: без разбора регулярок дубль на той же
    // строке считался комментарием (замечание проверки круга 5).
    writeFileSync(
      path.join(dir, 'src', 'regex-slash.ts'),
      "const re = /^https?:\\/\\//; throw new Error('Not connected: call etn.server.connect first');\n",
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/regex-slash.ts:1'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('регулярка с классом [/*] не открывает блочный комментарий', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-regex-block-'));
    mkdirSync(path.join(dir, 'src'));
    // `/*` внутри класса не открывает блочный комментарий: иначе он тянулся бы
    // до `*/`/EOF и глушил дубль на следующей строке.
    writeFileSync(
      path.join(dir, 'src', 'regex-block.ts'),
      "const re = /[/*]/;\nthrow new Error('Not connected: call etn.server.connect first');\n",
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/regex-block.ts:2'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('класс [...] закрывается только вне класса: дубль на той же строке ловится', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-regex-class-'));
    mkdirSync(path.join(dir, 'src'));
    // Без учёта класса первый `/` внутри `[///]` преждевременно закрыл бы
    // литерал, и `//` из оставшихся слешей съел бы дубль на той же строке.
    writeFileSync(
      path.join(dir, 'src', 'regex-class.ts'),
      "const re = /[///]/; throw new Error('Not connected: call etn.server.connect first');\n",
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/regex-class.ts:1'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('регулярка с кавычками не оставляет лексер в строке: // после неё — комментарий', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-regex-quote-'));
    mkdirSync(path.join(dir, 'src'));
    // Кавычки внутри класса не должны переводить лексер в строковое состояние:
    // иначе настоящий `//` на следующей строке считался бы кодом (ложное нарушение).
    writeFileSync(
      path.join(dir, 'src', 'regex-quote.ts'),
      "const quote = /['\"]/;\n// Not connected: call etn.server.connect first\n",
    );
    // Контрольный дубль в коде: скан не пуст, ложных нарушений нет.
    writeFileSync(
      path.join(dir, 'src', 'dup.ts'),
      "throw new Error('Not connected: call etn.server.connect first');\n",
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/dup.ts:1'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('деление не принимается за регулярку: // после него распознан', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-division-'));
    mkdirSync(path.join(dir, 'src'));
    // `/` после значения — деление; литерал в настоящем `//`-комментарии разрешён.
    writeFileSync(
      path.join(dir, 'src', 'division.ts'),
      'const half = total / count; // Not connected: call etn.server.connect first\n',
    );
    // Контрольный дубль в коде: правило живое, нарушений ровно одно.
    writeFileSync(
      path.join(dir, 'src', 'dup.ts'),
      "throw new Error('Not connected: call etn.server.connect first');\n",
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/dup.ts:1'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('постфиксный ++: деление не принимается за регулярку', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-postfix-inc-'));
    mkdirSync(path.join(dir, 'src'));
    // `++` после значения — постфиксный: на `6b31c7d1` он перетирал `prev` на
    // оператор, `/ 2` принимался за регулярку, и настоящий `//`-комментарий с
    // литералом краснил ложным нарушением.
    writeFileSync(
      path.join(dir, 'src', 'postfix-inc.ts'),
      'let i = 0;\ni++ / 2; // Not connected: call etn.server.connect first\n',
    );
    // Контрольный дубль в коде: правило живое, нарушений ровно одно.
    writeFileSync(
      path.join(dir, 'src', 'dup.ts'),
      "throw new Error('Not connected: call etn.server.connect first');\n",
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/dup.ts:1'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('постфиксный --: деление не принимается за регулярку', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-postfix-dec-'));
    mkdirSync(path.join(dir, 'src'));
    // `--` после значения — постфиксный: `/ 2` деление, литерал в блочном
    // комментарии разрешён.
    writeFileSync(
      path.join(dir, 'src', 'postfix-dec.ts'),
      'let j = 4;\nj-- / 2; /* Not connected: call etn.server.connect first */\n',
    );
    writeFileSync(
      path.join(dir, 'src', 'dup.ts'),
      "throw new Error('Not connected: call etn.server.connect first');\n",
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/dup.ts:1'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('TS non-null assertion: деление не принимается за регулярку', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-nonnull-'));
    mkdirSync(path.join(dir, 'src'));
    // `!` после значения — non-null assertion, а не префиксный оператор:
    // `/ 2` деление, литерал в `//`-комментарии разрешён.
    writeFileSync(
      path.join(dir, 'src', 'nonnull.ts'),
      'const total3 = 4;\nconst nn = total3! / 2; // Not connected: call etn.server.connect first\n',
    );
    writeFileSync(
      path.join(dir, 'src', 'dup.ts'),
      "throw new Error('Not connected: call etn.server.connect first');\n",
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/dup.ts:1'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('регулярка в начале строки после } распознаётся: дубль пойман', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-line-start-regex-'));
    mkdirSync(path.join(dir, 'src'));
    // `prev` не сбрасывался на переводе строки: `/` в начале строки после `}`
    // считался делением, `/*` внутри `/[/*]/` открывал блочный комментарий до
    // EOF и глушил дубль на следующей строке.
    writeFileSync(
      path.join(dir, 'src', 'after-brace-regex.ts'),
      'if (ok) {\n  total += 1;\n}\n/[/*]/;\nthrow new Error(\'Not connected: call etn.server.connect first\');\n',
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/after-brace-regex.ts:5'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('//-комментарий не съедает начало следующей строки: регулярка после него распознаётся', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-after-line-comment-'));
    mkdirSync(path.join(dir, 'src'));
    // `// done` потреблял свой `\n`, поэтому сброс `prev` не срабатывал:
    // `/[/*]/` на следующей строке читалась как деление, `/*` открывал
    // блочный комментарий до EOF и глушил дубль (замечание проверки круга 6).
    writeFileSync(
      path.join(dir, 'src', 'after-line-comment.ts'),
      "if (ok) {\n  total += 1;\n} // done\n/[/*]/;\nthrow new Error('Not connected: call etn.server.connect first');\n",
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/after-line-comment.ts:5'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('многострочный /* */ закрывается в середине новой строки: регулярка после него распознаётся', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-after-block-comment-'));
    mkdirSync(path.join(dir, 'src'));
    // `*/` в середине новой строки (после `continued`) оставлял `prev`
    // значением прошлой строки (`}`): `/` после комментария читался как
    // деление, `/*` в `/[/*]/` открывал блочный комментарий до EOF и глушил
    // дубль (проверка круга 7).
    writeFileSync(
      path.join(dir, 'src', 'after-block-comment.ts'),
      "if (ok) {\n  total += 1;\n} /* note\n  continued */ /[/*]/;\nthrow new Error('Not connected: call etn.server.connect first');\n",
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/after-block-comment.ts:5'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('многострочный /* */ закрывается в начале новой строки: регулярка после него распознаётся', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-after-block-comment-bol-'));
    mkdirSync(path.join(dir, 'src'));
    // `*/` первым на строке — граничный случай сброса `prev` в ветке `block`:
    // новая строка начинается там же, где закрывается комментарий.
    writeFileSync(
      path.join(dir, 'src', 'after-block-comment-bol.ts'),
      "if (ok) {\n  total += 1;\n} /* note\n*/ /[/*]/;\nthrow new Error('Not connected: call etn.server.connect first');\n",
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/after-block-comment-bol.ts:5'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('однострочный /* */ в середине строки: деление после него не принимается за регулярку', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-midline-block-'));
    mkdirSync(path.join(dir, 'src'));
    // `*/` в середине строки `prev` НЕ сбрасывает: `/ 2` после него — деление,
    // литерал в `//`-комментарии разрешён. Безусловный сброс `prev` в ветке
    // `block` сделал бы `//` частью нераспознанной регулярки и покраснил бы
    // сторож ложным нарушением (замечание проверки круга 7).
    writeFileSync(
      path.join(dir, 'src', 'midline-block.ts'),
      'if (ok) {\n  total += 1;\n} /* x */ / 2; // Not connected: call etn.server.connect first\n',
    );
    // Контрольный дубль в коде: правило живое, нарушений ровно одно.
    writeFileSync(
      path.join(dir, 'src', 'dup.ts'),
      "throw new Error('Not connected: call etn.server.connect first');\n",
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/dup.ts:1'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('не зависит от регистра расширения: литерал в dup-upper.TS ловится', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-ext-'));
    mkdirSync(path.join(dir, 'src'));
    // Регистр расширения не должен прятать исходник от сторожа.
    writeFileSync(
      path.join(dir, 'src', 'dup-upper.TS'),
      "throw new Error('Not connected: call etn.server.connect first');\n",
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/dup-upper.TS:1'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('одноимённый client/src/errors.ts — нарушение: источник только в shared', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-roots-'));
    const clientRoot = path.join(dir, 'client');
    const sharedRoot = path.join(dir, 'shared');
    const source = path.join(sharedRoot, 'src', 'errors.ts');
    mkdirSync(path.dirname(source), { recursive: true });
    mkdirSync(path.join(clientRoot, 'src'), { recursive: true });

    // Источник строки — только shared.
    writeFileSync(
      source,
      "export const NOT_CONNECTED_ERROR_TEXT = 'Not connected: call etn.server.connect first';\n",
    );
    // Одноимённый файл в клиенте: широкий `rel === 'src/errors.ts'` пропускал его.
    writeFileSync(
      path.join(clientRoot, 'src', 'errors.ts'),
      "export const DUP = 'Not connected: call etn.server.connect first';\n",
    );

    const hits = collectViolations(clientRoot, rulesFor(clientRoot, source));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/errors.ts:1'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
    assert.deepEqual(collectViolations(sharedRoot, rulesFor(sharedRoot, source)), []);
  });
});
