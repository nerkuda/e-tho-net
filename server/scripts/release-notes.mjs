#!/usr/bin/env node
/**
 * Сборка тела и заголовка GitHub-релиза из `CHANGELOG.md`.
 *
 * Шаг процедуры «Публикация релиза на GitHub» (мыслесеть ETN, инструкция
 * 04f08f92): тело релиза не должно оставаться пустым, а `generate_release_notes`
 * без pull request'ов вырождается в одну строку «Full Changelog». Потому
 * workflow job `publish` вызывает этот скрипт и передаёт результат
 * в `body_path` и `name` экшена `softprops/action-gh-release`.
 *
 * ## Заголовок
 *
 * Заголовок всегда `ETN X.Y.Z — <тема>` (ошибка 9d0c2d5e). Источники темы,
 * по убыванию:
 *
 *   1. subject АННОТИРОВАННОГО тега (`git tag -a … -m "ETN X.Y.Z — <тема>"`);
 *   2. первый абзац секции версии в `CHANGELOG.md` — его часть до первого
 *      двоеточия, тире или конца предложения (лид «о чём версия»);
 *   3. явный `--title` (в workflow — вход `title` ручного запуска).
 *
 * Subject lightweight-тега не читается никогда: у такого тега
 * `%(contents:subject)` — это subject КОММИТА, на который тег указывает, и
 * заголовок релиза превращался в `fix(ci): …` (так вышло на v0.15.2: тег
 * создал `softprops/action-gh-release` при prerelease). Объектный тип тега
 * проверяется через `%(objecttype)`: `tag` — аннотация, `commit` — lightweight.
 *
 * Префикс «ETN X.Y.Z» из источника снимается и ставится заново из версии
 * релиза: дубля «ETN … ETN …» не бывает, номер в заголовке всегда совпадает
 * с версией.
 *
 * ## Тело
 *
 * Из `CHANGELOG.md` вырезается содержимое секции `## [X.Y.Z] — …` (без строки
 * заголовка) до следующей секции `## [`; секции нет — ошибка с ненулевым кодом.
 * К вырезанному тексту добавляется футер: что скачать под каждую ОС и — если
 * передан `--prev-tag` — markdown-ссылка на сравнение версий. Эмодзи в текстах
 * релиза не используются (решение пользователя 2026-10-06).
 *
 * Запуск (из корня репозитория):
 *
 *   node server/scripts/release-notes.mjs --version 0.11.1 --prev-tag v0.10.3
 *       # в release-body.md: секция 0.11.1 + футер с ассетами и compare-ссылкой
 *   node server/scripts/release-notes.mjs --version 0.15.3 --tag v0.15.3 \
 *       --out release-body.md --title-out release-title.txt
 *       # тело и заголовок (ETN 0.15.3 — <тема>) для workflow
 *   node server/scripts/release-notes.mjs
 *       # версия — из корневого package.json, без compare-ссылки
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHANGELOG_PATH = path.join(REPO_ROOT, 'CHANGELOG.md');
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');

/** Репозиторий по умолчанию, если не задан `--repo` и нет env GITHUB_REPOSITORY. */
const DEFAULT_REPO = 'nerkuda/e-tho-net';

/** Экранирование спецсимволов регулярного выражения. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Разбор аргументов: `--version`, `--prev-tag`, `--out`, `--repo`, `--tag`,
 * `--title`, `--title-out`, `--changelog`.
 */
function parseArgs(argv) {
  const options = {
    version: null,
    prevTag: null,
    out: null,
    repo: null,
    tag: null,
    title: null,
    titleOut: null,
    changelog: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') {
      options.version = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--prev-tag') {
      options.prevTag = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--out') {
      options.out = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--repo') {
      options.repo = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--tag') {
      options.tag = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--title') {
      options.title = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--title-out') {
      options.titleOut = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--changelog') {
      options.changelog = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Использование: node server/scripts/release-notes.mjs ' +
          '[--version X.Y.Z] [--prev-tag vX.Y.W] [--out <file>] [--repo owner/name] ' +
          '[--tag <tag>] [--title <тема>] [--title-out <file>] [--changelog <file>]',
      );
      process.exit(0);
    } else {
      console.error(`Неизвестный аргумент: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

/** Версия: из `--version`, иначе — из корневого package.json. */
function resolveVersion(explicitVersion) {
  if (typeof explicitVersion === 'string' && explicitVersion !== '') return explicitVersion;
  const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('Не удалось определить версию релиза: передай --version X.Y.Z');
  }
  return pkg.version;
}

/** Репозиторий: из `--repo`, иначе env GITHUB_REPOSITORY, иначе значение по умолчанию. */
function resolveRepo(explicitRepo) {
  if (typeof explicitRepo === 'string' && explicitRepo !== '') return explicitRepo;
  const fromEnv = process.env.GITHUB_REPOSITORY;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  return DEFAULT_REPO;
}

/**
 * Содержимое секции `## [version] — …` из CHANGELOG без строки заголовка и без
 * завершающих пустых строк. Секция кончается на следующем заголовке `## [`.
 * Разделитель в заголовке любой (`—`, `-`, `–`): regexp смотрит только на
 * `## [version]`.
 */
function extractChangelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = new RegExp(`^##\\s*\\[${escapeRegExp(version)}\\]`);
  const nextHeading = /^##\s*\[/;
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    throw new Error(`Секция версии ${version} не найдена в CHANGELOG.md`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (nextHeading.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
  while (body.length > 0 && body[0].trim() === '') body.shift();
  return body.join('\n');
}

/**
 * Первый абзац секции — лид «о чём версия». `null`, если секция начинается
 * с подзаголовка (`### Добавлено`): лида нет, тему берут из другого источника.
 */
function leadOf(section) {
  const lines = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      if (lines.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed)) break;
    lines.push(trimmed);
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Тема из лида: часть до первого двоеточия, точки с запятой, тире или конца
 * предложения. Хвостовая скобка-пояснение (`(\`1d48df6d\`)`) отбрасывается:
 * в заголовке релиза идентификатор мысли лишний.
 */
function themeFromLead(lead) {
  if (!lead) return null;
  const cut = lead.search(/[:;]|\s[—–]\s|\.\s/u);
  let theme = cut >= 0 ? lead.slice(0, cut) : lead;
  theme = theme.replace(/\s*\([^()]*\)\s*$/u, '');
  theme = theme.replace(/[.,;:—–\-\s]+$/u, '').replace(/^\*+|\*+$/g, '').trim();
  if (theme === '') return null;
  return theme.charAt(0).toUpperCase() + theme.slice(1);
}

/** Вывод git в текущем каталоге; пустая строка — команда не отработала. */
function gitOutput(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/**
 * Subject аннотированного тега; `null` — тега нет или он lightweight.
 *
 * Для lightweight-тега `%(contents:subject)` — subject коммита, а не тема
 * релиза (ошибка 9d0c2d5e), поэтому такой тег здесь принципиально не читается:
 * `%(objecttype)` у аннотированного тега — `tag`, у lightweight — `commit`.
 */
function annotatedTagSubject(tag) {
  if (typeof tag !== 'string' || tag === '') return null;
  const objectType = gitOutput(['for-each-ref', '--format=%(objecttype)', `refs/tags/${tag}`]);
  if (objectType !== 'tag') return null;
  return gitOutput(['for-each-ref', '--format=%(contents:subject)', `refs/tags/${tag}`]) || null;
}

/**
 * Тема из готовой строки: снимает префикс «ETN X.Y.Z», «Release vX.Y.Z» или
 * «vX.Y.Z» вместе с разделителем, чтобы не собрать «ETN … — ETN …».
 * `null` — темы в строке нет (остался один префикс).
 */
function themeOf(text) {
  if (typeof text !== 'string') return null;
  const stripped = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^ETN\s+v?\d+\.\d+\.\d+\s*(?:[—–:-]\s*)?/iu, '')
    .replace(/^Release\s+v?\d+\.\d+\.\d+\s*(?:[—–:-]\s*)?/iu, '')
    .replace(/^v?\d+\.\d+\.\d+\s*(?:[—–:-]\s*)?/u, '')
    .replace(/[.,;:—–\-\s]+$/u, '')
    .trim();
  return stripped === '' ? null : stripped;
}

/**
 * Заголовок релиза `ETN X.Y.Z — <тема>`. Источники перебираются по порядку:
 * аннотированный тег → лид changelog → явный `--title`. Ни один не дал темы —
 * ошибка: заголовок без темы (голый `ETN X.Y.Z`) не соответствует контракту.
 */
function buildReleaseTitle({ version, tagSubject, leadTheme, explicitTitle }) {
  for (const source of [tagSubject, leadTheme, explicitTitle]) {
    const theme = themeOf(source);
    if (theme) return `ETN ${version} — ${theme}`;
  }
  throw new Error(
    `Не удалось сформировать заголовок релиза ${version}: нет темы ни в аннотации ` +
      'тега, ни в лиде секции CHANGELOG.md, ни в --title. Заголовок обязан иметь ' +
      'вид «ETN X.Y.Z — <тема>»: добавь лид-абзац в секцию версии changelog или ' +
      'создай аннотированный тег.',
  );
}

/** Футер тела релиза: ассеты по платформам и compare-ссылка. */
function buildFooter(version, prevTag, repo) {
  const lines = [
    '## Скачать',
    '',
    `- Windows: \`ETN-Setup-${version}.exe\` — установщик сервера и клиента`,
    `- Linux-клиент: \`ETN-Client-${version}-linux-x64.tar.gz\` — установка и обновление скриптом \`install.sh\``,
    `- Сервер Linux: \`etn-server-${version}.tar.gz\` — архив серверной поставки`,
    '',
    'SHA-256 каждого ассета — в файле `SHA256SUMS` этого же релиза.',
  ];
  if (typeof prevTag === 'string' && prevTag !== '') {
    const compareUrl = `https://github.com/${repo}/compare/${prevTag}...v${version}`;
    lines.push('', `[Полный список коммитов](${compareUrl})`);
  }
  return lines.join('\n');
}

const options = parseArgs(process.argv.slice(2));
const version = resolveVersion(options.version);
const repo = resolveRepo(options.repo);
const outPath = path.resolve(REPO_ROOT, options.out ?? 'release-body.md');
const changelogPath = path.resolve(REPO_ROOT, options.changelog ?? CHANGELOG_PATH);

const changelog = readFileSync(changelogPath, 'utf8');
const section = extractChangelogSection(changelog, version);
const title = buildReleaseTitle({
  version,
  tagSubject: annotatedTagSubject(options.tag),
  leadTheme: themeFromLead(leadOf(section)),
  explicitTitle: options.title,
});
const body = `${section}\n\n---\n\n${buildFooter(version, options.prevTag, repo)}\n`;

writeFileSync(outPath, body, 'utf8');
if (typeof options.titleOut === 'string' && options.titleOut !== '') {
  writeFileSync(path.resolve(REPO_ROOT, options.titleOut), `${title}\n`, 'utf8');
}

const compare =
  typeof options.prevTag === 'string' && options.prevTag !== ''
    ? `, compare ${options.prevTag}...v${version}`
    : '';
console.log(`Тело релиза v${version} собрано${compare}: ${path.relative(REPO_ROOT, outPath)}`);
console.log(`Заголовок релиза v${version}: ${title}`);
