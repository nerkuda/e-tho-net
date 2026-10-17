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
 * **Как сторожит.** Тремя частями:
 *  • ГРАНИЦА — на документе длиннее вьюпорта начального разбора дерево обрезано
 *    ВСЕГДА (не гонка, а дизайн): тест на таком документе получить полное дерево
 *    не может, и хелпер обязан падать громко, а не отдавать обрезанное дерево;
 *  • ПОВЕДЕНИЕ — истёкший бюджет воспроизводится детерминированно (вытеснение
 *    процесса имитируется сдвигом часов на пике разбора) и снимается
 *    `createParsedState` (состояние пересоздаётся до полного разбора);
 *  • КЛАСС — каждый тест-файл, читающий `syntaxTree`-производное состояние
 *    (маркеры {@link SYNTAX_READER_MARKERS}), обязан использовать
 *    `createParsedState`. Список маркеров и ожидаемый класс объявлены явно:
 *    расширять/сужать их — осознанной правкой вместе с правилом, а не тихо.
 *
 * **Мутация.** Убрать `createParsedState` из `md-live.test.ts` или
 * `comment-collapse.test.ts` — краснеет статическая часть; снять проверку
 * полноты разбора в `editor-parse.ts` — поведенческая.
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

/** Маркеры «файл читает производное от `syntaxTree` состояние». */
const SYNTAX_READER_MARKERS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'collapse-sections', pattern: /commentCollapseInternals\s*\.\s*collectSections/ },
  { name: 'live-preview-field', pattern: /\.field\(\s*livePreview\s*\)/ },
  { name: 'raw-syntax-tree', pattern: /[^A-Za-z]syntaxTree\s*\(/ },
];

/**
 * Файлы класса, которых сторож обязан видеть. Если маркеры перестанут их
 * находить (переименовали поле/шов), проверка станет пустой — это провал.
 */
const EXPECTED_CLASS_FILES: readonly string[] = ['comment-collapse.test.ts', 'md-live.test.ts'];

/**
 * Файлы, которым разрешено строить «сырые» состояния: сам сторож обязан
 * показать обрезку дерева, то есть собрать заведомо неполное состояние.
 */
const RAW_STATE_ALLOWED: readonly string[] = ['guard-editor-parse-complete.test.ts'];

/** Документ длиннее вьюпорта начального разбора: разбор обрезан по дизайну. */
const OVER_VIEWPORT_DOC = '## Раздел с длинным телом\n\nтекст раздела для разбора\n\n'.repeat(80);
const OVER_VIEWPORT_HEADINGS = 80;

/**
 * Короткий документ, значимая часть — в КОНЦЕ: если бюджет разбора истёк на
 * первых токенах, заголовок до парсера не доходит.
 */
const STARVED_DOC = 'просто текст без разметки сначала\n\n## Заголовок в конце\n\nтело раздела\n';

/** Имитация вытеснения процесса: бюджет разбора (20 мс) истекает на пике. */
function withExpiredParseBudget<T>(fn: () => T): T {
  const real = Date.now;
  let calls = 0;
  Date.now = () => {
    calls += 1;
    return calls === 1 ? real() : real() + 100_000;
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

  it('тест-файлы, читающие состояние из syntaxTree, используют createParsedState', () => {
    const files = fs.readdirSync(TESTS_ROOT).filter((name) => name.endsWith('.test.ts'));
    const classFiles: string[] = [];
    const violations: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(path.join(TESTS_ROOT, file), 'utf8');
      const markers = SYNTAX_READER_MARKERS.filter((m) => m.pattern.test(source)).map((m) => m.name);
      if (markers.length === 0) continue;
      classFiles.push(file);
      if (RAW_STATE_ALLOWED.includes(file)) continue;
      if (!/\bcreateParsedState\s*\(/.test(source)) {
        violations.push(`${file} [${markers.join(', ')}] — состояние строится без createParsedState`);
        continue;
      }
      // Каждое состояние файла класса обязано быть построено с полным разбором:
      // одно «сырое» создание — уже обрезанное дерево на чтении.
      const creations = (source.match(/EditorState\.create\s*\(/g) ?? []).length;
      const parsed = (source.match(/\bcreateParsedState\s*\(/g) ?? []).length;
      if (creations !== parsed) {
        violations.push(
          `${file} — EditorState.create: ${creations}, createParsedState: ${parsed}`,
        );
      }
    }
    assert.deepEqual(
      violations,
      [],
      'Файл читает производное от syntaxTree состояние, но строит его без полного разбора: ' +
        'создавайте состояние через createParsedState из ./editor-parse.js — иначе полный ' +
        'прогон под нагрузкой прочитает обрезанное дерево',
    );
    for (const expected of EXPECTED_CLASS_FILES) {
      assert.ok(
        classFiles.includes(expected),
        `класс читателей дерева обязан включать ${expected}: маркеры перестали находить файл — сторож ослеп`,
      );
    }
  });
});
