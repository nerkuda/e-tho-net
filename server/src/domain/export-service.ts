/**
 * Export service (task C13, docs/03-server-api.md §14; phase P tasks P2/P3 for
 * the `.etnx` zip format).
 *
 * Produces a Markdown/HTML/PDF document or a `.etnx` zip archive for a set of
 * thoughts. Markdown/HTML/PDF are textual exports (legacy); `.etnx` is the
 * full graph slice including types, comments, attachments and properties, used
 * for import/export between networks.
 *
 * All formats complete synchronously (the job goes straight to `done`); the
 * async job machinery exists for symmetry with the future PDF renderer and for
 * the per-job TTL/cleanup semantics.
 *
 * MVP note: PDF generation requires a renderer (`puppeteer`); until that lands,
 * `startExportJob` fails PDF requests with a clear validation error while
 * `html` works fully (the HTML is also printable to PDF by the user).
 */

import { randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import archiver from 'archiver';

import {
  EtnError,
  ETNX_MAX_BYTES,
  type EtnxManifest,
  type EtnxManifestSource,
  type ExportEtnxOptions,
  type ExportFormat,
  type ExportJob,
  type PublicationExportReport,
} from '@etn/shared';
import { renderMarkdown } from '@etn/markdown';

import type { NetworkDb } from '../db/network-db.js';
import { logger } from '../logger.js';
import { buildManifest } from './etnx-format.js';
import { getThoughtOrThrow } from './thought-service.js';
import { listComments } from './comment-service.js';

interface ExportJobEntry extends ExportJob {
  /** Rendered body — string for markdown/html. Unused when `filePath` is set. */
  content?: string | Buffer;
  /** Path to a temp file holding the rendered body — used for `.etnx` zip
   *  exports (storing the whole zip in memory risks truncation; archiver
   *  emits non-fatal `warning`s that earlier rejected the in-memory pipeline). */
  filePath?: string;
  /** Requested output format (stored so the download route can pick a MIME type). */
  format?: ExportFormat;
  /** Explicit MIME type overriding {@link contentTypeFor} (e.g. publication zip). */
  contentType?: string;
  /** Рекомендуемое имя файла результата (переопределяет дефолт download-роута). */
  filename?: string;
  /** Отчёт джобы по публикациям (экспорт публикаций). */
  report?: PublicationExportReport | null;
  /** Wall-clock ms when the job reached a terminal state (for TTL sweep). */
  finishedAt?: number;
}

/** In-memory job store: `job_id -> ExportJobEntry`. */
const jobs = new Map<string, ExportJobEntry>();

/** How long a finished job's result stays retrievable (03-server-api.md §14 TTL). */
const JOB_RESULT_TTL_MS = 10 * 60 * 1000;

/** Drop finished jobs older than {@link JOB_RESULT_TTL_MS}; for jobs with a
 *  `filePath` (the `.etnx` exports) also remove the temp file. */
function sweepJobs(): void {
  const now = Date.now();
  for (const [id, entry] of jobs) {
    if (entry.finishedAt !== undefined && now - entry.finishedAt > JOB_RESULT_TTL_MS) {
      if (entry.filePath !== undefined) {
        try {
          unlinkSync(entry.filePath);
        } catch {
          // already gone — fine.
        }
      }
      jobs.delete(id);
    }
  }
}

function toPublicJob(entry: ExportJobEntry): ExportJob {
  return {
    job_id: entry.job_id,
    status: entry.status,
    download_url: entry.download_url,
    ...(entry.filename === undefined ? {} : { filename: entry.filename }),
    ...(entry.report === undefined ? {} : { report: entry.report }),
  };
}

/**
 * Register an already-rendered file-backed job under the shared job store.
 *
 * Publication exports (задача 6d87f1f2) build their zip in a temp file and only
 * need the job/status/download lifecycle of this service — they must not spin up
 * a second job mechanism. The entry is immediately `done`; the caller owns the
 * file, this service owns its cleanup on TTL (via {@link sweepJobs}).
 */
export function registerFinishedFileJob(input: {
  filePath: string;
  contentType: string;
  filename?: string;
  report?: PublicationExportReport | null;
}): ExportJob {
  const jobId = randomUUID();
  const entry: ExportJobEntry = {
    job_id: jobId,
    status: 'done',
    download_url: `/api/v1/jobs/${jobId}/download`,
    filePath: input.filePath,
    contentType: input.contentType,
    ...(input.filename === undefined ? {} : { filename: input.filename }),
    ...(input.report === undefined ? {} : { report: input.report }),
    finishedAt: Date.now(),
  };
  jobs.set(jobId, entry);
  return toPublicJob(entry);
}

/**
 * Build the Markdown document for `thoughtIds` (docs/03-server-api.md §14:
 * заголовки, постоянный комментарий, хронология, связи).
 */
export function exportToMarkdown(ndb: NetworkDb, thoughtIds: string[]): string {
  const lines: string[] = ['# Экспорт мыслесети ETN\n'];
  for (const id of thoughtIds) {
    const thought = getThoughtOrThrow(ndb, id);
    lines.push(`## ${thought.title}`);
    if (!thought.active) {
      lines.push(`\n> *Неактуальная мысль.*`);
    }
    const comments = listComments(ndb, 'thought', id);
    const permanent = comments.find((c) => c.kind === 'permanent');
    const chronological = comments.filter((c) => c.kind === 'chronological');
    if (permanent) {
      lines.push(`\n${permanent.body_md}`);
    }
    for (const c of chronological) {
      const range = c.valid_to ? `${c.valid_from} — ${c.valid_to}` : c.valid_from;
      lines.push(`\n### ${c.title ?? 'Хронология'}`);
      lines.push(`*${range}*\n`);
      lines.push(c.body_md);
    }
    const children = ndb
      .prepare(
        `SELECT t.title, lt.name_forward
           FROM links_v l
           JOIN thoughts_v t ON t.id = l.target_id
           LEFT JOIN link_types_v lt ON lt.id = l.type_id
          WHERE l.source_id = ? AND l.active = 1
          ORDER BY t.title COLLATE NOCASE`,
      )
      .all(id) as Array<{ title: string; name_forward: string | null }>;
    if (children.length > 0) {
      lines.push('\n**Связи:**\n');
      for (const child of children) {
        const label = child.name_forward ? `${child.name_forward} → ` : '';
        lines.push(`- ${label}${child.title}`);
      }
    }
    lines.push('\n---\n');
  }
  return lines.join('\n');
}

/** Wrap the Markdown document into a printable standalone HTML page. */
function markdownToHtml(markdown: string): string {
  // Unified pipeline (task M1): the same renderer as the cached comment HTML.
  const body = renderMarkdown(markdown, { maxLength: Infinity });
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>ETN export</title></head><body>${body}</body></html>`;
}

/**
 * Start an export job for the given thoughts and format. Markdown/HTML/PDF
 * complete synchronously (job goes straight to `done`); the `.etnx` zip
 * archive needs an async stream writer so the job reaches `done` after a
 * `Promise` resolves. The async signature is uniform for every format — the
 * REST route already awaits the result, so callers don't need branching.
 *
 * @param opts.etnx - options for `.etnx` exports (ignored for other formats).
 * @param source - provenance block written into the manifest.
 */
export async function startExportJob(
  ndb: NetworkDb,
  thoughtIds: string[],
  format: ExportFormat,
  opts: { etnx?: ExportEtnxOptions; source: EtnxManifestSource },
): Promise<ExportJob> {
  const jobId = randomUUID();
  const entry: ExportJobEntry = {
    job_id: jobId,
    status: 'done',
    download_url: `/api/v1/jobs/${jobId}/download`,
    format,
    finishedAt: Date.now(),
  };
  if (format === 'pdf') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'PDF export is not implemented on the MVP; use HTML and print to PDF',
    );
  } else if (format === 'etnx') {
    // Stream the zip into a temp file (avoids the in-memory `archiver.on('warning')`
    // pitfall that produced truncated archives in the first attempt).
    const filePath = path.join(os.tmpdir(), `etn-export-${jobId}.zip`);
    await exportToEtnx(ndb, thoughtIds, opts.etnx, opts.source, filePath);
    entry.filePath = filePath;
    // Рекомендуемое имя скачиваемого файла — `etn-<network>.etnx` (задача
    // 99c16033): REST download-роут отдаёт его в `content-disposition`.
    entry.filename = `etn-${sanitizeFilename(opts.source.network_name)}.etnx`;
  } else {
    const markdown = exportToMarkdown(ndb, thoughtIds);
    entry.content = format === 'html' ? markdownToHtml(markdown) : markdown;
  }
  jobs.set(jobId, entry);
  return toPublicJob(entry);
}

/** Status lookup for `GET /jobs/{id}` (03-server-api.md §14). */
export function getExportJob(jobId: string): ExportJob | null {
  sweepJobs();
  const entry = jobs.get(jobId);
  return entry ? toPublicJob(entry) : null;
}

/**
 * Rendered content of a finished export job, or `null` (not ready/unknown).
 *
 * For textual exports (markdown/html) the body is a `string`. For `.etnx` the
 * body is a `Buffer` loaded from the job's temp file. The file is NOT removed
 * here (задача 99c16033): the result must stay retrievable for the whole job
 * TTL, so a dropped/interrupted download can be retried. Cleanup happens in
 * {@link sweepJobs} once the TTL expires.
 *
 * @param format - preferred output format; falls back to the format stored
 *   with the job when omitted (the REST download route does not know it).
 */
export function getExportJobContent(
  jobId: string,
  format?: ExportFormat,
): { body: string | Buffer; contentType: string; filename?: string } | null {
  sweepJobs();
  const entry = jobs.get(jobId);
  if (!entry || entry.status !== 'done') return null;
  const effectiveFormat = format ?? entry.format ?? 'markdown';
  const contentType = entry.contentType ?? contentTypeFor(effectiveFormat);
  const filename = entry.filename;
  if (entry.filePath !== undefined) {
    if (!existsSync(entry.filePath)) return null;
    const buf = readFileSync(entry.filePath);
    return { body: buf, contentType, ...(filename === undefined ? {} : { filename }) };
  }
  if (entry.content === undefined) return null;
  return { body: entry.content, contentType, ...(filename === undefined ? {} : { filename }) };
}

/**
 * File-backed content of a finished export job, for the streaming REST download
 * route (задача 99c16033): the route pipes `createReadStream(filePath)` straight
 * to the socket instead of buffering the whole archive in memory, and can serve
 * the same job repeatedly until the TTL sweep removes the file.
 *
 * Returns `null` for unknown/not-done jobs and for jobs whose body lives in
 * memory (markdown/html) — those go through {@link getExportJobContent}.
 */
export function getExportJobFile(jobId: string): {
  filePath: string;
  contentType: string;
  size: number;
  filename?: string;
} | null {
  sweepJobs();
  const entry = jobs.get(jobId);
  if (!entry || entry.status !== 'done' || entry.filePath === undefined) return null;
  if (!existsSync(entry.filePath)) return null;
  const effectiveFormat = entry.format ?? 'markdown';
  const contentType = entry.contentType ?? contentTypeFor(effectiveFormat);
  let size: number;
  try {
    size = statSync(entry.filePath).size;
  } catch {
    return null;
  }
  const filename = entry.filename;
  return { filePath: entry.filePath, contentType, size, ...(filename === undefined ? {} : { filename }) };
}

/** MIME type for an export job's stored content. */
function contentTypeFor(format: ExportFormat): string {
  if (format === 'html') return 'text/html; charset=utf-8';
  if (format === 'markdown') return 'text/markdown; charset=utf-8';
  if (format === 'etnx') return 'application/zip';
  return 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// .etnx (phase P, task P2)
// ---------------------------------------------------------------------------

/** Счётчики экспортированного среза (из манифеста `.etnx`). */
export interface EtnxExportCounts {
  thoughts: number;
  links: number;
  attachments: number;
  thought_types: number;
  link_types: number;
}

/** Куда MCP `export.subgraph` пишет `.etnx` (симметрично `import.subgraph.source`). */
export interface EtnxFileDestination {
  /** Абсолютный путь на ФС сервера. */
  path: string;
  /** Перезаписать существующий файл (по умолчанию — запрещено). */
  overwrite?: boolean;
}

/**
 * Build a `.etnx` zip archive for the given root thoughts (phase P, P2). The
 * archive contains exactly two kinds of entries:
 *
 *   * `manifest.json` — full graph slice produced by `buildManifest`;
 *   * `attachments/<relpath>` — binary attachment files referenced by
 *     `manifest.attachments[].file_path` (only when `include_attachments`).
 *
 * The archive is streamed into `outputPath` (a caller-owned file inside
 * `os.tmpdir()`) so large exports don't sit in memory; the route streams the
 * file back to the client with a `createReadStream`. The file is the
 * caller's responsibility to delete (the job's TTL sweep does this for jobs
 * served through `startExportJob`).
 *
 * Returns the archive `size` and the manifest `counts` (задача 99c16033) —
 * the latter feed the MCP `export.subgraph.destination` summary response.
 */
export async function exportToEtnx(
  ndb: NetworkDb,
  rootIds: string[],
  opts: ExportEtnxOptions | undefined,
  source: EtnxManifestSource,
  outputPath: string,
): Promise<{ size: number; counts: EtnxExportCounts }> {
  const manifest = buildManifest(ndb, rootIds, opts, source, logger);
  const size = await collectZip(manifest, ndb, outputPath);
  if (size > ETNX_MAX_BYTES) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Размер .etnx превысил лимит ${ETNX_MAX_BYTES} байт (получено ${size}). ` +
        'Отключите вложения или уменьшите subtree_depth.',
      { limit: ETNX_MAX_BYTES, actual: size },
    );
  }
  return {
    size,
    counts: {
      thoughts: manifest.thoughts.length,
      links: manifest.links.length,
      attachments: manifest.attachments.length,
      thought_types: manifest.thought_types.length,
      link_types: manifest.link_types.length,
    },
  };
}

/**
 * Записать `.etnx` по абсолютному пути назначения (задача 99c16033).
 *
 * Отдельный вход (не через job store) для MCP `export.subgraph.destination`:
 * сервер пишет архив прямо по пути и возвращает `{ path, size, counts }` —
 * без base64 в ответе. Правила безопасности:
 *
 *   * `path` обязан быть абсолютным (`VALIDATION_ERROR` иначе);
 *   * каталог назначения должен существовать, иначе `VALIDATION_ERROR`;
 *   * существующий файл перезаписывается только при `overwrite: true`;
 *   * сбой записи (нет прав/места) → `INTERNAL` с понятным сообщением; при
 *     сбое недописанный файл удаляется.
 */
export async function exportToEtnxFile(
  ndb: NetworkDb,
  rootIds: string[],
  opts: ExportEtnxOptions | undefined,
  source: EtnxManifestSource,
  destination: EtnxFileDestination,
): Promise<{ path: string; size: number; counts: EtnxExportCounts }> {
  const target = resolveEtnxTargetPath(destination);
  try {
    const { size, counts } = await exportToEtnx(ndb, rootIds, opts, source, target);
    return { path: target, size, counts };
  } catch (err) {
    // Не оставляем недописанный/частичный архив на диске.
    try {
      unlinkSync(target);
    } catch {
      // файла нет или уже удалён — не мешает.
    }
    if (err instanceof EtnError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    throw new EtnError(
      'INTERNAL',
      `Не удалось записать .etnx по пути ${target}: ${err instanceof Error ? err.message : String(err)}`,
      { path: target, ...(code === undefined ? {} : { code }) },
    );
  }
}

/**
 * Проверить путь назначения и вернуть его как есть. Никаких побочных
 * эффектов — файл ещё не создан. Бросает `VALIDATION_ERROR` с указанием
 * поля `destination.path`.
 */
function resolveEtnxTargetPath(destination: EtnxFileDestination): string {
  const target = destination.path;
  if (!path.isAbsolute(target)) {
    throw new EtnError('VALIDATION_ERROR', `destination.path должен быть абсолютным: ${target}`, {
      field: 'destination.path',
    });
  }
  const dir = path.dirname(target);
  let dirStat;
  try {
    dirStat = statSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new EtnError('VALIDATION_ERROR', `Каталог назначения не найден: ${dir}`, {
      field: 'destination.path',
      ...(code === undefined ? {} : { code }),
    });
  }
  if (!dirStat.isDirectory()) {
    throw new EtnError('VALIDATION_ERROR', `Каталог назначения — не каталог: ${dir}`, {
      field: 'destination.path',
    });
  }
  if (existsSync(target)) {
    if (destination.overwrite !== true) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `Файл уже существует: ${target}. Передайте overwrite: true, чтобы перезаписать.`,
        { field: 'destination.path' },
      );
    }
    if (statSync(target).isDirectory()) {
      throw new EtnError('VALIDATION_ERROR', `Путь назначения — каталог: ${target}`, {
        field: 'destination.path',
      });
    }
  }
  return target;
}

/** Имя файла для download-роута: убрать символы, невалидные в имени файла. */
function sanitizeFilename(name: string): string {
  const cleaned = Array.from(name)
    // Управляющие символы (код < 0x20) в имени файла недопустимы.
    .filter((ch) => ch.charCodeAt(0) >= 0x20)
    .join('')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'network';
}

/**
 * Stream the manifest + referenced attachments into `outputPath` via
 * `archiver.pipe(fs.createWriteStream(path))`. Two failure modes from the
 * first attempt are explicitly handled:
 *
 *   1. `archiver.on('warning')` is logged but **does not** reject — the
 *      earlier `reject(err)` made the export fail with a partial zip the
 *      moment `archiver` emitted any non-fatal diagnostic, which happened
 *      for every empty attachment entry.
 *   2. The Promise only resolves after the file stream's `close` event —
 *      `archive.finalize()` schedules the closing chunks asynchronously
 *      and resolving earlier produced a truncated zip.
 */
function collectZip(manifest: EtnxManifest, ndb: NetworkDb, outputPath: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const fileStream = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    let settled = false;

    fileStream.on('close', () => {
      if (settled) return;
      settled = true;
      try {
        const stat = statSync(outputPath);
        resolve(stat.size);
      } catch {
        resolve(0);
      }
    });
    fileStream.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    archive.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    archive.on('warning', (err: Error) => {
      logger.warn({ err: err.message }, 'archiver warning — non-fatal, ignoring');
    });

    archive.pipe(fileStream);

    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    const attachDir = path.join(path.dirname(ndb.dbPath), 'attachments');
    // Дедупликация имён внутри архива: строка-вложение-обложка публикации
    // ссылается на тот же физический файл, что и вложение мысли (ADR 73cfcf64),
    // поэтому два ряда манифеста дают один и тот же `attachments/<basename>`.
    // Повторный `append` создал бы дубль-запись в zip.
    const archived = new Set<string>();
    for (const att of manifest.attachments) {
      if (att.kind !== 'file' || att.file_path === null) continue;
      const rel = att.file_path.replace(/^\/+/, '');
      if (archived.has(rel)) continue;
      const abs = joinWithinDir(attachDir, rel);
      if (abs === null) continue;
      if (!existsSync(abs)) {
        logger.warn({ rel }, 'attachment missing on export — skipping');
        continue;
      }
      archived.add(rel);
      archive.append(createReadStream(abs), { name: `attachments/${rel}` });
    }

    void archive.finalize();
  });
}

/**
 * Resolve `attachments/<rel>` against the network's `attachments/` directory.
 * Returns `null` for path-traversal attempts (zip-slip protection). The
 * `rel` argument is the literal attachment file basename as stored in the DB,
 * never user input — this guard is a defence-in-depth check.
 */
function joinWithinDir(dir: string, rel: string): string | null {
  if (rel.includes('..') || rel.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rel)) return null;
  return `${dir.replace(/[\\/]+$/, '')}/${rel}`;
}
