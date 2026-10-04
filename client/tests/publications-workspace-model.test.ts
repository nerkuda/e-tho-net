/**
 * Юнит-тесты чистой модели рабочей области открытой публикации (0.11.1,
 * задача 4f03b9d5, элемент интерфейса 2ebacd12): разворот дерева разделов,
 * ключ локального порядка и перестановка узлов.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  Publication,
  PublicationAssembly,
  PublicationAssemblySection,
} from '@etn/shared';

import {
  applyPublicationOrder,
  blockSignature,
  collapsibleSectionIds,
  documentBlocks,
  flattenSections,
  linkEntryMatchesPick,
  positionsFor,
  reorderIds,
  sectionNodeKey,
  siblingNodeKeys,
  subtreeIds,
  tocLines,
} from '../src/renderer/screens/publications/model.js';
import { reconcileKeyed } from '../src/renderer/lib/ui/keyed-list.js';
import { ShimElement } from './dom-shim.js';

/** Минимальная карточка публикации для подписи титула. */
function makePublication(overrides: Partial<Publication> = {}): Publication {
  return {
    id: 'pub1',
    title: 'Док',
    subtitle: null,
    summary_md: null,
    authorship: null,
    cover_attachment_id: null,
    cover_url: null,
    cover_kind: 'none',
    assembly_date: null,
    title_recipe: null,
    text_sources: [],
    extra_properties: [],
    numbering_from: null,
    numbering_to: null,
    active: true,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    version: 1,
    created_at: '2024-01-01T00:00:00Z',
    created_by: 'u',
    updated_at: '2024-01-01T00:00:00Z',
    updated_by: 'u',
    ...overrides,
  };
}

/** Минимальная сборка документа с заданными разделами. */
function makeAssembly(
  sections: PublicationAssemblySection[],
  summaryHtml = '',
): PublicationAssembly {
  return {
    publication: {
      title: 'Док',
      subtitle: null,
      authorship: null,
      assembly_date: null,
      summary_html: summaryHtml,
      cover: { kind: 'placeholder', ref: null },
      new_candidates: 0,
    },
    sections,
    excluded: [],
    warnings: [],
    meta: { page: 1, per_page: 20, total_roots: sections.length, has_more: false },
  };
}

/**
 * Раздел сборки: минимальный узел с детьми. `nodeKey` по умолчанию — id мысли
 * (корень), у вложенного — id ребра вхождения (`e:<id>`).
 */
function section(
  thoughtId: string,
  children: PublicationAssemblySection[] = [],
  nodeKey = `e:${thoughtId}`,
): PublicationAssemblySection {
  return {
    thought_id: thoughtId,
    node_key: nodeKey,
    anchor: `pub-${thoughtId}`,
    level: 1,
    heading: thoughtId,
    preamble_html: '',
    texts: [],
    extra: [],
    flags: { repeat_of: null, cycle_cut: false },
    children,
  };
}

describe('модель рабочей области публикации: дерево разделов', () => {
  it('разворачивает дерево в плоский список в порядке документа (DFS)', () => {
    const tree = [section('A', [section('B'), section('C', [section('D')])]), section('E')];
    const flat = flattenSections(tree);
    assert.deepEqual(
      flat.map((item) => [item.section.thought_id, item.depth, item.parentThoughtId]),
      [
        ['A', 0, null],
        ['B', 1, 'A'],
        ['C', 1, 'A'],
        ['D', 2, 'C'],
        ['E', 0, null],
      ],
    );
  });

  it('ключ порядка берётся из DTO для корня и для вложенного раздела', () => {
    const flat = flattenSections([section('A', [section('B')], 'A')]);
    const [root, child] = flat;
    assert.equal(sectionNodeKey(root!), 'A');
    assert.equal(sectionNodeKey(child!), 'e:B');
  });

  it('выделяет группу соседей одного родителя (корни — parentThoughtId null)', () => {
    const tree = [
      section('A', [section('B'), section('C')], 'A'),
      section('D', [], 'D'),
    ];
    const flat = flattenSections(tree);
    assert.deepEqual(siblingNodeKeys(flat, null), ['A', 'D']);
    assert.deepEqual(siblingNodeKeys(flat, 'A'), ['e:B', 'e:C']);
    assert.deepEqual(siblingNodeKeys(flat, 'B'), []);
  });
});

describe('модель рабочей области публикации: перестановка узлов', () => {
  it('переносит узел перед указанным соседом', () => {
    assert.deepEqual(reorderIds(['A', 'B', 'C'], 'C', 'A'), ['C', 'A', 'B']);
    assert.deepEqual(reorderIds(['A', 'B', 'C'], 'A', 'C'), ['B', 'A', 'C']);
  });

  it('null-сосед ставит узел в конец', () => {
    assert.deepEqual(reorderIds(['A', 'B', 'C'], 'A', null), ['B', 'C', 'A']);
  });

  it('неизвестный перемещаемый узел возвращает исходный список', () => {
    assert.deepEqual(reorderIds(['A', 'B'], 'X', 'A'), ['A', 'B']);
  });

  it('неизвестный сосед трактуется как «в конец»', () => {
    assert.deepEqual(reorderIds(['A', 'B'], 'A', 'Z'), ['B', 'A']);
  });

  it('назначает позиции 1..N по порядку списка', () => {
    assert.deepEqual(positionsFor(['A', 'B', 'C']), [
      { node_key: 'A', position: 1 },
      { node_key: 'B', position: 2 },
      { node_key: 'C', position: 3 },
    ]);
  });

  it('переставляет вложенные разделы по node_key, не трогая корни', () => {
    const tree = [section('A', [section('B'), section('C'), section('D')], 'A')];
    const flat = flattenSections(tree);
    const keys = siblingNodeKeys(flat, 'A');
    assert.deepEqual(keys, ['e:B', 'e:C', 'e:D']);
    const next = reorderIds(keys, 'e:D', 'e:B');
    assert.deepEqual(next, ['e:D', 'e:B', 'e:C']);
    assert.deepEqual(positionsFor(next), [
      { node_key: 'e:D', position: 1 },
      { node_key: 'e:B', position: 2 },
      { node_key: 'e:C', position: 3 },
    ]);
    // Корневая группа при перестановке вложенных не меняется.
    assert.deepEqual(siblingNodeKeys(flat, null), ['A']);
  });
});

describe('модель рабочей области: применение локального порядка (d13fd645)', () => {
  const text = (id: string): PublicationAssemblySection['texts'][number] => ({
    thought_id: id,
    anchor: `pub-${id}`,
    edge_id: `e:${id}`,
    body_html: `<p>${id}</p>`,
  });
  const nested = (id: string): PublicationAssemblySection => ({ ...section(id), level: 2 });

  it('переставляет корневые разделы, не трогая их содержимое', () => {
    const asm = makeAssembly([section('A', [nested('A1')]), section('B'), section('C')]);
    const ordered = applyPublicationOrder(asm, positionsFor(['e:C', 'e:A', 'e:B']))!;
    assert.deepEqual(ordered.sections.map((s) => s.thought_id), ['C', 'A', 'B']);
    const a = ordered.sections.find((s) => s.thought_id === 'A')!;
    assert.deepEqual(a.children.map((c) => c.thought_id), ['A1']);
  });

  it('переставляет тексты внутри раздела, не вынося их к другому разделу', () => {
    const asm = makeAssembly([
      { ...section('A'), texts: [text('A1'), text('A2'), text('A3')] },
      { ...section('B'), texts: [text('B1')] },
    ]);
    const ordered = applyPublicationOrder(asm, positionsFor(['e:A3', 'e:A1', 'e:A2']))!;
    assert.deepEqual(ordered.sections[0]!.texts.map((t) => t.thought_id), ['A3', 'A1', 'A2']);
    assert.deepEqual(ordered.sections[1]!.texts.map((t) => t.thought_id), ['B1']);
  });

  it('вложенный node_key не пересекает уровни: корни остаются на месте', () => {
    const asm = makeAssembly([section('A', [nested('A1'), nested('A2')]), section('B')]);
    const ordered = applyPublicationOrder(asm, positionsFor(['e:A2', 'e:A1']))!;
    assert.deepEqual(ordered.sections.map((s) => s.thought_id), ['A', 'B']);
    assert.deepEqual(ordered.sections[0]!.children.map((c) => c.thought_id), ['A2', 'A1']);
  });

  it('без позиции узел сохраняет место; применение идемпотентно', () => {
    const asm = makeAssembly([section('A'), section('B'), section('C')]);
    const items = positionsFor(['e:B', 'e:A']);
    const once = applyPublicationOrder(asm, items)!;
    assert.deepEqual(once.sections.map((s) => s.thought_id), ['B', 'A', 'C']);
    const twice = applyPublicationOrder(once, items)!;
    assert.deepEqual(twice.sections.map((s) => s.thought_id), ['B', 'A', 'C']);
  });

  it('пустой батч и `null`-сборка возвращаются как есть', () => {
    const asm = makeAssembly([section('A')]);
    assert.equal(applyPublicationOrder(asm, []), asm);
    assert.equal(applyPublicationOrder(null, positionsFor(['A'])), null);
  });

  /**
   * Блокер верификатора d13fd645: узел без локальной позиции НЕ уезжает в
   * конец. Серверный компаратор берёт для него сетевое/ветковое место
   * (`localOf ?? branchPosition / selectionIndex`,
   * `server/src/domain/publication-assembly-service.ts:475,495,505,511-534`),
   * то есть он остаётся на своём текущем месте. Детерминированный кейс:
   * порядок [C,A,B], позиции только A=1,B=2 → C сохраняет первое место.
   */
  it('узел без позиции сохраняет место: [C,A,B] + {A:1,B:2} → [C,A,B]', () => {
    const asm = makeAssembly([section('C'), section('A'), section('B')]);
    assert.deepEqual(
      asm.sections.map((s) => s.thought_id),
      ['C', 'A', 'B'],
    );
    const ordered = applyPublicationOrder(asm, [
      { node_key: 'e:A', position: 1 },
      { node_key: 'e:B', position: 2 },
    ])!;
    assert.deepEqual(ordered.sections.map((s) => s.thought_id), ['C', 'A', 'B']);
  });

  it('группа без позиций не пересортировывается при применении чужого порядка', () => {
    // Корни без позиций; items адресуют только вложенную группу — корни обязаны
    // остаться на месте (нетронутая группа).
    const asm = makeAssembly([
      section('A', [nested('A1'), nested('A2')]),
      section('B'),
      section('C'),
    ]);
    const ordered = applyPublicationOrder(asm, positionsFor(['e:A2', 'e:A1']))!;
    assert.deepEqual(ordered.sections.map((s) => s.thought_id), ['A', 'B', 'C']);
    assert.deepEqual(ordered.sections[0]!.children.map((c) => c.thought_id), ['A2', 'A1']);
  });

  it('позиционированные узлы не перескакивают слоты неупорядоченных соседей', () => {
    // Текущий порядок [A,C,B], у C=2, B=1, A — без позиции. Неупорядоченный A
    // держит нулевой слот; позиционированные B,C заполняют слоты 1..2 по
    // позициям (B=1,C=2) → [A,B,C]. A не вытесняется в конец.
    const asm = makeAssembly([section('A'), section('C'), section('B')]);
    const ordered = applyPublicationOrder(asm, [
      { node_key: 'e:C', position: 2 },
      { node_key: 'e:B', position: 1 },
    ])!;
    assert.deepEqual(ordered.sections.map((s) => s.thought_id), ['A', 'B', 'C']);
  });

  it('блоки документа несут node_key и группу соседей (вход drag-фасада)', () => {
    const asm = makeAssembly([{ ...section('A', [nested('B')], 'A'), texts: [text('tA')] }]);
    const blocks = documentBlocks(asm, null);
    const sectionOf = (id: string) =>
      blocks.find(
        (b): b is Extract<typeof b, { kind: 'section' }> =>
          b.kind === 'section' && b.thoughtId === id,
      );
    const a = sectionOf('A');
    assert.ok(a !== undefined);
    assert.equal(a.nodeKey, 'A');
    assert.equal(a.parentThoughtId, null);
    const b = sectionOf('B');
    assert.ok(b !== undefined);
    assert.equal(b.nodeKey, 'e:B');
    assert.equal(b.parentThoughtId, 'A');
    const textBlock = blocks.find(
      (block): block is Extract<typeof block, { kind: 'text' }> => block.kind === 'text',
    );
    assert.ok(textBlock !== undefined);
    assert.equal(textBlock.nodeKey, 'e:tA');
    assert.equal(textBlock.parentThoughtId, 'A');
  });
});

describe('модель рабочей области публикации: блоки документа и их подписи', () => {
  it('титульный блок меняет подпись при правке настроек публикации и резюме', () => {
    const asm = makeAssembly([section('A', [], 'A')], '<p>резюме</p>');
    const base = documentBlocks(asm, makePublication())[0]!;
    const renamed = documentBlocks(asm, makePublication({ title: 'Другое' }))[0]!;
    const resummed = documentBlocks(makeAssembly([section('A', [], 'A')], '<p>иное</p>'), makePublication())[0]!;
    assert.equal(base.kind, 'title');
    assert.notEqual(blockSignature(base), blockSignature(renamed));
    assert.notEqual(blockSignature(base), blockSignature(resummed));
    // Идентичная карточка — подпись стабильна (лишних пересборок нет).
    assert.equal(
      blockSignature(base),
      blockSignature(documentBlocks(asm, makePublication())[0]!),
    );
  });

  it('раздел меняет подпись при появлении предисловия', () => {
    const empty = documentBlocks(makeAssembly([section('A', [], 'A')]), null)[1]!;
    const withPreamble = documentBlocks(
      makeAssembly([{ ...section('A', [], 'A'), preamble_html: '<p>текст</p>' }]),
      null,
    )[1]!;
    assert.equal(empty.kind, 'section');
    assert.notEqual(blockSignature(empty), blockSignature(withPreamble));
  });

  it('блок «доп. материалы» меняет подпись при переименовании цели', () => {
    const withExtra = (title: string) =>
      documentBlocks(
        makeAssembly([
          {
            ...section('A', [], 'A'),
            extra: [{ property: 'p1', targets: [{ id: 't1', title }] }],
          },
        ]),
        null,
      )[2]!;
    const a = withExtra('Старое');
    const b = withExtra('Новое');
    assert.equal(a.kind, 'extra');
    assert.notEqual(blockSignature(a), blockSignature(b));
  });
});

describe('модель рабочей области публикации: повторное вхождение раздела', () => {
  /** Дерево из пробы сервера: A→D и B→D, D показан дважды (repeat_of). */
  const repeatTree = (): PublicationAssemblySection[] => [
    section('A', [section('D')]),
    section('B', [{ ...section('D'), flags: { repeat_of: 'pub-D', cycle_cut: false } }]),
  ];

  it('блоки документа несут уникальные ключи и DOM-id при повторе', () => {
    const blocks = documentBlocks(makeAssembly(repeatTree()), null);
    const keys = blocks.map((block) => block.key);
    assert.equal(new Set(keys).size, keys.length, 'ключи блоков уникальны');

    const sections = blocks.filter(
      (block): block is Extract<typeof block, { kind: 'section' }> => block.kind === 'section',
    );
    const domIds = sections.map((block) => block.domId);
    assert.equal(new Set(domIds).size, domIds.length, 'DOM-id уникальны');
    // Первое вхождение — чистый якорь (цель repeat_of), повтор — с суффиксом.
    assert.deepEqual(domIds, ['pub-A', 'pub-D', 'pub-B', 'pub-D-r1']);
    assert.equal(sections[3]!.repeat, true);
  });

  it('строки оглавления не дублируют ключи и reconcileKeyed не бросает', () => {
    const lines = tocLines(makeAssembly(repeatTree()), new Set(), (i) => `Текст ${i}`);
    const keys = lines.map((line) => line.key);
    assert.equal(new Set(keys).size, keys.length, 'ключи строк уникальны');

    const dRows = lines.filter(
      (line): line is Extract<typeof line, { kind: 'section' }> =>
        line.kind === 'section' && line.thoughtId === 'D',
    );
    assert.equal(dRows.length, 2, 'повтор даёт вторую строку');
    assert.equal(dRows[0]!.anchor, 'pub-D');
    assert.equal(dRows[0]!.repeat, false);
    assert.equal(dRows[1]!.anchor, 'pub-D-r1');
    assert.equal(dRows[1]!.repeat, true);
    // Переход по пометке повтора ведёт к первому вхождению (repeat_of).
    assert.equal(dRows[1]!.repeatOf, 'pub-D');

    // Прямая проверка: сверка списка с такими ключами не бросает duplicate key.
    const host = new ShimElement('div') as unknown as HTMLElement;
    reconcileKeyed(host, lines, {
      key: (line) => line.key,
      build: () => new ShimElement('div') as unknown as HTMLElement,
      update: () => undefined,
    });
    assert.equal(host.children.length, lines.length);
  });

  it('счётчик вхождений считается по всем ветвям — нумерация совпадает с документом (ошибка 59a17805)', () => {
    // Ветвь A свёрнута: первое вхождение D скрыто, видимым остаётся повтор под B.
    const asm = makeAssembly(repeatTree());
    const lines = tocLines(asm, new Set(['A']), (i) => `Текст ${i}`);

    const dRows = lines.filter(
      (line): line is Extract<typeof line, { kind: 'section' }> =>
        line.kind === 'section' && line.thoughtId === 'D',
    );
    assert.equal(dRows.length, 1, 'D под свёрнутой A скрыт, виден только повтор');

    // `documentBlocks` нумерует по всем вхождениям (свёрнутость на него не влияет):
    // D под A — чистый `pub-D`, повтор под B — `pub-D-r1`.
    const docD = documentBlocks(asm, null)
      .filter(
        (block): block is Extract<typeof block, { kind: 'section' }> =>
          block.kind === 'section' && block.thoughtId === 'D',
      )
      .map((block) => block.domId);
    assert.deepEqual(docD, ['pub-D', 'pub-D-r1']);

    assert.equal(dRows[0]!.anchor, docD[1], 'anchor видимого повтора совпадает с документом');
    assert.equal(dRows[0]!.anchor, 'pub-D-r1');
    assert.equal(dRows[0]!.repeat, true);
    // Пометка повтора ведёт к первому вхождению, а не на саму себя.
    assert.equal(dRows[0]!.repeatOf, 'pub-D');
    assert.notEqual(dRows[0]!.anchor, dRows[0]!.repeatOf);
  });
});

describe('модель рабочей области: сворачивание разделов (b51dbca4)', () => {
  const text = (
    id: string,
  ): PublicationAssemblySection['texts'][number] => ({
    thought_id: id,
    anchor: `pub-${id}`,
    edge_id: `e:${id}`,
    body_html: `<p>${id}</p>`,
  });

  /** A (предисловие + текст) → B (текст); C — пустой корневой раздел. */
  const withText = (
    id: string,
    children: PublicationAssemblySection[] = [],
  ): PublicationAssemblySection => ({ ...section(id, children, id), texts: [text(`t${id}`)] });
  const tree = (): PublicationAssemblySection[] => [
    {
      ...section('A', [withText('B')], 'A'),
      preamble_html: '<p>preA</p>',
      texts: [text('tA')],
    },
    section('C', [], 'C'),
  ];

  const isSection = (
    block: ReturnType<typeof documentBlocks>[number],
  ): block is Extract<ReturnType<typeof documentBlocks>[number], { kind: 'section' }> =>
    block.kind === 'section';

  it('свёрнутый раздел прячет свои тексты, предисловие и подразделы', () => {
    const asm = makeAssembly(tree());
    const full = documentBlocks(asm, null);
    const folded = documentBlocks(asm, null, new Set(['A']));
    assert.ok(full.some((b) => b.kind === 'text' && b.thoughtId === 'tA'), 'в развёрнутом тексте текст виден');
    assert.ok(!folded.some((b) => b.kind === 'text' && b.thoughtId === 'tA'), 'текст свёрнутого скрыт');
    assert.ok(!folded.some((b) => isSection(b) && b.thoughtId === 'B'), 'подраздел скрыт');
    const a = folded.find((b) => isSection(b) && b.thoughtId === 'A');
    assert.ok(a !== undefined && isSection(a));
    assert.equal(a.collapsed, true);
    assert.equal(a.collapsible, true);
    assert.ok(folded.some((b) => isSection(b) && b.thoughtId === 'C'), 'соседний корневой раздел виден');
  });

  it('нумерация якорей не сбивается при сворачивании (совпадает с полным деревом)', () => {
    const asm = makeAssembly(tree());
    const full = documentBlocks(asm, null);
    const folded = documentBlocks(asm, null, new Set(['A']));
    const domOf = (blocks: ReturnType<typeof documentBlocks>, id: string): string | undefined => {
      const found = blocks.find((b) => isSection(b) && b.thoughtId === id);
      return found !== undefined && isSection(found) ? found.domId : undefined;
    };
    assert.equal(domOf(folded, 'C'), domOf(full, 'C'));
    assert.equal(domOf(folded, 'A'), domOf(full, 'A'));
  });

  it('tocLines прячет тексты свёрнутого раздела и даёт каретку разделу с текстами', () => {
    const asm = makeAssembly(tree());
    const lines = tocLines(asm, new Set(['A']), (i) => `Текст ${i}`);
    assert.ok(!lines.some((l) => l.kind === 'text' && l.thoughtId === 'tA'), 'текст свёрнутого скрыт');
    const a = lines.find((l) => l.kind === 'section' && l.thoughtId === 'A');
    assert.ok(a !== undefined && a.kind === 'section');
    assert.equal(a.hasChildren, true, 'раздел с текстом получает каретку');
    assert.equal(a.collapsed, true);
  });

  it('оглавление содержит только разделы — строк текстов нет (ea1b5f14, п. 2)', () => {
    const asm = makeAssembly(tree());
    const lines = tocLines(asm, new Set(), (i) => `Текст ${i}`);
    assert.ok(!lines.some((line) => line.kind === 'text'), 'строк-текстов в оглавлении нет');
    assert.ok(lines.some((line) => line.kind === 'section'), 'разделы остаются');

    // Якоря разделов совпадают с документом: счётчик вхождений не смещён.
    const tocAnchors = lines
      .filter((line): line is Extract<(typeof lines)[number], { kind: 'section' }> =>
        line.kind === 'section',
      )
      .map((line) => line.anchor);
    const docAnchors = documentBlocks(asm, null)
      .filter(isSection)
      .map((block) => block.domId);
    assert.deepEqual(tocAnchors, docAnchors);
  });

  it('collapsibleSectionIds — разделы с содержимым (текст/предисловие/подраздел)', () => {
    assert.deepEqual(collapsibleSectionIds(makeAssembly(tree())).sort(), ['A', 'B']);
  });
});

// ---------------------------------------------------------------------------
// Блокеры верификации ea1b5f14: предикаты операций над блоками.
// ---------------------------------------------------------------------------

describe('модель рабочей области: операции с блоками (ea1b5f14, блокеры 1–3)', () => {
  it('subtreeIds покрывает потомков — перенос раздела в потомка отвергается (блокер 1)', () => {
    const items = [
      { id: 'A', parentId: null },
      { id: 'A1', parentId: 'A' },
      { id: 'A1a', parentId: 'A1' },
      { id: 'B', parentId: null },
      { id: 'B1', parentId: 'B' },
    ];
    const sub = subtreeIds('A', items);
    assert.deepEqual([...sub].sort(), ['A', 'A1', 'A1a'], 'сам и всё поддерево');
    assert.ok(sub.has('A1'), 'собственный потомок в запрете — диалог его не предложит');
    assert.ok(sub.has('A1a'), 'глубже одного уровня тоже');
    assert.ok(!sub.has('B1'), 'чужие ветви не задеты');
    // Диалог «Переместить в раздел…»: список = все минус поддерево.
    const offered = items.filter((item) => !subtreeIds('A', items).has(item.id)).map((i) => i.id);
    assert.deepEqual(offered, ['B', 'B1'], 'себя и потомков в дереве нет');
  });

  it('linkEntryMatchesPick находит свойство-связь вне типа (property_id пуст) — блокеры 2 и 3', () => {
    const pick = { propertyId: 'pid-1', key: 'Содержит' };
    // Сервер отдаёт внетиповое значение с пустым id, но именем стороны.
    const outsideType = { property_id: '', property_name: 'Содержит' };
    assert.equal(
      linkEntryMatchesPick(outsideType, pick),
      true,
      'совпадение по имени стороны при пустом property_id',
    );
    // Обычная привязка — по id.
    assert.equal(linkEntryMatchesPick({ property_id: 'pid-1', property_name: 'иначе' }, pick), true);
    // Чужое свойство не совпадает (иначе затронули бы чужой список).
    assert.equal(linkEntryMatchesPick({ property_id: '', property_name: 'Другое' }, pick), false);
  });

  it('аддитивное добавление к найденному внетиповому значению сохраняет прежние цели (блокер 2)', () => {
    const pick = { propertyId: 'pid-1', key: 'Содержит' };
    const entry = { property_id: '', property_name: 'Содержит', values: [{ target_id: 'text-a' }] };
    // Логика addPropertyValue: найти запись предикатом и взять её цели.
    const found = linkEntryMatchesPick(entry, pick) ? entry.values.map((v) => v.target_id) : [];
    const target = 'text-b';
    const merged = found.includes(target) ? found : [...found, target];
    assert.deepEqual(merged, ['text-a', 'text-b'], 'оба текста остаются');
  });
});
