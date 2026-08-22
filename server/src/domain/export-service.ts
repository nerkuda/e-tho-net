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
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import archiver from 'archiver';
import { Writable } from 'node:stream';

import {
  EtnError,
  ETNX_MAX_BYTES,
  type EtnxManifest,
  type EtnxManifestSource,
  type ExportEtnxOptions,
  type ExportFormat,
  type ExportJob,
} from '@etn/shared';
import { renderMarkdown } from '@etn/markdown';

import type { NetworkDb } from '../db/network-db.js';
import { logger } from '../logger.js';
import { buildManifest } from './etnx-format.js';
import { getThoughtOrThrow } from './thought-service.js';
import { listComments } from './comment-service.js';

interface ExportJobEntry extends ExportJob {
  /** Rendered body — string for markdown/html, Buffer for .etnx (zip binary). */
  content?: string | Buffer;
  /** Requested output format (stored so the download route can pick a MIME type). */
  format?: ExportFormat;
  /** Wall-clock ms when the job reached a terminal state (for TTL sweep). */
  finishedAt?: number;
}

/** In-memory job store: `job_id -> ExportJobEntry`. */
const jobs = new Map<string, ExportJobEntry>();

/** How long a finished job's result stays retrievable (03-server-api.md §14 TTL). */
const JOB_RESULT_TTL_MS = 10 * 60 * 1000;

/** Drop finished jobs older than {@link JOB_RESULT_TTL_MS}. */
function sweepJobs(): void {
  const now = Date.now();
  for (const [id, entry] of jobs) {
    if (entry.finishedAt !== undefined && now - entry.finishedAt > JOB_RESULT_TTL_MS) {
      jobs.delete(id);
    }
  }
}

function toPublicJob(entry: ExportJobEntry): ExportJob {
  return { job_id: entry.job_id, status: entry.status, download_url: entry.download_url };
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
           FROM links l
           JOIN thoughts t ON t.id = l.target_id
           LEFT JOIN link_types lt ON lt.id = l.type_id
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
  let content: string | Buffer;
  if (format === 'pdf') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'PDF export is not implemented on the MVP; use HTML and print to PDF',
    );
  } else if (format === 'etnx') {
    content = await exportToEtnx(ndb, thoughtIds, opts.etnx, opts.source);
  } else {
    const markdown = exportToMarkdown(ndb, thoughtIds);
    content = format === 'html' ? markdownToHtml(markdown) : markdown;
  }
  const jobId = randomUUID();
  const entry: ExportJobEntry = {
    job_id: jobId,
    status: 'done',
    download_url: `/api/v1/jobs/${jobId}/download`,
    content,
    format,
    finishedAt: Date.now(),
  };
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
 * @param format - preferred output format; falls back to the format stored
 *   with the job when omitted (the REST download route does not know it).
 */
export function getExportJobContent(
  jobId: string,
  format?: ExportFormat,
): { body: string | Buffer; contentType: string } | null {
  sweepJobs();
  const entry = jobs.get(jobId);
  if (!entry || entry.status !== 'done' || entry.content === undefined) return null;
  const effectiveFormat = format ?? entry.format ?? 'markdown';
  const contentType = contentTypeFor(effectiveFormat);
  return { body: entry.content, contentType };
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

/**
 * Build a `.etnx` zip archive for the given root thoughts (phase P, P2). The
 * archive contains exactly two kinds of entries:
 *
 *   * `manifest.json` — full graph slice produced by `buildManifest`;
 *   * `attachments/<relpath>` — binary attachment files referenced by
 *     `manifest.attachments[].file_path` (only when `include_attachments`).
 *
 * The zip is collected into memory and bounded by {@link ETNX_MAX_BYTES} —
 * large exports fail fast with `VALIDATION_ERROR` rather than blocking the
 * HTTP loop. Streaming into `reply.raw` is a future optimisation.
 */
export async function exportToEtnx(
  ndb: NetworkDb,
  rootIds: string[],
  opts: ExportEtnxOptions | undefined,
  source: EtnxManifestSource,
): Promise<Buffer> {
  const manifest = buildManifest(ndb, rootIds, opts, source, logger);
  const zip = await collectZip(manifest, ndb);
  if (zip.length > ETNX_MAX_BYTES) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Размер .etnx превысил лимит ${ETNX_MAX_BYTES} байт (получено ${zip.length}). ` +
        'Отключите вложения или уменьшите subtree_depth.',
      { limit: ETNX_MAX_BYTES, actual: zip.length },
    );
  }
  return zip;
}

/** Stream the manifest + referenced attachments into a single in-memory zip. */
function collectZip(manifest: EtnxManifest, ndb: NetworkDb): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const archive = archiver('zip', { zlib: { level: 9 } });
  const finished = new Promise<void>((resolve, reject) => {
    sink.on('finish', (): void => resolve());
    archive.on('warning', (err: Error): void => reject(err));
    archive.on('error', (err: Error): void => reject(err));
  });
  archive.pipe(sink);

  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

  const attachDir = path.join(path.dirname(ndb.dbPath), 'attachments');
  for (const att of manifest.attachments) {
    if (att.kind !== 'file' || att.file_path === null) continue;
    const rel = att.file_path.replace(/^\/+/, '');
    const abs = joinWithinDir(attachDir, rel);
    if (abs === null) continue;
    try {
      archive.append(createReadStream(abs), { name: `attachments/${rel}` });
    } catch {
      // Missing/unreadable file — skip silently (a missing attachment does
      // not invalidate the export; the importer will see `file_path` and may
      // log a warning at apply time).
    }
  }

  void archive.finalize();
  return finished.then(() => Buffer.concat(chunks));
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
