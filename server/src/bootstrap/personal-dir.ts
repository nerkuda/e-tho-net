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
 * Домашний каталог по правилу POSIX: непустой `$HOME` процесса, иначе `null`.
 *
 * Подставной `$HOME` обязан побеждать `homedir`-параметр: smoke-тест бандла
 * (`scripts/build-mcpb.mjs`) и проверка npm-пакета
 * (`scripts/verify-npm-package.mjs`) запускают дочерний сервер с чужим `HOME`
 * и тем же окружением считают ожидаемый путь (ошибка 40959532).
 */
function homeFromEnv(env: NodeJS.ProcessEnv): string | null {
  const home = env.HOME?.trim();
  return home !== undefined && home !== '' ? home : null;
}

/**
 * Абсолютный путь личного каталога данных для текущей платформы.
 *
 * - Windows: `%LOCALAPPDATA%\etn-mcp` (fallback — `%USERPROFILE%\AppData\Local`);
 * - macOS: `$HOME/Library/Application Support/etn-mcp`;
 * - Linux/прочие: `${XDG_DATA_HOME:-$HOME/.local/share}/etn-mcp`.
 *
 * На POSIX база пути — `HOME` **окружения** (как у `os.homedir()`), а параметр
 * `homedir` — только запасной вариант для пустого/отсутствующего `HOME`: smoke
 * бандла и проверка npm-пакета запускают дочерний сервер с подставным `HOME` и
 * тем же окружением считают ожидаемый путь (ошибка 40959532 — на macOS путь
 * строился от реального дома вызывающего процесса, и smoke проверял не тот
 * каталог).
 *
 * @param env - окружение (для тестов и обёртки подменяется целиком).
 * @param platform - целевая платформа (`process.platform` по умолчанию).
 * @param homedir - домашний каталог-запасной вариант (для тестов).
 */
export function defaultDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: string = os.homedir(),
): string {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    const base =
      localAppData !== undefined && localAppData !== ''
        ? localAppData
        : path.join(homedir, 'AppData', 'Local');
    return path.join(base, PERSONAL_DIR_NAME);
  }
  // POSIX: база — HOME процесса (как у самого Node в `os.homedir()`), а
  // homedir-параметр — только запасной вариант, когда HOME пуст.
  const home = homeFromEnv(env) ?? homedir;
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', PERSONAL_DIR_NAME);
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg !== undefined && xdg !== '' ? xdg : path.join(home, '.local', 'share');
  return path.join(base, PERSONAL_DIR_NAME);
}
