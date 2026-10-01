/**
 * Экспорт документа публикации в Markdown/HTML (0.11.1, задача 6d87f1f2;
 * операции 1f161c74 одиночный и 074d7a97 пакетный; требования детерминизма
 * a26135ad, ссылок 888453b6, ассетов 975b159a, титула 745fdc48; ADR 06874c5d).
 *
 * Документ собирается ТЕМ ЖЕ кодом, что `/assembly` (см.
 * `buildPublicationExportDocument`): одна сборка даёт и markdown-источники, и
 * HTML-фрагменты, поэтому превью и файл не расходятся ([[#9969e586]]).
 *
 * **Артефакт — всегда zip** (оба формата). Файлы создаются в temp-файле и
 * стримятся `archiver`'ом; инфраструктура джоб НЕ дублируется — готовый
 * файл регистрируется в общем сторе (`registerFinishedFileJob`).
 *
 * **Детерминизм** ([[#a26135ad]], [[#06874c5d]]): фиксированные метки времени
 * zip-записей, детерминированные имена (slug + суффикс `-<shortid>` при
 * коллизии; имена ассетов — от содержимого), стабильный порядок записей
 * (сортировка). В артефакты НЕ попадает время сборки.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import archiver from 'archiver';

import {
  EtnError,
  type ExportJob,
  type PublicationExportEntry,
  type PublicationExportFormat,
  type PublicationExportReport,
} from '@etn/shared';
import {
  buildToc,
  renderPublicationFragment,
  renderPublicationMarkdownFragment,
  shortId,
  type TocNode,
} from '@etn/markdown';

import type { NetworkDb } from '../db/network-db.js';
import { logger } from '../logger.js';
import { getAttachment } from './attachment-service.js';
import { getPublication, listPublications } from './publication-service.js';
import {
  buildPublicationExportDocument,
  type PublicationExportDocument,
  type PublicationExportSection,
} from './publication-assembly-service.js';
import { registerFinishedFileJob } from './export-service.js';

/**
 * Потолок числа публикаций в пакетном экспорте (прецедент серверных
 * бюджетов: работа с целым графом публикаций). Явный список сверх потолка —
 * `VALIDATION_ERROR`; `active_only` усекается с предупреждением (усечение,
 * не отказ — как в отборах).
 */
export const PUBLICATION_EXPORT_BATCH_MAX = 100;

/**
 * Фиксированная метка времени всех записей zip (ADR 06874c5d). Константа, а
 * не время сборки — иначе повторный экспорт давал бы разные байты.
 */
const ZIP_ENTRY_DATE = new Date(Date.UTC(2020, 0, 1));

/** Каталог картинок-вложений внутри архива (требование 975b159a). */
const ASSETS_DIR = 'assets';

/** Размер короткого хеша содержимого ассета (hex-символов). */
const ASSET_HASH_LENGTH = 8;

/** Транслитерация кириллицы для slug (детерминированная, без библиотек). */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Deterministic transliterated slug of a publication title (card 1f161c74). */
export function publicationSlug(title: string): string {
  const latin = [...title.toLowerCase()]
    .map((ch) => (Object.prototype.hasOwnProperty.call(TRANSLIT, ch) ? TRANSLIT[ch]! : ch))
    .join('');
  const slug = latin
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug === '' ? 'publication' : slug;
}

/** Escape a string for HTML text/attribute output. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Dispatch a publication export builder (markdown or standalone HTML). */
function renderDocument(
  document: PublicationExportDocument,
  format: PublicationExportFormat,
  coverSrc: string | null,
): string {
  return format === 'md'
    ? renderMarkdownDocument(document, coverSrc)
    : renderHtmlDocument(document, coverSrc);
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * Full Markdown document: title block (H1), then sections (root = H2). Each
 * block carries an explicit `<a id="pub-<shortid>">` anchor so in-document
 * `[title](#pub-…)` links stay clickable in renderers that keep raw HTML.
 */
function renderMarkdownDocument(
  document: PublicationExportDocument,
  coverSrc: string | null,
): string {
  const parts: string[] = [];
  const { title } = document;
  parts.push(`# ${title.title}`);
  if (title.subtitle !== null && title.subtitle.trim() !== '') parts.push(title.subtitle);
  if (coverSrc !== null) parts.push(`![${title.title}](${coverSrc})`);
  parts.push(`**Автор:** ${title.authorship ?? title.creator}`);
  if (title.assembly_date !== null) parts.push(`**Дата сборки:** ${title.assembly_date}`);
  if (title.summary_md.trim() !== '') parts.push(title.summary_md.trim());
  for (const section of document.sections) parts.push(renderMarkdownSection(section, document.resolveLink));
  return `${parts.filter((p) => p.trim() !== '').join('\n\n')}\n`;
}

/** Markdown of one section (recursive over children). */
function renderMarkdownSection(
  section: PublicationExportSection,
  resolveLink: PublicationExportDocument['resolveLink'],
): string {
  const parts: string[] = [];
  parts.push(`<a id="${section.anchor}"></a>`);
  parts.push(`${'#'.repeat(section.level + 1)} ${section.heading}`);
  if (section.preamble_md.trim() !== '') {
    parts.push(
      renderPublicationMarkdownFragment(section.preamble_md, {
        baseLevel: section.level + 1,
        resolveLink,
      }).markdown,
    );
  }
  for (const text of section.texts) {
    parts.push(`<a id="${text.anchor}"></a>`);
    if (text.body_md.trim() !== '') {
      parts.push(
        renderPublicationMarkdownFragment(text.body_md, {
          baseLevel: section.level + 1,
          resolveLink,
        }).markdown,
      );
    }
  }
  if (section.extra.length > 0) {
    const lines = ['**Дополнительные материалы**'];
    for (const group of section.extra) {
      lines.push(`- ${group.property}: ${group.targets.map((t) => t.title).join(', ')}`);
    }
    parts.push(lines.join('\n'));
  }
  for (const child of section.children) parts.push(renderMarkdownSection(child, resolveLink));
  return parts.filter((p) => p.trim() !== '').join('\n\n');
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** Standalone printable HTML document (title, TOC, styles, sections). */
function renderHtmlDocument(
  document: PublicationExportDocument,
  coverSrc: string | null,
): string {
  const { title } = document;
  const head = `<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<title>${escapeHtml(title.title)}</title>\n<style>${PUBLICATION_HTML_STYLES}</style>\n</head>\n<body>\n`;
  const header: string[] = ['<header class="pub-title">'];
  if (coverSrc !== null) {
    header.push(`<img class="pub-cover" src="${escapeHtml(coverSrc)}" alt="">`);
  }
  header.push(`<h1>${escapeHtml(title.title)}</h1>`);
  if (title.subtitle !== null && title.subtitle.trim() !== '') {
    header.push(`<p class="pub-subtitle">${escapeHtml(title.subtitle)}</p>`);
  }
  header.push(`<p class="pub-meta">Автор: ${escapeHtml(title.authorship ?? title.creator)}</p>`);
  if (title.assembly_date !== null) {
    header.push(`<p class="pub-meta">Дата сборки: ${escapeHtml(title.assembly_date)}</p>`);
  }
  if (title.summary_md.trim() !== '') {
    header.push(
      `<div class="pub-summary">${renderPublicationFragment(title.summary_md, { resolveLink: document.resolveLink }).html}</div>`,
    );
  }
  header.push('</header>');

  const toc = renderToc(buildToc(document.headings));
  const main = document.sections.map((s) => renderHtmlSection(s)).join('\n');

  return `${head}${header.join('\n')}\n<nav class="pub-toc"><h2>Оглавление</h2>${toc}</nav>\n<main class="pub-body">\n${main}\n</main>\n</body>\n</html>\n`;
}

/** Nested TOC list from the flat heading tree (`buildToc`). */
function renderToc(nodes: readonly TocNode[]): string {
  if (nodes.length === 0) return '';
  const items = nodes
    .map((node) => {
      const label = escapeHtml(node.text);
      const body =
        node.anchor === null ? label : `<a href="#${escapeHtml(node.anchor)}">${label}</a>`;
      return `<li>${body}${renderToc(node.children)}</li>`;
    })
    .join('');
  return `<ul>${items}</ul>`;
}

/** HTML of one section (recursive over children); anchors are element ids. */
function renderHtmlSection(section: PublicationExportSection): string {
  const parts: string[] = [`<section id="${escapeHtml(section.anchor)}">`];
  const level = Math.min(section.level + 1, 6);
  parts.push(`<h${level}>${escapeHtml(section.heading)}</h${level}>`);
  if (section.preamble_html.trim() !== '') parts.push(section.preamble_html);
  for (const text of section.texts) {
    parts.push(`<div class="pub-text" id="${escapeHtml(text.anchor)}">${text.body_html}</div>`);
  }
  if (section.extra.length > 0) {
    const groups = section.extra
      .map(
        (group) =>
          `<dt>${escapeHtml(group.property)}</dt><dd>${group.targets.map((t) => escapeHtml(t.title)).join(', ')}</dd>`,
      )
      .join('');
    parts.push(`<aside class="pub-extra"><h3>Дополнительные материалы</h3><dl>${groups}</dl></aside>`);
  }
  for (const child of section.children) parts.push(renderHtmlSection(child));
  parts.push('</section>');
  return parts.join('\n');
}

/** Minimal self-contained stylesheet of the exported document. */
const PUBLICATION_HTML_STYLES = [
  'body{font-family:system-ui,Segoe UI,Roboto,sans-serif;line-height:1.55;max-width:52rem;margin:0 auto;padding:2rem;color:#1f2328}',
  'h1,h2,h3,h4,h5,h6{line-height:1.25}',
  '.pub-cover{max-width:100%;height:auto;border-radius:8px}',
  '.pub-subtitle{color:#57606a;font-size:1.1rem}',
  '.pub-meta{color:#57606a;font-size:.9rem;margin:.2rem 0}',
  '.pub-toc{border:1px solid #d0d7de;border-radius:8px;padding:1rem 1.5rem;margin:2rem 0}',
  '.pub-text{margin:1rem 0}',
  '.pub-extra{border-left:3px solid #d0d7de;padding-left:1rem;color:#57606a}',
  'img{max-width:100%}',
].join('');

// ---------------------------------------------------------------------------
// Ассеты (требование 975b159a)
// ---------------------------------------------------------------------------

/** Один файл ассета, скопированный в архив. */
interface AssetFile {
  /** Имя внутри каталога `assets/` (детерминированное). */
  name: string;
  /** Абсолютный путь исходного файла в attachments-директории сети. */
  absPath: string;
}

/** Результат сбора ассетов: карта замен URL → относительный путь и файлы. */
interface AssetCollection {
  replacements: Map<string, string>;
  files: AssetFile[];
  warnings: string[];
}

/** `etnimg://…` URL inside markdown/HTML output. */
const ETNIMG_URL_RE = /etnimg:\/\/[^\s"'<>)]+/g;

/** Абсолютный путь сети к её attachments-директории. */
function attachmentsDir(ndb: NetworkDb): string {
  return path.join(path.dirname(ndb.dbPath), 'attachments');
}

/**
 * `etnimg://<host>/<path…>` → absolute file path (inverse of the client's
 * `etnimgUrl`). Returns `null` for a malformed URL.
 */
function decodeEtnimgUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'etnimg:') return null;
  let host: string;
  let pathname: string;
  try {
    host = decodeURIComponent(url.hostname);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const segments = pathname.split('/').filter((s) => s !== '' && s !== '.' && s !== '..');
  if (host === '' || segments.length === 0) return null;
  return /^[a-zA-Z]$/.test(host) ? `${host}:\\${segments.join('\\')}` : `/${[host, ...segments].join('/')}`;
}

/** Normalized absolute path for containment checks (case-folded on Windows). */
function normalizeForCompare(abs: string): string {
  const normalized = path.resolve(abs).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** True when `abs` lives inside the network's attachments directory. */
function isInsideAttachments(dir: string, abs: string): boolean {
  const root = normalizeForCompare(dir);
  const target = normalizeForCompare(abs);
  return target === root || target.startsWith(`${root}/`);
}

/** Extract unique `etnimg://` URLs from a set of fragment sources. */
function collectEtnimgUrls(sources: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    for (const match of source.matchAll(ETNIMG_URL_RE)) {
      const url = match[0];
      if (!seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
  }
  return out;
}

/** Deterministic asset name from file content: `<hash8><ext>`. */
function assetNameFor(absPath: string): string {
  const hash = createHash('sha1').update(readFileSync(absPath)).digest('hex').slice(0, ASSET_HASH_LENGTH);
  const ext = path.extname(absPath).toLowerCase().replace(/[^a-z0-9.]/g, '');
  return `${hash}${ext}`;
}

/**
 * Copy server-available image attachments referenced by `sources` into the
 * archive's `assets/` directory. Missing files, client-local paths and
 * external URLs produce a warning and leave the `src` untouched — the document
 * never fails (requirement 975b159a).
 */
function collectAssets(ndb: NetworkDb, sources: readonly string[], withAssets: boolean): AssetCollection {
  const replacements = new Map<string, string>();
  const files: AssetFile[] = [];
  const warnings: string[] = [];
  if (!withAssets) return { replacements, files, warnings };

  const dir = attachmentsDir(ndb);
  const byName = new Map<string, string>(); // name → absPath (dedup identical content)
  for (const url of collectEtnimgUrls(sources)) {
    const abs = decodeEtnimgUrl(url);
    if (abs === null) {
      warnings.push(`вложение недоступно: не разобран URL ${url}`);
      continue;
    }
    if (!isInsideAttachments(dir, abs)) {
      warnings.push(`вложение недоступно: путь вне каталога сервера (${path.basename(abs)})`);
      continue;
    }
    if (!existsSync(abs)) {
      warnings.push(`вложение недоступно: файл не найден на сервере (${path.basename(abs)})`);
      continue;
    }
    let name: string;
    try {
      name = assetNameFor(abs);
    } catch {
      warnings.push(`вложение недоступно: не удалось прочитать файл (${path.basename(abs)})`);
      continue;
    }
    if (!byName.has(name)) {
      byName.set(name, abs);
      files.push({ name, absPath: abs });
    }
    replacements.set(url, `${ASSETS_DIR}/${name}`);
  }
  return { replacements, files, warnings };
}

/** Apply asset URL replacements to rendered text (markdown or HTML). */
function applyAssetReplacements(text: string, replacements: Map<string, string>): string {
  let out = text;
  for (const [from, to] of replacements) out = out.split(from).join(to);
  return out;
}

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

/** One file going into the archive. */
interface ZipEntry {
  name: string;
  data: Buffer | string;
}

/**
 * Write entries into `outputPath` with a fixed date and in sorted order so two
 * runs over unchanged data yield byte-identical archives (ADR 06874c5d).
 * `archiver.on('warning')` is logged, never rejecting (same pitfall as `.etnx`).
 */
function writeZip(outputPath: string, entries: readonly ZipEntry[]): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const fileStream = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    let settled = false;

    fileStream.on('close', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(statSync(outputPath).size);
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
    for (const entry of sorted) {
      archive.append(entry.data, { name: entry.name, date: ZIP_ENTRY_DATE });
    }
    void archive.finalize();
  });
}

// ---------------------------------------------------------------------------
// Сборка артефакта публикации
// ---------------------------------------------------------------------------

/** Собранные файлы одной публикации: записи zip + отчётная запись. */
interface PublicationArtifact {
  entries: ZipEntry[];
  entry: PublicationExportEntry;
}

/**
 * Build the zip entries of one publication under `prefix` ('' for a single
 * export; `<slug>/` inside a batch). Never throws for asset problems — they
 * land in the report entry's `warnings`.
 */
function buildPublicationArtifact(
  ndb: NetworkDb,
  document: PublicationExportDocument,
  format: PublicationExportFormat,
  withAssets: boolean,
  prefix: string,
  slug: string,
): PublicationArtifact {
  const sources: string[] = [document.title.summary_md];
  for (const section of flattenExportSections(document.sections)) {
    sources.push(section.preamble_md);
    for (const text of section.texts) sources.push(text.body_md);
  }

  const assets = collectAssets(ndb, sources, withAssets);
  const warnings = [...document.warnings, ...assets.warnings];
  const coverSrc = resolveCoverSource(ndb, document, assets, withAssets, warnings);

  const extension = format === 'md' ? 'md' : 'html';
  const mainName = `${prefix}${slug}.${extension}`;
  const rendered = renderDocument(document, format, coverSrc);
  const entries: ZipEntry[] = [
    { name: mainName, data: applyAssetReplacements(rendered, assets.replacements) },
  ];
  const fileNames: string[] = [mainName];
  for (const file of assets.files) {
    entries.push({
      name: `${prefix}${ASSETS_DIR}/${file.name}`,
      data: readFileSync(file.absPath),
    });
    fileNames.push(`${prefix}${ASSETS_DIR}/${file.name}`);
  }

  return {
    entries,
    entry: {
      publication_id: document.publication_id,
      title: document.title.title,
      slug,
      status: 'ok',
      warnings,
      files: fileNames,
    },
  };
}

/**
 * Resolve the title cover to a source string: an external URL stays as-is; a
 * server-available attachment is copied into `assets/` and referenced
 * relatively; a placeholder (or an unavailable/omitted cover) yields `null`.
 * Требование 745fdc48: обложка-вложение в Markdown уходит в assets.
 */
function resolveCoverSource(
  ndb: NetworkDb,
  document: PublicationExportDocument,
  assets: AssetCollection,
  withAssets: boolean,
  warnings: string[],
): string | null {
  const { cover } = document.title;
  if (cover.kind === 'url') return cover.ref;
  if (cover.kind !== 'attachment' || cover.ref === null) return null;
  if (!withAssets) return null;

  const attachment = getAttachment(ndb, cover.ref);
  if (attachment === null || attachment.kind !== 'file' || attachment.file_path === null) {
    warnings.push('обложка-вложение недоступна');
    return null;
  }
  const abs = attachment.file_path;
  if (!isInsideAttachments(attachmentsDir(ndb), abs) || !existsSync(abs)) {
    warnings.push(`обложка-вложение недоступна (${path.basename(abs)})`);
    return null;
  }
  let name: string;
  try {
    name = assetNameFor(abs);
  } catch {
    warnings.push(`обложка-вложение недоступна (${path.basename(abs)})`);
    return null;
  }
  if (!assets.files.some((f) => f.name === name)) assets.files.push({ name, absPath: abs });
  return `${ASSETS_DIR}/${name}`;
}

/** Flat pre-order list of export sections. */
function flattenExportSections(
  sections: readonly PublicationExportSection[],
): PublicationExportSection[] {
  const out: PublicationExportSection[] = [];
  const stack: PublicationExportSection[] = [...sections].reverse();
  while (stack.length > 0) {
    const section = stack.pop()!;
    out.push(section);
    for (let i = section.children.length - 1; i >= 0; i -= 1) stack.push(section.children[i]!);
  }
  return out;
}

/** Temp zip path for a job (TTL sweep removes it after download/TTL). */
function tempZipPath(jobId: string): string {
  return path.join(os.tmpdir(), `etn-pub-export-${jobId}.zip`);
}

/**
 * Start a single-publication export job (operation 1f161c74). Result is a zip
 * containing `<slug>.<md|html>` and, with assets, an `assets/` directory.
 * The returned job exposes a TTL download URL and a report with warnings.
 */
export async function startPublicationExportJob(
  ndb: NetworkDb,
  publicationId: string,
  opts: { format: PublicationExportFormat; with_assets?: boolean },
  userId: string,
  resolveUserName: (userId: string) => string | null,
): Promise<ExportJob> {
  const pub = getPublication(ndb, publicationId);
  if (pub === null) {
    throw new EtnError('NOT_FOUND', `publication ${publicationId} not found`, {
      entity: 'publication',
      id: publicationId,
    });
  }
  const document = buildPublicationExportDocument(ndb, publicationId, userId, resolveUserName);
  const slug = publicationSlug(pub.title);
  const artifact = buildPublicationArtifact(
    ndb,
    document,
    opts.format,
    opts.with_assets !== false,
    '',
    slug,
  );

  const jobId = randomUUID();
  const filePath = tempZipPath(jobId);
  await writeZip(filePath, artifact.entries);
  const report: PublicationExportReport = {
    publications: [artifact.entry],
    warnings: [],
  };
  return registerFinishedFileJob({
    filePath,
    contentType: 'application/zip',
    filename: `${slug}.zip`,
    report,
  });
}

/**
 * Start a batch export job (operation 074d7a97): `ids` or `active_only`.
 * Result is a zip with one `<slug>/` sub-directory per publication (collision →
 * `-<shortid>` suffix). A failing publication is reported with `status='error'`
 * and does not abort the whole archive.
 */
export async function startPublicationBatchExportJob(
  ndb: NetworkDb,
  opts: { ids?: string[]; active_only?: boolean; format: PublicationExportFormat; with_assets?: boolean },
  userId: string,
  resolveUserName: (userId: string) => string | null,
): Promise<ExportJob> {
  const warnings: string[] = [];
  let ids: string[];
  if (Array.isArray(opts.ids) && opts.ids.length > 0) {
    if (opts.ids.length > PUBLICATION_EXPORT_BATCH_MAX) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `Пакетный экспорт принимает не более ${PUBLICATION_EXPORT_BATCH_MAX} публикаций.`,
        { field: 'ids', limit: PUBLICATION_EXPORT_BATCH_MAX },
      );
    }
    ids = [...opts.ids];
  } else if (opts.active_only === true) {
    const listed = listPublications(ndb, { active: 'true', limit: PUBLICATION_EXPORT_BATCH_MAX });
    ids = listed.items
      .slice()
      .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : a.id < b.id ? -1 : 1))
      .map((p) => p.id);
    if (listed.total > PUBLICATION_EXPORT_BATCH_MAX) {
      warnings.push(
        `пакет усечён до ${PUBLICATION_EXPORT_BATCH_MAX} публикаций (в сети ${listed.total} актуальных)`,
      );
    }
  } else {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Укажите ids (непустой список) или active_only: true.',
      { field: 'ids' },
    );
  }

  // Детерминированные slug'и с суффиксом -<shortid> при коллизии (ADR 06874c5d).
  const titles = new Map<string, string>();
  for (const id of ids) {
    const pub = getPublication(ndb, id);
    if (pub !== null) titles.set(id, pub.title);
  }
  const slugCount = new Map<string, number>();
  for (const id of ids) {
    const title = titles.get(id);
    if (title === undefined) continue;
    const slug = publicationSlug(title);
    slugCount.set(slug, (slugCount.get(slug) ?? 0) + 1);
  }
  const slugById = new Map<string, string>();
  const usedDirs = new Set<string>();
  for (const id of ids) {
    const title = titles.get(id);
    if (title === undefined) continue;
    const base = publicationSlug(title);
    let slug = (slugCount.get(base) ?? 0) > 1 ? `${base}-${shortId(id)}` : base;
    while (usedDirs.has(slug)) slug = `${slug}-${shortId(id)}`;
    usedDirs.add(slug);
    slugById.set(id, slug);
  }

  const entries: ZipEntry[] = [];
  const publications: PublicationExportEntry[] = [];
  for (const id of ids) {
    const slug = slugById.get(id);
    const title = titles.get(id);
    if (slug === undefined || title === undefined) {
      publications.push({
        publication_id: id,
        title: '',
        slug: '',
        status: 'error',
        warnings: [],
        error: 'публикация не найдена',
      });
      continue;
    }
    try {
      const document = buildPublicationExportDocument(ndb, id, userId, resolveUserName);
      const artifact = buildPublicationArtifact(
        ndb,
        document,
        opts.format,
        opts.with_assets !== false,
        `${slug}/`,
        slug,
      );
      entries.push(...artifact.entries);
      publications.push(artifact.entry);
    } catch (err) {
      publications.push({
        publication_id: id,
        title,
        slug,
        status: 'error',
        warnings: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const jobId = randomUUID();
  const filePath = tempZipPath(jobId);
  await writeZip(filePath, entries);
  const report: PublicationExportReport = { publications, warnings };
  return registerFinishedFileJob({
    filePath,
    contentType: 'application/zip',
    filename: 'publications-export.zip',
    report,
  });
}
