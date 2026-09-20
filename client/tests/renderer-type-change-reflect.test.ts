/**
 * Regression test for ETN error 786bcd69 «Смена типа мысли не обновляет
 * облачка и набор свойств» — вторая половина: смена типа обязана сразу
 * отразиться там, где мысль видна (фокус-облачко, облачко зоны), а realtime
 * `thought.updated` для чужой смены типа обязан нести `type_id` и
 * применяться к кэшу клиента.
 *
 * Половина редактора (перечитывание набора свойств вкладки «Свойства»)
 * проверяется в `renderer-type-change-panes.test.ts` — там нужен смонтированный
 * редактор.
 *
 * Диагноз (см. хронологию ошибки в ETN): сервер событие публикует —
 * `PATCH /thoughts/{id}` с `type_id` эмитит `thought.updated`
 * `{ id, changes, version }`, и `changes` несёт новый `type_id`; визуал
 * облачка клиент резолвит по каталогу типов из store, поэтому событию
 * достаточно `type_id`. Актор эха не получает (04-realtime.md §5) и
 * отражает ответ PATCH локально (`saveThought` → `reflectThoughtUpdate`).
 * Эти контракты и закрепляются здесь.
 *
 * Runs under Node with a minimal `window` shim — no DOM needed: nothing is
 * mounted, so `store.update` only fans out to module listeners.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FocusResponse, Thought, ThoughtRef, ThoughtType } from '@etn/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** `window` shim: `scheduleRefresh` arms `window.setTimeout`, `saveThought`
 *  reads `window.etn`. */
function shimDom(updated: Thought): void {
  const win = ((globalThis as any).window ??
    ((globalThis as any).window = {})) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.etn = {
    thoughts: {
      update: async () => updated,
      // `scheduleRefresh`'s debounced focus refetch must not crash.
      focus: async () => {
        throw new Error('focus refetch is not part of this test');
      },
    },
  };
}

function makeThought(id: string, overrides: Partial<Thought> = {}): Thought {
  return {
    id,
    title: id,
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

function makeRef(id: string, overrides: Partial<ThoughtRef> = {}): ThoughtRef {
  return {
    id,
    title: id,
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    marked_for_deletion: false,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    ...overrides,
  };
}

/** Type A is dark-on-light with «🅰», type B is light-on-black with «🅱» —
 *  the two cases must not be confusable in the assertions below. */
function makeType(id: string, visual: Partial<ThoughtType> = {}): ThoughtType {
  return {
    id,
    name: id,
    parent_id: null,
    is_root: false,
    comment_template_md: null,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u1',
    ...visual,
  };
}

const ROOT_TYPE = makeType('root', { is_root: true });
const TYPE_A = makeType('ta', { icon: '🅰', fg_color: '#111111', bg_color: '#eeeeee' });
const TYPE_B = makeType('tb', { icon: '🅱', fg_color: '#222222', bg_color: '#000000' });

function makeFocus(focused: Thought, children: string[] = []): FocusResponse {
  return {
    focused,
    parents: [],
    siblings: [],
    children: children.map((id) => ({
      id,
      title: id,
      type_id: null,
      icon: null,
      active: true,
      link_id: `link-${id}`,
      link_type_id: null,
      link_active: true,
      has_incoming: false,
      has_outgoing: true,
      manual_position: null,
    })),
    edges: [],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

describe('смена типа мысли — отражение в облачках и карточках (786bcd69)', () => {
  it('фокус-облачко перекрашивается оформлением нового типа и холст перерисовывается', async () => {
    const updated = makeThought('t1', { type_id: 'tb', version: 2 });
    shimDom(updated);
    const { editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    const { resolveCloudStyle, resolveThoughtIcon } = await import('../src/renderer/lib/thought-cloud.js');
    const { canvasInternals } = await import('../src/renderer/canvas/canvas.js');

    store.update({
      networkId: 'n1',
      thoughtTypes: [ROOT_TYPE, TYPE_A, TYPE_B],
      focus: makeFocus(makeThought('t1', { type_id: 'ta' })),
      editorTarget: null,
    } as any);

    const before = canvasInternals.canvasRenderKey();
    // Precondition: the cloud currently resolves type A's оформление.
    assert.equal(resolveCloudStyle(store.state.focus!.focused).bg, '#eeeeee');

    const ok = await editorInternals.saveThought({ type_id: 'tb' });
    assert.equal(ok, true, 'сохранение типа должно пройти успешно');

    const focused = store.state.focus!.focused;
    assert.equal(focused.type_id, 'tb', 'фокус обязан нести новый тип');
    const style = resolveCloudStyle(focused);
    assert.equal(style.bg, '#000000', 'фон облачка — из нового типа');
    assert.equal(style.fg, '#222222', 'цвет текста облачка — из нового типа');
    assert.equal(resolveThoughtIcon(focused).icon, '🅱', 'значок облачка — из нового типа');
    assert.notEqual(
      canvasInternals.canvasRenderKey(),
      before,
      'ключ отрисовки холста обязан измениться — иначе облачко останется старым',
    );
  });

  it('облачко соседа фокуса теряет устаревший кэш, чтобы перерезолвиться с новым типом', async () => {
    const updated = makeThought('t1', { type_id: 'tb', version: 2 });
    shimDom(updated);
    const { editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    const { canvasInternals } = await import('../src/renderer/canvas/canvas.js');

    // The editor is open on a zone cloud ('t1' is a child of the focus 'f').
    store.update({
      networkId: 'n1',
      thoughtTypes: [ROOT_TYPE, TYPE_A, TYPE_B],
      focus: makeFocus(makeThought('f'), ['t1']),
      editorTarget: { kind: 'thought', id: 't1', thought: makeThought('t1', { type_id: 'ta' }) },
    } as any);
    canvasInternals.refCache.set('t1', makeRef('t1', { type_id: 'ta' }));

    const ok = await editorInternals.saveThought({ type_id: 'tb' });
    assert.equal(ok, true);

    assert.equal(
      canvasInternals.refCache.has('t1'),
      false,
      'устаревший ref облачка обязан быть сброшен до отложенного обновления фокуса',
    );
  });

  it('realtime `thought.updated` со сменой типа применяется к кэшу клиента', async () => {
    const { RealtimeState, applyRealtimeEvent } = await import('../src/main/realtime/applier.js');

    const state = new RealtimeState();
    state.setThought(makeThought('t1', { type_id: 'ta' }));
    const result = applyRealtimeEvent(
      state,
      {
        getClientId: () => 'me',
        getCurrentUserId: () => 'u1',
        removeFromFocusHistoryEverywhere: () => undefined,
        getCurrentFocusId: () => null,
      },
      {
        type: 'thought.updated',
        seq: 7,
        ts: '2026-09-20T18:00:00.000Z',
        actor: { user_id: 'u2', client_id: 'other' },
        network_id: 'n1',
        audience: 'network',
        layer_id: 'base',
        data: { id: 't1', changes: { type_id: 'tb' }, version: 2 },
      } as any,
    );

    assert.equal(result.applied, true, 'чужое событие смены типа обязано примениться');
    assert.equal(
      state.getThought('t1')?.type_id,
      'tb',
      'событие несёт type_id, и кэш клиента получает новый тип',
    );
  });
});
