/**
 * Пример зелёного сторожа (задача 8d1f8b79, веха 1 версии 0.8.2).
 *
 * Демонстрирует инфраструктуру `guard-helpers.ts` на реальном, уже
 * соблюдаемом правиле: рендерер не импортирует `electron` напрямую —
 * доступ к главному процессу идёт только через preload-мост
 * (`client/src/preload/index.ts`, `contextBridge`). Импорт `electron`
 * в рендерере — архитектурная ошибка и дыра в модели изоляции;
 * `import type` допустим.
 *
 * Запреты вех 2–7 (`guard-thought-cloud`, `guard-entity-picker`,
 * `guard-value-editor`, `guard-filter-builder`) подключаются в этом же
 * каталоге и по этому же образцу.
 */

import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

describe('guard: рендерер не импортирует electron напрямую', () => {
  it('в client/src/renderer нет импортов из "electron"', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-direct-electron-in-renderer',
        description:
          'Рендерер работает через preload-мост (contextBridge): ' +
          'импорт "electron" в client/src/renderer запрещён, допустим только import type.',
        pattern: /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]electron['"]/,
        filePattern: /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]electron['"]/,
        allow: (_rel, line) => line.includes('import type'),
      },
    ]);
  });
});
