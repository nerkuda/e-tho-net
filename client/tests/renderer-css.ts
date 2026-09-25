/**
 * Доступ тестов к исходному CSS рендерера (задача de23c709).
 *
 * `client/src/renderer/styles.css` — манифест: он не содержит правил, только
 * `@import` модулей `client/src/renderer/styles/**`. Тесты, которые проверяют
 * правила стилей (шкалы токенов, вид компонентов, каскад), должны видеть тот
 * же CSS, что и прежний единый файл — то есть все модули в порядке импорта.
 *
 * Два способа:
 *   • {@link readRendererCss} — текст собранного CSS (когда тест читает
 *     содержимое и работает с ним);
 *   • {@link assembledStylesFile} — путь к временному файлу с тем же текстом
 *     (когда тест читает CSS по пути через `readFileSync`/`readText`).
 *
 * Сборка намеренно повторяет логику Vite: модули встраиваются в позицию
 * манифеста в порядке `@import` — это и есть контракт каскада (грабли
 * 36889dd6). Целостность манифеста сторожит `guard-styles-modules.test.ts`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень рендерера (`client/src/renderer`). */
export const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/** Пути `@import` из манифеста в порядке появления (без ведущего `./`). */
function manifestImports(manifest: string): string[] {
  const out: string[] = [];
  const re = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*\)?\s*;/g;
  for (const m of manifest.matchAll(re)) {
    if (m[1]) out.push(m[1].replace(/^\.\/+/, ''));
  }
  return out;
}

/**
 * CSS всех модулей манифеста в порядке `@import` — то же содержимое, что
 * прежний единый `styles.css` (манифест правил не содержит и в результат не
 * входит).
 */
export function readRendererCss(rendererRoot: string = RENDERER_ROOT): string {
  const manifest = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8');
  return manifestImports(manifest)
    .map((rel) => fs.readFileSync(path.resolve(rendererRoot, rel), 'utf8'))
    .join('\n');
}

/**
 * Путь к временному файлу с {@link readRendererCss}. Нужен тестам, читающим
 * CSS по пути (`readFileSync(path, 'utf8')`); содержимое идентично модулям в
 * порядке импорта.
 */
export function assembledStylesFile(): string {
  const out = path.join(os.tmpdir(), 'etn-renderer-assembled-styles.css');
  fs.writeFileSync(out, readRendererCss(), 'utf8');
  return out;
}
