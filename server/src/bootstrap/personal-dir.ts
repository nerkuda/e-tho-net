/**
 * Личный каталог данных пакета `etn-mcp` (ADR aa9507e6 п. 2).
 *
 * Модуль намеренно не тянет `better-sqlite3` и остальной рантайм: входная
 * точка `dist/bin/etn-mcp.js` вычисляет каталог по умолчанию **до** загрузки
 * сервера, чтобы стартовый страж платформы и ошибка нативной загрузки
 * срабатывали раньше тяжёлых импортов.
 *
 * Правило: `ETN_DATA_DIR` не задан — личный каталог ОС; подкоманда `etn mcp`
 * внутри установленного сервера личного каталога не получает (ADR п. 2).
 * Переменная окружения `ETN_DATA_DIR` сюда не читается — её обрабатывает
 * вызывающая сторона.
 */

import os from 'node:os';
import path from 'node:path';

/** Имя каталога пакета внутри каталога данных ОС. */
export const PERSONAL_DIR_NAME = 'etn-mcp';

/**
 * Абсолютный путь личного каталога данных для текущей платформы.
 *
 * - Windows: `%LOCALAPPDATA%\etn-mcp` (fallback — `%USERPROFILE%\AppData\Local`);
 * - macOS: `~/Library/Application Support/etn-mcp`;
 * - Linux/прочие: `${XDG_DATA_HOME:-~/.local/share}/etn-mcp`.
 *
 * @param env - окружение (для тестов и обёртки подменяется целиком).
 * @param platform - целевая платформа (`process.platform` по умолчанию).
 * @param homedir - домашний каталог (для тестов).
 */
export function defaultDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: string = os.homedir(),
): string {
  const home = homedir;
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    const base =
      localAppData !== undefined && localAppData !== ''
        ? localAppData
        : path.join(home, 'AppData', 'Local');
    return path.join(base, PERSONAL_DIR_NAME);
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', PERSONAL_DIR_NAME);
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg !== undefined && xdg !== '' ? xdg : path.join(home, '.local', 'share');
  return path.join(base, PERSONAL_DIR_NAME);
}
