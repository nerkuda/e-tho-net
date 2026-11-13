/**
 * Сторож перечня сторонних компонентов (задача 35b9cc05, ADR 03eb2c61;
 * обобщение на вендоренные ассеты — задача 76a65602).
 *
 * ADR обязывает: THIRD-PARTY-NOTICES входит в дистрибутив, раздел сторонних
 * компонентов — в диалоге «О программе»; список не должен протухать. Каталог
 * `lib/third-party.ts` — единый источник и для диалога, и для генератора
 * `scripts/generate-notices.ts`. Сторож держит эту связку:
 *
 * 1. **Полнота каталога.** Каждая прямая производственная зависимость клиента
 *    (кроме собственных `@etn/*`) описана в каталоге — добавили пакет, не
 *    описали: тест красный. Это защита от протухания.
 * 2. **Корректность записей.** У записи непустые имя/лицензия/ссылка; запись —
 *    либо библиотека npm (непустой `packages`), либо вендоренный ассет
 *    (`asset: true` + `licenseFile` внутри `licenses/`), но не то и другое
 *    сразу; пакет не входит одновременно в две записи.
 * 3. **Связка с файлами лицензий ассетов.** Каждый файл из
 *    `src/renderer/public/licenses/` упомянут записью-ассетом, и каждая
 *    запись-ассет указывает на существующий файл: лицензия не едет в поставке
 *    без записи и запись не ссылается в пустоту.
 * 4. **Генератор.** `buildNotices()` включает записи-ассеты и полный текст их
 *    лицензий — иначе ассет есть в диалоге, но не в THIRD-PARTY-NOTICES.
 * 5. **Связка со сборкой.** В `client/package.json` есть скрипты `notices`
 *    (генератор) и `prepackage` (запуск перед упаковкой), а
 *    `electron-builder.yml` кладёт `THIRD-PARTY-NOTICES.txt` в поставку через
 *    `extraResources`.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  THIRD_PARTY_COMPONENTS,
  assetComponents,
  coveredPackageNames,
  type ThirdPartyComponent,
} from '../src/renderer/lib/third-party.js';
import { buildNotices } from '../scripts/generate-notices.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Каталог лицензий вендоренных ассетов в поставке (`public/` → asar). */
const LICENSES_DIR = path.join(CLIENT_ROOT, 'src', 'renderer', 'public', 'licenses');

/** Собственные пакеты монорепозитория — не сторонние. */
const OWN_SCOPE = '@etn/';

/** Прямые производственные зависимости клиента без собственных пакетов. */
function directDependencyNames(): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {}).filter((n) => !n.startsWith(OWN_SCOPE));
}

/** Файлы каталога лицензий (имена, отсортированы). */
function licenseFileNames(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Нарушения связи «записи-ассеты ↔ файлы лицензий» (правило раздела 3).
 * `dir` — каталог `public/licenses` (реальный или копия для мутаций).
 */
export function licenseLinkProblems(
  components: readonly ThirdPartyComponent[],
  dir: string,
): string[] {
  const problems: string[] = [];
  const mentioned = new Set<string>();
  for (const comp of components) {
    if (comp.asset !== true) continue;
    const rel = comp.licenseFile ?? '';
    if (rel === '') {
      problems.push(`ассет «${comp.title}»: не указан licenseFile`);
      continue;
    }
    if (path.posix.dirname(rel) !== 'licenses') {
      problems.push(`ассет «${comp.title}»: licenseFile «${rel}» вне каталога licenses/`);
      continue;
    }
    const name = path.posix.basename(rel);
    mentioned.add(name);
    if (!fs.existsSync(path.join(dir, name))) {
      problems.push(`ассет «${comp.title}»: файл лицензии ${rel} отсутствует в поставке`);
    }
  }
  for (const name of licenseFileNames(dir)) {
    if (!mentioned.has(name)) {
      problems.push(`файл лицензии ${name} не упомянут ни одной записью-ассетом`);
    }
  }
  return problems;
}

/** Временный каталог для мутаций — как у соседних сторожей: без гонок путей. */
function withTempDir<T>(prefix: string, run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

  it('записи каталога заполнены: библиотека npm или ассет, без дублей пакетов', () => {
    const seen = new Map<string, string>();
    for (const comp of THIRD_PARTY_COMPONENTS) {
      assert.ok(comp.title.trim() !== '', 'у записи каталога пустое имя');
      assert.ok(comp.license.trim() !== '', `у записи «${comp.title}» пустая лицензия`);
      assert.match(comp.url, /^https:\/\//, `у записи «${comp.title}» некорректная ссылка`);
      const packages = comp.packages ?? [];
      if (comp.asset === true) {
        assert.equal(
          packages.length,
          0,
          `запись-ассет «${comp.title}» не должна перечислять npm-пакеты`,
        );
        assert.match(
          comp.licenseFile ?? '',
          /^licenses\/[\w.-]+\.txt$/,
          `у записи-ассета «${comp.title}» некорректный путь к файлу лицензии`,
        );
      } else {
        assert.ok(
          packages.length > 0,
          `у записи «${comp.title}» нет пакетов и нет признака ассета (asset: true)`,
        );
        assert.equal(
          comp.licenseFile,
          undefined,
          `у библиотеки «${comp.title}» лишний licenseFile — он только у ассетов`,
        );
      }
      for (const name of packages) {
        const prev = seen.get(name);
        assert.equal(prev, undefined, `пакет ${name} описан дважды: «${prev}» и «${comp.title}»`);
        seen.set(name, comp.title);
      }
    }
  });

  it('файлы лицензий ассетов упомянуты, записи-ассеты ссылаются на существующие файлы', () => {
    const problems = licenseLinkProblems(THIRD_PARTY_COMPONENTS, LICENSES_DIR);
    assert.deepEqual(problems, [], `лицензии ассетов:\n${problems.join('\n')}`);

    // Обе вендоренные гарнитуры (задача e622824e) в каталоге, обе — OFL 1.1.
    for (const title of ['Inter', 'JetBrains Mono']) {
      const comp = THIRD_PARTY_COMPONENTS.find((c) => c.title === title);
      assert.ok(comp !== undefined, `в каталоге нет записи «${title}»`);
      assert.equal(comp.asset, true, `«${title}» должна быть записью-ассетом`);
      assert.equal(comp.license, 'OFL-1.1', `«${title}»: ожидалась лицензия OFL-1.1`);
    }

    withTempDir('etn-guard-third-party-', (dir) => {
      fs.cpSync(LICENSES_DIR, dir, { recursive: true });
      assert.deepEqual(
        licenseLinkProblems(THIRD_PARTY_COMPONENTS, dir),
        [],
        'копия реального каталога лицензий обязана быть чистой',
      );

      // Негативная проба на РЕАЛЬНЫХ файлах: в поставке появился файл лицензии
      // без записи (забыли описать ассет) — красный.
      fs.writeFileSync(path.join(dir, 'orphan-OFL-1.1.txt'), 'SIL OFL 1.1\n', 'utf8');
      const orphan = licenseLinkProblems(THIRD_PARTY_COMPONENTS, dir);
      assert.ok(
        orphan.some((p) => p.includes('orphan-OFL-1.1.txt')),
        `файл лицензии без записи обязан краснить: ${orphan.join(' | ') || 'нарушений нет'}`,
      );
      fs.rmSync(path.join(dir, 'orphan-OFL-1.1.txt'));

      // Негативная проба: у записи-ассета JetBrains Mono пропал файл лицензии.
      fs.rmSync(path.join(dir, 'jetbrains-mono-OFL-1.1.txt'));
      const missing = licenseLinkProblems(THIRD_PARTY_COMPONENTS, dir);
      assert.ok(
        missing.some((p) => p.includes('JetBrains Mono')),
        `запись-ассет без файла лицензии обязана краснить: ${missing.join(' | ') || 'нарушений нет'}`,
      );
    });

    // Негативная проба на реальном каталоге: из записей убрали Inter — его файл
    // остался в поставке сиротой.
    const withoutInter = THIRD_PARTY_COMPONENTS.filter((c) => c.title !== 'Inter');
    const orphaned = licenseLinkProblems(withoutInter, LICENSES_DIR);
    assert.ok(
      orphaned.some((p) => p.includes('inter-OFL-1.1.txt')),
      `файл лицензии без записи обязан краснить: ${orphaned.join(' | ') || 'нарушений нет'}`,
    );

    // Негативная проба: запись-ассет ссылается на несуществующий файл.
    const broken = THIRD_PARTY_COMPONENTS.map((c) =>
      c.title === 'Inter' ? { ...c, licenseFile: 'licenses/missing-OFL-1.1.txt' } : c,
    );
    const dangling = licenseLinkProblems(broken, LICENSES_DIR);
    assert.ok(
      dangling.some((p) => p.includes('missing-OFL-1.1.txt')),
      `ссылка записи на отсутствующий файл обязана краснить: ${dangling.join(' | ') || 'нарушений нет'}`,
    );
  });

  it('генератор notices включает вендоренные ассеты и полные тексты их лицензий', () => {
    const notices = buildNotices();
    const assets = assetComponents();
    assert.ok(
      notices.includes(`ВЕНДОРЕННЫЕ АССЕТЫ (${assets.length})`),
      'в THIRD-PARTY-NOTICES нет раздела вендоренных ассетов',
    );
    for (const asset of assets) {
      assert.ok(
        notices.includes(`${asset.title} — ${asset.license}`),
        `в notices нет записи ассета «${asset.title}»`,
      );
      const rel = asset.licenseFile ?? '';
      assert.ok(
        notices.includes(`Файл лицензии в поставке: ${rel}`),
        `в notices нет ссылки на файл лицензии «${asset.title}» (${rel})`,
      );
      const text = fs.readFileSync(
        path.join(CLIENT_ROOT, 'src', 'renderer', 'public', rel),
        'utf8',
      );
      assert.ok(
        notices.includes(text.trim()),
        `в notices нет полного текста лицензии «${asset.title}»`,
      );
    }
  });

  it('генерация notices подключена к сборке', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
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
