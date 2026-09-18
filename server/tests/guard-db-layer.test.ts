/**
 * Пример зелёного сторожа (задача 8d1f8b79, веха 1 версии 0.8.2).
 *
 * Демонстрирует инфраструктуру `guard-helpers.ts` на реальном, уже
 * соблюдаемом правиле: драйвер БД `better-sqlite3` импортируется только
 * слоем доступа к данным `server/src/db`; домен и фасады (routes, mcp)
 * ходят через этот слой. Значение-импорт драйвера вне `src/db` запрещён,
 * `import type` допустим где угодно.
 *
 * Запрет SQL в фасадах (`guard-server-layers`) подключается задачей вехи 7
 * в этом же каталоге и по этому же образцу.
 */

import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const SERVER_SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
);

describe('guard: better-sqlite3 только в слое db', () => {
  it('вне server/src/db нет значений-импортов better-sqlite3', () => {
    assertGuardClean(SERVER_SRC_ROOT, [
      {
        name: 'better-sqlite3-only-in-db-layer',
        description:
          'Драйвер better-sqlite3 импортируется только из server/src/db; ' +
          'домен и фасады работают через слой db.',
        pattern: /(?:from\s+|require\s*\(\s*)['"]better-sqlite3['"]/,
        filePattern: /(?:from\s+|require\s*\(\s*)['"]better-sqlite3['"]/,
        allow: (rel, line) =>
          rel === 'db' || rel.startsWith('db/') || line.includes('import type'),
      },
    ]);
  });
});
