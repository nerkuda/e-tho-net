/**
 * Сторож правила «сообщения диалога» (требование 397c5a56 «Сообщения диалога:
 * любая ошибка — строкой на панели кнопок, клик ведёт к полю»; ранее — ошибка
 * add8d09d «Сообщения об ошибках диалогов с вкладками видны на любой вкладке»).
 *
 * Правило. Любая ошибка диалога — и операция, и валидация поля — выводится
 * строкой в панели кнопок (футере), видимой при активной любой вкладке, а не
 * единственно в теле вкладки. Строку создаёт словарь `lib/ui/messages.ts`
 * (`footerErrorLine` / `errorLine` / `fieldError` / `operationError`):
 * самодельные `span('', 'error-text')` и литералы «Ошибка:» запрещены.
 *
 * Правила сторожа:
 * 1. `no-error-line-in-tab-pane` — `errorLine` не добавляется в панель вкладки
 *    (`xxxPane.append(… errorLine …)`, `xxxPanel.append(… errorLine …)`).
 * 2. `tabbed-dialog-uses-footer-error` — файл, который строит панели вкладок
 *    (`div('…-tab-pane')` / `div('…-tab-panel')`), обязан передавать строку
 *    ошибки в `showDialog` опцией `footerError`.
 * 3. `no-raw-error-text-class` — класс строки ошибки задаёт только словарь
 *    `lib/ui/messages.ts`; литерал `'error-text'` вне `lib/ui` запрещён.
 * 4. `no-error-prefix-literal` — префикс «Ошибка:» объявлен только в словаре
 *    (`operationErrorText`); литерал в рендерере запрещён.
 * 5. `no-error-line-appended-to-body` — строка ошибки не добавляется в тело
 *    диалога (`body.append(… errorLine …)`): обязательное место — футер.
 *
 * Сторож вводится зелёным — вместе с правкой, которая переносит строку в футер.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertGuardClean,
  collectViolations,
  listSourceFiles,
  type GuardRule,
  type GuardViolation,
} from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/** Правило 1 — регулярка, применимая к любой строке файла. */
const RULES: GuardRule[] = [
  {
    name: 'no-error-line-in-tab-pane',
    description:
      'Строка ошибки записи (errorLine) не добавляется в панель вкладки — ' +
      'она обязана жить в панели кнопок (footerError), видимой на любой ' +
      'вкладке (ошибка add8d09d).',
    pattern: /\b\w*(?:[Pp]ane|[Pp]anel)\w*\.append\([^)]*\berrorLine\b/,
  },
  {
    name: 'no-raw-error-text-class',
    description:
      'Класс строки ошибки задаёт только словарь lib/ui/messages.ts ' +
      '(errorLine/fieldError/footerErrorLine); самодельный литерал ' +
      "'error-text' вне lib/ui запрещён (требование 397c5a56).",
    pattern: /['"]error-text['"]/,
    include: (rel) => !rel.startsWith('lib/ui/'),
  },
  {
    name: 'no-error-prefix-literal',
    description:
      'Префикс «Ошибка:» объявлен только в lib/ui/messages.ts ' +
      '(operationErrorText); литерал в рендерере запрещён — ' +
      'используй operationError/operationErrorText (требование 397c5a56).',
    pattern: /Ошибка:/,
    include: (rel) => !rel.startsWith('lib/ui/'),
  },
  {
    name: 'no-error-line-appended-to-body',
    description:
      'Строка ошибки диалога не добавляется в тело (body.append(… errorLine …)): ' +
      'единственное обязательное место — панель кнопок (footerError, ' +
      'требование 397c5a56).',
    filePattern: /\bbody\.append\([^;]*\berrorLine\b/,
    include: (rel) => !rel.startsWith('lib/ui/'),
  },
];

/** Панель вкладки в исходнике: `div('type-editor-tab-pane')`, `div('att-tab-panel')`. */
const TAB_PANE_DECL = /div\('[a-z0-9-]*-tab-(?:pane|panel)'\)/;

/** Вкладочный диалог каркаса: `showDialog({ … tabs: [ … ] })` (a57e7998). */
function hasDialogTabs(content: string): boolean {
  const re = /showDialog\(\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (/\btabs:\s*\[/.test(content.slice(match.index, match.index + 1500))) return true;
  }
  return false;
}

/** Файл объявляет вкладочный диалог любым из двух способов. */
function isTabbedDialogFile(content: string): boolean {
  return TAB_PANE_DECL.test(content) || hasDialogTabs(content);
}

/**
 * Правило 2 (многофайловое: нужен весь текст файла). Ищет файлы, которые
 * строят вкладочный диалог (панели вкладок либо `tabs: […]` общего механизма
 * каркаса) и ведут общую строку ошибки записи (`errorLine`), но не передают её
 * в `footerError` — тогда ошибка видна только на активной вкладке (add8d09d).
 */
function findTabbedDialogsWithoutFooterError(root: string): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const file of listSourceFiles(root)) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');
    if (rel.startsWith('lib/ui/')) continue;
    if (!isTabbedDialogFile(content)) continue;
    if (!/\berrorLine\b/.test(content)) continue;
    if (content.includes('footerError:')) continue;
    const index = content.search(TAB_PANE_DECL);
    const at = index >= 0 ? index : content.indexOf('tabs: [');
    const line = content.slice(0, at).split('\n').length;
    violations.push({
      rule: 'tabbed-dialog-uses-footer-error',
      file: rel,
      line,
      text: 'вкладочный диалог без `footerError:` in showDialog',
    });
  }
  return violations;
}

describe('guard: ошибка диалога с вкладками — в панели кнопок (add8d09d)', () => {
  it('строка ошибки не живёт в теле вкладки', () => {
    assertGuardClean(RENDERER_ROOT, RULES);
  });

  it('у каждого вкладочного диалога есть footerError', () => {
    const violations = findTabbedDialogsWithoutFooterError(RENDERER_ROOT);
    assert.equal(
      violations.length,
      0,
      `вкладочный диалог без footerError:\n${violations
        .map((v) => `  • ${v.file}:${v.line}`)
        .join('\n')}`,
    );
  });

  it('правило 1 краснеет на умышленно добавленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-tab-err-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'fake-tabbed-dialog.ts'),
        [
          "import { div, span } from './lib/dom.js';",
          'function buildTab(): HTMLElement {',
          "  const propsPane = div('some-tab-pane');",
          "  const errorLine = span('', 'error-text');",
          '  propsPane.append(errorLine);',
          '  return propsPane;',
          '}',
          'void buildTab;',
        ].join('\n'),
        'utf8',
      );
      const violations = collectViolations(dir, RULES);
      assert.ok(
        violations.some((v) => v.rule === 'no-error-line-in-tab-pane'),
        'строка ошибки, добавленная в панель вкладки, обязана попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('правило 2 краснеет, если вкладочный диалог не передаёт footerError', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-tab-err2-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'inline-tabbed.ts'),
        [
          "const pane = div('x-tab-pane');",
          "const errorLine = span('', 'error-text');",
          'showDialog({ title: t, body, buttons: [] });',
        ].join('\n'),
        'utf8',
      );
      const violations = findTabbedDialogsWithoutFooterError(dir);
      assert.ok(
        violations.some((v) => v.rule === 'tabbed-dialog-uses-footer-error'),
        'вкладочный диалог без footerError обязан попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('правило 3 краснеет на самодельном error-text вне lib/ui', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-tab-err3-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'raw.ts'),
        "const e = span('', 'error-text');\n",
        'utf8',
      );
      const violations = collectViolations(dir, RULES);
      assert.ok(
        violations.some((v) => v.rule === 'no-raw-error-text-class'),
        'литерал error-text вне lib/ui обязан попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('правила 3–5 не трогают словарь lib/ui', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-tab-err4-'));
    try {
      const messagesDir = path.join(dir, 'lib', 'ui');
      fs.mkdirSync(messagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(messagesDir, 'messages.ts'),
        [
          "export const ERROR_LINE_CLASS = 'error-text';",
          'export function t(): string {',
          "  return `Ошибка: ${String(1)}`;",
          '}',
        ].join('\n'),
        'utf8',
      );
      const violations = collectViolations(dir, RULES);
      assert.equal(
        violations.length,
        0,
        `словарь lib/ui не должен нарушать собственные правила:\n${violations
          .map((v) => `  • ${v.file}:${v.line} [${v.rule}]`)
          .join('\n')}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('правило 5 краснеет, если строка ошибки добавлена в тело диалога', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-tab-err5-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'body-error.ts'),
        [
          'showDialog({',
          '  title: t,',
          '  size: \'m\',',
          '  buttons: [{ label: \'Закрыть\' }],',
          '});',
          'body.append(list.root, errorLine);',
        ].join('\n'),
        'utf8',
      );
      const violations = collectViolations(dir, RULES);
      assert.ok(
        violations.some((v) => v.rule === 'no-error-line-appended-to-body'),
        'строка ошибки, добавленная в тело диалога, обязана попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Общее правило «строка ошибки записи прикреплена к диалогу» для диалогов без
 * вкладок: она обязана уходить в панель кнопок (`footerError`) либо явно
 * добавляться в тело. Осиротевшая строка молча глотает ошибки записи — именно
 * так проявилась ошибка c83f0215 в редакторе свойства (`openPropertyManagerEditor`).
 * Сторож-якорь: конкретный диалог с известной историей.
 */
describe('диалоги: строка ошибки записи прикреплена', () => {
  it('property-manager: редактор свойства передаёт footerError', () => {
    const src = fs.readFileSync(
      path.join(RENDERER_ROOT, 'screens', 'property-manager.ts'),
      'utf8',
    );
    assert.ok(
      src.includes('footerError: errorLine'),
      'редактор свойства не передаёт footerError — ошибка записи станет невидимой',
    );
  });
});
