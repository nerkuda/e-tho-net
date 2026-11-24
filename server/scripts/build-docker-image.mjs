#!/usr/bin/env node
/**
 * Локальная сборка Docker-образа ETN (задача 3db76d75, ADR d17c3a29).
 *
 * Собирает одну цель из `server/Dockerfile` (`server` — HTTP, `mcp` — stdio) с
 * метками из единственного источника (`lib/docker-metadata.mjs`). Публикации
 * здесь нет намеренно: пуши делает конвейер релиза
 * (`.github/workflows/docker-image.yml`) с токенами владельца namespace;
 * локально собирается только образ для проверки.
 *
 * Использование:
 *   node server/scripts/build-docker-image.mjs --target <server|mcp> [--tag vX.Y.Z]
 *     [--revision <sha>] [--platform linux/amd64]
 *
 * Без `--tag` берётся `v<версия ETN>` — тег релиза, с которым сравнивается
 * `docker inspect`.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  DOCKER_TARGETS,
  REPO_ROOT,
  dockerBuildArgs,
  imageRefs,
  readRegistryName,
  rootVersion,
} from './lib/docker-metadata.mjs';

/**
 * Разобрать аргументы командной строки.
 *
 * @param {readonly string[]} argv - `process.argv.slice(2)`.
 * @returns {{ target: string, tag: string, revision: string, platform: string | null }}
 *   разобранные значения (`target` проверяется вызывающим).
 */
function parseArgs(argv) {
  const options = { target: '', tag: '', revision: '', platform: null };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    const value = argv[i + 1] ?? '';
    if (name === '--target') options.target = value;
    else if (name === '--tag') options.tag = value;
    else if (name === '--revision') options.revision = value;
    else if (name === '--platform') options.platform = value;
    else throw new Error(`неизвестный аргумент: ${name}`);
    i += 1;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!DOCKER_TARGETS.includes(options.target)) {
  throw new Error(
    `--target обязателен, допустимы: ${DOCKER_TARGETS.join(', ')} (получено «${options.target}»). ` +
      'Без явной цели Dockerfile не собирается: метки и вход различаются.',
  );
}

const tag = options.tag || `v${rootVersion(REPO_ROOT)}`;
const registryName = readRegistryName(REPO_ROOT);
const refs = imageRefs(options.target, tag, registryName);
const buildArgs = dockerBuildArgs({ revision: options.revision, registryName });

const args = ['build', '--file', path.join('server', 'Dockerfile'), '--target', options.target];
for (const [key, value] of Object.entries(buildArgs)) {
  args.push('--build-arg', `${key}=${value}`);
}
if (options.platform) args.push('--platform', options.platform);
args.push('--tag', refs.dockerHub, REPO_ROOT);

console.log(`docker ${args.join(' ')}`);
const result = spawnSync('docker', args, { cwd: REPO_ROOT, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`docker build завершился с кодом ${result.status ?? 'неизвестно'}`);
}
console.log(`\nИтог: ${refs.dockerHub}`);
console.log(`Метки: docker inspect --format '{{json .Config.Labels}}' ${refs.dockerHub}`);
