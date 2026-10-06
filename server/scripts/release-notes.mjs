#!/usr/bin/env node
/**
 * Сборка тела GitHub-релиза из секции версии `CHANGELOG.md` и футера.
 *
 * Шаг процедуры «Публикация релиза на GitHub» (мыслесеть ETN, инструкция
 * 04f08f92): тело релиза не должно оставаться пустым, а `generate_release_notes`
 * без pull request'ов вырождается в одну строку «Full Changelog». Потому
 * workflow job `github-release` вызывает этот скрипт и передаёт результат
 * в `body_path` экшена `softprops/action-gh-release`.
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
 *   node server/scripts/release-notes.mjs
 *       # версия — из корневого package.json, без compare-ссылки
 *   node server/scripts/release-notes.mjs --version 0.11.1 --out body.md \
 *       --repo owner/name
 */

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

/** Разбор аргументов: `--version`, `--prev-tag`, `--out`, `--repo`. */
function parseArgs(argv) {
  const options = { version: null, prevTag: null, out: null, repo: null };
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
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Использование: node server/scripts/release-notes.mjs ' +
          '[--version X.Y.Z] [--prev-tag vX.Y.W] [--out <file>] [--repo owner/name]',
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

/** Футер тела релиза: ассеты по ОС, автообновление и compare-ссылка. */
function buildFooter(version, prevTag, repo) {
  const lines = [
    '## Скачать',
    '',
    `- Windows: \`ETN.Setup.${version}.exe\``,
    `- macOS (Apple Silicon): \`ETN-${version}-arm64.dmg\``,
    `- Linux: \`ETN-${version}.AppImage\` / \`ETN-${version}.deb\``,
    '',
    'Установленный клиент обновится сам.',
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

const changelog = readFileSync(CHANGELOG_PATH, 'utf8');
const section = extractChangelogSection(changelog, version);
const body = `${section}\n\n---\n\n${buildFooter(version, options.prevTag, repo)}\n`;

writeFileSync(outPath, body, 'utf8');

const compare =
  typeof options.prevTag === 'string' && options.prevTag !== ''
    ? `, compare ${options.prevTag}...v${version}`
    : '';
console.log(`Тело релиза v${version} собрано${compare}: ${path.relative(REPO_ROOT, outPath)}`);
