#!/usr/bin/env node
/**
 * Генерация `server.json` в корне репозитория (задача 760402ba, ADR d17c3a29
 * п. 4).
 *
 * Единственный источник имени и версии — серверный код и корневой
 * `package.json`: `buildServerJson` (собранный `dist/npm/package-manifest.js`)
 * подставляет `MCP_REGISTRY_NAME` и версию ETN. Запись npm — эта задача;
 * MCPB и OCI добавляют свои записи в `packages[]` после неё.
 *
 * Использование: node server/scripts/generate-server-json.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { MCP_SERVER_JSON_FILE, buildServerJson } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'server', 'dist', 'npm', 'package-manifest.js')).href
);

const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const document = buildServerJson({ version: String(rootPkg.version) });
const target = path.join(REPO_ROOT, MCP_SERVER_JSON_FILE);
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`server.json: ${path.relative(REPO_ROOT, target)} (version ${document.version})`);
