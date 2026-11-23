/**
 * Метаданные Docker-образов ETN (задача 3db76d75, ADR d17c3a29 п. 1, 5).
 *
 * Единственный источник реестровой идентичности — серверный код
 * (`MCP_REGISTRY_NAME` в `server/src/mcp/server.ts`), версии — корневой
 * `package.json`, лицензии — `LICENSE`. Модуль проецирует их в то, что нужно
 * конвейеру релиза и локальной сборке: build-args Dockerfile (метки OCI и
 * `io.modelcontextprotocol.server.name`), имена образов и namespace Docker Hub.
 *
 * Литерала `io.github.nerkuda/e-tho-net` здесь нет намеренно: значение читается
 * из исходника строгим разбором одной строки (`readRegistryName`), сторож
 * `tests/guard-release-docker.test.ts` сверяет разбор с импортированной
 * константой — расхождение краснеет. Так образ можно собрать без `npm install`
 * и без предварительной сборки `dist` (метки нужны до сборки), а имя остаётся
 * одним.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

/** Цели Dockerfile (имена стадий) — сборочный контракт образа. */
export const DOCKER_TARGETS = ['server', 'mcp'];

/** Цель, которая запускает MCP (stdio) и потому несёт реестровую метку. */
export const DOCKER_MCP_TARGET = 'mcp';

/** Имя образа для цели (последний сегмент ссылки). */
export const DOCKER_IMAGE_NAMES = Object.freeze({
  server: 'etn-server',
  mcp: 'etn-mcp',
});

/** Реестр Docker Hub в ссылке образа. */
export const DOCKER_HUB_REGISTRY = 'docker.io';

/**
 * Прочитать `MCP_REGISTRY_NAME` из исходника: одна строгая строка.
 *
 * @param {string} [repoRoot] - корень репозитория.
 * @returns {string} реестровое имя сервера.
 * @throws {Error} если строка не найдена или найдена не одна.
 */
export function readRegistryName(repoRoot = REPO_ROOT) {
  const file = path.join(repoRoot, 'server', 'src', 'mcp', 'server.ts');
  const text = readFileSync(file, 'utf8');
  const matches = [...text.matchAll(/^export const MCP_REGISTRY_NAME = '([^']+)';$/gm)];
  if (matches.length !== 1) {
    throw new Error(
      'server/src/mcp/server.ts: ожидается ровно одно объявление ' +
        `export const MCP_REGISTRY_NAME = '...';, найдено ${matches.length}`,
    );
  }
  return matches[0][1];
}

/**
 * GitHub-slug владельца из реестрового имени: `io.github.<owner>/<repo>`.
 *
 * Та же логика, что `githubSlugFromRegistryName` в `src/mcpb/manifest.ts`
 * (сторож сверяет результаты): скрипт конвейера обязан работать без сборки.
 *
 * @param {string} registryName - реестровое имя.
 * @returns {string} `<owner>/<repo>`.
 */
export function githubSlug(registryName) {
  const match = /^io\.github\.([a-z0-9-]+)\/([a-z0-9._-]+)$/i.exec(registryName);
  if (!match) {
    throw new Error(
      `реестровое имя «${registryName}» не в форме io.github.<owner>/<repo> — ` +
        'namespace Docker Hub и адрес исходников вывести нельзя',
    );
  }
  return `${match[1]}/${match[2]}`;
}

/**
 * Namespace Docker Hub: владелец из реестрового имени (ADR d17c3a29 п. 1).
 *
 * @param {string} registryName - реестровое имя.
 * @returns {string} namespace Docker Hub.
 */
export function dockerHubNamespace(registryName) {
  return githubSlug(registryName).split('/')[0];
}

/**
 * Ссылки образа цели: GHCR (зеркало в GitHub) и Docker Hub.
 *
 * @param {'server'|'mcp'} target - цель Dockerfile.
 * @param {string} tag - тег релиза (`vX.Y.Z`).
 * @param {string} registryName - реестровое имя.
 * @returns {{ ghcr: string, dockerHub: string }} ссылки образов.
 */
export function imageRefs(target, tag, registryName) {
  if (!DOCKER_TARGETS.includes(target)) {
    throw new Error(`неизвестная цель образа «${target}», допустимы: ${DOCKER_TARGETS.join(', ')}`);
  }
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`тег образа «${tag}» не в форме vX.Y.Z (latest не публикуется)`);
  }
  const name = DOCKER_IMAGE_NAMES[target];
  const slug = githubSlug(registryName);
  return {
    ghcr: `ghcr.io/${slug}/${name}:${tag}`,
    dockerHub: `${DOCKER_HUB_REGISTRY}/${dockerHubNamespace(registryName)}/${name}:${tag}`,
  };
}

/**
 * Версия ETN из корневого `package.json` (ADR d17c3a29 п. 7).
 *
 * @param {string} [repoRoot] - корень репозитория.
 * @returns {string} версия ETN.
 */
export function rootVersion(repoRoot = REPO_ROOT) {
  return JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
}

/**
 * SPDX-лицензия из файла `LICENSE` (первая строка вида «MIT License»).
 *
 * @param {string} [repoRoot] - корень репозитория.
 * @returns {string} идентификатор лицензии.
 */
export function licenseIdentifier(repoRoot = REPO_ROOT) {
  const file = path.join(repoRoot, 'LICENSE');
  if (!existsSync(file)) throw new Error('нет файла LICENSE — метка licenses не определена');
  const first = readFileSync(file, 'utf8').split('\n')[0]?.trim() ?? '';
  const match = /^(.+?) License$/.exec(first);
  if (!match) {
    throw new Error(`LICENSE: первая строка «${first}» не в форме «<SPDX> License»`);
  }
  return match[1];
}

/**
 * Адрес исходников образа: `https://github.com/<owner>/<repo>`.
 *
 * @param {string} registryName - реестровое имя.
 * @returns {string} URL репозитория.
 */
export function sourceUrl(registryName) {
  return `https://github.com/${githubSlug(registryName)}`;
}

/**
 * Аргументы сборки Dockerfile: метки и идентичность.
 *
 * Значения совпадают с тем, что конвейер передаёт в `build-args`; локальная
 * сборка берёт их отсюда, чтобы метки не разошлись с релизными.
 *
 * @param {{ revision?: string, repoRoot?: string, registryName?: string }} [input]
 *   `revision` — коммит кода образа (в CI — `github.sha`), `registryName` —
 *   подмена для теста.
 * @returns {Record<string, string>} build-args.
 */
export function dockerBuildArgs(input = {}) {
  const repoRoot = input.repoRoot ?? REPO_ROOT;
  const registryName = input.registryName ?? readRegistryName(repoRoot);
  const revision = (input.revision ?? '').trim() || 'unknown';
  return {
    VERSION: rootVersion(repoRoot),
    REVISION: revision,
    MCP_REGISTRY_NAME: registryName,
    SOURCE_URL: sourceUrl(registryName),
    LICENSE: licenseIdentifier(repoRoot),
  };
}
