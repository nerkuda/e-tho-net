/**
 * Печать HTML в PDF скрытым окном Electron (0.11.2, задача 178f4921).
 *
 * PDF публикации формирует КЛИЕНТ: сервер отдаёт самодостаточный печатный HTML
 * (`GET …/publications/{id}/print`, картинки встроены как data-URI, есть
 * водяной знак), а основной процесс грузит его в СКРЫТОЕ окно и снимает PDF
 * через `webContents.printToPDF` (ADR клиентской печати). Сервер печатать не
 * умеет, новых серверных зависимостей (puppeteer/playwright) нет.
 *
 * Модуль намеренно НЕ импортирует `electron`: оркестрация (временный файл →
 * загрузка → ожидание картинок и шрифтов → печать → уборка) — чистая логика с
 * внедряемыми зависимостями, поэтому проверяется юнит-тестом без настоящей
 * печати. Реальные зависимости (`BrowserWindow`, файловая система) собирает
 * IPC-обработчик.
 */

import { pathToFileURL } from 'node:url';

/** Опции `webContents.printToPDF`, которые использует печать публикации. */
export interface PdfPrintOptions {
  /** Печатать фон (нужен для полупрозрачного водяного знака и рамок оглавления). */
  printBackground?: boolean;
  /** Формат страницы (подмножество форматов Chromium). */
  pageSize?: 'A0' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'Legal' | 'Letter' | 'Tabloid' | 'Ledger';
  landscape?: boolean;
}

/** Минимальная поверхность webContents, нужная печати. */
export interface PdfPrintWebContents {
  printToPDF(options: PdfPrintOptions): Promise<Buffer>;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

/** Минимальная поверхность скрытого окна, нужная печати. */
export interface PdfPrintWindow {
  loadURL(url: string): Promise<void>;
  readonly webContents: PdfPrintWebContents;
  destroy(): void;
}

/** Внедряемые зависимости печати (в проде — Electron + FS). */
export interface PdfPrintDeps {
  /** Создать скрытое окно (`show: false`) — не перехватывает фокус пользователя. */
  createWindow(): PdfPrintWindow;
  /** Записать печатный HTML во временный файл, вернуть абсолютный путь. */
  writeTempHtml(html: string): string;
  /** Удалить временный файл (не бросает). */
  removeFile(filePath: string): void;
}

/**
 * Дождаться загрузки картинок и шрифтов страницы: печать не должна снять PDF
 * раньше, чем отрисуются все изображения (требование «ВСЕ картинки»).
 */
const SETTLE_SCRIPT = `Promise.all([
  document.fonts ? document.fonts.ready : Promise.resolve(),
  ...Array.from(document.images).map((img) =>
    img.complete ? Promise.resolve() : new Promise((resolve) => {
      img.addEventListener('load', resolve);
      img.addEventListener('error', resolve);
    })),
]).then(() => true)`;

/**
 * Снять PDF с HTML-документа: временный файл → скрытое окно → `printToPDF` →
 * уборка. Временный файл и окно освобождаются ВСЕГДА (даже при ошибке печати).
 *
 * @param html самодостаточный печатный HTML серверного рендера.
 * @param deps внедрённые Electron/FS-зависимости.
 */
export async function printHtmlToPdf(html: string, deps: PdfPrintDeps): Promise<Buffer> {
  const filePath = deps.writeTempHtml(html);
  const win = deps.createWindow();
  try {
    await win.loadURL(pathToFileURL(filePath).href);
    try {
      await win.webContents.executeJavaScript(SETTLE_SCRIPT, true);
    } catch {
      // Ожидание картинок — best-effort: печатаем то, что успело загрузиться.
    }
    return await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
  } finally {
    win.destroy();
    deps.removeFile(filePath);
  }
}
