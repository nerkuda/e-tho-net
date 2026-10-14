/**
 * Трансклюзии в публикации (ошибка `3b3035cf`, требование `2fb33964`).
 *
 * Синтаксис `![[#<id>]]` / `![[#<id>#Раздел]]` работает во всех markdown-полях,
 * в том числе в предисловиях и текстах публикации. Проверяется:
 *   * сборка (`assemblePublication`) разворачивает трансклюзию предисловия и
 *     текста в блок `md-transclusion` с содержимым источника;
 *   * DTO отдаёт ИСХОДНЫЙ `body_md` (источник карты каретки, задача 59774016);
 *   * отсутствующий источник/раздел и цикл дают штатный контейнер, сборка не
 *     падает;
 *   * Markdown-экспорт разворачивает текст БЕЗ маркеров `etn:transclusion`;
 *   * HTML-экспорт несёт то же развёрнутое содержимое.
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { publicationAnchor } from '@etn/markdown';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { createTypeProperty } from '../src/domain/property-service.js';
import { createPublication } from '../src/domain/publication-service.js';
import {
  assemblePublication,
  buildPublicationExportDocument,
} from '../src/domain/publication-assembly-service.js';
import { buildPublicationArtifact } from '../src/domain/publication-export-service.js';

/** True when the `better-sqlite3` native binding loads. */
function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const skip = !nativeAvailable();
const USER = 'u';
const NOW = '2024-01-01T00:00:00Z';

/** Seed a thought of `typeId` directly. */
function seedThought(ndb: NetworkDb, title: string, typeId: string | null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, 0, 0, 1, ?, ?, ?, ?)`,
    )
    .run(id, ndb.layerId, title, title.toLowerCase(), typeId, NOW, USER, NOW, USER);
  return id;
}

/** Seed a link (typed or untyped). */
function seedLink(
  ndb: NetworkDb,
  source: string,
  target: string,
  typeId: string | null,
  position: number,
): void {
  ndb
    .prepare(
      `INSERT INTO links (id, layer_id, deleted, base_version, source_id, target_id, type_id,
                          position, active, marked_for_deletion, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, 0, 0, ?, ?, ?, ?, 1, 0, 1, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), ndb.layerId, source, target, typeId, position, NOW, NOW, USER, USER);
}

/** Seed a permanent comment (`body_md`). */
function seedComment(ndb: NetworkDb, thoughtId: string, bodyMd: string): void {
  ndb
    .prepare(
      `INSERT INTO comments (id, owner_type, owner_id, kind, title, body_md, body_html,
                             valid_from, valid_to, version, created_at, updated_at, created_by, updated_by)
       VALUES (?, 'thought', ?, 'permanent', NULL, ?, '', ?, NULL, 1, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), thoughtId, bodyMd, NOW, NOW, NOW, USER, USER);
}

/** Recipe matching one thought type. */
function recipeForType(typeId: string) {
  return { type_ids: [typeId], sort: 'alpha' as const, order: 'asc' as const };
}

/** Typed link property for texts; returns property id. */
function seedTextProperty(ndb: NetworkDb, typeId: string): string {
  const linkType = createLinkType(ndb, { name_forward: 'Текст', name_reverse: 'Раздел' }, USER);
  const prop = createTypeProperty(
    ndb,
    'thought_type',
    typeId,
    { key: `texts-${randomUUID().slice(0, 8)}`, value_type: 'link', config: { link_type_id: linkType.id } },
    USER,
  );
  return prop.property_id;
}

/** link_type_id of a text property (for seeding typed text edges). */
function linkTypeOf(ndb: NetworkDb, propertyId: string): string {
  const row = ndb.prepare('SELECT config FROM properties_v WHERE id = ?').get(propertyId) as {
    config: string;
  };
  return (JSON.parse(row.config) as { link_type_id: string }).link_type_id;
}

describe('публикация: развёртка трансклюзий (ошибка 3b3035cf)', { skip }, () => {
  it('предисловие раздела разворачивает ![[#id]] в блок md-transclusion', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const source = seedThought(ndb, 'Источник', null);
      seedComment(ndb, source, 'Тело источника.');
      seedComment(ndb, a, `Начало.\n\n![[#${source}]]\n\nКонец.`);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);

      const doc = assemblePublication(ndb, pub.id, USER);
      const html = doc.sections.find((s) => s.thought_id === a)!.preamble_html;
      assert.ok(html.includes('Тело источника.'), `нет развёрнутого источника: ${html}`);
      assert.ok(html.includes('md-transclusion'), `нет блока md-transclusion: ${html}`);
      assert.ok(!html.includes('![['), `осталась ссылка трансклюзии: ${html}`);
    } finally {
      ndb.close();
    }
  });

  it('текст раздела: превью и экспорт разворачивают ![[#id#Раздел]], DTO отдаёт ИСХОДНЫЙ body_md', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const plain = createThoughtType(ndb, { name: 'Plain' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const text = seedThought(ndb, 'Текст', plain.id);
      const source = seedThought(ndb, 'Источник', null);
      seedComment(ndb, source, '## Раздел\n\nСодержимое раздела\n\n## Другой\nХвост');
      const raw = `![[#${source}#Раздел]]`;
      seedComment(ndb, text, raw);

      const prop = seedTextProperty(ndb, type.id);
      seedLink(ndb, a, text, linkTypeOf(ndb, prop), 0);
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(type.id), text_sources: [prop] },
        USER,
      );

      // Превью (`assemblePublication`) разворачивает текст (требование 2fb33964,
      // замечание круга 3: `body_html` должен быть развёрнут — агенту полезнее).
      const doc = assemblePublication(ndb, pub.id, USER);
      const dto = doc.sections.find((s) => s.thought_id === a)!.texts[0]!;
      assert.ok(
        dto.body_html.includes('Содержимое раздела'),
        `превью не развернуло раздел: ${dto.body_html}`,
      );
      assert.ok(
        dto.body_html.includes('md-transclusion'),
        `превью без блока md-transclusion: ${dto.body_html}`,
      );
      assert.ok(!dto.body_html.includes('Хвост'), `взято лишнее вне раздела: ${dto.body_html}`);
      assert.equal(dto.body_md, raw, 'body_md DTO должен остаться исходным');

      // Экспортный HTML (`exportSink`, без sourceMap) — то же развёрнутое содержимое.
      const document = buildPublicationExportDocument(ndb, pub.id, USER, () => null);
      const exportText = document.sections.find((s) => s.thought_id === a)!.texts[0]!;
      assert.ok(
        exportText.body_html.includes('Содержимое раздела'),
        `нет содержимого раздела: ${exportText.body_html}`,
      );
      assert.ok(
        exportText.body_html.includes('md-transclusion'),
        `нет блока md-transclusion: ${exportText.body_html}`,
      );
      assert.ok(
        !exportText.body_html.includes('Хвост'),
        `взято лишнее вне раздела: ${exportText.body_html}`,
      );
    } finally {
      ndb.close();
    }
  });

  it('sourceMap превью: офсеты собственного текста — в координатах body_md', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const plain = createThoughtType(ndb, { name: 'Plain' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const text = seedThought(ndb, 'Текст', plain.id);
      const source = seedThought(ndb, 'Источник', null);
      // Вставка содержит ДЛИННЫЙ абзац: при рендере развёрнутого текста БЕЗ
      // свёртки офсеты собственного абзаца после ссылки уезжали за длину body_md.
      seedComment(ndb, source, 'x'.repeat(400));
      const raw = `абзац один\n\n![[#${source}]]\n\nабзац два`;
      seedComment(ndb, text, raw);

      const prop = seedTextProperty(ndb, type.id);
      seedLink(ndb, a, text, linkTypeOf(ndb, prop), 0);
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(type.id), text_sources: [prop] },
        USER,
      );

      const doc = assemblePublication(ndb, pub.id, USER);
      const dto = doc.sections.find((s) => s.thought_id === a)!.texts[0]!;
      // Вставка развёрнута…
      assert.ok(dto.body_html.includes('md-transclusion'), 'превью не развернуло вставку');
      assert.ok(dto.body_html.includes('x'.repeat(50)), 'нет содержимого источника');
      // …разметка позиций не выходит за длину body_md…
      const offsets = [...dto.body_html.matchAll(/data-md-(?:start|end|after)="(\d+)"/g)].map((m) =>
        Number(m[1]),
      );
      assert.ok(offsets.length > 0, 'нет разметки позиций в превью');
      for (const offset of offsets) {
        assert.ok(
          offset <= dto.body_md.length,
          `офсет ${offset} выходит за длину body_md (${dto.body_md.length})`,
        );
      }
      // …и собственный абзац ПОСЛЕ вставки имеет точный офсет body_md.
      const own = /<p data-md-start="(\d+)"[^>]*>абзац два/.exec(dto.body_html);
      assert.ok(own !== null, `нет абзаца «абзац два» с разметкой: ${dto.body_html}`);
      assert.equal(
        Number(own[1]),
        dto.body_md.indexOf('абзац два'),
        'офсет собственного абзаца после вставки сдвинут',
      );
      // А внутри самой вставки разметки нет (клик там — фолбэк).
      const block = /<div class="md-transclusion"[^>]*>([\s\S]*?)<\/div>/.exec(dto.body_html);
      assert.ok(block !== null, 'нет обёртки вставки');
      assert.ok(!block[1]!.includes('data-md-'), `разметка утекла во вставку: ${block[1]}`);
    } finally {
      ndb.close();
    }
  });

  it('превью: обычные вики-ссылки [[…]] резолвятся наравне с трансклюзией', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const plain = createThoughtType(ndb, { name: 'Plain' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const other = seedThought(ndb, 'B', type.id); // раздел документа — есть якорь
      const text = seedThought(ndb, 'Текст', plain.id);
      const source = seedThought(ndb, 'Источник', null);
      seedComment(ndb, source, 'тело источника');
      seedComment(ndb, text, `ссылка [[#${other}]] и вставка ![[#${source}]]`);

      const prop = seedTextProperty(ndb, type.id);
      seedLink(ndb, a, text, linkTypeOf(ndb, prop), 0);
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(type.id), text_sources: [prop] },
        USER,
      );

      const doc = assemblePublication(ndb, pub.id, USER);
      const html = doc.sections.find((s) => s.thought_id === a)!.texts[0]!.body_html;
      // Обычная ссылка разрешена резолвером публикации (якорь внутри документа)…
      assert.ok(
        html.includes(`#${publicationAnchor(other)}`),
        `обычная ссылка не разрешена в якорь: ${html}`,
      );
      // …трансклюзия развёрнута…
      assert.ok(html.includes('md-transclusion'), `вставка не развёрнута: ${html}`);
      assert.ok(html.includes('тело источника'), `нет содержимого источника: ${html}`);
      // …и ни одна ссылка не осталась сырой.
      assert.ok(!html.includes('[['), `осталась сырая ссылка: ${html}`);
    } finally {
      ndb.close();
    }
  });

  it('отсутствующий источник и раздел → контейнер missing, сборка не падает', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const source = seedThought(ndb, 'Источник', null);
      seedComment(ndb, source, '## Раздел\n\nсодержимое');
      seedComment(
        ndb,
        a,
        `![[#${randomUUID()}]]\n\n![[#${source}#НетТакого]]\n\n![[#${a}]]`,
      );
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);

      const doc = assemblePublication(ndb, pub.id, USER);
      const html = doc.sections.find((s) => s.thought_id === a)!.preamble_html;
      assert.ok(html.includes('md-transclusion--missing'), `нет контейнера missing: ${html}`);
      assert.ok(
        html.includes('Нет источника трансклюзии'),
        `нет подписи отсутствующего источника: ${html}`,
      );
      assert.ok(
        html.includes('Нет раздела в источнике трансклюзии'),
        `нет подписи отсутствующего раздела: ${html}`,
      );
      // Самоссылка — штатный skip (цикл), бесконечной развёртки нет.
      assert.ok(html.includes('md-transclusion--skipped'), `нет контейнера skipped: ${html}`);
      assert.ok(html.includes('Ссылка не раскрыта'), `нет подписи нераскрытой ссылки: ${html}`);
    } finally {
      ndb.close();
    }
  });

  it('Markdown-экспорт: развёрнутый текст без маркеров etn:transclusion', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const source = seedThought(ndb, 'Источник', null);
      seedComment(ndb, source, 'Тело источника.');
      seedComment(ndb, a, `Начало.\n\n![[#${source}]]\n\nКонец.`);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);

      const document = buildPublicationExportDocument(ndb, pub.id, USER, () => null);
      const artifact = buildPublicationArtifact(ndb, document, 'md', false, '', 'doc');
      const md = String(artifact.entries[0]!.data);
      assert.ok(md.includes('Тело источника.'), `нет развёрнутого текста: ${md}`);
      assert.ok(!md.includes('etn:transclusion'), `маркеры утекли в Markdown: ${md}`);
      assert.ok(!md.includes('![['), `осталась ссылка трансклюзии: ${md}`);
    } finally {
      ndb.close();
    }
  });

  it('HTML-экспорт несёт развёрнутое содержимое с блоками', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const source = seedThought(ndb, 'Источник', null);
      seedComment(ndb, source, 'Тело источника.');
      seedComment(ndb, a, `Начало.\n\n![[#${source}]]\n\nКонец.`);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);

      const document = buildPublicationExportDocument(ndb, pub.id, USER, () => null);
      const artifact = buildPublicationArtifact(ndb, document, 'html', false, '', 'doc');
      const html = String(artifact.entries[0]!.data);
      assert.ok(html.includes('Тело источника.'), `нет развёрнутого текста: ${html}`);
      assert.ok(html.includes('md-transclusion'), `нет блока md-transclusion: ${html}`);
    } finally {
      ndb.close();
    }
  });
});
