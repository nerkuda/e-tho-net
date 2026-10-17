/**
 * Задача d5e8ddc1 (требование b91336e7, ADR 7581ac14): AST-условие МЫСЛЕВЫХ
 * настроек в точке поиска — валидация профилем `thoughts` и исполнение единым
 * движком вместе с FTS-текстом.
 *
 * Доказываем:
 *   1. паритет мыслевых настроек: плоские параметры и эквивалентный AST дают
 *      тот же набор (на дереве БЕЗ рёбер корзины);
 *   2. объявленное НАМЕРЕННОЕ отличие: ребро, помеченное на удаление, в новый
 *      подкорень не входит (прежний `collectSubtreeIds` его пропускал);
 *   3. `ast` XOR плоские мыслевые параметры → `VALIDATION_ERROR` (домен);
 *   4. условие вне профиля `thoughts` → `VALIDATION_ERROR` (сценарий 55f31eee);
 *   5. корпусные разделы не меняются AST; `by_links` и link-половина хронологии
 *      AST не фильтруются, thought-половина — фильтруется;
 *   6. автор/редактор (корпусные) совместимы с `ast`;
 *   7. ресурсный предохранитель подкорня → `VALIDATION_ERROR`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { EtnError, FILTER_AST_VERSION, typeNameKey, type FilterAst, type FilterAstNode } from '@etn/shared';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { collectSubtreeIds, search } from '../src/domain/search-service.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

function seedThought(
  ndb: NetworkDb,
  title: string,
  opts: { type_id?: string | null; active?: number; trashed?: number; created_by?: string } = {},
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, marked_for_deletion, is_protected,
                             is_root, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, '2024-01-01T00:00:00Z', ?, '2024-01-01T00:00:00Z', ?)`,
    )
    .run(
      id,
      title,
      title.normalize('NFC').trim().toLowerCase(),
      opts.type_id ?? null,
      opts.active ?? 1,
      opts.trashed ?? 0,
      opts.created_by ?? 'u',
      opts.created_by ?? 'u',
    );
  return id;
}

function seedThoughtType(ndb: NetworkDb, name: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thought_types (id, name, name_key, version, created_at, updated_at, created_by)
       VALUES (?, ?, ?, 1, '2024', '2024', 'u')`,
    )
    .run(id, name, typeNameKey(name));
  return id;
}

function seedComment(
  ndb: NetworkDb,
  ownerType: 'thought' | 'link',
  ownerId: string,
  body: string,
  kind: 'permanent' | 'chronological' = 'permanent',
  createdBy = 'u',
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO comments (id, owner_type, owner_id, kind, body_md, body_html, valid_from,
                             version, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, '2024-01-01', 1, '2024', '2024', ?, ?)`,
    )
    .run(id, ownerType, ownerId, kind, body, body, createdBy, createdBy);
  return id;
}

function seedLink(
  ndb: NetworkDb,
  sourceId: string,
  targetId: string,
  opts: { active?: number; trashed?: number } = {},
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, marked_for_deletion, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, NULL, ?, ?, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, sourceId, targetId, opts.active ?? 1, opts.trashed ?? 0);
  return id;
}

/** `and` из набора узлов; одиночный узел — как есть. */
function and(...children: FilterAstNode[]): FilterAst {
  return {
    version: FILTER_AST_VERSION,
    filter: children.length === 1 ? children[0]! : { op: 'and', children },
  };
}

/** Подкорень — паттерн «ИЛИ(id в [корень], parents in_hierarchy [корень] all_links)». */
function subtreeNode(root: string): FilterAstNode {
  return {
    op: 'or',
    children: [
      { entity: { kind: 'id' }, operator: 'in', value: [root] },
      { entity: { kind: 'parents' }, operator: 'in_hierarchy', mode: 'all_links', value: [root] },
    ],
  };
}

describe('search + AST мыслевых настроек (задача d5e8ddc1)', { skip: !nativeAvailable() }, () => {
  it('паритет: плоские мыслевые настройки и эквивалентный AST дают тот же набор', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const typeA = seedThoughtType(ndb, 'Тип A');
      const typeB = seedThoughtType(ndb, 'Тип B');
      const parent = seedThought(ndb, 'Parent node', { type_id: typeA });
      const child = seedThought(ndb, 'Child secret', { type_id: typeA });
      seedLink(ndb, parent, child);
      const inactiveChild = seedThought(ndb, 'Inactive secret', { type_id: typeA, active: 0 });
      seedLink(ndb, parent, inactiveChild);
      const other = seedThought(ndb, 'Other secret', { type_id: typeA });
      const wrongType = seedThought(ndb, 'Secret wrong type', { type_id: typeB });
      seedLink(ndb, parent, wrongType);
      seedComment(ndb, 'thought', child, 'comment secret here');
      seedComment(ndb, 'thought', other, 'comment secret there');
      seedComment(ndb, 'thought', child, 'chrono secret entry', 'chronological');

      // Плоский путь (обратная совместимость).
      const flatHidden = search(ndb, {
        q: 'secret',
        in: 'subtree',
        from_thought_id: parent,
        type_id: [typeA],
        show_inactive: false,
      });
      const flatShown = search(ndb, {
        q: 'secret',
        in: 'subtree',
        from_thought_id: parent,
        type_id: [typeA],
        show_inactive: true,
      });

      // Эквивалентный AST (те же мыслевые настройки, tree без рёбер корзины).
      const astHidden = and(
        subtreeNode(parent),
        { entity: { kind: 'type' }, operator: 'in_hierarchy', value: [typeA] },
        { entity: { kind: 'active' }, operator: 'eq', value: true },
        { entity: { kind: 'trashed' }, operator: 'eq', value: false },
      );
      const astShown = and(
        subtreeNode(parent),
        { entity: { kind: 'type' }, operator: 'in_hierarchy', value: [typeA] },
        { entity: { kind: 'trashed' }, operator: 'eq', value: false },
      );

      const idsOf = (r: { by_names: Array<{ thought_id: string }> }): string[] =>
        r.by_names.map((h) => h.thought_id).sort();

      const hidden = search(ndb, { q: 'secret', ast: astHidden });
      assert.deepEqual(idsOf(hidden), idsOf(flatHidden), 'show_inactive=false: AST ≡ плоский');
      assert.deepEqual(idsOf(hidden), [child], 'неактивная и чужая ветвь отсечены');

      const shown = search(ndb, { q: 'secret', ast: astShown });
      assert.deepEqual(idsOf(shown), idsOf(flatShown), 'show_inactive=true: AST ≡ плоский');
      assert.deepEqual(idsOf(shown), [inactiveChild, child].sort(), 'неактивная мысль видна');

      // Все три группы мыслей: names, texts, thought-половина хронологии.
      assert.deepEqual(
        hidden.meta.total_in_group,
        flatHidden.meta.total_in_group,
        'итоги по группам совпадают',
      );
      assert.deepEqual(
        hidden.by_texts.map((h) => h.thought_id),
        flatHidden.by_texts.map((h) => h.thought_id),
      );
      assert.deepEqual(
        hidden.by_chrono.map((h) => h.owner_id),
        flatHidden.by_chrono.map((h) => h.owner_id),
      );
      assert.ok(!idsOf(hidden).includes(other));
      assert.ok(!idsOf(hidden).includes(wrongType));
    } finally {
      ndb.close();
    }
  });

  it('объявленное отличие: ребро корзины в новый подкорень НЕ входит (а в collectSubtreeIds входило)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const parent = seedThought(ndb, 'Trunk');
      const viaTrash = seedThought(ndb, 'Hidden secret');
      seedLink(ndb, parent, viaTrash, { trashed: 1 });

      // Прежний плоский обход корзину не проверял — мысль входила.
      const legacy = collectSubtreeIds(ndb, parent);
      assert.ok(legacy?.has(viaTrash), 'прежний collectSubtreeIds включал мысль за ребром корзины');

      // Новый путь (плоский `in=subtree` теперь компилируется в AST) — не входит.
      const res = search(ndb, { q: 'secret', in: 'subtree', from_thought_id: parent });
      assert.equal(res.by_names.length, 0, 'через ребро корзины мысль не достижима');
    } finally {
      ndb.close();
    }
  });

  it('ast XOR плоские мыслевые параметры → VALIDATION_ERROR', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const t = seedThought(ndb, 'Xor target');
      const ast = and({ entity: { kind: 'active' }, operator: 'eq', value: true });
      const isValidation = (e: unknown): boolean =>
        e instanceof EtnError && e.code === 'VALIDATION_ERROR' && (e.details as { field?: string })?.field === 'ast';

      assert.throws(() => search(ndb, { q: 'xor', ast, type_id: [t] }), isValidation, 'type_id');
      assert.throws(() => search(ndb, { q: 'xor', ast, type: 'Тип' }), isValidation, 'type');
      assert.throws(() => search(ndb, { q: 'xor', ast, show_inactive: true }), isValidation, 'show_inactive');
      assert.throws(() => search(ndb, { q: 'xor', ast, trashed: true }), isValidation, 'trashed');
      assert.throws(
        () => search(ndb, { q: 'xor', ast, in: 'subtree', from_thought_id: t }),
        isValidation,
        'in/from_thought_id',
      );
      // Пустой массив type_id — «не указан», XOR не нарушает.
      assert.doesNotThrow(() => search(ndb, { q: 'xor', ast, type_id: [] }));
      // Корпусные параметры с ast совместимы всегда.
      assert.doesNotThrow(() =>
        search(ndb, { q: 'xor', ast, author_id: 'u', editor_id: 'u', link_type_id: [] }),
      );
    } finally {
      ndb.close();
    }
  });

  it('условие вне профиля `thoughts` → VALIDATION_ERROR (сценарий 55f31eee)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      seedThought(ndb, 'Profile probe');
      // `record_title` — операнд профиля «хроника», невидимый в профиле «мысли».
      const ast = and({ entity: { kind: 'record_title' }, operator: 'eq', value: 'x' });
      assert.throws(
        () => search(ndb, { q: 'probe', ast }),
        (e: unknown) =>
          e instanceof EtnError &&
          e.code === 'VALIDATION_ERROR' &&
          Array.isArray((e.details as { violations?: unknown[] })?.violations),
      );
    } finally {
      ndb.close();
    }
  });

  it('корпусные разделы не фильтруются AST: by_links и link-хронология сохраняются', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const typeA = seedThoughtType(ndb, 'Тип A');
      const typeB = seedThoughtType(ndb, 'Тип B');
      const a = seedThought(ndb, 'Corpus A', { type_id: typeA });
      const b = seedThought(ndb, 'Corpus B', { type_id: typeB });
      const link = seedLink(ndb, a, b);
      seedComment(ndb, 'thought', b, 'corpword in thought comment');
      seedComment(ndb, 'link', link, 'corpword in link comment');
      seedComment(ndb, 'thought', b, 'chronoword thought entry', 'chronological');
      seedComment(ndb, 'link', link, 'chronoword link entry', 'chronological');

      // AST: только мысли типа A (B отсечён на уровне мысли).
      const ast = and(
        { entity: { kind: 'type' }, operator: 'in_hierarchy', value: [typeA] },
        { entity: { kind: 'active' }, operator: 'eq', value: true },
        { entity: { kind: 'trashed' }, operator: 'eq', value: false },
      );

      const texts = search(ndb, { q: 'corpword', scope: 'texts', ast });
      assert.equal(texts.by_texts.length, 0, 'мысль типа B отсечена AST в by_texts');

      const links = search(ndb, { q: 'corpword', scope: 'links', ast });
      assert.equal(links.by_links.length, 1, 'AST не фильтрует хиты-связи');
      assert.equal(links.by_links[0]!.link_id, link);

      const chrono = search(ndb, { q: 'chronoword', scope: 'chronology', ast });
      const owners = chrono.by_chrono.map((h) => `${h.owner}:${h.owner_id}`).sort();
      assert.deepEqual(
        owners,
        [`link:${link}`].sort(),
        'thought-половина отфильтрована, link-половина (тип B) сохранена',
      );
      assert.equal(chrono.meta.total_in_group.chronology, 1);
    } finally {
      ndb.close();
    }
  });

  it('автор/редактор (корпусные) совместимы с ast и фильтруют', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      seedThought(ndb, 'Author secret one', { created_by: 'author-1' });
      seedThought(ndb, 'Author secret two', { created_by: 'author-2' });
      const ast = and({ entity: { kind: 'active' }, operator: 'eq', value: true });
      const res = search(ndb, { q: 'secret', ast, author_id: 'author-1' });
      assert.equal(res.by_names.length, 1);
      assert.equal(res.by_names[0]!.title, 'Author secret one');
    } finally {
      ndb.close();
    }
  });

  it('ресурсный предохранитель подкорня → VALIDATION_ERROR (не молчаливый результат)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      // «Звезда» шире HIERARCHY_SUBTREE_MAX_NODES = 2000 (цепочка не годится:
      // обход ограничен глубиной TRAVERSAL_DEFAULTS.MAX_DEPTH = 20, усечение по
      // глубине молчаливое в обоих путях — см. требование b91336e7).
      const root = seedThought(ndb, 'Chain root');
      for (let i = 0; i < 2001; i += 1) {
        const child = seedThought(ndb, `Chain node ${i}`);
        seedLink(ndb, root, child);
      }
      assert.throws(
        () => search(ndb, { q: 'chain', in: 'subtree', from_thought_id: root }),
        (e: unknown) =>
          e instanceof EtnError &&
          e.code === 'VALIDATION_ERROR' &&
          (e.details as { reason?: string })?.reason === 'hierarchy_budget',
      );
    } finally {
      ndb.close();
    }
  });

  it('ранжирование и сниппеты сохранены при ast', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      seedThought(ndb, 'Ranks alpha');
      const res = search(ndb, {
        q: 'alpha',
        ast: and({ entity: { kind: 'active' }, operator: 'eq', value: true }),
      });
      assert.equal(res.by_names.length, 1);
      assert.ok(res.by_names[0]!.snippet.includes('<mark>'), 'сниппет с подсветкой сохранён');
    } finally {
      ndb.close();
    }
  });
});
