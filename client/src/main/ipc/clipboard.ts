/**
 * Чтение системного буфера обмена (задача 78eaf07a).
 *
 * Картинки из буфера рендереру недоступны (`navigator.clipboard` умеет только
 * текст; требование «Разделение процессов клиента» 7f7b2d57), поэтому буфер
 * читает главный процесс. Логика вынесена из обработчика за инъектируемый
 * {@link ClipboardReader}: так она проверяется юнит-тестом без Electron-runtime
 * (существующий паттерн main-тестов — `client-log.ts`).
 */

import type { ClipboardReadResult } from './contract.js';

/** Минимальный вид Electron-`clipboard`, нужный чтению (точка инъекции). */
export interface ClipboardReader {
  readText(): string;
  readImage(): { isEmpty(): boolean; toDataURL(): string };
}

/**
 * Читает буфер через {@link ClipboardReader}: текст (пустой → `null`) и картинку
 * как `data:`-URL PNG (нет картинки → `null`). Ничего не пишет; любой сбой
 * чтения даёт пустой результат — вызывающий просто сочтёт буфер непригодным.
 */
export function readClipboard(reader: ClipboardReader): ClipboardReadResult {
  try {
    const text = reader.readText();
    const image = reader.readImage();
    const imagePngDataUrl = image !== null && !image.isEmpty() ? image.toDataURL() : null;
    return { text: text !== '' ? text : null, imagePngDataUrl };
  } catch {
    return { text: null, imagePngDataUrl: null };
  }
}
