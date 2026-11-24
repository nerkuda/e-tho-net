#!/usr/bin/env node
/**
 * Генерация `server.json` в корне репозитория (задачи 760402ba, d1feff33;
 * ADR d17c3a29 п. 4-5).
 *
 * Единственный источник имени и версии — серверный код и корневой
 * `package.json`: `buildServerJson` (собранный `dist/npm/package-manifest.js`)
 * подставляет `MCP_REGISTRY_NAME`, версию ETN, запись npm-пакета и запись
 * MCPB-бандла канонического `win32-x64`.
 *
 * `fileSha256` MCPB-записи — хеш собранного артефакта, он меняется от сборки к
 * сборке. Порядок:
 *   - `--mcpb-sha256 <hex>` — конвейер релиза передаёт хеш собранного бандла;
 *   - без флага генератор сохраняет хеш из текущего `server.json` (тот же
 *     артефакт — тот же хеш), поэтому повторная генерация не переписывает
 *     файл впустую.
 *
 * Использование:
 *   node server/scripts/generate-server-json.mjs [--mcpb-sha256 <hex>]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { MCP_SERVER_JSON_FILE, buildServerJson } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'server', 'dist', 'npm', 'package-manifest.js')).href
);

const target = path.join(REPO_ROOT, MCP_SERVER_JSON_FILE);

/** Разобрать аргументы командной строки. */
function parseArgs(argv) {
  const options = { mcpbSha256: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--mcpb-sha256') {
      options.mcpbSha256 = argv[i + 1] ?? '';
      i += 1;
    } else {
      throw new Error(`неизвестный аргумент: ${argv[i]}`);
    }
  }
  return options;
}

/** SHA-256 MCPB-записи из текущего `server.json` (если файл уже есть). */
function existingMcpbSha256() {
  if (!existsSync(target)) return null;
  try {
    const document = JSON.parse(readFileSync(target, 'utf8'));
    const entry = (document.packages ?? []).find((item) => item.registryType === 'mcpb');
    return typeof entry?.fileSha256 === 'string' ? entry.fileSha256 : null;
  } catch {
    return null;
  }
}

const options = parseArgs(process.argv.slice(2));
const mcpbSha256 = options.mcpbSha256 ?? existingMcpbSha256();
if (typeof mcpbSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(mcpbSha256)) {
  throw new Error(
    'нет SHA-256 канонического MCPB-бандла: соберите бандл ' +
      '(node server/scripts/build-mcpb.mjs --platform win32-x64 --out release) и передайте ' +
      '--mcpb-sha256 <hex>',
  );
}

const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const document = buildServerJson({ version: String(rootPkg.version), mcpbSha256 });
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(
  `server.json: ${path.relative(REPO_ROOT, target)} (version ${document.version}, ` +
    `packages: ${document.packages.map((item) => item.registryType).join(', ')})`,
);
