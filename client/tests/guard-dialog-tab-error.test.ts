/**
 * Сторож правила «ошибка записи в диалоге с вкладками — в панели кнопок»
 * (ошибка add8d09d «Сообщения об ошибках диалогов с вкладками видны на любой
 * вкладке», веха 0.8.2).
 *
 * Правило. У диалога с вкладками глобальное сообщение о неудачной записи
 * обязано жить в панели кнопок (футере), а не в теле вкладки: футер виден на
 * любой вкладке, тело — только на активной. Ошибки конкретного поля вкладки
 * (например, ошибка поиска на вкладке «Найти существующее») допустимо держать
 * в теле — правило сторожа целится в общий идентификатор строки записи
 * (`errorLine`), а не в любую строку ошибки.
 *
 * Правила сторожа:
 * 1. `no-error-line-in-tab-pane` — `errorLine` не добавляется в панель вкладки
 *    (`xxxPane.append(… errorLine …)`, `xxxPanel.append(… errorLine …)`).
 * 2. `tabbed-dialog-uses-footer-error` — файл, который строит панели вкладок
 *    (`div('…-tab-pane')` / `div('…-tab-panel')`), обязан передавать строку
 *    ошибки в `showDialog` опцией `footerError`.
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
