/**
 * Карта маппинга токенов ETN → Web Awesome (`lib/ui/tokens.css`, задача 95dd50b9).
 *
 * Текстовые проверки связности и гигиены карты:
 *  • каждый `var(--token)` в карте существует в `styles.css` (нет опечаток и
 *    висячих ссылок);
 *  • цветовые токены ETN, на которые опирается карта, объявлены и в `:root`,
 *    и в `[data-theme='dark']` — потому одна карта и красит обе темы;
 *  • карта объявлена вне cascade-слоёв (`@layer`) и без прямых hex-литералов
 *    (цвета — только через токены ETN).
 *
 * Тематическая проверка «перекрашиваются ли контролы» опирается именно на это
 * свойство: значения карты — ссылки на токены ETN, а те подменяются темой.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

const STYLES_CSS = fs.readFileSync(
  path.join(RENDERER_ROOT, 'styles.css'),
  'utf8',
);
const TOKENS_CSS = fs.readFileSync(
  path.join(RENDERER_ROOT, 'lib', 'ui', 'tokens.css'),
  'utf8',
);

/** Внутренность CSS-блока, начинающегося с указанного заголовка (баланс скобок). */
function extractBlock(css: string, header: string): string {
  const at = css.indexOf(header);
  if (at === -1) throw new Error(`CSS-блок не найден: ${header}`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`CSS-блок не закрыт: ${header}`);
}

/** Имена custom-свойств, объявленных в блоке. */
function declaredTokens(block: string): Set<string> {
  const names = new Set<string>();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:/gi)) {
    names.add(m[1]!);
  }
  return names;
}

const lightTokens = declaredTokens(extractBlock(STYLES_CSS, ':root {'));
const darkTokens = declaredTokens(extractBlock(STYLES_CSS, "[data-theme='dark'] {"));

/** Токены ETN, на которые ссылается карта через `var(--x)`. */
const mappedRefs = new Set<string>();
for (const line of TOKENS_CSS.split('\n')) {
  if (!line.trimStart().startsWith('--wa-')) continue;
  for (const m of line.matchAll(/var\((--[a-z0-9-]+)\)/gi)) {
    mappedRefs.add(m[1]!);
  }
}

describe('lib/ui: карта маппинга токенов ETN → --wa-*', () => {
  it('ссылается только на токены ETN, объявленные в styles.css', () => {
    const dangling = [...mappedRefs].filter((t) => !lightTokens.has(t));
    if (dangling.length > 0) {
      throw new Error(
        `tokens.css ссылается на несуществующие токены ETN: ${dangling.join(', ')}`,
      );
    }
  });

  it('цветовые токены ETN объявлены в обеих темах (перекраска обеих тем)', () => {
    // Токены, значения которых ETN действительно меняет вместе с темой.
    const perTheme = [
      '--surface',
      '--surface-2',
      '--border',
      '--border-strong',
      '--text',
      '--text-dim',
      '--text-faint',
      '--accent',
      '--accent-strong',
      '--accent-soft',
      '--danger',
      '--danger-soft',
      '--ok',
      '--ok-soft',
      '--warn',
      '--warn-soft',
      '--backdrop',
      '--shadow-c',
    ];
    const notThemed = perTheme.filter(
      (t) => !mappedRefs.has(t) || !lightTokens.has(t) || !darkTokens.has(t),
    );
    if (notThemed.length > 0) {
      throw new Error(
        `Токены не объявлены в обеих темах или не используются картой: ${notThemed.join(', ')}`,
      );
    }
  });

  it('объявлена без cascade-слоёв и без прямых hex-литералов', () => {
    const code = TOKENS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const hex = code.match(/#[0-9a-fA-F]{3,8}\b/);
    if (hex) {
      throw new Error(
        `Прямой hex в карте маппинга (${hex[0]}): цвета берутся только из токенов ETN.`,
      );
    }
    if (/@layer/.test(code)) {
      throw new Error(
        'Карта маппинга не должна объявляться внутри @layer: unlayered-правила ' +
          'нужны, чтобы перекрыть токены Web Awesome (`@layer wa-*`).',
      );
    }
  });
});
