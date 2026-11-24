/**
 * Манифест публикуемого npm-пакета `etn-mcp` и файла `server.json`
 * (ADR d17c3a29, задача 760402ba).
 *
 * Один источник для трёх потребителей:
 *
 * - сборщик пакета (`server/scripts/build-npm-package.mjs`) пишет манифест в
 *   стейджинг перед `npm pack`;
 * - генератор `server.json` (`server/scripts/generate-server-json.mjs`) берёт
 *   отсюда имя реестра/версию и пишет файл в корень репозитория;
 * - сторож (`server/tests/guard-mcp-package.test.ts`) сверяет константы,
 *   манифест и закоммиченный `server.json`.
 *
 * `mcpName` всегда равен {@link MCP_REGISTRY_NAME} — имя реестра обязано
 * совпадать с `name` в `server.json`; имя рукопожатия (`MCP_SERVER_NAME`)
 * живёт отдельно и здесь не участвует.
 */

import { buildOciRegistryPackage } from '../docker/registry.js';
import { buildMcpbRegistryPackage, githubSlugFromRegistryName } from '../mcpb/manifest.js';
import { MCP_REGISTRY_NAME } from '../mcp/server.js';

/** Имя публикуемого npm-пакета. */
export const NPM_PACKAGE_NAME = 'etn-mcp';
/** Поле `bin` опубликованного пакета (собран из `src/bin/etn-mcp.ts`). */
export const NPM_BIN_PATH = 'dist/bin/etn-mcp.js';
/** Точка входа HTTP-рантайма (не продуктовая обсессия npm-задачи). */
export const NPM_MAIN_PATH = 'dist/index.js';
/** Файл `server.json` в корне репозитория. */
export const MCP_SERVER_JSON_FILE = 'server.json';
/** Схема официального реестра MCP, на которую опирается `server.json`. */
export const MCP_SERVER_JSON_SCHEMA =
  'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

/** Платформы пакета (`os`), совпадают с матрицей prebuilds better-sqlite3. */
export const NPM_SUPPORTED_OS = ['win32', 'darwin', 'linux'] as const;
/** Архитектуры пакета (`cpu`). */
export const NPM_SUPPORTED_CPU = ['x64', 'arm64', 'arm'] as const;
/** Каталоги, попадающие в tarball. */
export const NPM_PACKAGE_FILES = ['dist', 'migrations', 'README.md'] as const;

/** Параметры {@link buildNpmPackageManifest}. */
export interface NpmPackageManifestInput {
  /** Версия ETN (корневой `package.json`). */
  version: string;
  /** Корневое требование к Node (`engines.node`). */
  enginesNode: string;
  /** Prod-зависимости с точными версиями, включая `@etn/shared`/`@etn/markdown`. */
  dependencies: Record<string, string>;
  /** Имена bundled-зависимостей (все prod-зависимости). */
  bundleDependencies: readonly string[];
}

/** Параметры {@link buildServerJson}. */
export interface ServerJsonInput {
  /** Версия ETN (корневой `package.json`). */
  version: string;
  /**
   * SHA-256 канонического (`win32-x64`) MCPB-бандла этой версии.
   *
   * Хеш считается по собранному артефакту и меняется от сборки к сборке,
   * поэтому не вычисляется генератором: его передаёт конвейер релиза
   * (`--mcpb-sha256`), а без значения генератор сохраняет хеш из текущего
   * `server.json` (тот же бандл — тот же хеш).
   */
  mcpbSha256: string;
}

/**
 * Собрать манифест публикуемого пакета.
 *
 * @throws {Error} когда bundled-зависимость не объявлена в `dependencies`.
 */
export function buildNpmPackageManifest(input: NpmPackageManifestInput): Record<string, unknown> {
  for (const name of input.bundleDependencies) {
    if (!(name in input.dependencies)) {
      throw new Error(`bundleDependencies entry ${name} is missing from dependencies`);
    }
  }
  return {
    name: NPM_PACKAGE_NAME,
    version: input.version,
    description:
      'ETN MCP server: self-hosted graph-of-thoughts knowledge base for AI agents ' +
      'with the full ETN server runtime.',
    type: 'module',
    main: NPM_MAIN_PATH,
    bin: { 'etn-mcp': NPM_BIN_PATH },
    files: [...NPM_PACKAGE_FILES],
    engines: { node: input.enginesNode },
    os: [...NPM_SUPPORTED_OS],
    cpu: [...NPM_SUPPORTED_CPU],
    mcpName: MCP_REGISTRY_NAME,
    dependencies: { ...input.dependencies },
    bundleDependencies: [...input.bundleDependencies],
  };
}

/**
 * Собрать `server.json` для официального реестра MCP.
 *
 * Три записи `packages[]` — npm-пакет, MCPB-бандл канонического `win32-x64`
 * (ADR d17c3a29 п. 5, задача d1feff33) и OCI-образ `etn-mcp` в Docker Hub
 * (задача 3db76d75): остальные платформы — ассеты релиза и `SHA256SUMS`, их
 * записи появятся, когда каталог научится выбирать бандл по платформе
 * (открытый вопрос c823f1df).
 *
 * Публикация в реестр — задача c823f1df; здесь только артефакт и метаданные.
 *
 * @throws {Error} когда `mcpbSha256` не является SHA-256 в нижнем регистре.
 */
export function buildServerJson(input: ServerJsonInput): Record<string, unknown> {
  return {
    $schema: MCP_SERVER_JSON_SCHEMA,
    name: MCP_REGISTRY_NAME,
    description: 'Self-hosted graph-of-thoughts knowledge base with MCP tools for AI agents.',
    version: input.version,
    packages: [
      {
        registryType: 'npm',
        identifier: NPM_PACKAGE_NAME,
        version: input.version,
        transport: { type: 'stdio' },
        environmentVariables: [
          {
            name: 'ETN_DATA_DIR',
            description:
              'ETN data directory. When started via the etn-mcp wrapper, defaults to a ' +
              'personal per-user directory.',
            isRequired: false,
            format: 'string',
            isSecret: false,
          },
          {
            name: 'ETN_API_KEY',
            description: 'API key of an existing ETN server to attach to.',
            isRequired: false,
            format: 'string',
            isSecret: true,
          },
        ],
      },
      buildMcpbRegistryPackage({
        version: input.version,
        repository: githubSlugFromRegistryName(MCP_REGISTRY_NAME),
        fileSha256: input.mcpbSha256,
      }),
      buildOciRegistryPackage(input.version),
    ],
  };
}
