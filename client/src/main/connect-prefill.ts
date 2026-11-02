/**
 * Предзаполнение нового подключения, которое передаёт установщик (ошибка
 * 0f8dd0f3, п.6 карточки 860def0d).
 *
 * После установки сервера кнопка «Запустить клиент» запускает ETN.exe с
 * параметрами
 *   `--connect-url=http://localhost:<порт> --connect-name="Локальный сервер"`.
 * Клиент на первом запуске показывает форму нового подключения с уже
 * заполненными названием и адресом — пользователю остаётся ввести API-ключ.
 *
 * Модуль чистый (без Electron): разбор argv проверяется отдельным тестом, а
 * main передаёт готовый результат в IPC. Неполный или некорректный набор
 * флагов даёт `null` — пустая форма лучше мусора в полях подключения.
 */

/** Предзаполнение подключения: имя в списке серверов и адрес сервера. */
export interface ConnectPrefill {
  readonly name: string;
  readonly url: string;
}

/** Флаги командной строки, которые передаёт установщик. */
const URL_FLAG = '--connect-url=';
const NAME_FLAG = '--connect-name=';

/**
 * Снимает обрамляющие пробелы и парные кавычки: значение может доехать как
 * есть (`--connect-name="Локальный сервер"`), если установщик передал кавычки
 * внутри одного аргумента.
 */
function unquote(raw: string): string {
  let value = raw.trim();
  if (value.length >= 2) {
    const first = value.charAt(0);
    const last = value.charAt(value.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1).trim();
    }
  }
  return value;
}

/**
 * Приводит адрес к виду, который сохраняет `server.addProfile`: только
 * http/https, без хвостовых «/» (их снимает и сервер, но форма не должна
 * показывать пользователю двойной вид одного адреса). `null` — адрес негоден.
 */
function normalizeUrl(raw: string): string | null {
  const value = unquote(raw).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    // Проверка формы адреса, а не только префикса: `http://` без хоста не
    // должен попасть в форму.
    const parsed = new URL(value);
    if (parsed.hostname === '') return null;
  } catch {
    return null;
  }
  return value;
}

/**
 * Разбирает argv клиента и возвращает предзаполнение подключения.
 *
 * Флаги ищутся точным префиксом (`--connect-url=`, `--connect-name=`), поэтому
 * чужие аргументы с похожим началом (`--connect-urlx=`) не подходят. Нужны
 * оба значения: установщик передаёт их парой, а половина пары в форме —
 * недоделанное подключение. Флаги могут идти в любом порядке; при повторе
 * действует последнее значение (обычная семантика CLI).
 */
export function parseConnectArgs(argv: readonly string[]): ConnectPrefill | null {
  let name = '';
  let url: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith(URL_FLAG)) {
      url = normalizeUrl(arg.slice(URL_FLAG.length));
    } else if (arg.startsWith(NAME_FLAG)) {
      name = unquote(arg.slice(NAME_FLAG.length));
    }
  }
  if (url === null || name === '') return null;
  return { name, url };
}
