#!/usr/bin/env node
/**
 * CLI метаданных Docker-образов ETN (задача 3db76d75).
 *
 * Читает единственный источник идентичности и печатает либо JSON (человеку),
 * либо пары `key=value` в файл `--github-output` (шаг workflow релиза).
 * Нужен только Node: `npm install` и сборка `dist` не требуются.
 *
 * Использование:
 *   node server/scripts/docker-metadata.mjs [--revision <sha>] [--github-output <file>]
 */

import { appendFileSync } from 'node:fs';

import { DOCKER_IMAGE_NAMES, dockerBuildArgs, dockerHubNamespace } from './lib/docker-metadata.mjs';

/**
 * Разобрать аргументы командной строки.
 *
 * @param {readonly string[]} argv - `process.argv.slice(2)`.
 * @returns {{ revision: string, githubOutput: string | null }} разобранные значения.
 */
function parseArgs(argv) {
  const options = { revision: '', githubOutput: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--revision') {
      options.revision = argv[i + 1] ?? '';
      i += 1;
    } else if (argv[i] === '--github-output') {
      options.githubOutput = argv[i + 1] ?? '';
      i += 1;
    } else {
      throw new Error(`неизвестный аргумент: ${argv[i]}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const buildArgs = dockerBuildArgs({ revision: options.revision });
const registryName = buildArgs.MCP_REGISTRY_NAME;
const outputs = {
  registry_name: registryName,
  dockerhub_namespace: dockerHubNamespace(registryName),
  version: buildArgs.VERSION,
  revision: buildArgs.REVISION,
  source_url: buildArgs.SOURCE_URL,
  license: buildArgs.LICENSE,
  server_image: DOCKER_IMAGE_NAMES.server,
  mcp_image: DOCKER_IMAGE_NAMES.mcp,
};

if (options.githubOutput) {
  const lines = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  appendFileSync(options.githubOutput, `${lines}\n`, 'utf8');
} else {
  console.log(JSON.stringify({ buildArgs, outputs }, null, 2));
}
