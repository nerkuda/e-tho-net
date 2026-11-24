/**
 * Распознавание точки входа процесса (`process.argv[1]` ↔ файл модуля).
 *
 * Зачем отдельная проверка, а не `path.resolve(argv[1]) === fileURLToPath(import.meta.url)`:
 * ESM-загрузчик Node с самого старта раскрывает символические ссылки в пути
 * главного модуля, поэтому `import.meta.url` — это **реальный** путь, а
 * `process.argv[1]` остаётся тем, что передали оболочке. Если в пути есть
 * симлинк, прямое сравнение ложно, и модуль молча ничего не делает:
 * процесс выходит с кодом 0, а вызывающая сторона видит «сервер умер».
 *
 * Реальные случаи (ошибка 06f03d71):
 *
 * - macOS: `os.tmpdir()` — это `/var/folders/…`, а `/var` — симлинк на
 *   `/private/var`; MCPB smoke-тест собирает бандл во временном каталоге и
 *   запускает обёртку `dist/bin/etn-mcp.js` — она не распознавала себя и
 *   выходила с кодом 0 без единой строки в stderr (MCP-клиент видел
 *   `MCP error -32000: Connection closed`);
 * - POSIX: npm ставит `bin` символической ссылкой (`node_modules/.bin/etn-mcp`
 *   → `dist/bin/etn-mcp.js`), поэтому опубликованный пакет на Linux/macOS
 *   зависел бы от того же сравнения.
 *
 * Сравнение идёт по реальным путям (`realpath`); если файла нет, остаётся
 * абсолютный путь. На Windows дополнительно сравниваем без учёта регистра.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

/** Реальный путь файла; при ошибке (файла нет) — абсолютный как есть. */
function realpathOrResolved(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * Является ли файл точкой входа процесса.
 *
 * @param argv1 - `process.argv[1]` (путь запущенного файла, может быть через симлинк).
 * @param moduleFile - файл текущего модуля (`fileURLToPath(import.meta.url)`).
 * @param platform - платформа для правила регистра (шов для тестов; по умолчанию текущая).
 * @returns `true`, если запущен именно этот файл.
 */
export function isEntryPoint(
  argv1: string | undefined,
  moduleFile: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (argv1 === undefined || argv1 === '') return false;
  const invoked = realpathOrResolved(argv1);
  const self = realpathOrResolved(moduleFile);
  if (platform === 'win32') return invoked.toLowerCase() === self.toLowerCase();
  return invoked === self;
}
