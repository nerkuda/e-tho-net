/**
 * Юнит-тесты «замочка» чужого захвата трансклюзии в РЕЖИМЕ ПРОСМОТРА
 * (ошибка f60f99e0; элемент интерфейса 2b116d37, требование 647fa34a).
 *
 * Раньше карту чужих захватов вёл только плагин правки (`editor/transclusion.ts`,
 * CM6), поэтому в просмотре комментария блок не метился, и о захвате источника
 * узнавали лишь при попытке войти в правку. Теперь просмотр размечается той же
 * картой `lock-cache`: на внешнем и вложенном блоке появляется индикатор
 * `TRANSCLUSION_LOCK_CLASS`, при снятии захвата — исчезает.
 *
 * Headless (DOM-шим `tests/dom-shim.ts`), без сети.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import { __resetForTests, __setForTests } from '../src/renderer/lib/lock-cache.js';
import {
  decorateViewTransclusionLocks,
  TRANSCLUSION_LOCK_CLASS,
} from '../src/renderer/editor/transclusion.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ID_OUTER = '11111111-1111-4111-8111-111111111111';
const ID_NESTED = '22222222-2222-4222-8222-222222222222';

/** Минимальный шим DOM: `document.createElement` для индикатора. */
function installShim(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    querySelectorAll: () => [],
  };
}

/** Блок трансклюзии просмотра: `.md-transclusion` + id источника и глубина. */
function block(id: string, depth: number): ShimElement {
  const el = new ShimElement('div', 'md-transclusion');
  el.setAttribute('data-transclusion-source', id);
  el.setAttribute('data-transclusion-depth', String(depth));
  return el;
}

/** Строка кэша захватов (`lock-cache`) для мысли-источника. */
function lockRow(entityId: string, userName: string): any {
  return {
    id: `lock-${entityId}`,
    entity_type: 'thought',
    entity_id: entityId,
    user_id: userName,
    client_id: 'client-1',
    acquired_at_ms: 1,
  };
}

/** Внешний блок с вложенным — как разворачивает единый рендерер. */
function viewRoot(): { root: ShimElement; outer: ShimElement; nested: ShimElement } {
  const root = new ShimElement('div', 'md-field-view comment-view');
  const outer = block(ID_OUTER, 1);
  const nested = block(ID_NESTED, 2);
  outer.append(nested);
  root.append(outer);
  return { root, outer, nested };
}

/** Индикаторы-«замочки» в поддереве. */
function badges(root: ShimElement): ShimElement[] {
  return root.findAll(TRANSCLUSION_LOCK_CLASS);
}

describe('трансклюзии: «замочек» чужого захвата в просмотре (f60f99e0)', () => {
  beforeEach(() => {
    installShim();
    __resetForTests();
  });

  it('без захвата индикатора нет', () => {
    const { root } = viewRoot();
    decorateViewTransclusionLocks(root as unknown as HTMLElement);
    assert.equal(badges(root).length, 0);
  });

  it('чужой захват внешнего источника — «замочек» только на внешнем блоке', () => {
    const { root, outer, nested } = viewRoot();
    __setForTests([lockRow(ID_OUTER, 'Алиса')]);

    decorateViewTransclusionLocks(root as unknown as HTMLElement);

    const found = badges(root);
    assert.equal(found.length, 1, 'ровно один индикатор — на захваченном блоке');
    assert.equal(found[0]!.parent, outer, 'индикатор принадлежит внешнему блоку');
    assert.ok(!badges(nested).length, 'на свободном вложенном блоке индикатора нет');
    assert.match(found[0]!.title, /Алиса/, 'подсказка называет держателя захвата');
  });

  it('чужой захват внешнего и вложенного источников — индикатор на обоих', () => {
    const { root, outer, nested } = viewRoot();
    __setForTests([lockRow(ID_OUTER, 'Алиса'), lockRow(ID_NESTED, 'Боб')]);

    decorateViewTransclusionLocks(root as unknown as HTMLElement);

    const found = badges(root);
    assert.equal(found.length, 2, 'индикатор и на внешнем, и на вложенном блоке');
    assert.ok(found.some((b) => b.parent === outer), 'есть индикатор внешнего блока');
    assert.ok(found.some((b) => b.parent === nested), 'есть индикатор вложенного блока');
  });

  it('снятие захвата убирает индикатор (идемпотентная разметка)', () => {
    const { root } = viewRoot();
    __setForTests([lockRow(ID_OUTER, 'Алиса'), lockRow(ID_NESTED, 'Боб')]);
    decorateViewTransclusionLocks(root as unknown as HTMLElement);
    assert.equal(badges(root).length, 2);

    __setForTests([]);
    decorateViewTransclusionLocks(root as unknown as HTMLElement);

    assert.equal(badges(root).length, 0, 'без захвата индикаторы сняты');
  });

  it('повторная разметка при том же захвате не плодит дубли', () => {
    const { root } = viewRoot();
    __setForTests([lockRow(ID_OUTER, 'Алиса')]);
    decorateViewTransclusionLocks(root as unknown as HTMLElement);
    decorateViewTransclusionLocks(root as unknown as HTMLElement);
    assert.equal(badges(root).length, 1);
  });
});
