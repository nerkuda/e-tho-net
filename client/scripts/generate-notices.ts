/**
 * Генератор `THIRD-PARTY-NOTICES.txt` для дистрибутива клиента (задача
 * 35b9cc05, ADR 03eb2c61).
 *
 * Источники:
 *  • каталог сторонних компонентов `src/renderer/lib/third-party.ts` (единый с
 *    диалогом «О программе» источник — перечень семейств и ключевые лицензии),
 *    включая вендоренные ассеты: у записи-ассета `licenseFile` указывает на
 *    текст лицензии в `src/renderer/public/`, и он попадает в файл целиком;
 *  • фактические зависимости клиента из `package.json` и установленные пакеты
 *    в `node_modules` — перечень строится обходом дерева ПРОИЗВОДСТВЕННЫХ
 *    зависимостей (прямые + транзитивные), а не ручным списком, поэтому он не
 *    протухает при обновлении пакетов.
 *
 * Выход: `build/THIRD-PARTY-NOTICES.txt` — каталог `build/` объявлен
 * `directories.buildResources` в `electron-builder.yml`, а сам файл кладётся в
 * поставку через `extraResources` (рядом с программой).
 *
 * Запуск: `npm -w @etn/client run notices` (скрипт `prepackage` вызывает его
 * автоматически перед упаковкой).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLUE_TOPAZ_ATTRIBUTION,
  assetComponents,
  coveredPackageNames,
  themeComponents,
  type ThirdPartyComponent,
} from '../src/renderer/lib/third-party.js';
import { ru } from '../src/renderer/lib/locales/ru.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(here, '..');
const REPO_ROOT = path.resolve(CLIENT_ROOT, '..');

/** Собственные пакеты монорепозитория — не сторонние. */
const OWN_SCOPE = '@etn/';

/** Корень ассетов поставки рендерера: `public/` попадает в asar как есть. */
const PUBLIC_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer', 'public');

interface PackageRecord {
  name: string;
  version: string;
  license: string;
  copyright: string;
  url: string;
  dir: string;
}

/** Каталог установленного пакета: поднимаемся вверх по дереву `node_modules`. */
function resolvePackageDir(fromDir: string, name: string): string | null {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Текст правообладателя из полей `author`/`contributors` манифеста. */
function authorText(pkg: { author?: unknown; contributors?: unknown }): string {
  const one = (value: unknown): string | null => {
    if (typeof value === 'string') return value;
    if (value !== null && typeof value === 'object') {
      const rec = value as { name?: unknown; email?: unknown };
      if (typeof rec.name === 'string') {
        return typeof rec.email === 'string' ? `${rec.name} <${rec.email}>` : rec.name;
      }
    }
    return null;
  };
  const direct = one(pkg.author);
  if (direct !== null) return direct;
  if (Array.isArray(pkg.contributors)) {
    for (const c of pkg.contributors) {
      const text = one(c);
      if (text !== null) return text;
    }
  }
  return '';
}

/** Ссылка на домашнюю страницу/репозиторий манифеста. */
function urlText(pkg: { homepage?: unknown; repository?: unknown }): string {
  if (typeof pkg.homepage === 'string' && pkg.homepage !== '') return pkg.homepage;
  const repo = pkg.repository;
  if (typeof repo === 'string') return repo;
  if (repo !== null && typeof repo === 'object') {
    const url = (repo as { url?: unknown }).url;
    if (typeof url === 'string') {
      return url.replace(/^git\+/, '').replace(/\.git$/, '');
    }
  }
  return '';
}

/** Нормализует поле `license` манифеста в идентификатор. */
function licenseText(pkg: { license?: unknown; licenses?: unknown }): string {
  if (typeof pkg.license === 'string' && pkg.license !== '') return pkg.license;
  if (pkg.license !== null && typeof pkg.license === 'object') {
    const type = (pkg.license as { type?: unknown }).type;
    if (typeof type === 'string') return type;
  }
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses
      .map((l) => (l !== null && typeof l === 'object' ? (l as { type?: unknown }).type : null))
      .filter((t): t is string => typeof t === 'string');
    if (types.length > 0) return types.join(' OR ');
  }
  return '';
}

/** Прямые производственные зависимости клиента (без собственных пакетов). */
function directDependencyNames(): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {}).filter((n) => !n.startsWith(OWN_SCOPE));
}

/** Обход дерева производственных зависимостей: прямые + транзитивные. */
function collectPackages(): PackageRecord[] {
  const byName = new Map<string, PackageRecord>();
  const queue: Array<{ name: string; from: string }> = directDependencyNames().map((name) => ({
    name,
    from: CLIENT_ROOT,
  }));

  while (queue.length > 0) {
    const { name, from } = queue.shift()!;
    if (name.startsWith(OWN_SCOPE) || byName.has(name)) continue;
    const dir = resolvePackageDir(from, name);
    if (dir === null) {
      process.stderr.write(`[notices] не найден установленный пакет ${name}\n`);
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      license?: unknown;
      licenses?: unknown;
      author?: unknown;
      contributors?: unknown;
      homepage?: unknown;
      repository?: unknown;
    };
    byName.set(name, {
      name,
      version: typeof manifest.version === 'string' ? manifest.version : '—',
      license: licenseText(manifest) || '—',
      copyright: authorText(manifest),
      url: urlText(manifest),
      dir,
    });
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      queue.push({ name: dep, from: dir });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Находит текст файла лицензии пакета (LICENSE/LICENSE.txt/…). */
function readLicenseFile(dir: string): string | null {
  const names = fs.readdirSync(dir).filter((n) => /^licen[cs]e/i.test(n));
  for (const name of names) {
    const abs = path.join(dir, name);
    if (!fs.statSync(abs).isFile()) continue;
    const text = fs.readFileSync(abs, 'utf8').trim();
    if (text !== '') return text;
  }
  return null;
}

/** Известные свободные лицензии, полный текст которых кладём в файл. */
const KNOWN_LICENSE =
  /^(?:MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|CC0-1\.0|Unlicense|Python-2\.0)\b/;

/** Полный текст лицензии вендоренного ассета из поставки (`public/<licenseFile>`). */
function assetLicenseText(component: ThirdPartyComponent): string {
  const rel = component.licenseFile ?? '';
  if (rel === '') {
    throw new Error(`[notices] у ассета «${component.title}» не указан licenseFile`);
  }
  const abs = path.join(PUBLIC_ROOT, rel);
  if (!fs.existsSync(abs)) {
    throw new Error(`[notices] лицензия ассета «${component.title}» не найдена в поставке: ${rel}`);
  }
  return fs.readFileSync(abs, 'utf8').trim();
}

/** Полные тексты лицензий: по одному представителю на каждый идентификатор. */
function keyLicenseTexts(packages: PackageRecord[]): Array<{ id: string; text: string }> {
  const ids = [...new Set(packages.map((p) => p.license))]
    .filter((id) => KNOWN_LICENSE.test(id))
    .sort();
  const result: Array<{ id: string; text: string }> = [];
  for (const id of ids) {
    const representative = packages.find(
      (p) => p.license === id && readLicenseFile(p.dir) !== null,
    );
    if (representative === undefined) continue;
    result.push({ id, text: readLicenseFile(representative.dir)! });
  }
  return result;
}

export function buildNotices(): string {
  const clientPkg = JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8')) as {
    version?: string;
  };
  const packages = collectPackages();

  // Список не должен протухать: каждая прямая зависимость обязана быть
  // описана в общем каталоге `lib/third-party.ts`.
  const covered = new Set(coveredPackageNames());
  const uncovered = directDependencyNames().filter((n) => !covered.has(n));
  if (uncovered.length > 0) {
    throw new Error(
      `Прямые зависимости клиента не описаны в lib/third-party.ts:\n` +
        `${uncovered.map((n) => `  • ${n}`).join('\n')}\n` +
        'Добавь библиотеку в THIRD_PARTY_COMPONENTS, затем повтори генерацию.',
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  const out: string[] = [];
  out.push('THIRD-PARTY SOFTWARE NOTICES');
  out.push('ETN — The Endless Thought Network');
  out.push(`Версия клиента: ${clientPkg.version ?? '—'}`);
  out.push(`Дата формирования: ${date}`);
  out.push('');
  out.push(
    'Файл сгенерирован автоматически (client/scripts/generate-notices.ts) и ' +
      'входит в дистрибутив. В нём перечислены сторонние библиотеки, ' +
      'используемые клиентом, с указанием лицензий и правообладателей.',
  );
  out.push('');
  out.push('='.repeat(72));
  out.push(`ПЕРЕЧЕНЬ СТОРОННИХ КОМПОНЕНТОВ (${packages.length})`);
  out.push('='.repeat(72));
  out.push('');
  for (const p of packages) {
    out.push(`${p.name} ${p.version}`);
    out.push(`  Лицензия: ${p.license}`);
    if (p.copyright !== '') out.push(`  Copyright: ${p.copyright}`);
    if (p.url !== '') out.push(`  Ссылка: ${p.url}`);
    out.push('');
  }

  const allAssets = assetComponents();
  // Темы оформления перечислены отдельным разделом ниже (задача 3cac16cc):
  // в счётчике и в списке вендоренных ассетов их нет — иначе число в
  // заголовке не сходится с числом строк под ним (замечание проверки).
  const assets = allAssets.filter((asset) => asset.theme === undefined);
  if (assets.length > 0) {
    out.push('='.repeat(72));
    out.push(`ВЕНДОРЕННЫЕ АССЕТЫ (${assets.length})`);
    out.push('='.repeat(72));
    out.push('');
    for (const asset of assets) {
      out.push(asset.title);
      out.push(`  Лицензия: ${asset.license}`);
      if (asset.copyright !== '') out.push(`  Copyright: ${asset.copyright}`);
      out.push(`  Ссылка: ${asset.url}`);
      out.push(`  Файл лицензии в поставке: ${asset.licenseFile ?? '—'}`);
      out.push('');
    }
  }

  const themes = themeComponents();
  if (themes.length > 0) {
    // Темы оформления (задача 3cac16cc): названия описательные, ETN не связан с
    // авторами; тексты лицензий — ниже, в разделе полных текстов ассетов.
    out.push('='.repeat(72));
    out.push(`ТЕМЫ ОФОРМЛЕНИЯ (${themes.length})`);
    out.push('='.repeat(72));
    out.push('');
    // Дисклеймер — тот же текст, что в диалоге «О программе»: берём из словаря
    // `ru` (задача 3cac16cc), второй копии строки не заводим.
    out.push(ru['about.themesDisclaimer']);
    out.push('');
    for (const theme of themes) {
      const name =
        theme.unofficial === true ? `${theme.title} (${ru['about.themeUnofficial']})` : theme.title;
      out.push(name);
      out.push(`  Лицензия: ${theme.license}`);
      if (theme.copyright !== '') out.push(`  Copyright: ${theme.copyright}`);
      out.push(`  Ссылка: ${theme.url}`);
      out.push(`  Файл лицензии в поставке: ${theme.licenseFile ?? '—'}`);
      out.push('');
    }
    // Фраза автора Blue Topaz — дословно, как требует лицензия темы.
    out.push(BLUE_TOPAZ_ATTRIBUTION);
    out.push('');
  }

  const keyLicenses = keyLicenseTexts(packages);
  if (keyLicenses.length > 0) {
    out.push('='.repeat(72));
    out.push('ПОЛНЫЕ ТЕКСТЫ ЛИЦЕНЗИЙ');
    out.push('='.repeat(72));
    out.push('');
    for (const { id, text } of keyLicenses) {
      out.push('-'.repeat(72));
      out.push(id);
      out.push('-'.repeat(72));
      out.push('');
      out.push(text);
      out.push('');
    }
  }

  if (allAssets.length > 0) {
    out.push('='.repeat(72));
    out.push('ПОЛНЫЕ ТЕКСТЫ ЛИЦЕНЗИЙ ВЕНДОРЕННЫХ АССЕТОВ');
    out.push('='.repeat(72));
    out.push('');
    for (const asset of allAssets) {
      out.push('-'.repeat(72));
      out.push(`${asset.title} — ${asset.license}`);
      out.push('-'.repeat(72));
      out.push('');
      out.push(assetLicenseText(asset));
      out.push('');
    }
  }

  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * Запись файла — только при прямом запуске скрипта (`npm -w @etn/client run
 * notices`). Модуль экспортирует `buildNotices` для сторожа
 * `guard-third-party-notices.test.ts`: импорт из теста ничего не пишет.
 */
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const target = path.join(CLIENT_ROOT, 'build', 'THIRD-PARTY-NOTICES.txt');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buildNotices(), 'utf8');
  process.stdout.write(`[notices] записан ${path.relative(REPO_ROOT, target)}\n`);
}
