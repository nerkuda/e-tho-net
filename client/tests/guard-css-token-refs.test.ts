/**
 * Сторож ссылок на CSS-токены рендерера (ошибка d0bc4c1c, версия 0.12.1).
 *
 * Правило: любая ссылка `var(--x)` в CSS рендерера обязана указывать на
 * переменную, которая где-то объявлена (`--x: …` в любом селекторе/теме любого
 * CSS-модуля) либо осознанно выставляется из JS в рантайме. Ссылка на
 * несуществующую переменную невалидна: без fallback цвет/размер наследуется от
 * родителя, с fallback тихо подставляется светотематический литерал — в обоих
 * случаях оформление не следует теме (симптом `--muted`/`--text-muted`).
 *
 * Почему магия строк в объявлениях допустима: токены объявляются в разных
 * блоках (`:root`, `[data-theme='dark']`, локальные селекторы вроде
 * `.md-transclusion`), поэтому «объявленность» собирается по ВСЕМ CSS-модулям
 * рендерера, а не только по `tokens.css`.
 *
 * Allow-списки (осознанные, минимизированы, не разрастаются сами — есть тест
 * на отсутствие «мёртвых» записей):
 *   • RUNTIME_TOKENS — кастом-свойства, которые выставляются из JS
 *     (`style.setProperty`/`getComputedStyle`) и потому не могут быть
 *     объявлены в CSS;
 *   • LEGACY_UNDEFINED_TOKENS — известные токены-наследие, ссылки на которые
 *     подлежат отдельному исправлению (ошибка 014bb4c1). Список закрыт:
 *     НОВЫЙ неопределённый токен сюда не попадёт — сторож покраснеет.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { listSourceFiles } from './guard-helpers.js';
import { RENDERER_ROOT } from './renderer-css.js';

/** Токены, выставляемые из JS в рантайме (не объявляются в CSS). */
const RUNTIME_TOKENS = new Set([
  // canvas/canvas.ts
  '--cloud-zoom',
  '--focus-band-top',
  '--focus-band-bottom',
  // canvas/canvas-zoom.ts
  '--link-label-font',
  // canvas/zone-splitters.ts
  '--zone-top-split',
  '--zone-children-share',
  // lib/layer-colors.ts
  '--layer-bg',
  '--layer-focus-stripe',
  // lib/ui/popover.ts
  '--ui-popover-arrow-left',
  // lib/ui/tree.ts
  '--tree-level',
  // editor/list-heights.ts
  '--clamp-attachments',
  '--clamp-chrono',
  '--clamp-props',
  // editor/mini-graph.ts
  '--edge-color',
  '--edge-width',
  '--edge-hover-width',
  // screens/event-area-resizer.ts
  '--event-area-w',
  // screens/selection-resizer.ts
  '--selection-w',
  // screens/structures/structures.ts
  '--st-indent',
  // screens/publications/workspace.ts
  '--pub-doc-width',
]);

/**
 * Известные неопределённые токены-наследие (подлежат отдельному исправлению —
 * ошибка 014bb4c1). Все используются с fallback. Размер списка сторожится
 * тестом «нет мёртвых записей»: исправишь токен — убери его отсюда.
 */
const LEGACY_UNDEFINED_TOKENS = new Set([
  '--mono',
  '--font-mono',
  '--surface-alt',
  '--surface-3',
  '--bg-soft',
  '--shadow-2',
  '--st-checks-h',
  '--fp-size-side',
  '--fp-size-top',
]);

const TOKENS_CSS = path.join(RENDERER_ROOT, 'styles', 'tokens.css');

/** Блочные комментарии → пробелы (номера строк сохраняются). */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** CSS-модули рендерера (относительный путь с `/` → абсолютный путь). */
function cssFiles(): Array<{ rel: string; abs: string }> {
  return listSourceFiles(RENDERER_ROOT, { extensions: ['.css'] }).map((abs) => ({
    abs,
    rel: path.relative(RENDERER_ROOT, abs).split(path.sep).join('/'),
  }));
}

/** Имена, объявленные как кастом-свойства (`--x:`) во всех CSS рендерера. */
function declaredTokens(): Set<string> {
  const declared = new Set<string>();
  for (const { abs } of cssFiles()) {
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    for (const m of code.matchAll(/(^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g)) declared.add(m[2]!);
  }
  return declared;
}

interface Usage {
  token: string;
  file: string;
  line: number;
  text: string;
}

/** Ссылки `var(--x)` по всем CSS рендерера с координатами. */
function usedTokens(): Usage[] {
  const usages: Usage[] = [];
  for (const { rel, abs } of cssFiles()) {
    const lines = stripComments(fs.readFileSync(abs, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
        usages.push({ token: m[1]!, file: rel, line: i + 1, text: line.trim() });
      }
    });
  }
  return usages;
}

describe('guard: ссылки на CSS-токены рендерера', () => {
  it('каждый var(--token) объявлен в CSS или выставляется из JS', () => {
    const declared = declaredTokens();
    const violations = usedTokens().filter(
      (u) =>
        !declared.has(u.token) &&
        !RUNTIME_TOKENS.has(u.token) &&
        !LEGACY_UNDEFINED_TOKENS.has(u.token),
    );
    if (violations.length > 0) {
      const list = violations
        .map((v) => `  • ${v.file}:${v.line} — var(${v.token}); ${v.text}`)
        .join('\n');
      throw new Error(
        `CSS рендерера ссылается на неопределённые токены (${violations.length}):\n${list}\n\n` +
          'Объяви токен в CSS либо из JS (тогда добавь в RUNTIME_TOKENS осознанно). ' +
          'Осознанное исключение — только RUNTIME_TOKENS/LEGACY_UNDEFINED_TOKENS.',
      );
    }
  });

  it('нет ссылок на var(--muted)/var(--text-muted) (регресс d0bc4c1c)', () => {
    const bad = usedTokens().filter((u) => u.token === '--muted' || u.token === '--text-muted');
    if (bad.length > 0) {
      const list = bad.map((v) => `  • ${v.file}:${v.line} — ${v.text}`).join('\n');
      throw new Error(
        `Приглушённый текст обязан брать объявленный токен (--text-dim/--text-faint):\n${list}`,
      );
    }
  });

  it('канонические токены приглушённого текста объявлены', () => {
    const root = stripComments(fs.readFileSync(TOKENS_CSS, 'utf8'));
    const missing = ['--text-dim', '--text-faint'].filter(
      (t) => !new RegExp(`(^|[;{\\s])${t}\\s*:`).test(root),
    );
    if (missing.length > 0) {
      throw new Error(`Не объявлены токены приглушённого текста: ${missing.join(', ')}`);
    }
  });

  it('allow-списки не содержат мёртвых записей', () => {
    const usedNames = new Set(usedTokens().map((u) => u.token));
    const stale = [...RUNTIME_TOKENS, ...LEGACY_UNDEFINED_TOKENS].filter((t) => !usedNames.has(t));
    if (stale.length > 0) {
      throw new Error(
        `Записи allow-списков больше не используются в CSS — удали их: ${stale.join(', ')}`,
      );
    }
  });
});
