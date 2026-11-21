/**
 * Сторож ЕДИНСТВЕННОГО ИСТОЧНИКА ГРАММАТИКИ task-строк (0.16.1, задача
 * c4cc50f1; требование d957a49d; ADR «парсер строк задач — библиотечный
 * модуль» 20a62354).
 *
 * Правило. Синтаксис `- [ ]` / `- [x]` разбирает ТОЛЬКО правило единого
 * рендерера `markdown/src/task-list.ts`; парсер строк задач
 * (`markdown/src/task-lines.ts`) обязан читать его результат — принадлежность
 * inline пункту списка (`ownerListItemIndex`) и состояние чек-бокса
 * (`taskListCheckbox`), — а не заводить второй разбор того же синтаксиса.
 *
 * Сторож краснеет на:
 *   1. собственную грамматику маркера в любом файле пакета, кроме
 *      `task-list.ts` (регэксп вида `\[[ xX]\]`, объявление константы
 *      `TASK_MARKER` — импорт готового `TASK_MARKER_PATTERN` законен, —
 *      имя токена `task_list_checkbox`, HTML-классы task-списка);
 *   2. потерю импорта общих хелперов в `task-lines.ts` (парсер начал бы
 *      разбирать разметку сам);
 *   3. исчезновение самого правила/хелперов из `task-list.ts`.
 *
 * Поведенческая половина сверяет парсер с рендерером на корпусе форм: число
 * чек-боксов HTML обязано совпадать с числом строк с чек-боксом.
 *
 * Входит в обычный `npm -w @etn/markdown test`; читает исходники пакета, поэтому
 * краснеет сразу на правку `markdown/src/**` без пересборки.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parseTaskLines, renderMarkdown } from '../src/index.js';

const SRC_DIR = resolve(import.meta.dirname, '..', 'src');

/** Файл, которому разрешено знать грамматику маркера задачи. */
const GRAMMAR_OWNER = 'task-list.ts';

/** Исходники пакета (без комментариев — в них синтаксис упоминается легально). */
function sources(): Array<{ file: string; code: string }> {
  return readdirSync(SRC_DIR)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => ({
      file,
      code: readFileSync(resolve(SRC_DIR, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/[^\n]*/g, '$1')
        // Чистый ре-экспорт (`export { … } from './…'`) — не второй разбор:
        // barrel `index.ts` переселяет наружу имя константы, но не грамматику.
        .replace(/export \{[^}]*\} from '[^']+';/g, ''),
    }));
}

describe('сторож: грамматика task-строк — только в правиле единого рендерера', () => {
  it('маркер задачи и имя токена не разбираются заново вне task-list.ts', () => {
    const forbidden: Array<{ name: string; pattern: RegExp }> = [
      // Маркер `[ ]` / `[x]` / `[ xX]` в КОДЕ файла (в комментариях он
      // легален и вырезан выше): символьный класс с пробелом/x/X внутри скобок.
      { name: 'маркер `[ ]`/`[x]`', pattern: /\[[xX ]{1,3}\]/ },
      { name: 'константа TASK_MARKER', pattern: /(?:const|let|var)\s+TASK_MARKER/ },
      { name: 'имя токена task_list_checkbox', pattern: /task_list_checkbox/ },
      { name: 'HTML-класс task-list-item', pattern: /task-list-item/ },
      { name: 'HTML-класс contains-task-list', pattern: /contains-task-list/ },
    ];
    for (const { file, code } of sources()) {
      if (file === GRAMMAR_OWNER) continue;
      for (const rule of forbidden) {
        assert.equal(
          rule.pattern.test(code),
          false,
          `${file}: ${rule.name} вне ${GRAMMAR_OWNER} — второй разбор грамматики task-строк (ADR 20a62354)`,
        );
      }
    }
  });

  it('парсер строк задач читает готовый результат рендерера, а не разметку', () => {
    const parser = readFileSync(resolve(SRC_DIR, 'task-lines.ts'), 'utf8');
    assert.match(
      parser,
      /import \{[^}]*ownerListItemIndex[^}]*\} from '\.\/task-list\.js'/,
      'парсер обязан брать принадлежность inline пункту списка из правила рендерера',
    );
    assert.match(
      parser,
      /import \{[^}]*taskListCheckbox[^}]*\} from '\.\/task-list\.js'/,
      'парсер обязан брать состояние чек-бокса из правила рендерера',
    );
  });

  it('правило и его общие хелперы на месте', () => {
    const rule = readFileSync(resolve(SRC_DIR, 'task-list.ts'), 'utf8');
    assert.match(
      rule,
      /export function ownerListItemIndex\(/,
      'пропал общий хелпер ownerListItemIndex',
    );
    assert.match(
      rule,
      /export function taskListCheckbox\(/,
      'пропал общий хелпер taskListCheckbox',
    );
    assert.match(rule, /export function taskListPlugin\(/, 'пропало правило task-списков');
  });

  it('парсер и рендерер согласны на корпусе форм', () => {
    const corpus = [
      '- [ ] открытая',
      '- [x] закрытая',
      '* [ ] звёздочка',
      '1. [ ] нумерованная',
      '- [ ] без пробела после скобки',
      '- [ ]',
      'Текст [ ] не задача',
      '- обычный пункт',
      '  - [ ] подзадача',
      '',
      '```',
      '- [ ] в блоке кода',
      '```',
      '',
      '    - [ ] в блоке кода отступом',
      '',
      '\\- [ ] экранировано',
      '',
      '<!-- - [ ] в комментарии -->',
    ].join('\n');
    const html = renderMarkdown(corpus);
    const rendered = html.match(/class="task-list-item-checkbox"/g) ?? [];
    const parsed = parseTaskLines(corpus).filter((line) => line.hasCheckbox);
    assert.equal(
      parsed.length,
      rendered.length,
      'число задач парсера разошлось с числом чек-боксов единого рендерера',
    );
    assert.equal(parsed.length, 6);
  });
});
