/**
 * `content-disposition` для скачиваемых файлов (ошибка 175b2803).
 *
 * Node отвергает не-латиницу в значении заголовка (`ERR_INVALID_CHAR`), а
 * имена файлов приходят из пользовательских данных (display_name сети,
 * имена вложений). Значение всегда собирается в ASCII:
 *
 *   * `filename*` — RFC 5987 (`UTF-8''<percent-encoded>`), современные
 *     клиенты берут из него настоящее имя;
 *   * `filename` — ASCII-fallback для старых клиентов (не-ASCII → `_`).
 *
 * Значение гарантированно не содержит управляющих символов, кавычек и
 * обратных слэшей, поэтому `reply.header()` не может уронить процесс.
 */

export type ContentDispositionKind = 'attachment' | 'inline';

/** Процентное кодирование по RFC 5987 (attr-char, UTF-8). */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** ASCII-fallback: не-ASCII/управляющие символы заменяются на `_`. */
function asciiFallback(value: string): string {
  return Array.from(value)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code > 0x7e || ch === '"' || ch === '\\') return '_';
      return ch;
    })
    .join('');
}

/**
 * Собрать значение заголовка `content-disposition`.
 * `filename` — рекомендуемое имя; пустое имя превращается в `download`.
 */
export function buildContentDisposition(
  kind: ContentDispositionKind,
  filename: string | null | undefined,
): string {
  const name = filename !== null && filename !== undefined && filename.length > 0 ? filename : 'download';
  const cleaned = asciiFallback(name);
  const fallback = cleaned.length > 0 ? cleaned : 'download';
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}
