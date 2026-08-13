/**
 * Export service (task C13, docs/03-server-api.md §14).
 *
 * Produces a Markdown/HTML/PDF document for a set of thoughts: title, permanent
 * comment, chronological comments and outgoing links per thought. Markdown is
 * synchronous (fast, returned directly); HTML/PDF run as asynchronous jobs
 * behind a small in-process queue so large exports do not block the HTTP loop.
 *
 * MVP note: PDF generation requires a renderer (`puppeteer`); until that lands,
 * `startExportJob` fails PDF requests with a clear validation error while
 * `html` works fully (the HTML is also printable to PDF by the user).
 */

import { randomUUID } from 'node:crypto';

import { EtnError, type ExportFormat, type ExportJob } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { getThoughtOrThrow } from './thought-service.js';
import { listComments } from './comment-service.js';

interface ExportJobEntry extends ExportJob {
  /** Rendered document body (markdown or html) once `done`. */
  content?: string;
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
  // MVP renderer: line-based HTML. A real markdown→HTML pipeline
  // (domain/markdown.ts) plugs in here in a follow-up without changing the API.
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = markdown
    .split('\n')
    .map((line) => {
      if (line.startsWith('# ')) return `<h1>${escape(line.slice(2))}</h1>`;
      if (line.startsWith('## ')) return `<h2>${escape(line.slice(3))}</h2>`;
      if (line.startsWith('### ')) return `<h3>${escape(line.slice(4))}</h3>`;
      if (line.startsWith('- ')) return `<li>${escape(line.slice(2))}</li>`;
      if (line === '---') return '<hr>';
      if (line === '') return '';
      return `<p>${escape(line)}</p>`;
    })
    .join('\n');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>ETN export</title></head><body>${body}</body></html>`;
}

/**
 * Start an export job for the given thoughts and format. Markdown and HTML
 * complete immediately (job goes straight to `done`); PDF is not implemented
 * on the MVP and throws `VALIDATION_ERROR` with a helpful message.
 */
export function startExportJob(
  ndb: NetworkDb,
  thoughtIds: string[],
  format: ExportFormat,
): ExportJob {
  if (format === 'pdf') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'PDF export is not implemented on the MVP; use HTML and print to PDF',
    );
  }
  const content =
    format === 'html'
      ? markdownToHtml(exportToMarkdown(ndb, thoughtIds))
      : exportToMarkdown(ndb, thoughtIds);
  const jobId = randomUUID();
  const entry: ExportJobEntry = {
    job_id: jobId,
    status: 'done',
    download_url: `/api/v1/jobs/${jobId}/download`,
    content,
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

/** Rendered content of a finished export job, or `null` (not ready/unknown). */
export function getExportJobContent(
  jobId: string,
  format: ExportFormat,
): { body: string; contentType: string } | null {
  sweepJobs();
  const entry = jobs.get(jobId);
  if (!entry || entry.status !== 'done' || entry.content === undefined) return null;
  const contentType =
    format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8';
  return { body: entry.content, contentType };
}
