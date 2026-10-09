/**
 * Юнит-тесты команд «Вставить ссылку на мысль» и «Вставить трансклюзию мысли»
 * (ТЗ5 «Дневник без псевдослота», 0.12.1).
 *
 * Сеть и диалог подменяются портом {@link CommentThoughtInsertPort}: проверяются
 * формы вставки, последовательность нескольких мыслей, родители новой мысли
 * (все цели-чипсы записи) и отмена диалога без изменений.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { MdEditor, MdEditorEdit, MdEditorSnapshot } from '../src/renderer/editor/md-editor.js';
import type { CommentCommandContext } from '../src/renderer/editor/comment-commands.js';
import { parentThoughtIds } from '../src/renderer/screens/chronicle/diary.js';
import type { ChronicleTarget } from '@etn/shared';
import {
  commentThoughtInsertDisabled,
  commentThoughtInsertMenuItems,
  joinThoughtRefs,
  runCommentThoughtInsert,
  setCommentThoughtInsertPort,
  thoughtLinkRef,
  thoughtTransclusionRef,
  type CommentThoughtInsertPort,
} from '../src/renderer/editor/comment-thought-insert.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface Recorded {
  changes: unknown;
  selection: unknown;
}

/** Снимок редактора с кареткой в `caret`. */
function snapshot(text: string, caret = text.length): MdEditorSnapshot {
  return { text, from: caret, to: caret };
}

/** Фейковый редактор: пишет применённую правку в `recorded`. */
function fakeEditor(text: string, recorded: Recorded[]): MdEditor {
  let doc = text;
  return {
    snapshot: () => snapshot(doc),
    applyEdit: (edit: MdEditorEdit) => {
      recorded.push({ changes: edit.changes, selection: edit.selection });
      if (typeof edit.changes === 'object' && !Array.isArray(edit.changes)) {
        const c = edit.changes as { from: number; to?: number; insert?: string };
        doc = doc.slice(0, c.from) + (c.insert ?? '') + doc.slice(c.to ?? c.from);
      }
    },
  } as unknown as MdEditor;
}

/** Контекст команды: владелец/цели и фейковый редактор. */
function ctxFor(opts: {
  ownerId?: string | null;
  parents?: readonly string[] | null;
  text?: string;
  recorded: Recorded[];
}): CommentCommandContext {
  const ownerId = opts.ownerId === undefined ? UUID_P1 : opts.ownerId;
  return {
    editor: fakeEditor(opts.text ?? '', opts.recorded),
    root: {} as HTMLElement,
    getCommentOwner: () => (ownerId === null ? null : { ownerType: 'thought', ownerId }),
    getCommentParents: () => opts.parents ?? null,
    run: () => false,
  };
}

/** Порт-заглушка: записывает создание/связи, возвращает заданный диалог. */
function stubPort(input: {
  parents?: { ids: string[]; primaryId: string; primaryTitle: string } | null;
  pick?: {
    items: Array<{ kind: 'existing'; id: string } | { kind: 'new'; title: string; synonyms: string[] }>;
    thoughtTypeId: string | null;
  } | null;
  titles?: Record<string, string>;
  created?: { id: string; title: string };
}): {
  port: CommentThoughtInsertPort;
  created: Array<{ title: string; synonyms: readonly string[]; typeId: string | null }>;
  linked: Array<{ id: string; parents: readonly string[] }>;
  resolved: number;
  picked: number;
} {
  const created: Array<{ title: string; synonyms: readonly string[]; typeId: string | null }> = [];
  const linked: Array<{ id: string; parents: readonly string[] }> = [];
  const state = { resolved: 0, picked: 0 };
  const port: CommentThoughtInsertPort = {
    async resolveParents() {
      state.resolved += 1;
      return input.parents ?? null;
    },
    async pick() {
      state.picked += 1;
      return input.pick ?? null;
    },
    async thoughtTitle(id) {
      return input.titles?.[id] ?? 'Мысль';
    },
    async create(request) {
      created.push({ title: request.title, synonyms: request.synonyms, typeId: request.typeId });
      return input.created ?? { id: UUID_A, title: request.title };
    },
    async linkParents(id, parents) {
      linked.push({ id, parents: [...parents] });
    },
  };
  return {
    port,
    created,
    linked,
    get resolved() {
      return state.resolved;
    },
    get picked() {
      return state.picked;
    },
  };
}

afterEach(() => setCommentThoughtInsertPort(null));

describe('ТЗ5: чистые преобразования вставки', () => {
  it('thoughtLinkRef: `[[#<id>|<имя>]]`, пустое имя — без алиаса', () => {
    assert.equal(thoughtLinkRef(UUID_A, 'Имя'), `[[#${UUID_A}|Имя]]`);
    assert.equal(thoughtLinkRef(UUID_A, '  '), `[[#${UUID_A}]]`);
  });

  it('thoughtTransclusionRef: `![[#<id>]]` через единый дом трансклюзий', () => {
    assert.equal(thoughtTransclusionRef(UUID_A), `![[#${UUID_A}]]`);
  });

  it('joinThoughtRefs: ссылки — через запятую, трансклюзии — с новой строки', () => {
    assert.equal(joinThoughtRefs(['a', 'b'], 'link'), 'a, b');
    assert.equal(joinThoughtRefs(['a', 'b'], 'transclusion'), 'a\nb');
  });

  it('commentThoughtInsertDisabled: без владельца и целей — недоступно', () => {
    assert.equal(
      commentThoughtInsertDisabled({ getEditor: () => null, root: {} as HTMLElement } as never),
      true,
    );
    assert.equal(
      commentThoughtInsertDisabled({
        getEditor: () => null,
        root: {} as HTMLElement,
        getCommentOwner: () => ({ ownerType: 'thought', ownerId: UUID_P1 }),
      }),
      false,
    );
    assert.equal(
      commentThoughtInsertDisabled({
        getEditor: () => null,
        root: {} as HTMLElement,
        getCommentParents: () => [UUID_P1, UUID_P2],
      }),
      false,
    );
  });
});

describe('ТЗ5: тела команд вставки', () => {
  it('ссылка: вставка `[[#<id>|<имя>]]` в позицию каретки', async () => {
    const recorded: Recorded[] = [];
    const stub = stubPort({
      parents: { ids: [UUID_P1], primaryId: UUID_P1, primaryTitle: 'Родитель' },
      pick: { items: [{ kind: 'existing', id: UUID_A }], thoughtTypeId: null },
      titles: { [UUID_A]: 'Имя мысли' },
    });
    setCommentThoughtInsertPort(stub.port);
    const ctx = ctxFor({ text: 'абв', recorded });
    await runCommentThoughtInsert(ctx, 'link');
    assert.equal(recorded.length, 1, 'одна правка');
    assert.deepEqual(recorded[0]!.changes, { from: 3, to: 3, insert: `[[#${UUID_A}|Имя мысли]]` });
    assert.deepEqual(recorded[0]!.selection, { anchor: 3 + `[[#${UUID_A}|Имя мысли]]`.length });
  });

  it('трансклюзия: `![[#<id>]]`', async () => {
    const recorded: Recorded[] = [];
    setCommentThoughtInsertPort(
      stubPort({
        parents: { ids: [UUID_P1], primaryId: UUID_P1, primaryTitle: 'Р' },
        pick: { items: [{ kind: 'existing', id: UUID_A }], thoughtTypeId: null },
      }).port,
    );
    await runCommentThoughtInsert(ctxFor({ recorded }), 'transclusion');
    assert.deepEqual(recorded[0]!.changes, { from: 0, to: 0, insert: `![[#${UUID_A}]]` });
  });

  it('несколько выбранных мыслей — вставляются последовательно', async () => {
    const recorded: Recorded[] = [];
    setCommentThoughtInsertPort(
      stubPort({
        parents: { ids: [UUID_P1], primaryId: UUID_P1, primaryTitle: 'Р' },
        pick: {
          items: [
            { kind: 'existing', id: UUID_A },
            { kind: 'existing', id: UUID_B },
          ],
          thoughtTypeId: null,
        },
        titles: { [UUID_A]: 'Первая', [UUID_B]: 'Вторая' },
      }).port,
    );
    await runCommentThoughtInsert(ctxFor({ recorded }), 'link');
    assert.deepEqual(recorded[0]!.changes, {
      from: 0,
      to: 0,
      insert: `[[#${UUID_A}|Первая]], [[#${UUID_B}|Вторая]]`,
    });
  });

  it('новая мысль: родителями становятся ВСЕ цели-чипсы записи', async () => {
    const recorded: Recorded[] = [];
    const stub = stubPort({
      parents: { ids: [UUID_P1, UUID_P2], primaryId: UUID_P1, primaryTitle: 'Первая цель' },
      pick: { items: [{ kind: 'new', title: 'Новая мысль', synonyms: ['син'] }], thoughtTypeId: 'type-1' },
      created: { id: UUID_A, title: 'Новая мысль' },
    });
    setCommentThoughtInsertPort(stub.port);
    await runCommentThoughtInsert(ctxFor({ parents: [UUID_P1, UUID_P2], recorded }), 'link');
    assert.equal(stub.created.length, 1, 'мысль создана');
    assert.equal(stub.created[0]!.typeId, 'type-1');
    assert.deepEqual(stub.created[0]!.synonyms, ['син']);
    assert.equal(stub.linked.length, 1, 'родители проставлены');
    assert.deepEqual(stub.linked[0], { id: UUID_A, parents: [UUID_P1, UUID_P2] });
    assert.deepEqual(recorded[0]!.changes, { from: 0, to: 0, insert: `[[#${UUID_A}|Новая мысль]]` });
  });

  it('отмена диалога ничего не меняет', async () => {
    const recorded: Recorded[] = [];
    const stub = stubPort({
      parents: { ids: [UUID_P1], primaryId: UUID_P1, primaryTitle: 'Р' },
      pick: null,
    });
    setCommentThoughtInsertPort(stub.port);
    await runCommentThoughtInsert(ctxFor({ recorded }), 'link');
    assert.equal(stub.picked, 1, 'диалог открывался');
    assert.equal(stub.created.length, 0, 'мысли не создавались');
    assert.equal(recorded.length, 0, 'текст не менялся');
  });

  it('без контекста комментария команда — no-op (порт не задействован)', async () => {
    const recorded: Recorded[] = [];
    const stub = stubPort({ pick: null });
    setCommentThoughtInsertPort(stub.port);
    await runCommentThoughtInsert(ctxFor({ ownerId: null, parents: null, recorded }), 'link');
    assert.equal(stub.resolved, 0, 'родители не разрешались');
    assert.equal(recorded.length, 0, 'текст не менялся');
  });
});

describe('ТЗ5: пункты контекстного меню', () => {
  it('два пункта рядом с публикационной ссылкой; без контекста — недоступны', () => {
    const without = commentThoughtInsertMenuItems({
      getEditor: () => null,
      root: {} as HTMLElement,
    } as never);
    assert.deepEqual(
      without.map((item) => item.label),
      ['Вставить ссылку на мысль…', 'Вставить трансклюзию мысли…'],
    );
    assert.deepEqual(
      without.map((item) => item.disabled),
      [true, true],
      'без владельца/целей пункты недоступны',
    );

    const withOwner = commentThoughtInsertMenuItems({
      getEditor: () => null,
      root: {} as HTMLElement,
      getCommentOwner: () => ({ ownerType: 'thought', ownerId: UUID_P1 }),
    } as never);
    assert.deepEqual(withOwner.map((item) => item.disabled), [false, false]);
    for (const item of withOwner) assert.equal(typeof item.onClick, 'function');
  });
});

describe('ТЗ5: родители новой мысли из целей записи', () => {
  const thoughtRef = (id: string): ChronicleTarget => ({
    kind: 'thought',
    thought: { id, title: `Мысль ${id}`, type_id: null, icon: null, icon_kind: 'emoji' } as never,
  });
  const linkRef = (sourceId: string): ChronicleTarget => ({
    kind: 'link',
    link: {
      id: `link-${sourceId}`,
      type_id: null,
      active: true,
      type_name_forward: null,
      type_name_reverse: null,
      source: { id: sourceId, title: 'источник', type_id: null, icon: null, icon_kind: 'emoji' },
      target: { id: 'target', title: 'цель', type_id: null, icon: null, icon_kind: 'emoji' },
    } as never,
  });

  it('parentThoughtIds: все чипсы, для связи — источник, дубли схлопнуты', () => {
    assert.deepEqual(
      parentThoughtIds([thoughtRef(UUID_A), thoughtRef(UUID_B), thoughtRef(UUID_A)]),
      [UUID_A, UUID_B],
    );
    assert.deepEqual(parentThoughtIds([linkRef(UUID_P1), thoughtRef(UUID_P2)]), [UUID_P1, UUID_P2]);
    assert.deepEqual(parentThoughtIds([]), []);
  });

  it('экран «Дневник» отдаёт в контекст все цели записи', () => {
    const src = readRenderer('screens/chronicle/chronicle.ts');
    assert.match(src, /getParentThoughtIds: \(\) => parentThoughtIds\(row\.targets\)/);
  });

  it('вкладка «Дневник» и постоянный комментарий задают цели/владельца', () => {
    assert.match(
      readRenderer('editor/chrono-tab.ts'),
      /getParentThoughtIds: \(\) =>\s*\n\s*existing\.targets/,
    );
    assert.match(
      readRenderer('editor/comments.ts'),
      /getParentThoughtIds: \(\) => \(ctx\.ownerType === 'thought' \? \[ctx\.ownerId\] : \[\]\)/,
    );
  });

  it('поле комментария вставляет пункты рядом с публикационной ссылкой', () => {
    assert.match(
      readRenderer('editor/markdown-field.ts'),
      /extras\.push\(\.\.\.commentThoughtInsertMenuItems\(commandHost\)\)/,
    );
  });
});

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');

function readRenderer(rel: string): string {
  return fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');
}
