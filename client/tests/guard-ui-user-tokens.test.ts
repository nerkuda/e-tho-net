/**
 * Сторож пользовательских токенов `lib/ui` (требование e2895c24, задача
 * be2fce4d, стандарт «Правило без теста-сторожа не считается введённым»).
 *
 * Правило: аспекты оформления, которые планируется отдать пользователю
 * (фон холста, цвета, шрифты, стили текста комментариев), выделены в группу
 * `--user-*` в `styles.css` и документированы; компоненты `lib/ui` не
 * хардкодят то, что планируется отдать пользователю.
 *
 * Проверяется:
 *   1. группа `--user-*` объявлена в `:root` `styles.css` и снабжена
 *      поясняющим комментарием (архитектура настроек оформления);
 *   2. в CSS `lib/ui` нет литеральных семейств шрифта: `font-family` берётся
 *      из пользовательского токена (`--user-font-*`), а не из гарнитуры.
 *      Цвета и размеры уже закрыты сторожем `guard-ui-tokens.test.ts`.
 *
 * Сам функционал настроек оформления — отдельный будущий тех.проект; здесь
 * только архитектурная подготовка (граница требования e2895c24).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, type GuardRule } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');
const STYLES_CSS = path.join(RENDERER_ROOT, 'styles.css');

/** Минимум объявлений группы `--user-*` (шрифты, холст, комментарии). */
const MIN_USER_TOKENS = 5;

/** Маркер документации группы пользовательских токенов. */
const USER_GROUP_MARKER = 'Группа пользовательских токенов';

/** Строка — комментарий? */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function rules(): GuardRule[] {
  return [
    {
      name: 'no-literal-font-family-in-lib-ui',
      description:
        'Литеральное семейство шрифта в CSS lib/ui запрещено: шрифт берётся ' +
        'из пользовательского токена (--user-font-*) — требование e2895c24.',
      pattern: /font-family\s*:(?![^;]*var\()[^;]+/,
      include: (rel) => rel.startsWith('lib/ui/'),
      allow: (_rel, line) => isComment(line),
    },
  ];
}

describe('guard: пользовательские токены lib/ui', () => {
  it('группа --user-* объявлена и задокументирована в :root styles.css', () => {
    const css = fs.readFileSync(STYLES_CSS, 'utf8');
    // Блок :root до селектора тёмной темы (в шапке-комментарии `:root` тоже
    // упоминается `[data-theme='dark']`, поэтому ищем сам селектор).
    const rootEnd = css.indexOf("[data-theme='dark'] {");
    const root = css.slice(0, rootEnd === -1 ? css.length : rootEnd);
    if (!root.includes(USER_GROUP_MARKER)) {
      throw new Error(
        `Группа пользовательских токенов не задокументирована: в :root styles.css ` +
          `нет комментария «${USER_GROUP_MARKER}» (требование e2895c24).`,
      );
    }
    const declared = new Set<string>();
    for (const m of root.matchAll(/(--user-[a-z0-9-]+)\s*:/gi)) declared.add(m[1]!);
    if (declared.size < MIN_USER_TOKENS) {
      throw new Error(
        `Группа --user-* объявлена неполно (${declared.size} < ${MIN_USER_TOKENS}): ` +
          'ожидаются хотя бы шрифт интерфейса, шрифт кода, фон холста и стили ' +
          'текста комментариев (требование e2895c24).',
      );
    }
  });

  it('в CSS lib/ui шрифт берётся из --user-*, а не из литерала', () => {
    assertGuardClean(RENDERER_ROOT, rules(), { extensions: ['.css'] });
  });
});
