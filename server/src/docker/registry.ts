/**
 * Docker-канал поставки ETN (задача 3db76d75, ADR d17c3a29 п. 1, 2, 5).
 *
 * Образ `etn-mcp` — тот же серверный рантайм с MCP stdio на входе; его
 * реестровая запись (`registryType: "oci"`) ссылается на образ в Docker Hub.
 * Namespace выводится из единственного источника реестровой идентичности
 * {@link MCP_REGISTRY_NAME} (`io.github.<owner>/<repo>` — владелец тот же, что
 * namespace Docker Hub, подтверждено пользователем 23.11.2026), второго
 * литерала `nerkuda` в коде нет.
 *
 * Тег `latest` не заводится: образ адресуется версией (ADR d17c3a29 п. 7).
 */

import { MCP_REGISTRY_NAME } from '../mcp/server.js';
import { githubSlugFromRegistryName } from '../mcpb/manifest.js';

/** Реестр Docker Hub в ссылке образа. */
export const DOCKER_HUB_REGISTRY = 'docker.io';

/** Имя stdio-образа MCP-сервера (последний сегмент ссылки). */
export const MCP_DOCKER_IMAGE = 'etn-mcp';

/** Имя HTTP-образа сервера (последний сегмент ссылки). */
export const SERVER_DOCKER_IMAGE = 'etn-server';

/**
 * Namespace Docker Hub — владелец реестрового имени.
 *
 * @param registryName - реестровое имя (по умолчанию {@link MCP_REGISTRY_NAME}).
 * @returns namespace Docker Hub.
 */
export function dockerHubNamespace(registryName: string = MCP_REGISTRY_NAME): string {
  const [owner] = githubSlugFromRegistryName(registryName).split('/');
  if (owner === undefined || owner === '') {
    throw new Error(`cannot derive Docker Hub namespace from registry name ${registryName}`);
  }
  return owner;
}

/**
 * Ссылка на образ Docker Hub для версии ETN.
 *
 * @param image - имя образа ({@link MCP_DOCKER_IMAGE}/{@link SERVER_DOCKER_IMAGE}).
 * @param version - версия ETN (без префикса `v`).
 * @param registryName - реестровое имя (шов для теста).
 * @returns `docker.io/<namespace>/<image>:v<version>`.
 * @throws {Error} когда версия не в форме `X.Y.Z` — тег обязан повторять версию.
 */
export function dockerImageRef(
  image: string,
  version: string,
  registryName: string = MCP_REGISTRY_NAME,
): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`image version must be X.Y.Z (ETN version), got ${version}`);
  }
  return `${DOCKER_HUB_REGISTRY}/${dockerHubNamespace(registryName)}/${image}:v${version}`;
}

/**
 * Запись OCI для `packages[]` в `server.json` (DoD 7).
 *
 * @param version - версия ETN (без префикса `v`).
 * @param registryName - реестровое имя (шов для теста).
 * @returns запись `registryType: "oci"` с идентификатором образа `etn-mcp`.
 */
export function buildOciRegistryPackage(
  version: string,
  registryName: string = MCP_REGISTRY_NAME,
): Record<string, unknown> {
  return {
    registryType: 'oci',
    identifier: dockerImageRef(MCP_DOCKER_IMAGE, version, registryName),
    version,
    transport: { type: 'stdio' },
  };
}
