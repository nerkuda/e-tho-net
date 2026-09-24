/**
 * Сторож перечня сторонних компонентов (задача 35b9cc05, ADR 03eb2c61).
 *
 * ADR обязывает: THIRD-PARTY-NOTICES входит в дистрибутив, раздел сторонних
 * компонентов — в диалоге «О программе»; список не должен протухать. Каталог
 * `lib/third-party.ts` — единый источник и для диалога, и для генератора
 * `scripts/generate-notices.ts`. Сторож держит эту связку:
 *
 * 1. **Полнота каталога.** Каждая прямая производственная зависимость клиента
 *    (кроме собственных `@etn/*`) описана в каталоге — добавили пакет, не
 *    описали: тест красный. Это защита от протухания.
 * 2. **Корректность записей.** У записи непустые имя/лицензия/ссылка и хотя бы
 *    один пакет; пакет не входит одновременно в две записи.
 * 3. **Связка со сборкой.** В `client/package.json` есть скрипты `notices`
 *    (генератор) и `prepackage` (запуск перед упаковкой), а
 *    `electron-builder.yml` кладёт `THIRD-PARTY-NOTICES.txt` в поставку через
 *    `extraResources`.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { THIRD_PARTY_COMPONENTS, coveredPackageNames } from '../src/renderer/lib/third-party.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Собственные пакеты монорепозитория — не сторонние. */
const OWN_SCOPE = '@etn/';

/** Прямые производственные зависимости клиента без собственных пакетов. */
function directDependencyNames(): string[] {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  return Object.keys(pkg.dependencies ?? {}).filter((n) => !n.startsWith(OWN_SCOPE));
}

describe('guard: перечень сторонних компонентов (35b9cc05)', () => {
  it('каждая прямая зависимость клиента описана в lib/third-party.ts', () => {
    const covered = new Set(coveredPackageNames());
    const uncovered = directDependencyNames().filter((n) => !covered.has(n));
    assert.deepEqual(
      uncovered,
      [],
      `Зависимости без записи в каталоге THIRD_PARTY_COMPONENTS: ${uncovered.join(', ')}. ` +
        'Опиши библиотеку в lib/third-party.ts — иначе перечень протухает.',
    );
  });

  it('записи каталога заполнены и не дублируют пакеты', () => {
    const seen = new Map<string, string>();
    for (const comp of THIRD_PARTY_COMPONENTS) {
      assert.ok(comp.title.trim() !== '', 'у записи каталога пустое имя');
      assert.ok(comp.license.trim() !== '', `у записи «${comp.title}» пустая лицензия`);
      assert.match(comp.url, /^https:\/\//, `у записи «${comp.title}» некорректная ссылка`);
      assert.ok(comp.packages.length > 0, `у записи «${comp.title}» нет пакетов`);
      for (const name of comp.packages) {
        const prev = seen.get(name);
        assert.equal(prev, undefined, `пакет ${name} описан дважды: «${prev}» и «${comp.title}»`);
        seen.set(name, comp.title);
      }
    }
  });

  it('генерация notices подключена к сборке', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    assert.match(
      pkg.scripts?.notices ?? '',
      /generate-notices/,
      'в client/package.json нет скрипта `notices` с генератором',
    );
    assert.match(
      pkg.scripts?.prepackage ?? '',
      /notices/,
      'скрипт `prepackage` не запускает генерацию notices перед упаковкой',
    );

    const builder = fs.readFileSync(path.join(CLIENT_ROOT, 'electron-builder.yml'), 'utf8');
    assert.match(
      builder,
      /THIRD-PARTY-NOTICES\.txt/,
      'electron-builder.yml не кладёт THIRD-PARTY-NOTICES.txt в поставку (extraResources)',
    );
  });
});
