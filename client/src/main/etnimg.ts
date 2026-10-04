/**
 * Транспорт картинок и файлов-вложений клиента — схема `etnimg`
 * (0.11.1, ошибка 280a322b; ADR «Формы адреса схемы etnimg: файл по пути
 * и вложение по id»).
 *
 * Схема обслуживает два вида адресов:
 *
 * 1. **По пути** — `etnimg://<диск>/<путь…>` (Windows-диск одной латинской
 *    буквой) либо `etnimg://<первый-сегмент>/…` для POSIX-абсолютного пути.
 *    Так адресуются файлы, `file_path` которых уже известен вызывающему коду
 *    (`etnimgUrl` в рендерере): превью вложений, `![](etnimg:…)` в комментариях.
 * 2. **По id вложения** — `etnimg://attachment/<id>`. Так адресуется картинка,
 *    когда известен только id вложения (обложка публикации в списках,
 *    заголовке рабочей области и титульном блоке чтения). Файл вложения сперва
 *    читается локально, а если его нет на этой машине (вложение хранит
 *    УДАЛЁННЫЙ сервер) — скачивается по REST у активного соединения.
 *
 * Модуль намеренно не тянет `electron`: разбор адреса и порядок отдачи — чистая
 * логика с внедряемыми зависимостями, поэтому обе ветки (локальное чтение и
 * загрузка с сервера) покрыты юнит-тестами.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Content types для файлов, отдаваемых схемой `etnimg`. */
export const ETNIMG_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  // Text attachments («Показать» in the attachment context menu, L1).
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  markdown: 'text/plain; charset=utf-8',
};

/** A server-downloaded attachment file (etnimg fallback for remote servers). */
export interface ServerAttachmentFile {
  contentType: string;
  body: Buffer;
}

/** Разобранный адрес схемы `etnimg`. */
export type EtnimgTarget =
  | { kind: 'attachment'; attachmentId: string }
  | { kind: 'file'; filePath: string };

/** Сегмент «attachment» в хосте URL — признак адреса по id вложения. */
const ATTACHMENT_HOST = 'attachment';
/** id вложения: uuid-подобный (защита от мусора и path traversal). */
const ATTACHMENT_ID_RE = /^[0-9a-zA-Z-]{1,64}$/;

/**
 * Разбирает `etnimg`-адрес. Возвращает `null` для чужой схемы, пустого хоста
 * и адреса-вложения без корректного id. Сегменты `.`/`..` отбрасываются.
 */
export function parseEtnimgTarget(rawUrl: string): EtnimgTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'etnimg:') return null;
  const host = decodeURIComponent(url.hostname).toLowerCase();
  const segments = decodeURIComponent(url.pathname)
    .split('/')
    .filter((s) => s !== '' && s !== '.' && s !== '..');
  if (host === '') return null;

  if (host === ATTACHMENT_HOST) {
    const id = segments[0];
    if (segments.length !== 1 || id === undefined || !ATTACHMENT_ID_RE.test(id)) return null;
    return { kind: 'attachment', attachmentId: id };
  }
  if (segments.length === 0) return null;
  // Windows drive host ("c") → `C:\…`; anything else → a POSIX absolute path
  // (`/host/segments…`) whose local read simply fails on Windows clients.
  const filePath = /^[a-z]$/.test(host)
    ? path.join(`${host}:`, ...segments)
    : `/${[host, ...segments].join('/')}`;
  return { kind: 'file', filePath };
}

/** Content type по расширению пути (для локально прочитанных файлов). */
export function etnimgContentType(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  return ETNIMG_CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Результат отдачи `etnimg`-адреса. */
export type EtnimgServeResult =
  | { ok: true; body: Buffer; contentType: string }
  | { ok: false; status: number; message: string };

/** Зависимости отдачи — внедряются, чтобы логику можно было проверить тестом. */
export interface EtnimgServeDeps {
  /** `file_path` вложения по его id (или `null`, если вложения нет/оно не файл). */
  resolveAttachmentFilePath(attachmentId: string): Promise<string | null>;
  /** Скачать серверную копию файла по абсолютному пути (удалённый сервер). */
  fetchServerFile(filePath: string): Promise<ServerAttachmentFile | null>;
  /** Локальное чтение файла; по умолчанию — `statSync` + `readFileSync`. */
  readLocalFile?(filePath: string): Buffer | null;
}

/** Локальное чтение «как есть»: нет файла/нет прав — `null` (не исключение). */
function defaultReadLocalFile(filePath: string): Buffer | null {
  try {
    if (!statSync(filePath).isFile()) return null;
    return readFileSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Отдаёт `etnimg`-адрес: разбирает его, при адресе по id резолвит `file_path`
 * вложения, затем пробует локальное чтение и, если файла на этой машине нет,
 * скачивает серверную копию. Ошибки — `{ ok: false, status }`, чтобы main
 * превратил их в `Response` (заглушка картинки остаётся на стороне рендерера).
 */
export async function serveEtnimgRequest(
  rawUrl: string,
  deps: EtnimgServeDeps,
): Promise<EtnimgServeResult> {
  const target = parseEtnimgTarget(rawUrl);
  if (target === null) {
    return { ok: false, status: 400, message: 'bad etnimg url' };
  }

  let filePath: string;
  if (target.kind === 'attachment') {
    const resolved = await deps.resolveAttachmentFilePath(target.attachmentId);
    if (resolved === null) {
      return { ok: false, status: 404, message: 'attachment not found' };
    }
    filePath = resolved;
  } else {
    filePath = target.filePath;
  }

  const readLocal = deps.readLocalFile ?? defaultReadLocalFile;
  const local = readLocal(filePath);
  if (local !== null) {
    return { ok: true, body: local, contentType: etnimgContentType(filePath) };
  }

  const serverFile = await deps.fetchServerFile(filePath);
  if (serverFile === null) {
    return { ok: false, status: 404, message: 'not found' };
  }
  return { ok: true, body: serverFile.body, contentType: serverFile.contentType };
}
