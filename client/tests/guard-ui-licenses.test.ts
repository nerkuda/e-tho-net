/**
 * Сторож лицензий сторонних UI-библиотек (задача 95dd50b9, версия 0.9.1).
 *
 * ADR «Основа lib/ui: готовые Web Components за фасадами» разрешает только
 * свободные пакеты:
 *   • Web Awesome — исключительно Core (`@awesome.me/webawesome`, MIT);
 *     Pro-пакеты запрещены;
 *   • Vaadin — только отдельные пакеты `@vaadin/*` (Apache-2.0);
 *     `@vaadin/bundles` запрещён (CVDL, dual-license).
 *
 * Правило защищено двумя проверками: (1) в `client/package.json` нет
 * запрещённых зависимостей; (2) исходники рендерера их не импортируют.
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Запрещённый пакет по имени (точное или по префиксу подпути/семейства). */
function isForbiddenPackage(name: string): boolean {
  return (
    name === '@vaadin/bundles' ||
    name === '@awesome.me/webawesome-pro' ||
    name.startsWith('@awesome.me/webawesome-pro/') ||
    name.startsWith('@awesome.me/webawesome-pro-')
  );
}

const FORBIDDEN_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]@(?:vaadin\/bundles|awesome\.me\/webawesome-pro)['"/]/;

describe('guard: лицензии сторонних UI-библиотек', () => {
  it('в зависимостях клиента нет @vaadin/bundles и Pro-пакетов Web Awesome', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    const bad = names.filter(isForbiddenPackage);
    if (bad.length > 0) {
      throw new Error(
        `Запрещённые зависимости в client/package.json (${bad.length}):\n` +
          `${bad.map((n) => `  • ${n}`).join('\n')}\n\n` +
          'Разрешены только Web Awesome Core (MIT) и отдельные @vaadin/* ' +
          '(Apache-2.0). @vaadin/bundles и Pro-компоненты Web Awesome запрещены ' +
          'ADR «Основа lib/ui: готовые Web Components за фасадами».',
      );
    }
  });

  it('рендерер не импортирует запрещённые пакеты', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-forbidden-ui-licenses',
        description:
          'Импорт @vaadin/bundles (CVDL) и Pro-пакетов Web Awesome запрещён ' +
          '(ADR «Основа lib/ui: готовые Web Components за фасадами») — только ' +
          'Core Web Awesome и отдельные @vaadin/*.',
        pattern: FORBIDDEN_IMPORT,
        filePattern: FORBIDDEN_IMPORT,
      },
    ]);
  });
});
