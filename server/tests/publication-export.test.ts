/**
 * Экспорт документа публикации (0.11.1, задача 6d87f1f2; операции 1f161c74 и
 * 074d7a97). Покрытие DoD: два экспорта подряд — байтово идентичный zip;
 * недоступное вложение — предупреждение, не падение; внутренний якорь в HTML
 * кликабелен (цель ссылки существует); пакетный экспорт с суффиксом коллизии.
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, it } from 'node:test';

import yauzl from 'yauzl';

import { publicationAnchor, shortId } from '@etn/markdown';

import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { createTypeProperty } from '../src/domain/property-service.js';
import { createPublication } from '../src/domain/publication-service.js';
import { createAttachmentFile } from '../src/domain/attachment-service.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

const yauzlFromBuffer = promisify<Buffer, yauzl.Options, yauzl.ZipFile>(yauzl.fromBuffer);

const skip = !nativeAvailable();
const NOW = '2024-01-01T00:00:00Z';

/** Seed a thought of `typeId` directly. */
function seedThought(ndb: NetworkDb, title: string, typeId: string | null, user: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, 0, 0, 1, ?, ?, ?, ?)`,
    )
    .run(id, ndb.layerId, title, title.toLowerCase(), typeId, NOW, user, NOW, user);
  return id;
}

/** Seed a link (typed or untyped). */
function seedLink(
  ndb: NetworkDb,
  source: string,
  target: string,
  typeId: string | null,
  position: number,
  user: string,
): void {
  ndb
    .prepare(
      `INSERT INTO links (id, layer_id, deleted, base_version, source_id, target_id, type_id,
                          position, active, marked_for_deletion, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, 0, 0, ?, ?, ?, ?, 1, 0, 1, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), ndb.layerId, source, target, typeId, position, NOW, NOW, user, user);
}

/** Seed a permanent comment. */
function seedComment(ndb: NetworkDb, thoughtId: string, bodyMd: string, user: string): void {
  ndb
    .prepare(
      `INSERT INTO comments (id, owner_type, owner_id, kind, title, body_md, body_html,
                             valid_from, valid_to, version, created_at, updated_at, created_by, updated_by)
       VALUES (?, 'thought', ?, 'permanent', NULL, ?, '', ?, NULL, 1, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), thoughtId, bodyMd, NOW, NOW, NOW, user, user);
}

/** Typed link property for texts; returns its id. */
function seedTextProperty(ndb: NetworkDb, typeId: string, user: string): string {
  const linkType = createLinkType(ndb, { name_forward: 'Текст', name_reverse: 'Раздел' }, user);
  const prop = createTypeProperty(
    ndb,
    'thought_type',
    typeId,
    { key: `texts-${randomUUID().slice(0, 8)}`, value_type: 'link', config: { link_type_id: linkType.id } },
    user,
  );
  return prop.property_id;
}

/** Absolute path → `etnimg://` URL (mirrors the client helper). */
function etnimgUrl(filePath: string): string {
  const segments = filePath.replace(/\\/g, '/').split('/').filter((s) => s !== '');
  const encoded = segments.map((seg, i) =>
    i === 0 && /^[a-zA-Z]:$/.test(seg) ? seg[0]!.toLowerCase() : encodeURIComponent(seg),
  );
  return `etnimg://${encoded.join('/')}`;
}

interface ZipEntrySummary {
  fileName: string;
  uncompressedSize: number;
}

/** List file entries of a zip buffer (directories skipped). */
async function listZipEntries(buffer: Buffer): Promise<ZipEntrySummary[]> {
  const zip = await yauzlFromBuffer(buffer, { lazyEntries: true });
  const out: ZipEntrySummary[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (entry: yauzl.Entry) => {
      if (!/\/$/.test(entry.fileName)) {
        out.push({ fileName: entry.fileName, uncompressedSize: entry.uncompressedSize });
      }
      zip.readEntry();
    });
    zip.on('end', () => resolve());
    zip.on('error', reject);
    zip.readEntry();
  });
  zip.close();
  return out;
}

/** Read one entry's contents from a zip buffer as a Buffer. */
async function readZipEntry(buffer: Buffer, fileName: string): Promise<Buffer> {
  const zip = await yauzlFromBuffer(buffer, { lazyEntries: true });
  return new Promise<Buffer>((resolve, reject) => {
    zip.on('entry', (entry: yauzl.Entry) => {
      if (entry.fileName === fileName) {
        zip.openReadStream(entry, (err, stream) => {
          if (err !== null) {
            reject(err);
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => resolve(Buffer.concat(chunks)));
          stream.on('error', reject);
        });
      } else {
        zip.readEntry();
      }
    });
    zip.on('end', () => reject(new Error(`entry not found: ${fileName}`)));
    zip.on('error', reject);
    zip.readEntry();
  });
}

/** Start an export and return the job id. */
async function startExport(
  ctx: RestTestContext,
  publicationId: string,
  format: 'md' | 'html',
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/publications/${publicationId}/export`,
    headers: authHeaders(ctx),
    payload: { format },
  });
  assert.equal(res.statusCode, 202);
  return (res.json().data as { job_id: string }).job_id;
}

/** Download a finished job's zip as a Buffer. */
async function downloadJob(ctx: RestTestContext, jobId: string): Promise<Buffer> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/jobs/${jobId}/download`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 200);
  return res.rawPayload;
}

/** Job status document from `GET /jobs/{id}`. */
async function getJob(
  ctx: RestTestContext,
  jobId: string,
): Promise<{
  status: string;
  filename?: string;
  report?: { publications: Array<{ status: string; slug: string; warnings: string[] }>; warnings: string[] };
}> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/jobs/${jobId}`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 200);
  return res.json().data;
}

describe('publication-export: одиночный экспорт', { skip }, () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it('markdown: титул, якоря, ссылки, ассеты и предупреждения о недоступных вложениях', async () => {
    const ctx = await buildRestContext();
    cleanups.push(() => closeRestContext(ctx));

    const docType = createThoughtType(ctx.ndb, { name: 'Doc' }, ctx.adminId);
    const plainType = createThoughtType(ctx.ndb, { name: 'Plain' }, ctx.adminId);
    const a = seedThought(ctx.ndb, 'Раздел A', docType.id, ctx.adminId);
    const b = seedThought(ctx.ndb, 'Раздел B', docType.id, ctx.adminId);
    const outside = seedThought(ctx.ndb, 'Вне документа', plainType.id, ctx.adminId);
    const text = seedThought(ctx.ndb, 'Текст', plainType.id, ctx.adminId);
    seedLink(ctx.ndb, a, b, null, 0, ctx.adminId);
    const prop = seedTextProperty(ctx.ndb, docType.id, ctx.adminId);
    const linkTypeId = (
      JSON.parse(
        (ctx.ndb.prepare('SELECT config FROM properties_v WHERE id = ?').get(prop) as { config: string })
          .config,
      ) as { link_type_id: string }
    ).link_type_id;
    seedLink(ctx.ndb, a, text, linkTypeId, 1, ctx.adminId);
    seedComment(ctx.ndb, text, 'Текст раздела', ctx.adminId);

    // Реальная доступная серверу картинка + отсутствующая ссылка на файл.
    const attachmentsDir = path.join(ctx.dataDir, 'networks', ctx.networkId, 'attachments');
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const imgPath = path.join(attachmentsDir, 'pic.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const missingUrl = etnimgUrl(path.join(attachmentsDir, 'nope.png'));

    seedComment(
      ctx.ndb,
      a,
      `# Предисловие\n\nСм. [[#${b}]] и [[#${outside}]].\n\n![pic](${etnimgUrl(imgPath)})\n\n![gone](${missingUrl})`,
      ctx.adminId,
    );

    const pub = createPublication(
      ctx.ndb,
      {
        title: 'Моя Публикация',
        title_recipe: { type_ids: [docType.id], sort: 'alpha', order: 'asc' },
        text_sources: [prop],
        numbering_from: 1,
        numbering_to: 6,
      },
      ctx.adminId,
    );

    const jobId = await startExport(ctx, pub.id, 'md');
    const job = await getJob(ctx, jobId);
    assert.equal(job.status, 'done');
    assert.equal(job.filename, 'moya-publikaciya.zip');
    assert.equal(job.report?.publications[0]?.status, 'ok');
    assert.equal(job.report?.publications[0]?.slug, 'moya-publikaciya');
    assert.ok(
      job.report?.publications[0]?.warnings.some((w) => w.includes('вложение недоступно')),
      `ожидалось предупреждение о вложении: ${JSON.stringify(job.report)}`,
    );

    const zip = await downloadJob(ctx, jobId);
    const entries = await listZipEntries(zip);
    const names = entries.map((e) => e.fileName);
    assert.ok(names.includes('moya-publikaciya.md'), names.join(', '));
    const asset = names.find((n) => n.startsWith('assets/') && n.endsWith('.png'));
    assert.ok(asset, names.join(', '));

    const md = (await readZipEntry(zip, 'moya-publikaciya.md')).toString('utf8');
    assert.match(md, /^# Моя Публикация/);
    assert.match(md, /## 1\. Раздел A/);
    // Внутренняя ссылка — якорь блока; сам якорь блока присутствует.
    assert.ok(md.includes(`[Раздел B](#${publicationAnchor(b)})`), md);
    assert.ok(md.includes(`<a id="${publicationAnchor(b)}"></a>`), md);
    // Ссылка на мысль вне документа — названием текстом (без якоря).
    assert.ok(md.includes('Вне документа'), md);
    assert.ok(!md.includes(`#${publicationAnchor(outside)}`), md);
    // Картинка переписана на относительный путь ассета; недоступная не сломала документ.
    assert.ok(md.includes(`](${asset})`), md);
    assert.ok(md.includes(`![gone](${missingUrl})`), md);
    assert.match(md, /Текст раздела/);
  });

  it('повторный экспорт без изменений в базе — байтово идентичный zip', async () => {
    const ctx = await buildRestContext();
    cleanups.push(() => closeRestContext(ctx));

    const docType = createThoughtType(ctx.ndb, { name: 'Doc' }, ctx.adminId);
    const a = seedThought(ctx.ndb, 'Раздел A', docType.id, ctx.adminId);
    seedComment(ctx.ndb, a, '## Подзаголовок\n\nТекст предисловия', ctx.adminId);
    const pub = createPublication(
      ctx.ndb,
      { title: 'Детерминизм', title_recipe: { type_ids: [docType.id], sort: 'alpha', order: 'asc' } },
      ctx.adminId,
    );

    const first = await downloadJob(ctx, await startExport(ctx, pub.id, 'md'));
    const second = await downloadJob(ctx, await startExport(ctx, pub.id, 'md'));
    assert.ok(first.equals(second), 'два экспорта дали разные байты zip');
  });

  it('html: внутренний якорь кликабелен, оглавление и обложка-URL', async () => {
    const ctx = await buildRestContext();
    cleanups.push(() => closeRestContext(ctx));

    const docType = createThoughtType(ctx.ndb, { name: 'Doc' }, ctx.adminId);
    const a = seedThought(ctx.ndb, 'Раздел A', docType.id, ctx.adminId);
    const b = seedThought(ctx.ndb, 'Раздел B', docType.id, ctx.adminId);
    seedLink(ctx.ndb, a, b, null, 0, ctx.adminId);
    seedComment(ctx.ndb, a, `См. [[#${b}]].`, ctx.adminId);
    const pub = createPublication(
      ctx.ndb,
      {
        title: 'HTML Док',
        cover_url: 'https://example.test/cover.png',
        title_recipe: { type_ids: [docType.id], sort: 'alpha', order: 'asc' },
      },
      ctx.adminId,
    );

    const zip = await downloadJob(ctx, await startExport(ctx, pub.id, 'html'));
    const names = (await listZipEntries(zip)).map((e) => e.fileName);
    assert.ok(names.includes('html-dok.html'), names.join(', '));
    const html = (await readZipEntry(zip, 'html-dok.html')).toString('utf8');
    assert.match(html, /<nav class="pub-toc">/);
    assert.ok(html.includes(`href="#${publicationAnchor(b)}"`), html);
    assert.ok(html.includes(`<section id="${publicationAnchor(b)}">`), html);
    assert.ok(html.includes('src="https://example.test/cover.png"'), html);
  });

  it('print: печатный HTML сохраняет титул, оглавление, якоря, водяной знак и инлайн-картинки', async () => {
    const ctx = await buildRestContext();
    cleanups.push(() => closeRestContext(ctx));

    const docType = createThoughtType(ctx.ndb, { name: 'Doc' }, ctx.adminId);
    const a = seedThought(ctx.ndb, 'Раздел A', docType.id, ctx.adminId);
    const b = seedThought(ctx.ndb, 'Раздел B', docType.id, ctx.adminId);
    seedLink(ctx.ndb, a, b, null, 0, ctx.adminId);
    seedComment(ctx.ndb, a, `См. [[#${b}]].`, ctx.adminId);

    // Реальная картинка-вложение: должна вклеиться как data-URI.
    const attachmentsDir = path.join(ctx.dataDir, 'networks', ctx.networkId, 'attachments');
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const imgPath = path.join(attachmentsDir, 'pic.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));
    seedComment(ctx.ndb, b, `![pic](${etnimgUrl(imgPath)})`, ctx.adminId);

    const pub = createPublication(
      ctx.ndb,
      { title: 'Печатный Док', title_recipe: { type_ids: [docType.id], sort: 'alpha', order: 'asc' } },
      ctx.adminId,
    );

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/networks/${ctx.networkId}/publications/${pub.id}/print`,
      headers: authHeaders(ctx),
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /text\/html/);
    assert.equal(res.headers['x-publication-slug'], 'pechatnyy-dok');
    const html = res.body;

    // Титул и оглавление.
    assert.match(html, /^<!doctype html>/);
    assert.ok(html.includes('<title>Печатный Док</title>'), html);
    assert.ok(html.includes('<h1>Печатный Док</h1>'), html);
    assert.ok(html.includes('<nav class="pub-toc"><h2>Оглавление</h2>'), html);
    // Внутренние якоря: ссылка оглавления/текста и цель-раздел.
    assert.ok(html.includes(`href="#${publicationAnchor(b)}"`), html);
    assert.ok(html.includes(`<section id="${publicationAnchor(b)}">`), html);
    assert.ok(html.includes(`id="${publicationAnchor(b)}"`), html);
    // Водяной знак присутствует и помечен как печатный (position: fixed).
    assert.ok(html.includes('pub-watermark'), html);
    assert.ok(html.includes('Документ сгенерирован в ETN'), html);
    assert.ok(html.includes('position:fixed'), html);
    // Картинка вклеена как data-URI, а исходный etnimg-URL исчез.
    assert.ok(html.includes('src="data:image/png;base64,'), html);
    assert.ok(!html.includes('etnimg://'), html);
  });

  it('картинка по id вложения (etnimg://attachment/<id>): экспорт в assets и печать в data-URI, недоступное — предупреждение (5943e3e8)', async () => {
    const ctx = await buildRestContext();
    cleanups.push(() => closeRestContext(ctx));

    const docType = createThoughtType(ctx.ndb, { name: 'Doc' }, ctx.adminId);
    const a = seedThought(ctx.ndb, 'Раздел A', docType.id, ctx.adminId);

    // Серверная картинка-вложение (владелец — сам раздел); file_path внутри
    // каталога attachments сети — id резолвится по attachments_v.
    const att = createAttachmentFile(
      ctx.ndb,
      'thought',
      a,
      {
        title: 'pic',
        mime_type: 'image/png',
        data_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 7, 7, 7]).toString('base64'),
      },
      ctx.adminId,
    );
    assert.equal(att.kind, 'file');
    assert.ok(att.file_path !== null);

    // Ссылки в тексте: доступная по id + недоступная (несуществующий id).
    const missingId = randomUUID();
    seedComment(
      ctx.ndb,
      a,
      `![pic](etnimg://attachment/${att.id})\n\n![gone](etnimg://attachment/${missingId})\n\n![path](${etnimgUrl(att.file_path)})`,
      ctx.adminId,
    );

    const pub = createPublication(
      ctx.ndb,
      { title: 'Doc By Id', title_recipe: { type_ids: [docType.id], sort: 'alpha', order: 'asc' } },
      ctx.adminId,
    );

    // Zip-экспорт: доступная по id скопирована в assets и переписана; прежняя
    // форма по пути — тоже; недоступная оставлена как есть, документ цел.
    const jobId = await startExport(ctx, pub.id, 'html');
    const job = await getJob(ctx, jobId);
    assert.equal(job.status, 'done');
    assert.ok(
      job.report?.publications[0]?.warnings.some((w) => w.includes('вложение не найдено')),
      `ожидалось предупреждение о недоступном id: ${JSON.stringify(job.report)}`,
    );

    const zip = await downloadJob(ctx, jobId);
    const names = (await listZipEntries(zip)).map((e) => e.fileName);
    const asset = names.find((n) => n.startsWith('assets/') && n.endsWith('.png'));
    assert.ok(asset, names.join(', '));
    const html = (await readZipEntry(zip, 'doc-by-id.html')).toString('utf8');
    assert.ok(html.includes(`src="${asset}"`), html);
    assert.ok(!html.includes(`etnimg://attachment/${att.id}`), html);
    assert.ok(html.includes(`src="etnimg://attachment/${missingId}"`), html);

    // Печать: тот же резолв по id — картинка вклеена как data-URI, недоступная
    // не роняет печать (200), исходная схема доступной исчезает.
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/networks/${ctx.networkId}/publications/${pub.id}/print`,
      headers: authHeaders(ctx),
    });
    assert.equal(res.statusCode, 200);
    const printHtml = res.body;
    assert.ok(printHtml.includes('src="data:image/png;base64,'), printHtml);
    assert.ok(!printHtml.includes(`etnimg://attachment/${att.id}`), printHtml);
    assert.ok(printHtml.includes(`etnimg://attachment/${missingId}`), printHtml);
  });

  it('разделы глубже H6: обезглавливание в абзац, а не кламп (md и html)', async () => {
    const ctx = await buildRestContext();
    cleanups.push(() => closeRestContext(ctx));

    const docType = createThoughtType(ctx.ndb, { name: 'Doc' }, ctx.adminId);
    // Цепочка из 8 разделов: уровни 1..8 → заголовки H2..H9.
    const ids: string[] = [];
    for (let i = 1; i <= 8; i += 1) {
      ids.push(seedThought(ctx.ndb, `A${i}`, docType.id, ctx.adminId));
    }
    for (let i = 0; i < ids.length - 1; i += 1) {
      seedLink(ctx.ndb, ids[i]!, ids[i + 1]!, null, 0, ctx.adminId);
    }
    const pub = createPublication(
      ctx.ndb,
      {
        title: 'Глубокий Док',
        title_recipe: { type_ids: [docType.id], sort: 'alpha', order: 'asc' },
      },
      ctx.adminId,
    );

    // Markdown: до H6 — решётки, глубже — абзац с жирным текстом.
    const mdZip = await downloadJob(ctx, await startExport(ctx, pub.id, 'md'));
    const md = (await readZipEntry(mdZip, 'glubokiy-dok.md')).toString('utf8');
    assert.ok(md.includes('###### A5'), md);
    assert.ok(md.includes('**A6**'), md);
    assert.ok(md.includes('**A7**'), md);
    assert.ok(!md.includes('####### '), md);

    // HTML: до H6 — <hN>, глубже — <p><strong> (без клампа к H6).
    const htmlZip = await downloadJob(ctx, await startExport(ctx, pub.id, 'html'));
    const html = (await readZipEntry(htmlZip, 'glubokiy-dok.html')).toString('utf8');
    assert.ok(html.includes('<h6>A5</h6>'), html);
    assert.ok(html.includes('<p><strong>A6</strong></p>'), html);
    assert.ok(html.includes('<p><strong>A7</strong></p>'), html);
    assert.ok(!html.includes('<h7>'), html);
  });

  it('пакетный экспорт: подкаталоги публикаций и суффикс при коллизии slug', async () => {
    const ctx = await buildRestContext();
    cleanups.push(() => closeRestContext(ctx));

    const p1 = createPublication(ctx.ndb, { title: 'Док' }, ctx.adminId);
    const p2 = createPublication(ctx.ndb, { title: 'Док' }, ctx.adminId);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/networks/${ctx.networkId}/publications/export-batch`,
      headers: authHeaders(ctx),
      payload: { ids: [p1.id, p2.id], format: 'md' },
    });
    assert.equal(res.statusCode, 202);
    const jobId = (res.json().data as { job_id: string }).job_id;
    const job = await getJob(ctx, jobId);
    assert.equal(job.report?.publications.length, 2);
    assert.ok(job.report?.publications.every((p) => p.status === 'ok'));

    const zip = await downloadJob(ctx, jobId);
    const names = (await listZipEntries(zip)).map((e) => e.fileName);
    // Оба одноимённых slug'а получают суффикс -<shortid> (ADR 06874c5d).
    assert.ok(
      names.includes(`dok-${shortId(p1.id)}/dok-${shortId(p1.id)}.md`),
      names.join(', '),
    );
    assert.ok(
      names.includes(`dok-${shortId(p2.id)}/dok-${shortId(p2.id)}.md`),
      names.join(', '),
    );
    assert.ok(!names.includes('dok/dok.md'), names.join(', '));

    // Тот же пакет в HTML — ветка формата на общем сборщике.
    const htmlRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/networks/${ctx.networkId}/publications/export-batch`,
      headers: authHeaders(ctx),
      payload: { ids: [p1.id], format: 'html' },
    });
    assert.equal(htmlRes.statusCode, 202);
    const htmlZip = await downloadJob(ctx, (htmlRes.json().data as { job_id: string }).job_id);
    const htmlNames = (await listZipEntries(htmlZip)).map((e) => e.fileName);
    assert.ok(
      htmlNames.includes('dok/dok.html'),
      htmlNames.join(', '),
    );
  });
});
