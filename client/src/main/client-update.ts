/**
 * Обновление клиента по команде (задача 61cec451, требование d654473a,
 * элемент интерфейса ed068706, компонент 60722bfd).
 *
 * Клиент только открывает страницу релиза (`client_download_url` из
 * `GET /api/v1/version`) в системном браузере. Скачивания файла, проверки
 * SHA-256 и запуска установщика из клиента НЕТ: установщик скачивает и
 * запускает сервер (задача 48312755) либо пользователь вручную со страницы
 * релиза. На macOS ничего не автоматизируется — DMG монтирует и приложение
 * копирует пользователь (требование d654473a).
 *
 * Чистая логика проверки адреса отделена от Electron: `openExternal`
 * подменяется в тестах, `shell.openExternal` подключает IPC-обработчик
 * (`ipc/handlers.ts`, канал `system.openClientUpdatePage`).
 */

/** Результат открытия страницы релиза. */
export type ClientUpdateOpenResult = { ok: true } | { ok: false; reason: string };

/** Зависимости открытия страницы релиза — подменяются в тестах. */
export interface ClientUpdateDeps {
  /** Открыть адрес системным браузером; отказ ОС приходит исключением. */
  openExternal(url: string): Promise<void>;
}

/**
 * Нормализует адрес страницы релиза из ответа сервера; `null` — адрес не
 * годится для открытия в браузере.
 *
 * Принимается только абсолютный `http(s)`-адрес: `client_download_url` —
 * страница релиза (требование e3ef572c), а произвольные схемы (`file:`,
 * `javascript:`, чужие протоколы) не должны попадать в системный обработчик
 * от имени сервера.
 */
export function parseReleasePageUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const target = raw.trim();
  if (target === '') return null;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '') return null;
  return url.toString();
}

/**
 * Открывает страницу релиза в системном браузере. Возвращает `{ ok: true }`
 * либо причину отказа человеческим текстом (её показывает баннер/диалог
 * строкой ошибки). Файл не скачивается, хеш не проверяется, установщик не
 * запускается.
 */
export async function openClientUpdatePage(
  rawUrl: unknown,
  deps: ClientUpdateDeps,
): Promise<ClientUpdateOpenResult> {
  const url = parseReleasePageUrl(rawUrl);
  if (url === null) {
    return {
      ok: false,
      reason: 'Адрес страницы релиза должен быть абсолютным http:// или https://.',
    };
  }
  try {
    await deps.openExternal(url);
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Не удалось открыть «${url}»: ${detail}` };
  }
}
