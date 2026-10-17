/**
 * Сторож правила: клиентский тест редактора строит состояние с ПОЛНЫМ разбором
 * CodeMirror, прежде чем читать производное от дерева состояние (задача
 * `f9b5c36e`).
 *
 * **Что сторожит.** Тест `comment-collapse.test.ts` («редактор: несколько
 * вложенных блоков → один маркер») редко краснел в полном прогоне под
 * параллельной нагрузкой и всегда был зелён в изоляции. Причина — headless-
 * разбор: без `EditorView` дерево синтаксиса обрезано (`LanguageState.init`:
 * бюджет 20 мс + вьюпорт 3000 символов), а parse-worker — это ViewPlugin, то
 * есть без view доразбора не существует вовсе. Под вытеснением процесса бюджет
 * истекает, и тест читает неполное дерево. Протечка модульного состояния и
 * порядок файлов тут ни при чём: `node --test` исполняет каждый файл в
 * отдельном процессе.
 *
 * Лечение — общий приём `createParsedState` (`tests/editor-parse.ts`).
 *
 * **Как сторожит.** Четырьмя частями:
 *  • ГРАНИЦА — на документе длиннее вьюпорта начального разбора дерево обрезано
 *    ВСЕГДА (не гонка, а дизайн): тест на таком документе получить полное дерево
 *    не может, и хелпер обязан падать громко, а не отдавать обрезанное дерево;
 *  • ПОВЕДЕНИЕ — истёкший бюджет воспроизводится детерминированно (вытеснение
 *    процесса имитируется сдвигом часов на пике разбора) и снимается
 *    `createParsedState` (состояние пересоздаётся до полного разбора);
 *  • КЛАСС — файл, читающий `syntaxTree`-производное состояние (маркеры
 *    {@link SYNTAX_READER_MARKERS}) И создающий состояния, обязан строить их
 *    через `createParsedState`. Ожидаемый состав класса объявлен явно и
 *    сверяется ТОЧНО: новый читатель или маркер, сработавший вне цели, дают
 *    красный, который лечится осознанной правкой списка, а не подгонкой;
 *  • РАЗБОР — маркеры, создания состояния и границы аргументов вызова ищутся
 *    по КОДУ ({@link codeOnly}): комментарии и содержимое строк, шаблонов и
 *    регулярных выражений заменяются пробелами. Инвариант — КАЖДОЕ
 *    `EditorState.create(` лежит внутри аргумента `createParsedState(`
 *    ({@link inspectTestSource}); упоминание в комментарии не делает файл
 *    классом и не оправдывает сырое создание состояния.
 *
 * **Мутация.** Снять проверку полноты разбора в `editor-parse.ts` — краснеет
 * поведенческая часть; убрать `createParsedState` из `md-live.test.ts` или
 * оставить одно «сырое» создание в `comment-collapse.test.ts` — статическая.
 * Пробы «ложноотрицательный кейс» и «ложноположительный кейс» краснеют, если
 * вернуть сравнение подстрок (проверено на прежней редакции сторожа — задача
 * `601a494b`).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { syntaxTreeAvailable } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';

import { ShimElement } from './dom-shim.js';
import { MAX_HEADLESS_PARSE_LENGTH, createParsedState } from './editor-parse.js';
import { livePreview } from '../src/renderer/editor/md-live.js';
import { wikiLinkLanguage } from '../src/renderer/editor/wiki-link.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const TESTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

/** Маркеры «файл читает производное от `syntaxTree` состояние» (искать по КОДУ). */
const SYNTAX_READER_MARKERS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'collapse-sections', pattern: /commentCollapseInternals\s*\.\s*collectSections/ },
  { name: 'live-preview-field', pattern: /\.field\(\s*livePreview\s*\)/ },
  { name: 'raw-syntax-tree', pattern: /[^A-Za-z]syntaxTree\s*\(/ },
];

/**
 * Файлы класса, которых сторож обязан видеть — и только они. Маркеры,
 * переставшие их находить (переименовали поле/шов), и новые читатели дерева
 * одинаково ломают точную сверку: состав класса меняется осознанно, вместе с
 * правилом.
 */
const EXPECTED_CLASS_FILES: readonly string[] = ['comment-collapse.test.ts', 'md-live.test.ts'];

/**
 * Сам сторож исключён из сканирования: он по определению собирает «сырые»
 * состояния (показывает обрезку дерева) и содержит собственные маркеры.
 */
const SCANNER_SELF = 'guard-editor-parse-complete.test.ts';

/** Создание состояния, которое обязано быть обёрнуто хелпером. */
const STATE_CREATE_CALL = /\bEditorState\.create\s*\(/g;

/** Обёртка, внутри аргумента которой создание состояния допустимо. */
const PARSED_STATE_CALL = /\bcreateParsedState\s*\(/g;

/**
 * Символы, после которых `/` открывает регулярное выражение, а не деление
 * (эвристика: полноценный разбор требует контекста, недоступного сканеру).
 */
const REGEX_PREFIX_CHARS = '(,=:[!&|?{};+-*%^~<>';

/** Документ длиннее вьюпорта начального разбора: разбор обрезан по дизайну. */
const OVER_VIEWPORT_DOC = '## Раздел с длинным телом\n\nтекст раздела для разбора\n\n'.repeat(80);
const OVER_VIEWPORT_HEADINGS = 80;

/**
 * Короткий документ, значимая часть — в КОНЦЕ: если бюджет разбора истёк на
 * первых токенах, заголовок до парсера не доходит.
 */
const STARVED_DOC = 'просто текст без разметки сначала\n\n## Заголовок в конце\n\nтело раздела\n';

/**
 * Имитация вытеснения процесса: часы на каждом обращении уходят на 100 мс
 * вперёд, поэтому бюджет разбора (20 мс) истекает после первого же шага
 * парсера. Сдвиг на каждом вызове (а не «на втором») намеренно: сколько раз
 * кто-то спросит время до парсера — не наша забота, имитация обязана быть
 * детерминированной.
 */
function withExpiredParseBudget<T>(fn: () => T): T {
  const real = Date.now;
  let virtual = real();
  Date.now = () => {
    virtual += 100;
    return virtual;
  };
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

/** Число декораций live-preview в состоянии. */
function decoCount(state: EditorState): number {
  let count = 0;
  for (let it = state.field(livePreview).iter(); it.value !== null; it.next()) count += 1;
  return count;
}

/** Минимальный shim DOM, нужный модулю сворачивания (как в tests/comment-collapse.test.ts). */
function installShim(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    body: new ShimElement('body'),
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

// ---------------------------------------------------------------------------
// Статический разбор тест-файлов: маркеры и создания состояния — только по КОДУ
// ---------------------------------------------------------------------------

/** Копия образца с гарантированной (ровно одной) глобальностью. */
function globalRe(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, `${pattern.flags.replace(/g/g, '')}g`);
}

/** Заменяет диапазон пробелами, сохраняя переводы строк (позиции не едут). */
function blankRange(chars: string[], from: number, to: number): void {
  for (let i = Math.max(0, from); i < Math.min(to, chars.length); i += 1) {
    if (chars[i] !== '\n') chars[i] = ' ';
  }
}

/**
 * Код файла без комментариев и без содержимого литералов (длины сохраняются,
 * кавычки остаются как структура).
 *
 * Однопроходный сканер, а не парсер: контекста для надёжного отличия
 * регулярного выражения от деления у него нет, поэтому `/` считается началом
 * регулярного выражения по эвристике «предыдущий значимый символ из
 * {@link REGEX_PREFIX_CHARS}». Для тест-файлов проекта этого достаточно:
 * результат проверяется точным составом класса и пробами ниже.
 *
 * Следствие, о котором надо знать: содержимое `${…}` шаблона тоже вырезается —
 * создание состояния внутри шаблонной строки сторож не увидит (в тестах такого
 * нет; появится — правь сканер).
 */
function codeOnly(source: string): string {
  const chars = source.split('');
  let prevSignificant = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const to = end === -1 ? source.length : end;
      blankRange(chars, i, to);
      i = to;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const to = end === -1 ? source.length : end + 2;
      blankRange(chars, i, to);
      i = to;
      continue;
    }
    if (ch === '/' && (prevSignificant === '' || REGEX_PREFIX_CHARS.includes(prevSignificant))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const c = source[j] as string;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          j += 1;
          break;
        }
        j += 1;
      }
      blankRange(chars, i, j);
      i = j;
      prevSignificant = '/';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < source.length) {
        const c = source[j] as string;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      blankRange(chars, i + 1, j - 1);
      i = j;
      prevSignificant = ch;
      continue;
    }
    if (!/\s/.test(ch)) prevSignificant = ch;
    i += 1;
  }
  return chars.join('');
}

/**
 * Диапазоны аргументов вызовов, найденных образцом: от открывающей скобки до
 * парной закрывающей. Строки и комментарии к этому моменту уже вырезаны, так
 * что скобки внутри них баланс не ломают.
 */
function callArgSpans(code: string, call: RegExp): Array<{ from: number; to: number }> {
  const spans: Array<{ from: number; to: number }> = [];
  for (const match of code.matchAll(globalRe(call))) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (; end < code.length; end += 1) {
      const c = code[end] as string;
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    spans.push({ from: open, to: end });
  }
  return spans;
}

/**
 * Разбор одного тест-файла: маркеры класса — по коду (упоминание в комментарии
 * или строке не считается), инвариант — КАЖДОЕ `EditorState.create(` лежит
 * внутри аргумента `createParsedState(`.
 *
 * В класс файл попадает, только если он и читает производное от дерева
 * состояние, и создаёт состояния: без созданий проверять нечего — правило про
 * обёртку к такому файлу неприменимо.
 */
function inspectTestSource(
  file: string,
  source: string,
): { markers: string[]; inClass: boolean; violations: string[] } {
  const code = codeOnly(source);
  const markers = SYNTAX_READER_MARKERS.filter((m) => m.pattern.test(code)).map((m) => m.name);
  const creations = [...code.matchAll(globalRe(STATE_CREATE_CALL))].map((m) => m.index ?? 0);
  const inClass = markers.length > 0 && creations.length > 0;
  if (!inClass) return { markers, inClass, violations: [] };

  const wrappers = callArgSpans(code, PARSED_STATE_CALL);
  const raw = creations.filter((pos) => !wrappers.some((span) => pos > span.from && pos < span.to));
  if (raw.length === 0) return { markers, inClass, violations: [] };
  return {
    markers,
    inClass,
    violations: [
      `${file} [${markers.join(', ')}] — сырых EditorState.create вне createParsedState: ` +
        `${raw.length} из ${creations.length}`,
    ],
  };
}

/** Разбор всех тест-файлов каталога: точный состав класса и нарушения. */
function inspectTestsDir(): { classFiles: string[]; violations: string[] } {
  const classFiles: string[] = [];
  const violations: string[] = [];
  const files = fs
    .readdirSync(TESTS_ROOT)
    .filter((name) => name.endsWith('.test.ts') && name !== SCANNER_SELF)
    .sort();
  for (const file of files) {
    const source = fs.readFileSync(path.join(TESTS_ROOT, file), 'utf8');
    const inspected = inspectTestSource(file, source);
    if (!inspected.inClass) continue;
    classFiles.push(file);
    violations.push(...inspected.violations);
  }
  return { classFiles, violations };
}

describe('guard: полный разбор CM6 до чтения состояния (f9b5c36e)', () => {
  it('документ длиннее вьюпорта: дерево обрезано всегда, хелпер падает громко', async () => {
    installShim();
    const { commentCollapseExtension, commentCollapseInternals, createCommentCollapseState } =
      await import('../src/renderer/editor/comment-collapse.js');

    assert.ok(OVER_VIEWPORT_DOC.length > MAX_HEADLESS_PARSE_LENGTH, 'документ длиннее вьюпорта');
    const raw = EditorState.create({
      doc: OVER_VIEWPORT_DOC,
      extensions: [
        markdown({ base: markdownLanguage, extensions: [wikiLinkLanguage()] }),
        commentCollapseExtension(createCommentCollapseState('net', undefined)),
      ],
    });
    assert.equal(
      syntaxTreeAvailable(raw, raw.doc.length),
      false,
      'обрезано по вьюпорту — не гонка, а дизайн headless-разбора',
    );
    const sections = commentCollapseInternals.collectSections(raw).length;
    assert.ok(sections > 0, 'начало документа разобрано');
    assert.ok(
      sections < OVER_VIEWPORT_HEADINGS,
      `читатель дерева теряет разделы за вьюпортом (${sections} из ${OVER_VIEWPORT_HEADINGS})`,
    );

    assert.throws(
      () =>
        createParsedState(() =>
          EditorState.create({
            doc: OVER_VIEWPORT_DOC,
            extensions: [
              markdown({ base: markdownLanguage, extensions: [wikiLinkLanguage()] }),
              livePreview,
            ],
          }),
        ),
      /headless/,
      'на таком документе хелпер обязан падать громко, а не отдавать обрезанное дерево',
    );
  });

  it('истёкший бюджет разбора: неполное дерево теряет данные, хелпер пересоздаёт состояние', async () => {
    installShim();
    const { commentCollapseExtension, commentCollapseInternals, createCommentCollapseState } =
      await import('../src/renderer/editor/comment-collapse.js');

    const build = (): EditorState =>
      EditorState.create({
        doc: STARVED_DOC,
        extensions: [
          markdown({ base: markdownLanguage, extensions: [wikiLinkLanguage()] }),
          livePreview,
          commentCollapseExtension(createCommentCollapseState('net', undefined)),
        ],
      });

    // Красная сторона: бюджет истёк на первых токенах — дерево неполно, и
    // читатель теряет данные (это и есть флейк под нагрузкой).
    const starved = withExpiredParseBudget(build);
    assert.equal(
      syntaxTreeAvailable(starved, STARVED_DOC.length),
      false,
      'вытеснение процесса на пике разбора оставляет дерево обрезанным',
    );
    const intact = build();
    assert.equal(syntaxTreeAvailable(intact, STARVED_DOC.length), true, 'без вытеснения дерево полное');
    assert.deepEqual(commentCollapseInternals.collectSections(starved), [], 'неполное дерево теряет разделы');
    assert.equal(commentCollapseInternals.collectSections(intact).length, 1, 'полное дерево даёт раздел');
    assert.ok(
      decoCount(starved) < decoCount(intact),
      `live-preview тоже теряет разметку на обрезанном дереве (${decoCount(starved)} < ${decoCount(intact)})`,
    );

    // Зелёная сторона: хелпер проверяет полноту и пересоздаёт состояние.
    let attempts = 0;
    const state = createParsedState(() => {
      attempts += 1;
      return attempts === 1 ? withExpiredParseBudget(build) : build();
    });
    assert.equal(attempts, 2, 'состояние пересоздано после неудачной попытки');
    assert.equal(syntaxTreeAvailable(state, state.doc.length), true, 'разбор доведён до конца');
    assert.equal(
      commentCollapseInternals.collectSections(state).length,
      1,
      'разделы на месте и у ленивого поля (оно считается уже по полному дереву)',
    );
  });

  it('штатно: класс читателей дерева — ровно ожидаемые файлы, сырых созданий нет', () => {
    const { classFiles, violations } = inspectTestsDir();
    assert.deepEqual(
      violations,
      [],
      'Файл читает производное от syntaxTree состояние, но строит его без полного разбора: ' +
        'создавайте состояние через createParsedState из ./editor-parse.js — иначе полный ' +
        'прогон под нагрузкой прочитает обрезанное дерево',
    );
    assert.deepEqual(
      classFiles,
      [...EXPECTED_CLASS_FILES].sort(),
      'состав класса изменился: маркер сработал вне цели либо появился новый читатель дерева. ' +
        'Разберись и расширь EXPECTED_CLASS_FILES осознанно — ложный красный мешает другим задачам',
    );
  });

  it('ложноотрицательный кейс (601a494b): упоминание в комментарии не оправдывает сырое создание', () => {
    // Ровно случай из замечания верификатора: в файле класса — сырое
    // `EditorState.create`, а `createParsedState(` встречается ТОЛЬКО в
    // комментарии. Сравнение подстрок считало счётчики 1/1 и молчало.
    const source = [
      "import { EditorState } from '@codemirror/state';",
      '// состояние соберём как обычно: createParsedState( — см. tests/editor-parse.ts',
      'export function build(): unknown {',
      "  const state = EditorState.create({ doc: 'просто текст' });",
      '  return state.field(livePreview);',
      '}',
    ].join('\n');
    const inspected = inspectTestSource('synthetic-raw-state.test.ts', source);
    assert.equal(inspected.inClass, true, 'файл обязан попасть в класс — маркер есть в коде');
    assert.equal(inspected.violations.length, 1, 'сырое создание состояния — нарушение');
    assert.match(
      inspected.violations[0] ?? '',
      /сырых EditorState\.create вне createParsedState/,
      'нарушение названо по инварианту обёртки, а не по счётчику',
    );
  });

  it('ложноположительный кейс (601a494b): упоминание в комментарии не делает файл классом', () => {
    // Файл вне цели: маркер встречается только в комментарии. Сравнение
    // подстрок делало его классом и краснело без реального нарушения.
    const source = [
      '// здесь мы НЕ читаем syntaxTree(state) — разметку строит Lezer-плагин',
      "import { EditorState } from '@codemirror/state';",
      "export const state = EditorState.create({ doc: 'x' });",
    ].join('\n');
    const inspected = inspectTestSource('synthetic-comment-only.test.ts', source);
    assert.equal(inspected.inClass, false, 'маркер в комментарии не делает файл классом');
    assert.deepEqual(inspected.violations, [], 'реального нарушения нет — краснеть не за что');
  });

  it('упоминания хелпера в комментариях не влияют на счётчики и обёртки', () => {
    const source = [
      '// createParsedState( — упоминание в шапке файла',
      "import { EditorState } from '@codemirror/state';",
      "import { createParsedState } from './editor-parse.js';",
      'export const state = createParsedState(() => EditorState.create({ doc: "x" }));',
      'export const field = state.field(livePreview);',
      '// и ещё раз: createParsedState(',
    ].join('\n');
    const inspected = inspectTestSource('synthetic-commented-wrapper.test.ts', source);
    assert.equal(inspected.inClass, true, 'файл в классе — маркер и создание есть в коде');
    assert.deepEqual(
      inspected.violations,
      [],
      'создание обёрнуто в коде, лишние упоминания в комментариях нарушением не являются',
    );
  });
});
