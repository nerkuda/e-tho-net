/**
 * Сторож: серверный сниппет рендерится только через резолвер ID-форм
 * wiki-ссылок (ошибка 2a8181f4).
 *
 * Причина. Серверный `makeSnippet` (`server/src/domain/search-service.ts`)
 * намеренно сохраняет wiki-спан `[[…]]` целиком — имя мысли подставляет
 * клиент. Потребители сниппетов обязаны прогнать его через
 * `paintWikiIdsInSnippet` (синхронно, из кеша — id не мелькает на экране) и
 * `resolveWikiIdsInSnippet` (батч-дорезолв), как это делает группа «Ссылки на
 * мысль» (`editor/links-tab.ts`). Поверхности, рисовавшие `snippet` как есть
 * (`search/search.ts`, `lib/record-search.ts`, группа «Упоминания»
 * `editor/links-tab.ts` `buildMentionsBody`), показывали сырой `[[#<uuid>]]`.
 *
 * Сторож КЛАССОВЫЙ: сканирует все `renderHtml(...)` в рендерере и требует,
 * чтобы каждый вызов с аргументом-сниппетом нёс резолвер, — будущая
 * поверхность того же класса покраснеет сразу. Поведенческий сквозной сценарий
 * (живой рендер) — GUI-стенд; этот файл фиксирует проводку, потому что
 * экраны под Node импортируются частично (тянут Electron-каркас).
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

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

/**
 * Вырезает текст аргументов каждого вызова `renderHtml(` в файле, считая
 * баланс круглых скобок. Внутри строковых литералов (`"`, `'`, `` ` ``) скобки
 * не считаются — иначе литерал с `)` сорвал бы разбор.
 */
function renderHtmlArgs(source: string): Array<{ args: string; line: number }> {
  const out: Array<{ args: string; line: number }> = [];
  const needle = 'renderHtml(';
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at < 0) break;
    let i = at + needle.length;
    let depth = 1;
    let quote: string | null = null;
    const start = i;
    for (; i < source.length && depth > 0; i += 1) {
      const ch = source[i]!;
      if (quote !== null) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    const args = source.slice(start, i - 1);
    const line = source.slice(0, at).split('\n').length;
    out.push({ args, line });
    from = i;
  }
  return out;
}

describe('сторож: резолв ID-форм в серверных сниппетах (2a8181f4)', () => {
  it('ни один renderHtml со сниппетом не выводит его сырым (класс целиком)', () => {
    const offenders: string[] = [];
    for (const file of rendererFiles(RENDERER)) {
      const source = readFileSync(file, 'utf8');
      for (const { args, line } of renderHtmlArgs(source)) {
        // Сниппет — аргумент, обращающийся к полю `.snippet`
        // (hit.snippet / row.snippet). Рендер имени цели резолвера — не сниппет.
        if (!/\.snippet\b/.test(args)) continue;
        if (/paintWikiIdsInSnippet\s*\(/.test(args)) continue;
        offenders.push(`${relative(RENDERER, file)}:${line}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `сниппет рендерится без paintWikiIdsInSnippet (сырой [[#uuid]] на экране): ${offenders.join(', ')}`,
    );
  });

  it('search/search.ts резолвит сниппет результатов поиска', () => {
    const src = readFileSync(resolve(RENDERER, 'search', 'search.ts'), 'utf8');
    assert.match(
      src,
      /import\s*\{[^}]*paintWikiIdsInSnippet[^}]*\}\s*from\s*'\.\.\/editor\/wiki-link-resolver\.js'/,
      'резолвер сниппета подключён из общего модуля, а не переписан локально',
    );
    assert.match(src, /renderHtml\([^)]*paintWikiIdsInSnippet\(/, 'синхронный резолв сниппета');
    assert.match(src, /resolveWikiIdsInSnippet\(/, 'батч-дорезолв сниппета');
  });

  it('lib/record-search.ts резолвит сниппет записи «Дневника»', () => {
    const src = readFileSync(resolve(RENDERER, 'lib', 'record-search.ts'), 'utf8');
    assert.match(
      src,
      /import\s*\{[^}]*paintWikiIdsInSnippet[^}]*\}\s*from\s*'\.\.\/editor\/wiki-link-resolver\.js'/,
      'резолвер сниппета подключён из общего модуля',
    );
    assert.match(src, /renderHtml\([^)]*paintWikiIdsInSnippet\(/, 'синхронный резолв сниппета');
    assert.match(src, /resolveWikiIdsInSnippet\(/, 'батч-дорезолв сниппета');
  });

  it('editor/links-tab.ts buildMentionsBody резолвит сниппет группы «Упоминания»', () => {
    const src = readFileSync(resolve(RENDERER, 'editor', 'links-tab.ts'), 'utf8');
    const body =
      /function buildMentionsBody\([\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    assert.ok(body !== '', 'тело buildMentionsBody найдено');
    assert.match(
      body.replace(/\/\/[^\n]*/g, ''),
      /renderHtml\(\s*snippet\s*,\s*paintWikiIdsInSnippet\(/,
      'сниппет упоминаний проходит через резолвер, а не рендерится сырым',
    );
  });
});
