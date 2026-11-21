/**
 * Локальные словари проверки орфографии в поставке (задача 68402877, 0.16.1).
 *
 * Chromium держит словари Hunspell в `<userData>/Dictionaries`: если файла с
 * ожидаемым именем нет, он идёт за ним в сеть
 * (`https://redirector.gvt1.com/edgedl/chrome/dict/…`). В рабочей сети TLS до
 * этого хоста рвётся — в консоли dev-клиента повторяются
 * `ssl_client_socket_impl.cc handshake failed… net_error -101`, файлы в профиль
 * не приезжают, орфография не работает. Решение пользователя (2026-11-20):
 * словари включены в поставку, никаких сетевых загрузок.
 *
 * Имя файла задаёт Chromium: `GetVersionedFileName`
 * (`components/spellcheck/common/spellcheck_common.cc`) собирает его как
 * `<language-region><version>.bdic`. Для нужных ETN языков это
 * `ru-RU-3-0.bdic` и `en-US-10-1.bdic` — подтверждено экспериментом на
 * Electron 31.7.7: с пустым каталогом netlog показывает GET-запросы
 * `…/chrome/dict/ru-ru-3-0.bdic` и `…/en-us-10-1.bdic` (в URL имя в нижнем
 * регистре), а с файлами под именами выше — ни одного запроса.
 *
 * Модуль намеренно не зависит от Electron: пути, копирование и выбор языков —
 * чистые функции, тестируемые без живого приложения (`tests/
 * spellcheck-dictionaries.test.ts`).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Каталог профиля, куда Chromium смотрит за словарями. */
export const PROFILE_DICTIONARIES_DIR = 'Dictionaries';

/** Каталог словарей в ресурсах клиента (dev — репозиторий, упаковка — resources). */
export const RESOURCE_DICTIONARIES_DIR = 'dictionaries';

/** Один словарь поставки: язык для `setSpellCheckerLanguages` и имя файла. */
export interface SpellcheckDictionary {
  /** Локаль для Electron (`session.setSpellCheckerLanguages`). */
  language: string;
  /** Имя `.bdic` — ровно то, которое ищет Chromium (см. шапку модуля). */
  fileName: string;
}

/** Языки ETN: комментарии двуязычны, поэтому нужны русский и английский. */
export const SPELLCHECK_DICTIONARIES: readonly SpellcheckDictionary[] = [
  { language: 'ru', fileName: 'ru-RU-3-0.bdic' },
  { language: 'en-US', fileName: 'en-US-10-1.bdic' },
];

/**
 * Заведомо недоступный адрес загрузчика словарей: включается только когда
 * локальных словарей нет (битая установка) — чтобы Chromium не пошёл за ними
 * на gvt1 и не засорял консоль TLS-ошибками. Порт 9 (discard) на loopback
 * отвечает мгновенным отказом, внешней сети не касается.
 */
export const DISABLED_DICTIONARY_DOWNLOAD_URL = 'http://127.0.0.1:9/';

/**
 * Каталог-источник словарей: в упаковке — `process.resourcesPath/dictionaries`
 * (electron-builder `extraResources`), в dev — `client/resources/dictionaries`.
 */
export function dictionariesSourceDir(
  appPath: string,
  isPackaged: boolean,
  resourcesPath: string,
): string {
  return isPackaged
    ? path.join(resourcesPath, RESOURCE_DICTIONARIES_DIR)
    : path.join(appPath, 'resources', RESOURCE_DICTIONARIES_DIR);
}

/** Каталог словарей внутри профиля (`<userData>/Dictionaries`). */
export function profileDictionariesDir(userDataDir: string): string {
  return path.join(userDataDir, PROFILE_DICTIONARIES_DIR);
}

/** Итог подготовки одного файла словаря. */
export type DictionaryFileStatus = 'copied' | 'unchanged' | 'failed';

/** Итог подготовки одного файла словаря. */
export interface DictionaryFileResult {
  language: string;
  fileName: string;
  status: DictionaryFileStatus;
  /** Причина отказа — только у `failed` (идёт в `console.warn`). */
  error?: string;
}

/** Итог подготовки всех словарей поставки. */
export interface EnsureDictionariesResult {
  /** Откуда копировали (для диагностики). */
  sourceDir: string;
  /** Куда копировали (каталог Chromium в профиле). */
  targetDir: string;
  files: DictionaryFileResult[];
  /** Языки, чей словарь гарантированно лежит в профиле. */
  readyLanguages: string[];
}

/** SHA-256 файла — для сравнения содержимого при идемпотентном копировании. */
function sha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** Совпадает ли содержимое: сначала размер (дешёво), затем хэш. */
function sameContent(first: string, second: string): boolean {
  return fs.statSync(first).size === fs.statSync(second).size && sha256(first) === sha256(second);
}

/**
 * Копирование через временный файл и переименование: оборванный на середине
 * процесс не оставит в профиле полусловарь, который Chromium принял бы за
 * валидный.
 */
function copyAtomically(source: string, target: string): void {
  const temp = `${target}.tmp`;
  fs.copyFileSync(source, temp);
  fs.renameSync(temp, target);
}

/**
 * Привести `<userData>/Dictionaries` в согласие с поставкой (идемпотентно):
 * отсутствующий или отличающийся файл копируется, совпадающий по размеру и
 * хэшу не трогается. Никогда не бросает: причина отказа возвращается в
 * `files[].error`, старт клиента из-за словарей не падает.
 */
export function ensureSpellcheckDictionaries(
  sourceDir: string,
  targetDir: string,
): EnsureDictionariesResult {
  const files: DictionaryFileResult[] = [];
  const readyLanguages: string[] = [];
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    for (const dict of SPELLCHECK_DICTIONARIES) {
      files.push({ ...dict, status: 'failed', error: `cannot create ${targetDir}: ${reason}` });
    }
    return { sourceDir, targetDir, files, readyLanguages };
  }
  for (const dict of SPELLCHECK_DICTIONARIES) {
    const source = path.join(sourceDir, dict.fileName);
    const target = path.join(targetDir, dict.fileName);
    try {
      if (!fs.existsSync(source)) {
        files.push({ ...dict, status: 'failed', error: `missing resource ${source}` });
        continue;
      }
      if (fs.statSync(source).size === 0) {
        files.push({ ...dict, status: 'failed', error: `empty resource ${source}` });
        continue;
      }
      if (fs.existsSync(target) && sameContent(source, target)) {
        files.push({ ...dict, status: 'unchanged' });
        readyLanguages.push(dict.language);
        continue;
      }
      copyAtomically(source, target);
      files.push({ ...dict, status: 'copied' });
      readyLanguages.push(dict.language);
    } catch (err) {
      files.push({
        ...dict,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { sourceDir, targetDir, files, readyLanguages };
}

/**
 * Языки для `setSpellCheckerLanguages`. Включаются только когда в профиле есть
 * ВСЕ словари поставки: иначе Chromium пошёл бы за недостающим в сеть, чего
 * решение пользователя не допускает. Пустой массив — языки не включаем вовсе
 * (орфография остаётся на усмотрении Chromium/ОС, но запросов к gvt1 нет).
 * Язык, которого нет в сборке Chromium, отбрасывается — на нём
 * `setSpellCheckerLanguages` бросает.
 */
export function resolveSpellcheckLanguages(
  available: readonly string[],
  readyLanguages: readonly string[],
): string[] {
  const ready = new Set(readyLanguages);
  if (!SPELLCHECK_DICTIONARIES.every((dict) => ready.has(dict.language))) return [];
  return SPELLCHECK_DICTIONARIES.map((dict) => dict.language).filter((lang) =>
    available.includes(lang),
  );
}
