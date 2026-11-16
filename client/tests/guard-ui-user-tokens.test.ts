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
 *      Цвета и размеры уже закрыты сторожем `guard-ui-tokens.test.ts`;
 *   3. у каждого объявленного токена `--user-*` есть потребитель в CSS/TS
 *      рендерера (`var(--user-…)` в CSS, `setProperty`/`getPropertyValue`
 *      с именем токена в TS).
 *      Объявленный «впрок» токен — невидимая дыра: именно так холст
 *      `--user-canvas-*` объявлялся, но не применялся (ошибка d6fae042).
 *
 * Сам функционал настроек оформления — отдельный будущий тех.проект; здесь
 * только архитектурная подготовка (граница требования e2895c24).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, listSourceFiles, type GuardRule } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Минимум объявлений группы `--user-*` (шрифты, холст, комментарии). */
const MIN_USER_TOKENS = 5;

/** Расширения, в которых ищутся потребители токенов (CSS и TS рендерера). */
const CONSUMER_EXTENSIONS = ['.css', '.ts'];

/** Исходник рендерера для проверки потребителей (путь от `src/renderer`). */
export interface TokenSourceFile {
  rel: string;
  content: string;
}

/** Объявленные токены группы `--user-*` из `:root` `styles/tokens.css`. */
export function declaredUserTokens(tokensCss: string): string[] {
  const declared = new Set<string>();
  for (const m of tokensCss.matchAll(/^\s*(--user-[a-z0-9-]+)\s*:/gim)) declared.add(m[1]!);
  return [...declared].sort();
}

/**
 * Потребитель токена — `var(--user-…)` в CSS или адресация по имени в TS
 * (`style.setProperty('--user-…')` / `getPropertyValue('--user-…')`).
 * Само объявление `--user-…:` потребителем НЕ считается.
 */
export function hasUserTokenConsumer(token: string, files: readonly TokenSourceFile[]): boolean {
  const re = new RegExp(`(?:var\\(\\s*|\\.(?:set|get)Property(?:Value)?\\(\\s*['"])${token}\\b`);
  return files.some((file) => re.test(file.content));
}

/** Токены, объявленные без единого потребителя. */
export function deadUserTokens(
  declared: readonly string[],
  files: readonly TokenSourceFile[],
): string[] {
  return declared.filter((token) => !hasUserTokenConsumer(token, files));
}

/** Исходники рендерера, в которых ищутся потребители. */
function rendererSources(): TokenSourceFile[] {
  return listSourceFiles(RENDERER_ROOT, { extensions: CONSUMER_EXTENSIONS }).map((abs) => ({
    rel: path.relative(RENDERER_ROOT, abs).replace(/\\/g, '/'),
    content: fs.readFileSync(abs, 'utf8'),
  }));
}

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
    // Группа живёт в нетематическом файле токенов; цветовые значения теперь
    // в файлах тем (ADR de24adef), поэтому читаем сам `styles/tokens.css`.
    const root = fs.readFileSync(path.join(RENDERER_ROOT, 'styles', 'tokens.css'), 'utf8');
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

  it('у каждого объявленного --user-* токена есть потребитель в CSS/TS', () => {
    const tokensCss = fs.readFileSync(path.join(RENDERER_ROOT, 'styles', 'tokens.css'), 'utf8');
    const declared = declaredUserTokens(tokensCss);
    const dead = deadUserTokens(declared, rendererSources());
    assert.deepEqual(
      dead,
      [],
      `Объявленные, но не используемые пользовательские токены: ${dead.join(', ')}. ` +
        'Токен без потребителя не работает: аспект оформления объявлен, но вид ' +
        'не меняется (ошибка d6fae042 — так прошли --user-canvas-*). Добавь ' +
        'потребителя с фолбэком на тему или не объявляй токен.',
    );
  });

  it('сторож краснеет на токене без потребителя (мутация реального CSS)', () => {
    const tokensCss = fs.readFileSync(path.join(RENDERER_ROOT, 'styles', 'tokens.css'), 'utf8');
    const declared = declaredUserTokens(tokensCss);
    const sources = rendererSources();
    assert.ok(
      sources.some((file) => file.rel === 'styles/canvas.css'),
      'мутация адресует реальный styles/canvas.css',
    );

    // Негативная проба на РЕАЛЬНОМ файле: потребитель --user-canvas-dot снят.
    const canvas = sources.find((file) => file.rel === 'styles/canvas.css')!;
    const mutatedCanvas = canvas.content.replace(
      'var(--user-canvas-dot, var(--canvas-dot))',
      'var(--canvas-dot)',
    );
    assert.notEqual(mutatedCanvas, canvas.content, 'мутация «потребитель снят» не применилась');
    const mutated = sources.map((file) =>
      file.rel === 'styles/canvas.css' ? { rel: file.rel, content: mutatedCanvas } : file,
    );
    assert.deepEqual(
      deadUserTokens(declared, mutated),
      ['--user-canvas-dot'],
      'снятый потребитель обязан краснить ровно этот токен',
    );

    // Проба TS-потребителя: адресация по имени в коде считается.
    const withTsConsumer = [
      ...mutated,
      {
        rel: 'styles/__probe.ts',
        content: "document.documentElement.style.setProperty('--user-canvas-dot', 'red');",
      },
    ];
    assert.deepEqual(
      deadUserTokens(declared, withTsConsumer),
      [],
      'TS-потребитель закрывает токен',
    );
  });
});
