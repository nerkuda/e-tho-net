/**
 * Generates `shared/src/icon-catalog.ts` — the single catalogue of Lucide
 * icon names allowed for the `icon_kind='icon'` icon view (ADR 2b655b29,
 * требование ead91183, задача 610a440e).
 *
 * The catalogue is the ONE source of allowed names: the server validates the
 * `icon` field against it, and the client (the library tab of the icon picker)
 * offers exactly these names. The rendering façade
 * `client/src/renderer/lib/ui/icon.ts` derives its own runtime catalogue from
 * the same `lucide` package; `client/tests/guard-icon-catalog.test.ts` keeps
 * the two in sync.
 *
 * Besides the canonical names the script emits the alias map
 * `ICON_LIBRARY_ALIASES` (alias kebab-name → canonical kebab-name, ошибка
 * 08b90470): the client icon-picker search matches aliases too and returns the
 * canonical name (the only name the server accepts and the DB stores).
 *
 * Usage (after `npm install`, any cwd):
 *   node shared/scripts/gen-icon-catalog.mjs
 *
 * The generated file is committed; re-run after a `lucide` version bump.
 * Names are kebab-case, aliases (several exports sharing one geometry) are
 * deduplicated to a single canonical kebab-name — the SAME rule the façade's
 * `buildIconCatalog` uses, so the sets are equal by construction.
 *
 * `lucide` is a dependency of the client workspace, hoisted to the repo-root
 * `node_modules`; Node's resolution from this script finds it there.
 */

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.resolve(here, '..', 'src', 'icon-catalog.ts');

/** PascalCase export name → kebab-case catalogue name (`CalendarDays`). */
function iconNameFromExport(exportName) {
  return exportName
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])([0-9])/g, '$1-$2')
    .toLowerCase();
}

/** Resolve the `lucide` package entry point (root-hoisted node_modules). */
const lucideEntry = require.resolve('lucide/package.json');
const lucidePkg = require(lucideEntry);
const lucideEsm = path.join(path.dirname(lucideEntry), 'dist', 'esm', 'lucide.mjs');

const { icons } = await import(pathToFileURL(lucideEsm).href);

/** One canonical name per unique geometry (node reference), first export wins. */
const byNode = new Map();
for (const [exportName, node] of Object.entries(icons)) {
  if (!byNode.has(node)) byNode.set(node, iconNameFromExport(exportName));
}
const names = [...byNode.values()].sort((a, b) => a.localeCompare(b));

/**
 * Alias map: kebab-name of a non-canonical export → kebab-name of the
 * canonical export of the same geometry. Aliases colliding with a real
 * canonical name are dropped (canonical wins), duplicates keep the first.
 */
const canonicalNames = new Set(names);
const aliasByName = new Map();
for (const [exportName, node] of Object.entries(icons)) {
  const canonicalExport = byNode.get(node);
  if (canonicalExport === exportName) continue;
  const aliasKebab = iconNameFromExport(exportName);
  const canonicalKebab = iconNameFromExport(canonicalExport);
  if (aliasKebab === canonicalKebab || canonicalNames.has(aliasKebab)) continue;
  if (!aliasByName.has(aliasKebab)) aliasByName.set(aliasKebab, canonicalKebab);
}
const aliases = [...aliasByName.entries()].sort((a, b) => a[0].localeCompare(b[0]));

if (names.length < 100) {
  throw new Error(`lucide catalogue looks empty: ${names.length} names`);
}
if (aliases.length === 0) {
  throw new Error('lucide alias map looks empty');
}

const body = names.map((name) => `  '${name}',`).join('\n');
const aliasBody = aliases.map(([alias, canonical]) => `  '${alias}': '${canonical}',`).join('\n');

const content = `/**
 * Каталог имён иконок Lucide, допустимых для вида иконки мысли
 * "icon_kind='icon'" (ADR 2b655b29, требование ead91183, задача 610a440e).
 *
 * ЕДИНЫЙ источник допустимых имён: сервер валидирует поле "icon" по нему,
 * клиент (вкладка «Библиотека» диалога выбора иконки) предлагает ровно эти
 * имена. Файл СГЕНЕРИРОВАН скриптом shared/scripts/gen-icon-catalog.mjs
 * из пакета lucide ${lucidePkg.version} (${names.length} имён) — правки
 * вручную затрутся при перегенерации.
 *
 * Имена — kebab-case, псевдонимы (несколько экспортов одной геометрии)
 * сведены к одному каноническому имени — то же правило, что у фасада
 * client/src/renderer/lib/ui/icon.ts (buildIconCatalog); синхронность
 * сторон стережёт client/tests/guard-icon-catalog.test.ts.
 *
 * Рядом с каноническими именами собран карта псевдонимов
 * ICON_LIBRARY_ALIASES (псевдоним → каноническое имя, ошибка 08b90470):
 * поиск во вкладке «Библиотека» находит значок и по псевдониму, а отдаёт
 * каноническое имя — единственное, что принимает сервер и хранит БД.
 *
 * Перегенерировать после обновления lucide:
 *   node shared/scripts/gen-icon-catalog.mjs
 */

/** Допустимые имена иконок каталога Lucide (kebab-case, отсортированы). */
export const ICON_LIBRARY_NAMES: readonly string[] = [
${body}
];

const ICON_LIBRARY_NAME_SET: ReadonlySet<string> = new Set(ICON_LIBRARY_NAMES);

/** Является ли строка именем иконки каталога Lucide (kebab-case). */
export function isIconLibraryName(value: string): boolean {
  return ICON_LIBRARY_NAME_SET.has(value);
}

/**
 * Псевдонимы kebab-имён Lucide: псевдоним → каноническое kebab-имя той же
 * геометрии (ошибка 08b90470). Псевдонимы, совпавшие с каноническим именем,
 * опущены — каноническое имя приоритетнее.
 */
export const ICON_LIBRARY_ALIASES: Readonly<Record<string, string>> = {
${aliasBody}
};

/**
 * Каноническое kebab-имя значка по каноническому имени ИЛИ псевдониму;
 * null — строки нет среди имён и псевдонимов Lucide. Псевдонимы нужны для
 * ПОИСКА; хранить и валидировать следует только канонические имена.
 */
export function canonicalIconLibraryName(value: string): string | null {
  if (ICON_LIBRARY_NAME_SET.has(value)) return value;
  if (!Object.prototype.hasOwnProperty.call(ICON_LIBRARY_ALIASES, value)) return null;
  return ICON_LIBRARY_ALIASES[value] ?? null;
}
`;

writeFileSync(outFile, content, 'utf8');
console.log(`icon-catalog: ${names.length} names from lucide ${lucidePkg.version} -> ${outFile}`);
