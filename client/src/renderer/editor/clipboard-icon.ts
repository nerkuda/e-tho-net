/**
 * Разбор содержимого системного буфера обмена для диалога выбора иконки
 * (задача 78eaf07a). Чистые функции без домена: эвристика «текст буфера — ровно
 * один эмодзи» и сборка `File` из `data:`-URL картинки буфера. Сам буфер читает
 * main-процесс (`system.readClipboard`); сюда приходит уже результат.
 */

/**
 * Сегментация по графемным кластерам (Intl.Segmenter): один эмодзи может
 * состоять из нескольких код-поинтов (ZWJ-последовательности, тона кожи).
 */
const GRAPHEME = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Эмодзи из текста буфера: трим → РОВНО один графемный кластер, содержащий
 * `\p{Extended_Pictographic}` и НЕ содержащий букв/цифр. Иначе `null`
 * (текст не эмодзи-иконка). Составные эмодзи с цифрой (keycap `1️⃣`) сюда не
 * попадают — по требованию «нет цифр».
 */
export function emojiFromClipboardText(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  let clusters: string[];
  try {
    clusters = [...GRAPHEME.segment(trimmed)].map((part) => part.segment);
  } catch {
    return null;
  }
  if (clusters.length !== 1) return null;
  const cluster = clusters[0] ?? '';
  if (!/\p{Extended_Pictographic}/u.test(cluster)) return null;
  if (/[\p{L}\p{N}]/u.test(cluster)) return null;
  return cluster;
}

/** Расширение файла по mime-типу картинки. */
function extensionFor(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/svg+xml') return 'svg';
  return mime.startsWith('image/') ? mime.slice('image/'.length) : 'bin';
}

/**
 * Собирает `File` из `data:`-URL картинки буфера. Имя — `clipboard-<timestamp>`
 * с расширением по mime; тип — из заголовка. `null` — это не картинка или
 * URL битый. Base64-тело декодируется в байты (`atob` есть и в renderer, и в
 * Node 22 — модуль тестируется без DOM).
 */
export function fileFromImageDataUrl(dataUrl: string, timestamp: number): File | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl.trim());
  if (match === null) return null;
  const mime = match[1] ?? '';
  if (!mime.startsWith('image/')) return null;
  const b64 = (match[2] ?? '').replace(/\s+/g, '');
  try {
    const binary = atob(b64);
    const buffer = new ArrayBuffer(binary.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i += 1) view[i] = binary.charCodeAt(i);
    return new File([buffer], `clipboard-${timestamp}.${extensionFor(mime)}`, { type: mime });
  } catch {
    return null;
  }
}
