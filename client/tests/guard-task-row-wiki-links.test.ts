/**
 * Сторож: markdown-снапшот строки панели задач красится резолвом по ГОТОВОМУ
 * DOM (блокер 399c25d5, Д1 репроверки `7677fe06`).
 *
 * Причина дефекта. Панель «Задачи» редактора мысли (и до правки — панель
 * «Дневника») рендерила строку так: `renderMarkdown(text)` → HTML →
 * `paintWikiIdsInSnippet`/`resolveWikiIdsInSnippet`. Эти резолверы ищут в
 * ТЕКСТЕ серверного сниппета форму `[[#<id>]]`, а отрендеренный markdown несёт
 * уже `<span class="wiki-link" data-wiki-id>` — подпись оставалась пустой,
 * ссылка некликабельной. Правильный путь — `renderMarkdownWithWikiLinks`
 * (`editor/wiki-link-resolver.ts`): markdown → DOM → `resolveWikiLinksInDom`.
 *
 * Сторож КЛАССОВЫЙ: 1) панели строк используют общий вход; 2) ни один модуль
 * рендерера не передаёт результат `renderMarkdown(...)` в резолвер сниппета —
 * новая поверхность того же класса покраснеет сразу.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

/** Панели, которые рисуют markdown-снапшот строки задачи. */
const PANELS: Array<[label: string, path: string]> = [
  ['панель «Дневника»', 'screens/chronicle/tasks-panel.ts'],
  ['панель редактора мысли', 'editor/tasks-panel.ts'],
];

/** Рекурсивно собирает все `.ts`-файлы рендерера. */
function rendererFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) out.push(...rendererFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Комментарии не код: упоминание имени в пояснении — не вызов. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function read(relPath: string): string {
  return readFileSync(resolve(RENDERER, relPath), 'utf8');
}

describe('сторож: ID-ссылки строк панелей задач (399c25d5)', () => {
  it('обе панели рисуют строку общим входом renderMarkdownWithWikiLinks', () => {
    for (const [label, path] of PANELS) {
      const code = stripComments(read(path));
      assert.match(
        code,
        /renderMarkdownWithWikiLinks\s*\(/,
        `${label}: строка рисуется резолвом по готовому DOM (иначе ID-ссылка пуста)`,
      );
    }
  });

  it('результат renderMarkdown не попадает в резолвер сниппета (класс целиком)', () => {
    const offenders: string[] = [];
    for (const file of rendererFiles(RENDERER)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const rendered = new Set<string>();
      for (const match of code.matchAll(/(?:const|let)\s+(\w+)\s*=\s*renderMarkdown\s*\(/g)) {
        rendered.add(match[1]!);
      }
      for (const name of rendered) {
        const snippetCall = new RegExp(
          `(?:paintWikiIdsInSnippet|resolveWikiIdsInSnippet)\\s*\\(\\s*${name}\\b`,
        );
        if (snippetCall.test(code)) {
          offenders.push(`${relative(RENDERER, file)}: ${name}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `резолвер сниппета ищет [[#id]] в тексте и не видит <span data-wiki-id> ` +
        `в отрендеренном markdown (399c25d5): ${offenders.join(', ')}`,
    );
  });
});
