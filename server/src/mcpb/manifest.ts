/**
 * MCPB-бандл ETN: манифест формата MCPB 0.3 и запись реестра
 * `registryType: "mcpb"` (задача d1feff33, ADR ad67950b / aa9507e6 / d17c3a29).
 *
 * Один источник для трёх потребителей:
 *
 * - сборщик `server/scripts/build-mcpb.mjs` пишет `manifest.json` и маркер
 *   целевой платформы в корень бандла;
 * - `buildServerJson` (`npm/package-manifest.ts`) берёт отсюда запись MCPB для
 *   `server.json` (канонический `win32-x64` бандл);
 * - сторож `server/tests/guard-mcp-package.test.ts` сверяет манифест,
 *   идентичность и имена артефактов.
 *
 * Имя манифеста — {@link MCP_SERVER_NAME} (та же строка, что в serverInfo
 * рукопожатия); реестровое имя `io.github.nerkuda/e-tho-net` в манифест не
 * переносится (ADR d17c3a29 п. 5): это имя каталога, а не сервера.
 *
 * Бандл собирается под одну платформу: `better-sqlite3` — нативный модуль, и
 * universal-бандла нет. `compatibility.platforms` различает только ОС, поэтому
 * архитектуру несёт имя файла и маркер {@link MCPB_BUNDLE_TARGET_FILENAME},
 * который входная точка сверяет с хостом до загрузки нативного модуля.
 */

import { BUNDLE_TARGET_FILENAME } from '../bin/platform.js';
import { MCP_SERVER_NAME } from '../mcp/server.js';

/** Версия формата MCPB, который собирает конвейер. */
export const MCPB_MANIFEST_VERSION = '0.3';

/** Отображаемое имя сервера в каталоге клиента. */
export const MCPB_DISPLAY_NAME = 'ETN MCP Server';

/** Короткое описание для карточки установки. */
export const MCPB_DESCRIPTION =
  'Self-hosted graph-of-thoughts knowledge base with MCP tools for AI agents.';

/** Автор бандла (MCPB требует объект). */
export const MCPB_AUTHOR = {
  name: 'ETN',
  url: 'https://github.com/nerkuda/e-tho-net',
} as const;

/** Точка входа бандла: та же обёртка пакета, что и `bin` npm-пакета. */
export const MCPB_ENTRY_POINT = 'dist/bin/etn-mcp.js';

/** Требование к Node: клиент обязан обеспечить этот рантайм (ADR ad67950b п. 5). */
export const MCPB_NODE_RUNTIME = '>=22.2.0';

/** Маркер целевой платформы в корне бандла (его читает `bin/platform.ts`). */
export const MCPB_BUNDLE_TARGET_FILENAME = BUNDLE_TARGET_FILENAME;

/** Идентификатор маркера: отличает наш файл от постороннего JSON. */
export const MCPB_BUNDLE_TARGET_KIND = 'etn-mcp-bundle';

/** Платформы, под которые конвейер собирает бандлы (`<platform>-<arch>`). */
export const MCPB_TARGETS = ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64'] as const;

/** Канонический бандл: его запись попадает в `server.json` (ADR d17c3a29). */
export const MCPB_CANONICAL_TARGET = 'win32-x64';

/** Расширение артефакта. */
export const MCPB_EXTENSION = '.mcpb';

/** Разобранная цель сборки. */
export interface McpbTarget {
  /** `win32`, `darwin`, `linux`. */
  platform: string;
  /** `x64` или `arm64`. */
  arch: string;
  /** `<platform>-<arch>` — значение маркера и имя файла. */
  target: string;
}

/** Параметры {@link buildMcpbManifest}. */
export interface McpbManifestInput {
  /** Версия ETN (корневой `package.json`). */
  version: string;
  /** Цель сборки: `<platform>-<arch>`. */
  target: string;
}

/**
 * Разобрать цель сборки.
 *
 * @throws {Error} когда цель не входит в {@link MCPB_TARGETS}.
 */
export function parseMcpbTarget(target: string): McpbTarget {
  if (!(MCPB_TARGETS as readonly string[]).includes(target)) {
    throw new Error(
      `unsupported MCPB target: ${target}. Supported targets: ${MCPB_TARGETS.join(', ')}`,
    );
  }
  const [platform, arch] = target.split('-');
  return { platform: platform as string, arch: arch as string, target };
}

/** Имя артефакта: `etn-mcp-<version>-<platform>-<arch>.mcpb`. */
export function mcpbAssetName(version: string, target: string): string {
  parseMcpbTarget(target);
  return `etn-mcp-${version}-${target}${MCPB_EXTENSION}`;
}

/** GitHub-slug репозитория из имени реестра `io.github.<owner>/<repo>`. */
export function githubSlugFromRegistryName(registryName: string): string {
  const prefix = 'io.github.';
  if (!registryName.startsWith(prefix)) {
    throw new Error(`registry name ${registryName} is not an io.github.<owner>/<repo> name`);
  }
  return registryName.slice(prefix.length);
}

/**
 * URL релиза с бандлом (идентификатор записи реестра).
 *
 * @throws {Error} когда цель не входит в {@link MCPB_TARGETS}.
 */
export function mcpbReleaseUrl(version: string, target: string, repository: string): string {
  return `https://github.com/${repository}/releases/download/v${version}/${mcpbAssetName(version, target)}`;
}

/**
 * Собрать `manifest.json` бандла.
 *
 * `user_config` — оба поля необязательны (ADR aa9507e6): пустой `data_dir`
 * означает личный каталог пакета, пустой `api_key` — тихую инициализацию.
 * Подстановка в `mcp_config.env` — синтаксис MCPB `${user_config.<key>}`.
 *
 * @throws {Error} когда цель не входит в {@link MCPB_TARGETS}.
 */
export function buildMcpbManifest(input: McpbManifestInput): Record<string, unknown> {
  const { platform } = parseMcpbTarget(input.target);
  return {
    manifest_version: MCPB_MANIFEST_VERSION,
    name: MCP_SERVER_NAME,
    display_name: MCPB_DISPLAY_NAME,
    version: input.version,
    description: MCPB_DESCRIPTION,
    author: { ...MCPB_AUTHOR },
    license: 'MIT',
    server: {
      type: 'node',
      entry_point: MCPB_ENTRY_POINT,
      mcp_config: {
        command: 'node',
        args: [`\${__dirname}/${MCPB_ENTRY_POINT}`],
        env: {
          ETN_DATA_DIR: '${user_config.data_dir}',
          ETN_API_KEY: '${user_config.api_key}',
        },
      },
    },
    compatibility: {
      platforms: [platform],
      runtimes: { node: MCPB_NODE_RUNTIME },
    },
    user_config: {
      data_dir: {
        type: 'directory',
        title: 'ETN data directory',
        description:
          'Directory of an existing ETN server to attach to. Leave empty to use a personal ' +
          'data directory and initialize it on first start.',
        required: false,
      },
      api_key: {
        type: 'string',
        title: 'ETN API key',
        description:
          'API key of an existing ETN server (only needed to attach to it). Leave empty to ' +
          'use the key of the personal data directory.',
        sensitive: true,
        required: false,
      },
    },
    tools_generated: true,
  };
}

/**
 * Собрать маркер целевой платформы для корня бандла.
 *
 * `target` читает `bin/platform.ts`; `platform`/`arch` дублируются, чтобы файл
 * оставался понятным человеку.
 */
export function buildBundleTargetMarker(input: McpbManifestInput): Record<string, unknown> {
  const { platform, arch, target } = parseMcpbTarget(input.target);
  return {
    kind: MCPB_BUNDLE_TARGET_KIND,
    version: input.version,
    platform,
    arch,
    target,
  };
}

/** Параметры {@link buildMcpbRegistryPackage}. */
export interface McpbRegistryPackageInput {
  /** Версия ETN. */
  version: string;
  /** GitHub-slug репозитория релиза. */
  repository: string;
  /** SHA-256 канонического бандла (64 hex-символа). */
  fileSha256: string;
}

/**
 * Запись MCPB для `packages[]` в `server.json` (DoD 5).
 *
 * Идентификатор — URL релиза канонического бандла {@link MCPB_CANONICAL_TARGET};
 * `fileSha256` обязателен для MCPB-пакетов схемой реестра. Остальные
 * платформы — ассеты релиза и `SHA256SUMS`, пока каталог не умеет выбирать
 * бандл по платформе (открытый вопрос c823f1df).
 *
 * @throws {Error} когда `fileSha256` не является SHA-256 в нижнем регистре.
 */
export function buildMcpbRegistryPackage(input: McpbRegistryPackageInput): Record<string, unknown> {
  if (!/^[a-f0-9]{64}$/.test(input.fileSha256)) {
    throw new Error(`fileSha256 must be a lowercase SHA-256 hex string, got ${input.fileSha256}`);
  }
  return {
    registryType: 'mcpb',
    identifier: mcpbReleaseUrl(input.version, MCPB_CANONICAL_TARGET, input.repository),
    version: input.version,
    fileSha256: input.fileSha256,
    transport: { type: 'stdio' },
  };
}
