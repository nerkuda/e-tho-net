/**
 * Стартовый страж платформы и целевой платформы MCPB-бандла (ADR ad67950b
 * п. 6, ADR aa9507e6, задача 760402ba).
 *
 * Две независимые проверки входа `dist/bin/etn-mcp.js`:
 *
 * 1. **Хост поддержан пакетом** — матрица `os`/`cpu` в опубликованном
 *    `package.json` и тот же список здесь: `npm install` на платформе вне
 *    матрицы всё равно попытается собрать `better-sqlite3` из исходников
 *    (`prebuild-install || node-gyp rebuild` не подавить), поэтому входная
 *    точка даёт понятный текст раньше, чем `require` упадёт стеком.
 * 2. **Целевая платформа бандла совпадает с хостом** — MCPB-сборщик пишет
 *    маркер `etn-mcp-target.json` в корень бандла (`{ platform, arch }`),
 *    входная точка сверяет его с хостом **до** загрузки нативного модуля
 *    `better-sqlite3`:
 *    `compatibility.platforms` в манифесте MCPB различает только ОС, поэтому
 *    `darwin-arm64`-бандл на `darwin-x64` иначе дошёл бы до загрузки модуля.
 *
 * Тексты сообщений — английские (ADR daab6ac4): это пользовательские сообщения
 * опубликованного пакета.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Имя маркера целевой платформы в корне MCPB-бандла. */
export const BUNDLE_TARGET_FILENAME = 'etn-mcp-target.json';

/** Поддержанные пакетом цели (`<platform>-<arch>`), как в `os`/`cpu`. */
export const SUPPORTED_TARGETS = [
  'win32-x64',
  'win32-arm64',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
  'linux-arm',
] as const;

/** Ошибка стартового стража (сообщение уже готово для stderr). */
export class PlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformError';
  }
}

/** Идентификатор цели `<platform>-<arch>`. */
export function targetId(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}

/**
 * Проверить, что хост входит в матрицу пакета.
 *
 * @returns идентификатор цели (`win32-x64` и т.п.).
 * @throws {PlatformError} с перечнем поддержанных целей.
 */
export function assertSupportedHost(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const target = targetId(platform, arch);
  if (!(SUPPORTED_TARGETS as readonly string[]).includes(target)) {
    throw new PlatformError(
      `Unsupported platform: ${target}. This package supports: ${SUPPORTED_TARGETS.join(', ')}. ` +
        'The native SQLite module (better-sqlite3) has no prebuilt binary for this platform.',
    );
  }
  return target;
}

/**
 * Прочитать маркер целевой платформы из корня бандла.
 *
 * @param packageDir - корень пакета/бандла (рядом с `package.json`).
 * @returns `win32-x64`-подобная цель или `null`, если маркера нет (npm-пакет).
 */
export function readBundleTarget(packageDir: string): string | null {
  const file = path.join(packageDir, BUNDLE_TARGET_FILENAME);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      platform?: unknown;
      arch?: unknown;
      target?: unknown;
    };
    if (typeof parsed.target === 'string' && parsed.target.length > 0) {
      return parsed.target;
    }
    if (typeof parsed.platform === 'string' && typeof parsed.arch === 'string') {
      return targetId(parsed.platform, parsed.arch);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Сверить целевую платформу бандла с хостом.
 *
 * @throws {PlatformError} когда маркер есть и не совпадает с хостом.
 */
export function assertBundleTarget(bundleTarget: string | null, hostTarget: string): void {
  if (bundleTarget === null || bundleTarget === hostTarget) return;
  throw new PlatformError(
    `This MCP bundle is built for ${bundleTarget}, but the current host is ${hostTarget}. ` +
      'Download the bundle for your platform (the platform and architecture are part of the file name).',
  );
}
