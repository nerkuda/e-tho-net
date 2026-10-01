/**
 * Сборка документа публикации (0.11.1, задача 34119c67): дерево разделов,
 * тексты, нумерация, рендер, DTO, кандидаты и использование мысли.
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
import { createTypeProperty, setPropertyValue } from '../src/domain/property-service.js';
import {
  addPublicationExclusion,
  createPublication,
  setPublicationOrder,
  updatePublication,
} from '../src/domain/publication-service.js';
import {
  assemblePublication,
  buildSectionTree,
  listPublicationCandidates,
  listPublicationUsage,
  PublicationMembershipCache,
} from '../src/domain/publication-assembly-service.js';

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

/** Seed a thought directly (no type) and return its id. */
function seedThought(ndb: NetworkDb, title: string, typeId: string | null = null): string {
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

/** Seed an untyped (structural) link source → target. */
function seedUntypedLink(ndb: NetworkDb, source: string, target: string, position: number): string {
  return seedLink(ndb, source, target, null, position);
}

/** Seed a link (typed or untyped). */
function seedLink(
  ndb: NetworkDb,
  source: string,
  target: string,
  typeId: string | null,
  position: number,
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO links (id, layer_id, deleted, base_version, source_id, target_id, type_id,
                          position, active, marked_for_deletion, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, 0, 0, ?, ?, ?, ?, 1, 0, 1, ?, ?, ?, ?)`,
    )
    .run(id, ndb.layerId, source, target, typeId, position, NOW, NOW, USER, USER);
  return id;
}

/** Seed a permanent comment (body_md). */
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

/** Create a typed link property bound to the type; returns property id. */
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

/** Flatten section tree into thought ids (pre-order). */
function sectionIds(sections: Array<{ thought_id: string; children: unknown[] }>): string[] {
  const out: string[] = [];
  const walk = (list: Array<{ thought_id: string; children: unknown[] }>): void => {
    for (const s of list) {
      out.push(s.thought_id);
      walk(s.children as Array<{ thought_id: string; children: unknown[] }>);
    }
  };
  walk(sections);
  return out;
}

describe('publication-assembly-service: дерево разделов', { skip }, () => {
  it('строит вложенное дерево, нумерует и смещает заголовки предисловия', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const b = seedThought(ndb, 'B', type.id);
      seedUntypedLink(ndb, a, b, 0);
      seedComment(ndb, a, '# H1\n\nтекст');
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(type.id), numbering_from: 1, numbering_to: 6 },
        USER,
      );

      const doc = assemblePublication(ndb, pub.id, USER);
      assert.equal(doc.sections.length, 1);
      const root = doc.sections[0]!;
      assert.equal(root.thought_id, a);
      assert.equal(root.level, 1);
      assert.equal(root.heading, '1. A');
      assert.equal(root.anchor, publicationAnchor(a));
      // Предисловие раздела уровня 1 → базовый заголовок H2, H1 смещается в H3.
      assert.match(root.preamble_html, /<h3[ >]/);
      assert.equal(root.children.length, 1);
      assert.equal(root.children[0]!.heading, '1.1. B');
      assert.equal(root.children[0]!.level, 2);
    } finally {
      ndb.close();
    }
  });

  it('прикрепляет раздел к ближайшему отобранному предку через разрыв иерархии', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const other = createThoughtType(ndb, { name: 'Other' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const x = seedThought(ndb, 'X', other.id); // вне отбора
      const c = seedThought(ndb, 'C', type.id);
      seedUntypedLink(ndb, a, x, 0);
      seedUntypedLink(ndb, x, c, 0);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);

      const doc = assemblePublication(ndb, pub.id, USER);
      assert.deepEqual(sectionIds(doc.sections), [a, c]);
      assert.equal(doc.sections[0]!.children[0]!.thought_id, c);
    } finally {
      ndb.close();
    }
  });

  it('показывает раздел один раз: несколько родителей → repeat_of', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const b = seedThought(ndb, 'B', type.id);
      const d = seedThought(ndb, 'D', type.id);
      seedUntypedLink(ndb, a, d, 0);
      seedUntypedLink(ndb, b, d, 0);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);

      const doc = assemblePublication(ndb, pub.id, USER);
      assert.deepEqual(sectionIds(doc.sections), [a, d, b, d]);
      // Первое вхождение D — под A (нет пометки), второе — повтор под B.
      assert.equal(doc.sections[0]!.children[0]!.thought_id, d);
      assert.equal(doc.sections[0]!.children[0]!.flags.repeat_of, null);
      const repeat = doc.sections[1]!.children[0]!;
      assert.equal(repeat.thought_id, d);
      assert.equal(repeat.flags.repeat_of, publicationAnchor(d));
    } finally {
      ndb.close();
    }
  });

  it('обрезает кольцо во время обхода (cycle_cut) и не зацикливается', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const r = seedThought(ndb, 'R', type.id);
      const a = seedThought(ndb, 'A', type.id);
      const b = seedThought(ndb, 'B', type.id);
      const c = seedThought(ndb, 'C', type.id);
      seedUntypedLink(ndb, r, a, 0);
      seedUntypedLink(ndb, a, b, 0);
      seedUntypedLink(ndb, b, c, 0);
      seedUntypedLink(ndb, c, a, 0); // кольцо A→B→C→A
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);

      const doc = assemblePublication(ndb, pub.id, USER);
      assert.deepEqual(sectionIds(doc.sections), [r, a, b, c, a]);
      const repeat =
        doc.sections[0]!.children[0]!.children[0]!.children[0]!.children[0]!;
      assert.equal(repeat.thought_id, a);
      assert.equal(repeat.flags.cycle_cut, true);
      assert.equal(repeat.flags.repeat_of, publicationAnchor(a));
    } finally {
      ndb.close();
    }
  });

  it('учитывает локальный порядок узлов поверх сетевого', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const b = seedThought(ndb, 'B', type.id);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      setPublicationOrder(
        ndb,
        pub.id,
        [
          { node_key: b, position: 0 },
          { node_key: a, position: 1 },
        ],
        USER,
      );

      const doc = assemblePublication(ndb, pub.id, USER);
      assert.deepEqual(sectionIds(doc.sections), [b, a]);
    } finally {
      ndb.close();
    }
  });

  it('пагинирует по разделам верхнего уровня, сохраняя сквозную нумерацию', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(type.id), numbering_from: 1, numbering_to: 6 },
        USER,
      );
      for (let i = 1; i <= 21; i += 1) seedThought(ndb, `T${String(i).padStart(2, '0')}`, type.id);

      const page1 = assemblePublication(ndb, pub.id, USER, { page: 1 });
      assert.equal(page1.sections.length, 20);
      assert.equal(page1.meta.has_more, true);
      assert.equal(page1.sections[0]!.heading, '1. T01');
      const page2 = assemblePublication(ndb, pub.id, USER, { page: 2 });
      assert.equal(page2.sections.length, 1);
      assert.equal(page2.meta.has_more, false);
      // Номер сквозной: двадцать первый корень — 21.
      assert.equal(page2.sections[0]!.heading, '21. T21');
    } finally {
      ndb.close();
    }
  });
});

describe('publication-assembly-service: тексты и исключения', { skip }, () => {
  it('конкатенирует свойства текстов, исключает мысли-разделы и уважает пустой рецепт', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const plain = createThoughtType(ndb, { name: 'Plain' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const child = seedThought(ndb, 'Child', type.id); // тоже раздел
      const t1 = seedThought(ndb, 'T1', plain.id);
      const t2 = seedThought(ndb, 'T2', plain.id);
      seedUntypedLink(ndb, a, child, 0);
      const prop = seedTextProperty(ndb, type.id);
      const lt = ndb
        .prepare("SELECT config FROM properties_v WHERE id = ?")
        .get(prop) as { config: string };
      const linkTypeId = (JSON.parse(lt.config) as { link_type_id: string }).link_type_id;
      // Ребро-текст к T1 идёт раньше T2; цель-child — раздел (исключается).
      seedLink(ndb, a, child, linkTypeId, 0);
      seedLink(ndb, a, t1, linkTypeId, 1);
      seedLink(ndb, a, t2, linkTypeId, 2);
      seedComment(ndb, t1, 'Текст один');
      seedComment(ndb, t2, 'Текст два');
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(type.id), text_sources: [prop] },
        USER,
      );

      const doc = assemblePublication(ndb, pub.id, USER);
      const texts = doc.sections.find((s) => s.thought_id === a)!.texts;
      assert.deepEqual(texts.map((t) => t.thought_id), [t1, t2]);
      assert.match(texts[0]!.body_html, /Текст один/);

      // Пустой рецепт текстов — только предисловие.
      updatePublication(ndb, pub.id, { text_sources: [] }, USER);
      const doc2 = assemblePublication(ndb, pub.id, USER);
      assert.equal(doc2.sections.find((s) => s.thought_id === a)!.texts.length, 0);
    } finally {
      ndb.close();
    }
  });

  it('скрывает исключённые разделы в чтении и показывает в редакторе', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const b = seedThought(ndb, 'B', type.id);
      const c = seedThought(ndb, 'C', type.id);
      seedUntypedLink(ndb, a, b, 0);
      seedUntypedLink(ndb, b, c, 0);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      addPublicationExclusion(ndb, pub.id, b, USER);

      const reading = assemblePublication(ndb, pub.id, USER);
      // B исключён: C прикрепляется к ближайшему отобранному предку A.
      assert.deepEqual(sectionIds(reading.sections), [a, c]);
      assert.deepEqual(reading.excluded.map((e) => e.thought_id), [b]);

      const editor = assemblePublication(ndb, pub.id, USER, { include_excluded: true });
      assert.deepEqual(sectionIds(editor.sections), [a, b, c]);
    } finally {
      ndb.close();
    }
  });
});

describe('publication-assembly-service: кандидаты', { skip }, () => {
  it('показывает недостижимое кольцо отбора как кандидатов (дифф с деревом)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const b = seedThought(ndb, 'B', type.id);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      // Кольцо без точки входа: ни один узел не корень → дерево пусто.
      seedUntypedLink(ndb, a, b, 0);
      seedUntypedLink(ndb, b, a, 0);

      const doc = assemblePublication(ndb, pub.id, USER);
      assert.deepEqual(sectionIds(doc.sections), []);
      const result = listPublicationCandidates(ndb, pub.id, USER);
      assert.deepEqual(result.items.map((c) => c.thought_id).sort(), [a, b].sort());
      assert.equal(result.total, 2);
      assert.equal(result.has_more, false);
    } finally {
      ndb.close();
    }
  });

  it('обновляет кандидатов при подросшем отборе', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      // Пока A — единственная отобранная и она корень: кандидатов нет.
      assert.equal(listPublicationCandidates(ndb, pub.id, USER).total, 0);

      const b = seedThought(ndb, 'B', type.id);
      seedUntypedLink(ndb, a, b, 0);
      seedUntypedLink(ndb, b, a, 0);
      const grown = listPublicationCandidates(ndb, pub.id, USER);
      assert.equal(grown.total, 2);
      assert.deepEqual(grown.items.map((c) => c.thought_id).sort(), [a, b].sort());
    } finally {
      ndb.close();
    }
  });

  it('уважает лимит и пагинацию', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const b = seedThought(ndb, 'B', type.id);
      const c = seedThought(ndb, 'C', type.id);
      // Чистое кольцо A→B→C→A: все три недостижимы.
      seedUntypedLink(ndb, a, b, 0);
      seedUntypedLink(ndb, b, c, 0);
      seedUntypedLink(ndb, c, a, 0);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);

      const first = listPublicationCandidates(ndb, pub.id, USER, { limit: 2 });
      assert.equal(first.items.length, 2);
      assert.equal(first.total, 3);
      assert.equal(first.has_more, true);
      const second = listPublicationCandidates(ndb, pub.id, USER, { limit: 2, offset: 2 });
      assert.equal(second.items.length, 1);
      assert.equal(second.has_more, false);
    } finally {
      ndb.close();
    }
  });
});

describe('publication-assembly-service: использование мысли', { skip }, () => {
  it('различает роли раздела, текста и прямого свойства', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const plain = createThoughtType(ndb, { name: 'Plain' }, USER);
      const section = seedThought(ndb, 'Section', type.id);
      const text = seedThought(ndb, 'Text', plain.id);
      const prop = seedTextProperty(ndb, type.id);
      const lt = ndb
        .prepare('SELECT config FROM properties_v WHERE id = ?')
        .get(prop) as { config: string };
      const linkTypeId = (JSON.parse(lt.config) as { link_type_id: string }).link_type_id;
      seedLink(ndb, section, text, linkTypeId, 0);
      seedComment(ndb, text, 'тело');
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(type.id), text_sources: [prop] },
        USER,
      );

      const sectionUsage = listPublicationUsage(ndb, section, USER);
      assert.deepEqual(
        sectionUsage.items.map((i) => i.role),
        ['section'],
      );
      assert.deepEqual(sectionUsage.items[0]!.breadcrumbs, ['Section']);

      const textUsage = listPublicationUsage(ndb, text, USER);
      assert.equal(textUsage.items[0]!.role, 'text');
      assert.equal(textUsage.items[0]!.section_title, 'Section');

      // Прямое свойство типа «Публикация».
      const pubPropType = createThoughtType(ndb, { name: 'Holder' }, USER);
      const direct = seedThought(ndb, 'Direct', pubPropType.id);
      const pubProp = createTypeProperty(
        ndb,
        'thought_type',
        pubPropType.id,
        { key: 'pub', value_type: 'publication' },
        USER,
      );
      void pubProp;
      setPropertyValue(ndb, 'thought', direct, 'pub', pub.id, USER);
      const directUsage = listPublicationUsage(ndb, direct, USER);
      assert.equal(directUsage.items[0]!.role, 'direct');
      assert.equal(directUsage.items[0]!.publication_id, pub.id);
      assert.equal(directUsage.items[0]!.property, 'pub');

      // Лимит.
      const limited = listPublicationUsage(ndb, section, USER, { limit: 0 });
      assert.equal(limited.items.length, 0);
      assert.equal(limited.total, 1);
      assert.equal(limited.has_more, true);
    } finally {
      ndb.close();
    }
  });
});

describe('publication-assembly-service: кеш членства с дебаунсом', { skip }, () => {
  it('внутри окна отдаёт прежний результат, исполняя вычисление один раз', () => {
    let clock = 1_000;
    const cache = new PublicationMembershipCache(400, () => clock);
    let calls = 0;
    const compute = () => {
      calls += 1;
      return { items: [], total: calls, limit: 50, offset: 0, has_more: false };
    };
    assert.equal(cache.getCandidates('k', compute).total, 1);
    clock += 100;
    assert.equal(cache.getCandidates('k', compute).total, 1); // из кеша
    assert.equal(calls, 1);
    clock += 500; // за окном — пересчёт
    assert.equal(cache.getCandidates('k', compute).total, 2);
    assert.equal(calls, 2);
  });
});

describe('publication-assembly-service: buildSectionTree напрямую', { skip }, () => {
  it('пустой отбор даёт пустое дерево', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const { tree, shownIds } = buildSectionTree(ndb, [], new Map());
      assert.deepEqual(tree, []);
      assert.equal(shownIds.size, 0);
    } finally {
      ndb.close();
    }
  });
});
