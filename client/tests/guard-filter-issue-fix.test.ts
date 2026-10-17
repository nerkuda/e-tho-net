/**
 * Сторож правила «переход «исправить» из сообщения о запрете — общий каркас,
 * не экран» (требование 0fd1dc5d «Диагностика строк редактора и переход
 * „исправить“ во всех местах»; элементы 4e634c9a «Диагностика строк»,
 * ca905fbc «Футер редактора отбора»).
 *
 * Красную строку и переход в неё рисует каркас редактора: строка диагностики —
 * `lib/filter-tree.ts`, кнопка перехода из футера — `lib/filter-footer.ts`,
 * связка «адрес запрета → фокус строки» — `lib/filter-editor.ts`. Экраны лишь
 * подают диагностику через `host.issues`; своего знания о классах строки
 * диагностики (`ft-issue`) и классе кнопки перехода (`ff-fix`) у них нет —
 * иначе пятое место применения повторило бы переход по-своему.
 *
 * Обратная сторона правила проверяется прямо: каркас ОБЯЗАН нести кнопку и
 * связку — иначе «исправить» из запрета пропадёт молча.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, collectViolations } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/** Места применения отбора — экраны, полоса отборов, строка поиска карты. */
const APPLY_SITES = (rel: string): boolean =>
  rel.startsWith('screens/') || rel.startsWith('canvas/') || rel.startsWith('search/');

/** Классы и переход строки диагностики принадлежат каркасу редактора. */
const NO_LOCAL_ISSUE_TRANSITION = {
  name: 'no-local-issue-transition',
  description:
    'Строка диагностики (`ft-issue`) и переход к проблемной строке ' +
    '(`ff-preview__text--action` — клик по тексту фразы в футере; прежде ' +
    'кнопка `ff-fix`) живут в общем каркасе редактора (lib/filter-tree.ts, ' +
    'lib/filter-footer.ts, lib/filter-editor.ts), а не в экране: место ' +
    'применения подаёт диагностику через host.issues и не повторяет переход ' +
    'по-своему (требование 0fd1dc5d).',
  pattern: /ft-issue|ff-fix|ff-preview__text--action/,
  include: APPLY_SITES,
};

/** Каркас обязан нести переход (обратная сторона правила). */
function readLib(file: string): string {
  return fs.readFileSync(path.join(RENDERER_ROOT, 'lib', file), 'utf8');
}

describe('guard: переход «исправить» из сообщения о запрете — каркас, не экран', () => {
  it('экран не знает классов строки диагностики и перехода', () => {
    assertGuardClean(RENDERER_ROOT, [NO_LOCAL_ISSUE_TRANSITION]);
  });

  it('каркас несёт переход: футер отдаёт адрес записи из сообщения о запрете', () => {
    const footer = readLib('filter-footer.ts');
    assert.match(
      footer,
      /FILTER_FOOTER_PREVIEW_ACTION_CLASS/,
      'переход — по клику на текст фразы, класс-действие рисует общий футер (п.10)',
    );
    assert.doesNotMatch(footer, /class: 'ff-fix'/, 'отдельной кнопки «исправить» нет (п.10)');
    assert.match(
      footer,
      /firstLocalizedErrorIssue/,
      'переход предлагается только к ЛОКАЛИЗОВАННОЙ красной записи (есть адрес строки)',
    );
    assert.match(footer, /opts\.onFixIssue\?\.\(/, 'футер лишь передаёт адрес — логика перехода не в нём');
  });

  it('каркас несёт связку «адрес запрета → фокус строки»', () => {
    const editor = readLib('filter-editor.ts');
    assert.match(editor, /onFixIssue:/, 'фабрика подключает переход из запрета');
    assert.match(
      editor,
      /tree\.focusIssue\(path\)/,
      'единая точка перехода — фокус строки каркаса дерева',
    );
    const tree = readLib('filter-tree.ts');
    assert.match(tree, /focusIssue:/, 'дерево отдаёт переход по адресу записи');
    assert.match(
      tree,
      /fixers\.set\(issue\.path,\s*focus\)/,
      'адрес записи связывается с тем же переходом, что у кнопки в строке',
    );
  });

  it('правило краснеет на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-fix-'));
    try {
      fs.mkdirSync(path.join(dir, 'screens', 'fake'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'screens', 'fake', 'panel.ts'),
        [
          "const line = root.querySelector('.ft-issue');",
          "const fix = root.querySelector('.ff-fix');",
          'fix?.addEventListener(\'click\', () => line?.focus());',
        ].join('\n'),
        'utf8',
      );
      const names = new Set(collectViolations(dir, [NO_LOCAL_ISSUE_TRANSITION]).map((v) => v.rule));
      assert.ok(
        names.has('no-local-issue-transition'),
        'своя работа с классами диагностики в экране обязана попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
