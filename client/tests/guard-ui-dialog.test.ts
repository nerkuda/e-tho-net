/**
 * Сторож компонента диалога (задача a57e7998, требование 88a9225a «Каркас
 * диалога ETN — единственный источник всех диалогов» и требование 13464c39
 * «Стабильные размеры диалога: роли S/M/L/XL, высота не зависит от вкладки»).
 *
 * Правила:
 * 1. **Роль размера обязательна.** Каждый вызов `showDialog({…})` передаёт
 *    `size` — размер диалога задаётся ролью S/M/L/XL, а не шириной/классом.
 * 2. **Старые классы-костыли размеров запрещены** (`dialog-box-tall`,
 *    `group-delete-box`, `trash-box`) — их заменили роли.
 * 3. **Самодельные полосы вкладок запрещены** (`admin-tabs`, `icon-tabs`,
 *    `diff-tabs`, `type-editor-tabs`, `settings-md-tabs`) — вкладки в диалогах
 *    строит только общий механизм `lib/ui/tabs.ts`.
 * 4. **Самодельные сворачиваемые секции запрещены** (`<details>`/`<summary>`
 *    вне `lib/ui/collapsible.ts`) — сворачивание даёт общий компонент.
 * 5. **Авто-высота диалога запрещена:** у `.dialog-box` нет `height: auto`, а
 *    вкладочный диалог получает фиксированную высоту роли.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
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
import { readRendererCss } from './renderer-css.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/** Окно исходника после `showDialog({`, в котором ищется роль размера. */
const DIALOG_WINDOW = 700;

/** Роль размера в вызове каркаса. */
const SIZE_DECL = /\bsize:\s*'(?:s|m|l|xl)'/;

/**
 * Правило 1 (функциональное): каждый вызов `showDialog({…})` несёт роль размера.
 * Ширина/класс диалога задаются только ролью — точечные размеры запрещены.
 */
function findDialogsWithoutSize(root: string): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const file of listSourceFiles(root)) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const source = fs.readFileSync(file, 'utf8');
    const re = /showDialog\(\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const window = source.slice(match.index, match.index + DIALOG_WINDOW);
      if (SIZE_DECL.test(window)) continue;
      const line = source.slice(0, match.index).split('\n').length;
      violations.push({
        rule: 'dialog-has-size',
        file: rel,
        line,
        text: 'showDialog({…}) without `size: \'s\'|\'m\'|\'l\'|\'xl\'`',
      });
    }
  }
  return violations;
}

/** Правило 5 (функциональное): `.dialog-box` не получает авто-высоту. */
function findDialogAutoHeight(root: string): GuardViolation[] {
  const css = readRendererCss(root);
  const re = /\.dialog-box[^{}]*\{[^}]*height:\s*auto/;
  const match = re.exec(css);
  if (match === null) return [];
  return [
    {
      rule: 'no-dialog-auto-height',
      file: 'styles.css',
      line: css.slice(0, match.index).split('\n').length,
      text: '.dialog-box { height: auto }',
    },
  ];
}

/** Строка-комментарий (JS/CSS) — упоминание упразднённого имени в пояснении
 *  не является использованием. */
function isCommentLine(_rel: string, line: string): boolean {
  return /^\s*(?:\/\*|\*|\/\/)/.test(line);
}

const RULES: GuardRule[] = [
  {
    name: 'no-legacy-dialog-size-classes',
    description:
      'Старые точечные классы размеров диалога упразднены (требование ' +
      '13464c39): размер задаёт роль S/M/L/XL, а не `dialog-box-tall` / ' +
      '`group-delete-box` / `trash-box`.',
    pattern: /dialog-box-tall|group-delete-box|trash-box/,
    allow: isCommentLine,
  },
  {
    name: 'no-handmade-tab-strips',
    description:
      'Самодельные полосы вкладок диалогов упразднены (требование 88a9225a): ' +
      'вкладки строит только общий механизм `lib/ui/tabs.ts` через `tabs` ' +
      'каркаса диалога.',
    pattern: /(?:settings-md|icon|diff|admin|type-editor)-tabs\b/,
    allow: isCommentLine,
  },
  {
    name: 'no-handmade-collapsible',
    description:
      'Самодельные сворачиваемые секции запрещены (требование 88a9225a): ' +
      'сворачивание даёт общий компонент `lib/ui/collapsible.ts`, а не ' +
      '`<details>`/`<summary>` в потребителях.',
    pattern: /el\(\s*'(?:details|summary)'/,
    allow: (rel) => rel.startsWith('lib/ui/'),
  },
];

describe('guard: компонент диалога (a57e7998)', () => {
  it('каждый showDialog несёт роль размера', () => {
    const violations = findDialogsWithoutSize(RENDERER_ROOT);
    assert.equal(
      violations.length,
      0,
      `диалог без роли размера:\n${violations
        .map((v) => `  • ${v.file}:${v.line} [${v.rule}]`)
        .join('\n')}`,
    );
  });

  it('нет старых классов-костылей размеров и самодельных вкладок/сворачиваний', () => {
    assertGuardClean(RENDERER_ROOT, RULES, { extensions: ['.ts', '.css'] });
  });

  it('у .dialog-box нет авто-высоты', () => {
    const violations = findDialogAutoHeight(RENDERER_ROOT);
    assert.equal(
      violations.length,
      0,
      `авто-высота диалога запрещена: ${violations.map((v) => `${v.file}:${v.line}`).join(', ')}`,
    );
  });

  it('правило «роль размера» краснеет на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-dialog-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'fake-dialog.ts'),
        ["showDialog({ title: t, body, buttons: [] });"].join('\n'),
        'utf8',
      );
      const violations = findDialogsWithoutSize(dir);
      assert.ok(
        violations.some((v) => v.rule === 'dialog-has-size'),
        'вызов без size обязан попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('правило «старые классы» краснеет на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-dialog2-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'legacy.ts'),
        ["showDialog({ title: t, body, boxClass: 'trash-box' });"].join('\n'),
        'utf8',
      );
      const violations = collectViolations(dir, RULES, { extensions: ['.ts', '.css'] });
      assert.ok(
        violations.some((v) => v.rule === 'no-legacy-dialog-size-classes'),
        'старый класс размера обязан попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
