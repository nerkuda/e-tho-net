/**
 * Видимые привязки дневниковой записи — общий предикат `lib/record-targets.ts`
 * (0.15.4, тех.проект 43329662, задача 33ed043c, элемент 554e3129).
 *
 * Контракт:
 *  - HOME сети записи — служебная привязка, не показывается никогда (требование
 *    c81964c7); пока HOME не разрешён (`homeId: null`), скрывать нечего;
 *  - настройка «показывать неактуальные» действует на привязки ОБОИХ видов
 *    (мысль и связь);
 *  - СУЖЕНИЕ K4 (решение пользователя 2026-11-10): «показывать помеченные на
 *    удаление» действует ТОЛЬКО на чипы-МЫСЛИ; чип-связь фильтруется только по
 *    актуальности — пометки удаления у связи в контракте нет и не появляется;
 *  - порядок модели сохраняется (первичная привязка остаётся первой).
 *
 * Предикат чистый (без DOM и сети) — проверяется поведенчески; единственность
 * реализации и K4-сужение в исходниках стерегут `guard-record-targets`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChronicleTarget, ChronicleTargetLink, ThoughtRef } from '@etn/shared';

import { recordTargetRef, visibleRecordTargets } from '../src/renderer/lib/record-targets.js';

const HOME = '11111111-1111-4111-8111-111111111111';
const THOUGHT_A = '22222222-2222-4222-8222-222222222222';
const THOUGHT_B = '33333333-3333-4333-8333-333333333333';
const LINK_1 = '44444444-4444-4444-8444-444444444444';

/** Минимальная мысль-привязка: поля `ThoughtRef` с осмысленными значениями. */
function thought(id: string, overrides: Partial<ThoughtRef> = {}): ThoughtRef {
  return {
    id,
    title: `Мысль ${id}`,
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

/** Привязка-мысль. */
function thoughtTarget(id: string, overrides: Partial<ThoughtRef> = {}): ChronicleTarget {
  return { kind: 'thought', thought: thought(id, overrides) };
}

/** Привязка-связь «источник — тип — цель». */
function linkTarget(overrides: Partial<ChronicleTargetLink> = {}): ChronicleTarget {
  return {
    kind: 'link',
    link: {
      id: LINK_1,
      type_id: null,
      active: true,
      type_name_forward: 'связана с',
      type_name_reverse: 'связана с',
      source: thought(THOUGHT_A),
      target: thought(THOUGHT_B),
      ...overrides,
    },
  };
}

/** Id привязок — для читаемых сравнений без пересказа формы DTO. */
function ids(targets: readonly ChronicleTarget[]): string[] {
  return targets.map((target) => (target.kind === 'thought' ? target.thought.id : target.link.id));
}

describe('видимые привязки записи: общий предикат (задача 33ed043c)', () => {
  it('HOME скрыт, порядок остальных привязок сохранён', () => {
    const targets = [thoughtTarget(THOUGHT_A), thoughtTarget(HOME), thoughtTarget(THOUGHT_B)];

    const visible = visibleRecordTargets(targets, {
      homeId: HOME,
      showInactive: false,
      showTrash: false,
    });

    assert.deepEqual(ids(visible), [THOUGHT_A, THOUGHT_B], 'HOME не пользовательская привязка');
  });

  it('HOME ещё не разрешён (`homeId: null`) — скрывать нечего', () => {
    const targets = [thoughtTarget(THOUGHT_A), thoughtTarget(THOUGHT_B)];

    const visible = visibleRecordTargets(targets, {
      homeId: null,
      showInactive: false,
      showTrash: false,
    });

    assert.deepEqual(ids(visible), [THOUGHT_A, THOUGHT_B], 'без HOME в модели фильтр не сужает');
  });

  it('неактуальная мысль скрыта, пока настройка не разрешает показ', () => {
    const targets = [thoughtTarget(THOUGHT_A, { active: false }), thoughtTarget(THOUGHT_B)];

    const hidden = visibleRecordTargets(targets, {
      homeId: HOME,
      showInactive: false,
      showTrash: false,
    });
    const shown = visibleRecordTargets(targets, {
      homeId: HOME,
      showInactive: true,
      showTrash: false,
    });

    assert.deepEqual(ids(hidden), [THOUGHT_B], 'неактуальная привязка скрыта');
    assert.deepEqual(ids(shown), [THOUGHT_A, THOUGHT_B], 'настройка возвращает неактуальную');
  });

  it('K4: помеченная на удаление МЫСЛЬ скрыта, пока настройка не разрешает показ', () => {
    const targets = [
      thoughtTarget(THOUGHT_A, { marked_for_deletion: true }),
      thoughtTarget(THOUGHT_B),
    ];

    const hidden = visibleRecordTargets(targets, {
      homeId: HOME,
      showInactive: false,
      showTrash: false,
    });
    const shown = visibleRecordTargets(targets, {
      homeId: HOME,
      showInactive: false,
      showTrash: true,
    });

    assert.deepEqual(ids(hidden), [THOUGHT_B], 'корзина мысли учитывается настройкой');
    assert.deepEqual(ids(shown), [THOUGHT_A, THOUGHT_B], 'настройка возвращает помеченную мысль');
  });

  it('K4: чип-СВЯЗЬ не скрывается настройкой корзины', () => {
    const targets = [linkTarget(), thoughtTarget(THOUGHT_A, { marked_for_deletion: true })];

    const visible = visibleRecordTargets(targets, {
      homeId: HOME,
      showInactive: false,
      showTrash: false,
    });

    assert.deepEqual(
      ids(visible),
      [LINK_1],
      'show_trash касается только мыслей: у связи пометки удаления нет (K4)',
    );
  });

  it('неактуальная связь скрыта, пока настройка не разрешает показ', () => {
    const targets = [linkTarget({ active: false }), thoughtTarget(THOUGHT_B)];

    const hidden = visibleRecordTargets(targets, {
      homeId: HOME,
      showInactive: false,
      showTrash: false,
    });
    const shown = visibleRecordTargets(targets, {
      homeId: HOME,
      showInactive: true,
      showTrash: false,
    });

    assert.deepEqual(ids(hidden), [THOUGHT_B], 'неактуальная связь скрыта');
    assert.deepEqual(ids(shown), [LINK_1, THOUGHT_B], 'настройка возвращает неактуальную связь');
  });

  it('привязка → цель навигации: мысль и связь различаются видом', () => {
    assert.deepEqual(recordTargetRef(thoughtTarget(THOUGHT_A)), {
      kind: 'thought',
      id: THOUGHT_A,
    });
    assert.deepEqual(recordTargetRef(linkTarget()), { kind: 'link', id: LINK_1 });
  });
});
