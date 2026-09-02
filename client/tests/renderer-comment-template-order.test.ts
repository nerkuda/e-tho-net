/**
 * Regression test for the template-comment display race (карточка ETN
 * e477173f: «Гонка показа шаблонного комментария при назначении типа с
 * comment_template_md»).
 *
 * `saveThought({ type_id })` used to run `reflectThoughtUpdate` (which bumps
 * the thought version in the store → the editor re-renders → the «Комментарий»
 * group fetches `comments.list`) and `applyCommentTemplateIfEmpty`
 * (list → create) without ordering. When the group's fetch resolved before the
 * template `comments.create`, the field rendered empty and stayed that way
 * until the card was reopened — the comment creation does not bump the thought
 * version, so the signature-guarded editor never re-rendered again.
 *
 * The fix applies the template BEFORE reflecting the update in the store.
 * These tests pin the ordering by mocking `window.etn` and journaling every
 * relevant call; the store subscription stands in for the editor re-render
 * (nothing is mounted, mirroring renderer-icon-reflect.test.ts).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Comment, Thought, ThoughtType } from '@etn/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Operation journal shared by the etn mock and the store subscription. */
const log: string[] = [];

/** Whether the mocked server already has the template permanent comment. */
let templateCreated = false;

function resetState(): void {
  log.length = 0;
  templateCreated = false;
}

const TEMPLATE = '# Шаблон комментария типа';

const permanent: Comment = {
  id: 'c1',
  owner_type: 'thought',
  owner_id: 't1',
  targets: [{ owner_type: 'thought', owner_id: 't1' }],
  kind: 'permanent',
  title: null,
  body_md: TEMPLATE,
  body_html: '<h1>Шаблон комментария типа</h1>',
  valid_from: '2026-09-02T00:00:00.000Z',
  valid_to: null,
  version: 1,
  created_at: '2026-09-02T00:00:00.000Z',
  updated_at: '2026-09-02T00:00:00.000Z',
  created_by: 'u1',
  updated_by: 'u1',
};

/** `window` shim + etn mock (the editor renders nothing here — no DOM shim). */
function shimEtn(template: string | null, existingPermanent: boolean): void {
  const win = ((globalThis as any).window ??
    ((globalThis as any).window = {})) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  templateCreated = existingPermanent;
  win.etn = {
    thoughts: {
      // `scheduleRefresh` arms a 200 ms debounce → `refreshFocus`; a rejecting
      // focus is swallowed by its own `.catch` — no focus payload needed.
      focus: async () => {
        throw new Error('not needed in this test');
      },
      update: async () => {
        log.push('thoughts.update');
        return makeThought({ type_id: 'ty1', version: 2 });
      },
    },
    comments: {
      // The server-side state the tab fetch would see at this moment.
      list: async () => {
        log.push(templateCreated ? 'comments.list(filled)' : 'comments.list(empty)');
        return templateCreated ? [permanent] : [];
      },
      create: async () => {
        log.push('comments.create');
        templateCreated = true;
        return permanent;
      },
    },
  };
}

function makeThought(overrides: Partial<Thought> = {}): Thought {
  return {
    id: 't1',
    title: 'T1',
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    is_protected: false,
    is_root: false,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    synonyms: [],
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeType(template: string | null): ThoughtType {
  return {
    id: 'ty1',
    name: 'Тип с шаблоном',
    parent_id: null,
    is_root: false,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    comment_template_md: template,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u1',
  };
}

/**
 * Prepares the store for a `saveThought` call: the editor is open on 't1'
 * (opened by a canvas click — the entity rides in the target) and the type
 * catalogue holds one type. Every store notification (i.e. every
 * `reflectThoughtUpdate` patch) is journalled as `store.reflect`.
 */
async function setup(template: string | null, existingPermanent: boolean): Promise<void> {
  resetState();
  shimEtn(template, existingPermanent);
  const { store } = await import('../src/renderer/state.js');
  store.update({
    networkId: 'n1',
    focus: null,
    editorTarget: { kind: 'thought', id: 't1', thought: makeThought() },
    structuresActiveThought: null,
    structuresActiveThoughtId: null,
    thoughtTypes: [makeType(template)],
  } as any);
  store.subscribe(() => {
    log.push('store.reflect');
  });
  // Subscriptions from the previous tests of this file fire on the setup
  // `store.update` above — drop those journal entries so the log starts clean
  // right before the `saveThought` call under test.
  log.length = 0;
}

describe('saveThought — шаблон комментария типа vs перерисовка редактора (e477173f)', () => {
  it('создаёт шаблонный комментарий ДО отражения апдейта в store', async () => {
    await setup(TEMPLATE, false);
    const { editorInternals } = await import('../src/renderer/editor/editor.js');

    const ok = await editorInternals.saveThought({ type_id: 'ty1' });

    assert.equal(ok, true, 'saveThought должен завершиться успешно');
    assert.ok(log.includes('comments.create'), 'шаблонный комментарий должен быть создан');
    // The core invariant of the fix: the template create lands strictly before
    // the first store notification — the editor re-render (and its comments
    // fetch) can therefore only ever see the created comment.
    assert.ok(
      log.indexOf('comments.create') < log.indexOf('store.reflect'),
      `порядок должен быть create → reflect, получено: ${log.join(' → ')}`,
    );
    // The post-save view of the world: any `comments.list` issued by the
    // re-rendered «Комментарий» group now resolves the template.
    const list = await (globalThis as any).window.etn.comments.list('n1', 'thought', 't1');
    assert.equal(list[0]?.body_md, TEMPLATE, 'список комментариев после сохранения содержит шаблон');
  });

  it('не создаёт шаблон, когда у типа его нет (лишних запросов нет)', async () => {
    await setup(null, false);
    const { editorInternals } = await import('../src/renderer/editor/editor.js');

    const ok = await editorInternals.saveThought({ type_id: 'ty1' });

    assert.equal(ok, true);
    assert.ok(
      !log.includes('comments.create'),
      'тип без comment_template_md не должен создавать комментарий',
    );
    assert.ok(
      !log.some((entry) => entry.startsWith('comments.list')),
      'тип без шаблона не должен даже запрашивать список комментариев',
    );
    assert.ok(log.includes('store.reflect'), 'отражение апдейта должно произойти');
  });

  it('не создаёт шаблон, когда постоянный комментарий уже есть', async () => {
    await setup(TEMPLATE, true);
    const { editorInternals } = await import('../src/renderer/editor/editor.js');

    const ok = await editorInternals.saveThought({ type_id: 'ty1' });

    assert.equal(ok, true);
    assert.ok(
      !log.includes('comments.create'),
      'существующий permanent-комментарий должен предотвращать создание шаблона',
    );
    assert.ok(
      log.some((entry) => entry.startsWith('comments.list')),
      'проверка наличия комментария выполняется',
    );
  });
});
