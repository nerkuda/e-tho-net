/**
 * Сторож обнаружимости действий (задача e45ca252, стандарт 1b5f6200 «Функция
 * не живёт только на hover и только на хоткее», стандарт «Правило без
 * теста-сторожа не считается введённым»).
 *
 * Правило: у функции интерфейса есть видимая точка входа — она не достигается
 * ТОЛЬКО наведением мыши и не живёт ТОЛЬКО на горячей клавише. Сторож ловит три
 * машинно-проверяемых нарушения:
 *
 * 1. **Hover-only показ действия (CSS).** Правило `:hover`/`:focus-within`
 *    включает (`display`/`visibility`/`pointer-events`/`opacity`) элемент,
 *    который в покое спрятан, и у него нет парного `:focus`/`:focus-visible`
 *    пути — значит, действие видно только мыши. Ненаведённое покоящееся
 *    `opacity: 0.6` под правило не попадает: спрятанным считается `display:
 *    none`/`visibility: hidden`/`opacity: 0`/`pointer-events: none`.
 * 2. **Hover-only поведение компонента (`lib/ui`).** Компонент словаря не
 *    вешает функцию на `mouseenter`/`mouseover` — это делает её недостижимой
 *    без мыши (тач, клавиатура).
 * 3. **Хоткей без мышиного пути (`lib/ui`).** Модуль словаря, обрабатывающий
 *    горячую клавишу (`ctrlKey`/`metaKey`), обязан иметь и мышиный путь
 *    (`pointerdown`/`mousedown`/`click`) в том же модуле — горячая клавиша
 *    лишь ускоритель, не единственный путь.
 *
 * Карта хоткеев всего клиента (08-ui-spec) — вне словаря и проверяется
 * выборочно при переводе экрана (см. отчёт задачи e45ca252).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assembledStylesFile } from './renderer-css.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');
const UI_ROOT = path.join(RENDERER_ROOT, 'lib', 'ui');

/** Покоящееся «спрятано» — элемент недоступен мыши и клавиатуре. */
const HIDDEN =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\D|$)|pointer-events\s*:\s*none)/;

/** Включение на наведении — действие появляется. */
const REVEAL =
  /(?:^|;)\s*(?:display\s*:\s*(?!none)|visibility\s*:\s*visible|pointer-events\s*:\s*auto|opacity\s*:\s*1(?:\D|$))/;

interface CssBlock {
  selector: string;
  body: string;
}

/** Блоки `селектор { … }` без комментариев. */
function cssBlocks(css: string): CssBlock[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1]!.trim().replace(/\s+/g, ' '),
    body: m[2]!,
  }));
}

/** Хвост селектора — последний простой селектор (для сопоставления базы и цели). */
function lastToken(selector: string): string {
  const parts = selector.trim().split(/\s+/);
  return parts[parts.length - 1]!;
}

/**
 * Селекторы, включаемые только на `:hover`/`:focus-within`: цель спрятана в
 * покое и не имеет парного `:focus`-пути.
 */
function findHoverOnlyReveals(css: string): string[] {
  const blocks = cssBlocks(css);
  const hiddenTokens = new Set(
    blocks.filter((b) => HIDDEN.test(b.body)).map((b) => lastToken(b.selector.replace(/\[[^\]]*\]/g, ''))),
  );
  const focusRevealed = new Set(
    blocks
      .filter((b) => /:(focus|focus-visible|focus-within)\b/.test(b.selector) && REVEAL.test(b.body))
      .map((b) => lastToken(b.selector)),
  );
  const violations: string[] = [];
  for (const block of blocks) {
    if (!/:hover\b/.test(block.selector)) continue;
    if (!REVEAL.test(block.body)) continue;
    // Цель включения: часть селектора после `:hover` (потомок) либо сам
    // элемент без `:hover`/`:focus-within`.
    const afterHover = block.selector.replace(/^[\s\S]*?:hover\b/, '').trim();
    const target = afterHover === '' || afterHover === block.selector
      ? lastToken(block.selector)
      : lastToken(afterHover.replace(/^[>+~]\s*/, ''));
    if (hiddenTokens.has(target) && !focusRevealed.has(target)) {
      violations.push(block.selector);
    }
  }
  return violations;
}

describe('guard: обнаружимость действий (e45ca252, стандарт 1b5f6200)', () => {
  it('нет hover-only показа действий в CSS lib/ui и styles.css', () => {
    const files = [
      ...fs.readdirSync(UI_ROOT).filter((f) => f.endsWith('.css')).map((f) => path.join(UI_ROOT, f)),
      assembledStylesFile(),
    ];
    const problems: string[] = [];
    for (const file of files) {
      for (const selector of findHoverOnlyReveals(fs.readFileSync(file, 'utf8'))) {
        problems.push(`  • ${path.relative(RENDERER_ROOT, file).replace(/\\/g, '/')} «${selector}»`);
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `Действия, показываемые только наведением (${problems.length}):\n${problems.join('\n')}\n\n` +
          'У скрытого до hover действия обязан быть парный :focus-visible/:focus путь ' +
          'или видимая точка входа (стандарт 1b5f6200).',
      );
    }
  });

  it('компоненты lib/ui не живут на hover-событиях без мышиного/клавиатурного пути', () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(UI_ROOT).filter((f) => f.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(UI_ROOT, file), 'utf8');
      if (/addEventListener\(\s*['"](?:mouseenter|mouseover)['"]/.test(src)) {
        offenders.push(`  • lib/ui/${file}`);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `Компоненты lib/ui на mouseenter/mouseover (${offenders.length}):\n${offenders.join('\n')}\n\n` +
          'Функция компонента не может быть доступна только мышью (стандарт 1b5f6200): ' +
          'нужен pointer/клавиатурный путь.',
      );
    }
  });

  it('хоткей в lib/ui имеет мышиный путь в том же модуле', () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(UI_ROOT).filter((f) => f.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(UI_ROOT, file), 'utf8');
      const hotkey = /(?:ctrlKey|metaKey)/.test(src);
      if (!hotkey) continue;
      const pointerPath = /addEventListener\(\s*['"](?:pointerdown|mousedown|click|dblclick)['"]/.test(src);
      if (!pointerPath) offenders.push(`  • lib/ui/${file}`);
    }
    if (offenders.length > 0) {
      throw new Error(
        `Хоткей без мышиного пути (${offenders.length}):\n${offenders.join('\n')}\n\n` +
          'Горячая клавиша — ускоритель, а не единственный путь: у действия в модуле ' +
          'обязан быть pointer/click-путь (стандарт 1b5f6200).',
      );
    }
  });

  it('анализ hover-only краснеет на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-discover-'));
    try {
      const file = path.join(dir, 'x.css');
      fs.writeFileSync(
        file,
        '.act { display: none; }\n.row:hover .act { display: block; }\n',
        'utf8',
      );
      const found = findHoverOnlyReveals(fs.readFileSync(file, 'utf8'));
      assert.ok(
        found.some((s) => s.includes('.row:hover .act')),
        'hover-only показ действия обязан распознаваться',
      );
      // Парный focus-путь снимает нарушение.
      fs.writeFileSync(
        file,
        '.act { display: none; }\n.row:hover .act,\n.row:focus-within .act { display: block; }\n',
        'utf8',
      );
      assert.deepEqual(
        findHoverOnlyReveals(fs.readFileSync(file, 'utf8')),
        [],
        'парный focus-путь делает действие доступным без мыши',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
