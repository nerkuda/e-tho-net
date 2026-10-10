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
import { EtnError } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { createTypeProperty, setPropertyValue } from '../src/domain/property-service.js';
import {
  addPublicationExclusion,
  createPublication,
  getPublicationAcceptedIds,
  listPublicationExclusions,
  listPublicationOrder,
  removePublicationExclusion,
  setPublicationOrder,
  updatePublication,
} from '../src/domain/publication-service.js';
import { selectRecipeIds } from '../src/domain/publication-recipe.js';
import { queryThoughts, structureRequestToQuery } from '../src/domain/query-service.js';
import {
  acceptPublicationCandidate,
  assemblePublication,
  buildSectionTree,
  listPublicationCandidates,
  listPublicationUsage,
  publicationMembershipCache,
  PublicationMembershipCache,
  resetPublicationMembershipCache,
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

  /**
   * Контроль серверной семантики для блокера d13fd645: узел БЕЗ локальной
   * позиции не уезжает в конец — компаратор берёт сетевое/ветковое место
   * (`localOf(key) ?? branchPosition`, корни — `?? selectionIndex`). Порядок
   * рецепта alpha даёт отбору [A,B,C] (индексы 0,1,2); позиции только A и B
   * выше индекса C — C сохраняет первое место. Клиент обязан повторять это
   * (`applyPublicationOrder`, слоты неупорядоченных узлов).
   */
  it('узел без локальной позиции сохраняет своё место (не уезжает в конец)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const b = seedThought(ndb, 'B', type.id);
      const c = seedThought(ndb, 'C', type.id);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      // Отбор alpha → [A,B,C]; позиции заданы только A и B (выше индекса C).
      setPublicationOrder(
        ndb,
        pub.id,
        [
          { node_key: a, position: 5 },
          { node_key: b, position: 6 },
        ],
        USER,
      );

      const doc = assemblePublication(ndb, pub.id, USER);
      assert.deepEqual(sectionIds(doc.sections), [c, a, b]);
    } finally {
      ndb.close();
    }
  });

  it('отдаёт node_key раздела и применяет по нему локальный порядок вложенных', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const b = seedThought(ndb, 'B', type.id);
      const c = seedThought(ndb, 'C', type.id);
      const edgeB = seedUntypedLink(ndb, a, b, 0);
      const edgeC = seedUntypedLink(ndb, a, c, 1);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);

      const before = assemblePublication(ndb, pub.id, USER);
      const root = before.sections[0]!;
      // Корень адресуется id мысли, вложенные — id ребра вхождения.
      assert.equal(root.node_key, a);
      assert.deepEqual(
        root.children.map((child) => [child.thought_id, child.node_key]),
        [
          [b, edgeB],
          [c, edgeC],
        ],
      );

      // Локальный порядок по этим же ключам переставляет вложенные разделы.
      setPublicationOrder(
        ndb,
        pub.id,
        [
          { node_key: edgeC, position: 0 },
          { node_key: edgeB, position: 1 },
        ],
        USER,
      );
      const after = assemblePublication(ndb, pub.id, USER);
      assert.deepEqual(
        after.sections[0]!.children.map((child) => child.thought_id),
        [c, b],
      );
      // node_key следовал за узлом и после перестановки.
      assert.deepEqual(
        after.sections[0]!.children.map((child) => child.node_key),
        [edgeC, edgeB],
      );
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

  it('не ограничивает глубину дерева: цепочка 5000 рендерится без переполнения стека', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Deep' }, USER);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      let prev = seedThought(ndb, 'N0', type.id);
      for (let i = 1; i < 5000; i += 1) {
        const cur = seedThought(ndb, `N${i}`, type.id);
        seedUntypedLink(ndb, prev, cur, 0);
        prev = cur;
      }

      const doc = assemblePublication(ndb, pub.id, USER);
      // Обход результата итеративный — рекурсия в тесте упала бы так же, как
      // прежний рекурсивный рендер.
      let node = doc.sections[0]!;
      let depth = 1;
      while (node.children.length > 0) {
        node = node.children[0]!;
        depth += 1;
      }
      assert.equal(depth, 5000);
      assert.equal(node.level, 5000);
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
      const t3 = seedThought(ndb, 'T3', plain.id); // без комментария — пустой текст
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
      seedLink(ndb, a, t3, linkTypeId, 3);
      seedComment(ndb, t1, 'Текст один');
      seedComment(ndb, t2, 'Текст два');
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(type.id), text_sources: [prop] },
        USER,
      );

      const doc = assemblePublication(ndb, pub.id, USER);
      const texts = doc.sections.find((s) => s.thought_id === a)!.texts;
      // Пустой комментарий НЕ фильтруется: мысль-текст попадает в DTO с пустым
      // `body_html` (замечание 2 волны 7 — клиент рендерит пустой блок).
      assert.deepEqual(
        texts.map((t) => t.thought_id),
        [t1, t2, t3],
      );
      assert.match(texts[0]!.body_html, /Текст один/);
      assert.equal(texts[2]!.body_html, '');

      // Пустой рецепт текстов — только предисловие.
      updatePublication(ndb, pub.id, { text_sources: [] }, USER);
      const doc2 = assemblePublication(ndb, pub.id, USER);
      assert.equal(doc2.sections.find((s) => s.thought_id === a)!.texts.length, 0);
    } finally {
      ndb.close();
    }
  });

  it('размечает body_html текста позициями и отдаёт body_md для точной каретки (59774016)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const plain = createThoughtType(ndb, { name: 'Plain' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const t1 = seedThought(ndb, 'T1', plain.id);
      const prop = seedTextProperty(ndb, type.id);
      const lt = ndb
        .prepare('SELECT config FROM properties_v WHERE id = ?')
        .get(prop) as { config: string };
      const linkTypeId = (JSON.parse(lt.config) as { link_type_id: string }).link_type_id;
      seedLink(ndb, a, t1, linkTypeId, 0);
      const body = 'слово раз слово два';
      seedComment(ndb, t1, body);
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(type.id), text_sources: [prop] },
        USER,
      );

      const doc = assemblePublication(ndb, pub.id, USER);
      const text = doc.sections.find((s) => s.thought_id === a)!.texts[0]!;
      // Исходный фрагмент отдан рядом с HTML — координаты разметки в body_md.
      assert.equal(text.body_md, body);
      // Абзац размечен диапазоном всего исходника: каретка резолвится 1:1.
      assert.match(text.body_html, /data-md-start="0"/);
      assert.match(text.body_html, new RegExp(`data-md-end="${body.length}"`));
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

  it('исключение принимает мысль-текст публикации и отвергает постороннюю (3882bd46)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const plain = createThoughtType(ndb, { name: 'Plain' }, USER);
      const section = seedThought(ndb, 'Section', type.id);
      const text = seedThought(ndb, 'Text', plain.id);
      const prop = seedTextProperty(ndb, type.id);
      const lt = ndb.prepare('SELECT config FROM properties_v WHERE id = ?').get(prop) as {
        config: string;
      };
      const linkTypeId = (JSON.parse(lt.config) as { link_type_id: string }).link_type_id;
      seedLink(ndb, section, text, linkTypeId, 0);
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(type.id), text_sources: [prop] },
        USER,
      );
      // Текст входит в публикацию как содержимое раздела — исключение проходит.
      assert.equal(addPublicationExclusion(ndb, pub.id, text, USER).length, 1);
      // Мысль того же типа, но не связанная с разделом, — посторонняя.
      const stranger = seedThought(ndb, 'Stranger', plain.id);
      assert.throws(
        () => addPublicationExclusion(ndb, pub.id, stranger, USER),
        (e) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
      );
    } finally {
      ndb.close();
    }
  });

  it('снятие исключения чистит осиротевшую строку, когда мысль выпала из отбора (3882bd46)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const plain = createThoughtType(ndb, { name: 'Plain' }, USER);
      const other = createThoughtType(ndb, { name: 'Other' }, USER);
      const section = seedThought(ndb, 'Section', type.id);
      const text = seedThought(ndb, 'Text', plain.id);
      const prop = seedTextProperty(ndb, type.id);
      const lt = ndb.prepare('SELECT config FROM properties_v WHERE id = ?').get(prop) as {
        config: string;
      };
      const linkTypeId = (JSON.parse(lt.config) as { link_type_id: string }).link_type_id;
      seedLink(ndb, section, text, linkTypeId, 0);
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(type.id), text_sources: [prop] },
        USER,
      );
      // Текст — член публикации (содержимое раздела): исключение проходит.
      assert.equal(addPublicationExclusion(ndb, pub.id, text, USER).length, 1);

      // Рецепт перестал выбирать раздел, срез пересчитан → текст выпал из публикации.
      updatePublication(ndb, pub.id, { title_recipe: recipeForType(other.id) }, USER);
      setPublicationOrder(ndb, pub.id, [], USER);

      // Снятие исключения разрешено (строка физически есть) и подчищает её:
      // осиротевшая строка не подавит мысль при возврате в отбор.
      assert.equal(removePublicationExclusion(ndb, pub.id, text).length, 0);
      assert.equal(listPublicationExclusions(ndb, pub.id).length, 0);
    } finally {
      ndb.close();
    }
  });
});

describe('publication-assembly-service: тексты — единый пул свойств раздела (волна 8)', { skip }, () => {
  /**
   * Второе свойство-источник текстов: `seedTextProperty` создаёт тип связи с
   * фиксированными именами (второй вызов в той же сети даёт DUPLICATE) —
   * поэтому здесь имена уникальны.
   */
  const seedAnotherTextProperty = (ndb: NetworkDb, typeId: string): string => {
    const suffix = randomUUID().slice(0, 8);
    const linkType = createLinkType(
      ndb,
      { name_forward: `Текст-${suffix}`, name_reverse: `Раздел-${suffix}` },
      USER,
    );
    const prop = createTypeProperty(
      ndb,
      'thought_type',
      typeId,
      {
        key: `texts2-${suffix}`,
        value_type: 'link',
        config: { link_type_id: linkType.id },
      },
      USER,
    );
    return prop.property_id;
  };
  /** link_type_id свойства-связи (для seedLink). */
  const linkTypeOf = (ndb: NetworkDb, propId: string): string => {
    const row = ndb.prepare('SELECT config FROM properties_v WHERE id = ?').get(propId) as {
      config: string;
    };
    return (JSON.parse(row.config) as { link_type_id: string }).link_type_id;
  };
  const textIdsOf = (
    doc: ReturnType<typeof assemblePublication>,
    sectionId: string,
  ): string[] => doc.sections.find((s) => s.thought_id === sectionId)!.texts.map((t) => t.thought_id);

  it('новый текст первого свойства с последней позицией — ПОСЛЕДНИЙ в сборке', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const plain = createThoughtType(ndb, { name: 'Plain' }, USER);
      const section = seedThought(ndb, 'S', type.id);
      const tFull = seedThought(ndb, 'TFull', plain.id);
      const tEmpty = seedThought(ndb, 'TEmpty', plain.id);
      const tNew = seedThought(ndb, 'TNew', plain.id);
      const p1 = seedTextProperty(ndb, type.id);
      const p2 = seedAnotherTextProperty(ndb, type.id);
      const eFull = seedLink(ndb, section, tFull, linkTypeOf(ndb, p1), 0);
      const eEmpty = seedLink(ndb, section, tEmpty, linkTypeOf(ndb, p2), 0);
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(type.id), text_sources: [p1, p2] },
        USER,
      );
      // Базовый порядок: tFull (свойство 1), tEmpty (свойство 2).
      setPublicationOrder(ndb, pub.id, [
        { node_key: eFull, position: 1 },
        { node_key: eEmpty, position: 2 },
      ], USER);
      assert.deepEqual(textIdsOf(assemblePublication(ndb, pub.id, USER), section), [tFull, tEmpty]);

      // Новый текст добавлен в ПЕРВОЕ свойство (штатный сценарий «Добавить
      // текст раздела…»): его ребро идёт первым по сетевой позиции.
      const eNew = seedLink(ndb, section, tNew, linkTypeOf(ndb, p1), 0);
      // Клиент назначает ему позицию ПОСЛЕДНЕГО во всей группе текстов раздела.
      setPublicationOrder(ndb, pub.id, [
        { node_key: eFull, position: 1 },
        { node_key: eEmpty, position: 2 },
        { node_key: eNew, position: 3 },
      ], USER);
      // Перечитывание сборки (аналог F5) — новый текст ПОСЛЕДНИЙ, существующие
      // сохраняют взаимный порядок.
      assert.deepEqual(
        textIdsOf(assemblePublication(ndb, pub.id, USER), section),
        [tFull, tEmpty, tNew],
        'новый текст — последний независимо от того, в каком свойстве он лежит',
      );
    } finally {
      ndb.close();
    }
  });

  it('перемещение текста через границу свойства (PUT order) меняет порядок сборки', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const plain = createThoughtType(ndb, { name: 'Plain' }, USER);
      const section = seedThought(ndb, 'S', type.id);
      const tA = seedThought(ndb, 'TA', plain.id);
      const tB = seedThought(ndb, 'TB', plain.id);
      const p1 = seedTextProperty(ndb, type.id);
      const p2 = seedAnotherTextProperty(ndb, type.id);
      const eA = seedLink(ndb, section, tA, linkTypeOf(ndb, p1), 0);
      const eB = seedLink(ndb, section, tB, linkTypeOf(ndb, p2), 0);
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(type.id), text_sources: [p1, p2] },
        USER,
      );
      setPublicationOrder(ndb, pub.id, [
        { node_key: eA, position: 1 },
        { node_key: eB, position: 2 },
      ], USER);
      assert.deepEqual(textIdsOf(assemblePublication(ndb, pub.id, USER), section), [tA, tB]);
      // Alt/DnD: текст свойства 2 встаёт перед текстом свойства 1.
      setPublicationOrder(ndb, pub.id, [
        { node_key: eB, position: 1 },
        { node_key: eA, position: 2 },
      ], USER);
      assert.deepEqual(
        textIdsOf(assemblePublication(ndb, pub.id, USER), section),
        [tB, tA],
        'локальный порядок перекрывает и границу свойства',
      );
    } finally {
      ndb.close();
    }
  });

  it('тексты без локальных позиций — детерминированный порядок (сетевое место, свойство, id)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const plain = createThoughtType(ndb, { name: 'Plain' }, USER);
      const section = seedThought(ndb, 'S', type.id);
      const tA = seedThought(ndb, 'TA', plain.id);
      const tB = seedThought(ndb, 'TB', plain.id);
      const tC = seedThought(ndb, 'TC', plain.id);
      const p1 = seedTextProperty(ndb, type.id);
      const p2 = seedAnotherTextProperty(ndb, type.id);
      const lt1 = linkTypeOf(ndb, p1);
      const lt2 = linkTypeOf(ndb, p2);
      seedLink(ndb, section, tA, lt1, 0);
      seedLink(ndb, section, tB, lt1, 1);
      seedLink(ndb, section, tC, lt2, 0);
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(type.id), text_sources: [p1, p2] },
        USER,
      );
      // Сетевое место: tA(0,свойство1), tC(0,свойство2), tB(1,свойство1);
      // ничья tA/tC разрешается индексом свойства → [tA, tC, tB].
      const first = textIdsOf(assemblePublication(ndb, pub.id, USER), section);
      assert.deepEqual(first, [tA, tC, tB]);
      // Повторная сборка даёт тот же порядок (детерминизм).
      assert.deepEqual(textIdsOf(assemblePublication(ndb, pub.id, USER), section), first);
    } finally {
      ndb.close();
    }
  });
});

describe('publication-assembly-service: кандидаты (временная семантика)', { skip }, () => {
  it('новая мысль под отбор становится кандидатом; при создании кандидатов нет', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      // a подошла под рецепт ДО создания — принята, кандидатов нет.
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      assert.equal(listPublicationCandidates(ndb, pub.id, USER).total, 0);
      assert.equal(assemblePublication(ndb, pub.id, USER).publication.new_candidates, 0);

      // Новая мысль вошла в отбор позже принятого состояния — кандидат.
      const b = seedThought(ndb, 'B', type.id);
      const grown = listPublicationCandidates(ndb, pub.id, USER);
      assert.deepEqual(grown.items.map((c) => c.thought_id), [b]);
      assert.equal(grown.total, 1);
      // Живая сборка показывает и принятую, и нового кандидата в дереве.
      assert.deepEqual(sectionIds(assemblePublication(ndb, pub.id, USER).sections), [a, b]);
      // Плашка «+N» считается тем же вызовом.
      assert.equal(assemblePublication(ndb, pub.id, USER).publication.new_candidates, 1);
    } finally {
      ndb.close();
    }
  });

  it('расширение рецепта на существующие мысли даёт кандидата (впервые подошли)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const docType = createThoughtType(ndb, { name: 'Doc' }, USER);
      const noteType = createThoughtType(ndb, { name: 'Note' }, USER);
      seedThought(ndb, 'A', docType.id);
      const b = seedThought(ndb, 'B', noteType.id);
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(docType.id) },
        USER,
      );
      // b существует давно, но под рецепт не подходила — не кандидат (её нет в отборе).
      assert.equal(listPublicationCandidates(ndb, pub.id, USER).total, 0);

      // Рецепт расширен на тип Note: b впервые вошла в отбор — кандидат.
      updatePublication(
        ndb,
        pub.id,
        { title_recipe: { type_ids: [docType.id, noteType.id], sort: 'alpha', order: 'asc' } },
        USER,
      );
      const grown = listPublicationCandidates(ndb, pub.id, USER);
      // a принята при создании и остаётся принятой; кандидат — только b.
      assert.deepEqual(grown.items.map((c) => c.thought_id), [b]);
      assert.equal(grown.total, 1);
    } finally {
      ndb.close();
    }
  });

  it('«расставить» гасит одного кандидата (другие остаются) и фиксирует позицию в конец', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      const x = seedThought(ndb, 'X', type.id);
      const y = seedThought(ndb, 'Y', type.id);
      assert.deepEqual(
        listPublicationCandidates(ndb, pub.id, USER).items.map((c) => c.thought_id).sort(),
        [x, y].sort(),
      );

      const order = acceptPublicationCandidate(ndb, pub.id, x, USER);
      // x погашен индивидуально, y остаётся кандидатом.
      assert.deepEqual(listPublicationCandidates(ndb, pub.id, USER).items.map((c) => c.thought_id), [y]);
      // Позиция x зафиксирована в конец порядка.
      assert.equal(order[order.length - 1]!.node_key, x);
      assert.deepEqual(listPublicationOrder(ndb, pub.id).map((i) => i.node_key), [x]);

      // Идемпотентность: повторный accept не двигает позицию (no-op).
      const repeat = acceptPublicationCandidate(ndb, pub.id, x, USER);
      assert.deepEqual(repeat.map((i) => i.node_key), [x]);
      assert.equal(repeat[0]!.position, order[0]!.position, 'позиция не дрейфует');
    } finally {
      ndb.close();
    }
  });

  it('«скрыть» (исключение) убирает кандидата; снятие исключения возвращает', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      const x = seedThought(ndb, 'X', type.id);
      assert.equal(listPublicationCandidates(ndb, pub.id, USER).total, 1);

      addPublicationExclusion(ndb, pub.id, x, USER);
      assert.equal(listPublicationCandidates(ndb, pub.id, USER).total, 0);

      removePublicationExclusion(ndb, pub.id, x);
      assert.equal(listPublicationCandidates(ndb, pub.id, USER).total, 1);
    } finally {
      ndb.close();
    }
  });

  it('сохранение порядка принимает все текущие узлы (плашка уходит)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      const x = seedThought(ndb, 'X', type.id);
      const y = seedThought(ndb, 'Y', type.id);
      assert.equal(listPublicationCandidates(ndb, pub.id, USER).total, 2);

      setPublicationOrder(
        ndb,
        pub.id,
        [
          { node_key: x, position: 1 },
          { node_key: y, position: 2 },
        ],
        USER,
      );
      assert.equal(listPublicationCandidates(ndb, pub.id, USER).total, 0);

      // Новая мысль после сохранения снова кандидат.
      seedThought(ndb, 'Z', type.id);
      assert.equal(listPublicationCandidates(ndb, pub.id, USER).total, 1);
    } finally {
      ndb.close();
    }
  });

  it('уважает лимит и пагинацию', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      seedThought(ndb, 'A', type.id);
      seedThought(ndb, 'B', type.id);
      seedThought(ndb, 'C', type.id);

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

  it('кандидат несёт путь в дереве (breadcrumbs) — элемент интерфейса 43ec961f', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const a = seedThought(ndb, 'A', type.id);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      // b — корень, c — вложенный в a (a принята при создании).
      const b = seedThought(ndb, 'B', type.id);
      const c = seedThought(ndb, 'C', type.id);
      seedUntypedLink(ndb, a, c, 0);

      const items = listPublicationCandidates(ndb, pub.id, USER).items;
      const byId = new Map(items.map((i) => [i.thought_id, i]));
      assert.deepEqual(byId.get(b)?.breadcrumbs, ['B']);
      assert.deepEqual(byId.get(c)?.breadcrumbs, ['A', 'C']);
    } finally {
      ndb.close();
    }
  });

  it('неинициализированный срез (импорт/legacy) кандидатов не даёт', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      seedThought(ndb, 'B', type.id);
      assert.equal(listPublicationCandidates(ndb, pub.id, USER).total, 1);

      ndb.prepare('UPDATE publications SET accepted_ids = NULL WHERE id = ?').run(pub.id);
      assert.equal(listPublicationCandidates(ndb, pub.id, USER).total, 0);
    } finally {
      ndb.close();
    }
  });

  it('accept отвергает не-кандидата, не меняя срез и порядок (ошибка 2d33ef90)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const docType = createThoughtType(ndb, { name: 'Doc' }, USER);
      const otherType = createThoughtType(ndb, { name: 'Other' }, USER);
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(docType.id) },
        USER,
      );
      const candidate = seedThought(ndb, 'X', docType.id);
      const outsider = seedThought(ndb, 'O', otherType.id);

      const acceptedBefore = getPublicationAcceptedIds(ndb, pub.id);
      const orderBefore = listPublicationOrder(ndb, pub.id);

      assert.throws(
        () => acceptPublicationCandidate(ndb, pub.id, outsider, USER),
        (e) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
      );
      // Срез и порядок не изменились.
      assert.deepEqual(getPublicationAcceptedIds(ndb, pub.id), acceptedBefore);
      assert.deepEqual(listPublicationOrder(ndb, pub.id), orderBefore);

      // Кандидат принимается, идемпотентный повтор — успех.
      acceptPublicationCandidate(ndb, pub.id, candidate, USER);
      assert.deepEqual(listPublicationOrder(ndb, pub.id).map((i) => i.node_key), [candidate]);
      acceptPublicationCandidate(ndb, pub.id, candidate, USER);
      assert.deepEqual(listPublicationOrder(ndb, pub.id).map((i) => i.node_key), [candidate]);
    } finally {
      ndb.close();
    }
  });

  it('accept отвергает исключённую мысль (она не кандидат)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      const x = seedThought(ndb, 'X', type.id);
      addPublicationExclusion(ndb, pub.id, x, USER);
      assert.throws(
        () => acceptPublicationCandidate(ndb, pub.id, x, USER),
        (e) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
      );
      assert.deepEqual(listPublicationOrder(ndb, pub.id), []);
    } finally {
      ndb.close();
    }
  });

  it('пустой рецепт даёт пустую сборку и предупреждение (задача 7cfaba7c)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      seedThought(ndb, 'A', type.id);
      seedThought(ndb, 'B', type.id);
      const pub = createPublication(
        ndb,
        { title: 'Док', title_recipe: { sort: 'alpha', order: 'asc' } },
        USER,
      );
      // Никакие мысли не «приняты»: отбор пуст.
      assert.deepEqual(getPublicationAcceptedIds(ndb, pub.id), []);
      const doc = assemblePublication(ndb, pub.id, USER);
      assert.equal(doc.sections.length, 0);
      assert.equal(doc.publication.new_candidates, 0);
      assert.ok(
        doc.warnings.some((w) => w.includes('отбор заголовков не задан')),
        `warnings: ${JSON.stringify(doc.warnings)}`,
      );
      assert.equal(listPublicationCandidates(ndb, pub.id, USER).total, 0);
    } finally {
      ndb.close();
    }
  });

  it('рецепт с parent_ids собирает поддерево так же, как REST-выборка (ошибка b9db6c0a)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const catalog = seedThought(ndb, 'Каталог');
      const kids = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((title) => {
        const id = seedThought(ndb, title);
        seedUntypedLink(ndb, catalog, id, 0);
        return id;
      });
      const recipe = {
        parent_ids: [catalog],
        active: true,
        sort: 'alpha' as const,
        order: 'asc' as const,
      };

      // Контроль: отбор рецепта обязан совпасть с REST-выборкой того же фильтра
      // (тот же `structureRequestToQuery`). Если путь теряет `subtree`, рецепт
      // вернёт всю сеть — расхождение поймает это сравнение.
      const warnings: string[] = [];
      const recipeIds = selectRecipeIds(ndb, USER, recipe, warnings).sort();
      const rest = queryThoughts(
        ndb,
        USER,
        structureRequestToQuery({ ...recipe, limit: 2000, offset: 0 } as never),
        {},
      );
      assert.deepEqual(recipeIds, rest.items.map((i) => i.id).sort());
      assert.deepEqual(recipeIds, [...kids, catalog].sort());
      assert.deepEqual(warnings, []);

      // Сборка: каталог — корневой раздел, страницы-дети вложены в него.
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipe }, USER);
      const doc = assemblePublication(ndb, pub.id, USER);
      assert.equal(doc.sections.length, 1);
      assert.equal(doc.sections[0]!.thought_id, catalog);
      assert.deepEqual(
        doc.sections[0]!.children.map((c) => c.thought_id).sort(),
        [...kids].sort(),
      );
    } finally {
      ndb.close();
    }
  });

  it('рецепт с пустым parent_ids — пустая сборка с предупреждением, а не вся сеть (ошибка b9db6c0a)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      seedThought(ndb, 'A');
      seedThought(ndb, 'B');
      seedThought(ndb, 'C');
      // Рецепт задаёт отбор по родителю, но список корней пуст — парсер его
      // отбрасывает, и остаётся один модификатор `active`. Такой рецепт не
      // должен молча исполняться как «вся активная сеть» (живой симптом
      // ошибки: 255+ разделов без предупреждения).
      const recipe = {
        parent_ids: [] as string[],
        active: true,
        sort: 'alpha' as const,
        order: 'asc' as const,
      };
      const warnings: string[] = [];
      assert.deepEqual(selectRecipeIds(ndb, USER, recipe, warnings), []);
      assert.ok(
        warnings.some((w) => w.includes('отбор заголовков не задан')),
        `warnings: ${JSON.stringify(warnings)}`,
      );

      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipe }, USER);
      assert.deepEqual(getPublicationAcceptedIds(ndb, pub.id), []);
      const doc = assemblePublication(ndb, pub.id, USER);
      assert.equal(doc.sections.length, 0);
      assert.ok(
        doc.warnings.some((w) => w.includes('отбор заголовков не задан')),
        `warnings: ${JSON.stringify(doc.warnings)}`,
      );
    } finally {
      ndb.close();
    }
  });

  it('рецепт не задан (null) — та же пустая сборка с предупреждением (7cfaba7c, п.2)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      seedThought(ndb, 'A', type.id);
      seedThought(ndb, 'B', type.id);
      // Мастер создания не задаёт рецепт — в базе `null` (а не пустой объект).
      const pub = createPublication(ndb, { title: 'Док' }, USER);
      assert.equal(pub.title_recipe, null);
      const doc = assemblePublication(ndb, pub.id, USER);
      assert.equal(doc.sections.length, 0);
      assert.ok(
        doc.warnings.some((w) => w.includes('отбор заголовков не задан')),
        `warnings: ${JSON.stringify(doc.warnings)}`,
      );
      assert.equal(listPublicationCandidates(ndb, pub.id, USER).total, 0);
    } finally {
      ndb.close();
    }
  });

  it('валидный рецепт не даёт предупреждения о пустом отборе (регресс)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      seedThought(ndb, 'A', type.id);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      const doc = assemblePublication(ndb, pub.id, USER);
      assert.ok(
        !doc.warnings.some((w) => w.includes('отбор заголовков не задан')),
        `warnings: ${JSON.stringify(doc.warnings)}`,
      );
      assert.ok(doc.sections.length > 0, 'валидный рецепт даёт разделы');
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
      // Цель перехода (0.11.1, задача 3275fd8d): якорь первого вхождения и
      // страница корневого раздела.
      assert.equal(sectionUsage.items[0]!.anchor, publicationAnchor(section));
      assert.equal(sectionUsage.items[0]!.page, 1);

      const textUsage = listPublicationUsage(ndb, text, USER);
      assert.equal(textUsage.items[0]!.role, 'text');
      assert.equal(textUsage.items[0]!.section_title, 'Section');
      assert.equal(textUsage.items[0]!.anchor, publicationAnchor(text));
      assert.equal(textUsage.items[0]!.page, 1);

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
      // У прямой ссылки раздела нет — якоря и страницы тоже.
      assert.equal(directUsage.items[0]!.anchor, undefined);
      assert.equal(directUsage.items[0]!.page, undefined);

      // Лимит.
      const limited = listPublicationUsage(ndb, section, USER, { limit: 0 });
      assert.equal(limited.items.length, 0);
      assert.equal(limited.total, 1);
      assert.equal(limited.has_more, true);
    } finally {
      ndb.close();
    }
  });

  it('страница вхождения — по корневому разделу (21-й корень → страница 2)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const type = createThoughtType(ndb, { name: 'Root' }, USER);
      // 21 корневой раздел: рабочий стол сборки — 20 корней на страницу.
      const roots = Array.from({ length: 21 }, (_, i) =>
        seedThought(ndb, `R${String(i + 1).padStart(2, '0')}`, type.id),
      );
      createPublication(
        ndb,
        { title: 'Док', title_recipe: recipeForType(type.id) },
        USER,
      );
      const first = listPublicationUsage(ndb, roots[0]!, USER).items[0]!;
      assert.equal(first.role, 'section');
      assert.equal(first.page, 1);
      assert.equal(first.anchor, publicationAnchor(roots[0]!));

      const last = listPublicationUsage(ndb, roots[20]!, USER).items[0]!;
      assert.equal(last.role, 'section');
      assert.equal(last.page, 2);
      assert.equal(last.anchor, publicationAnchor(roots[20]!));
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

  it('фасад кандидатов использует кеш; мутация публикации его сбрасывает', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      resetPublicationMembershipCache();
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      const x = seedThought(ndb, 'X', type.id);
      seedThought(ndb, 'Y', type.id);
      const cached = (): number =>
        listPublicationCandidates(ndb, pub.id, USER, { cache: publicationMembershipCache }).total;
      assert.equal(cached(), 2);

      // Изменение мыслей — НЕ мутация публикации: в окне кеш отдаёт прежний счётчик
      // (ADR 7adf7778: индекс членства хуками записи мыслей не поддерживается).
      seedThought(ndb, 'Z', type.id);
      assert.equal(cached(), 2, 'внутри окна дебаунса — кешированный счётчик');
      resetPublicationMembershipCache();
      assert.equal(cached(), 3, 'после окна/сброса — свежий счётчик');

      // Сохранение порядка — мутация публикации: кеш сброшен, все текущие приняты.
      setPublicationOrder(ndb, pub.id, [{ node_key: x, position: 1 }], USER);
      assert.equal(cached(), 0);
    } finally {
      resetPublicationMembershipCache();
      ndb.close();
    }
  });

  it('«расставить» и «скрыть» сбрасывают кеш кандидатов', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      resetPublicationMembershipCache();
      const type = createThoughtType(ndb, { name: 'Doc' }, USER);
      const pub = createPublication(ndb, { title: 'Док', title_recipe: recipeForType(type.id) }, USER);
      const x = seedThought(ndb, 'X', type.id);
      const y = seedThought(ndb, 'Y', type.id);
      const cached = (): number =>
        listPublicationCandidates(ndb, pub.id, USER, { cache: publicationMembershipCache }).total;
      assert.equal(cached(), 2);

      acceptPublicationCandidate(ndb, pub.id, x, USER);
      assert.equal(cached(), 1, '«расставить» сбросил кеш');
      addPublicationExclusion(ndb, pub.id, y, USER);
      assert.equal(cached(), 0, '«скрыть» сбросил кеш');
    } finally {
      resetPublicationMembershipCache();
      ndb.close();
    }
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
