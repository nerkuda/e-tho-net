/**
 * Задача d23279f6 (замечание верификатора): restore связи из панели
 * использования/корзины обязан обновлять открытый редактор связи и структуры
 * сразу из ответа PATCH, не дожидаясь собственного realtime-эха (04-realtime
 * §5). Общий путь — `reflectLinkUpdate` (зеркало `reflectThoughtUpdate`),
 * его и проверяем без DOM: `store.update` здесь без подписчиков.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Link } from '@etn/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** `window` shim: `scheduleRefresh`/`scheduleStructuresRefresh` трогают таймеры. */
function shimDom(): void {
  const win = ((globalThis as any).window ??
    ((globalThis as any).window = {})) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.etn = { thoughts: { focus: async () => null } };
}

function makeLink(id: string, overrides: Partial<Link> = {}): Link {
  return {
    id,
    source_id: 's',
    target_id: 't',
    type_id: null,
    color: null,
    style: null,
    width: null,
    active: true,
    marked_for_deletion: true,
    marked_for_deletion_at: '2026-10-19T00:00:00.000Z',
    marked_for_deletion_by: 'u1',
    version: 2,
    created_at: '2026-10-19T00:00:00.000Z',
    updated_at: '2026-10-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('reflectLinkUpdate — restore связи обновляет открытый редактор', () => {
  it('подменяет снимок editorTarget.link на восстановленную связь', async () => {
    shimDom();
    const { reflectLinkUpdate } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');

    const marked = makeLink('l1');
    store.update({
      editorTarget: { kind: 'link', id: 'l1', link: marked },
      selectedLinkId: 'l1',
    });
    const restored = makeLink('l1', {
      marked_for_deletion: false,
      marked_for_deletion_at: null,
      marked_for_deletion_by: null,
      version: 3,
    });

    reflectLinkUpdate(restored);

    const target = store.state.editorTarget;
    assert.equal(target?.kind, 'link');
    assert.equal(target?.link, restored, 'редактор должен получить свежий объект связи');
    assert.equal(target?.link?.marked_for_deletion, false);
  });

  it('не подменяет редактор другой сущности', async () => {
    shimDom();
    const { reflectLinkUpdate } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');

    const other = makeLink('other');
    store.update({ editorTarget: { kind: 'link', id: 'other', link: other } });

    reflectLinkUpdate(makeLink('l1', { marked_for_deletion: false, version: 3 }));

    const target = store.state.editorTarget;
    assert.equal(target?.kind, 'link');
    assert.equal(
      target?.kind === 'link' ? target.link : undefined,
      other,
      'чужой editorTarget не должен перезаписываться',
    );
  });
});
