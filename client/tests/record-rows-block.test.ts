/**
 * Подблок строк-записей вкладки «Упоминания» (0.15.4, тех.проект 43329662,
 * задача ae72e47e, требование 012b2dc6).
 *
 * Здесь живёт правило, которого до задачи не было: строка-запись в группе
 * вкладки видна по `active` её ПЕРВИЧНОЙ привязки (своего `active` у `RecordHit`
 * нет), а неразрешённая привязка НЕ скрывает строку (fallback: цель физически
 * удалена / её нет в `thoughts_v`·`links_v` / веерный резолв чужой сети).
 * Дополнительно фиксируются потолок рендера с подписью «Показано N из M» только
 * при M > N и время жизни обвязки строк (наблюдатели полос не текут).
 *
 * Разметка самой строки проверяется тестами `record-row.test.ts` и GUI-стендом;
 * здесь — сборка ПОДБЛОКА (видимость, вид строки списка, срез, подпись).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChronicleTarget, RecordHit, ThoughtRef } from '@etn/shared';

import { RECORD_ROWS_LIMIT } from '../src/renderer/lib/chip-overflow.js';
import {
  mountRecordRowsBlock,
  recordRowActive,
  visibleRecordRows,
} from '../src/renderer/lib/record-rows-block.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const OWNER = '55555555-5555-4555-8555-555555555555';
const OTHER = '77777777-7777-4777-8777-777777777777';
const LINK = '88888888-8888-4888-8888-888888888888';
const NETWORK = '00000000-0000-4000-8000-00000000000a';
const FROM = '2026-11-10T09:15:00.000Z';

/** Минимальное облачко-мысль для привязки. */
function thought(
  id: string,
  overrides: Partial<ThoughtRef> & Pick<ThoughtRef, 'active'>,
): ThoughtRef {
  return {
    id,
    title: `Мысль ${id.slice(0, 4)}`,
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
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
function thoughtTarget(id: string, active: boolean): ChronicleTarget {
  return { kind: 'thought', thought: thought(id, { active }) };
}

/** Привязка-связь. */
function linkTarget(id: string, active: boolean): ChronicleTarget {
  return {
    kind: 'link',
    link: {
      id,
      type_id: null,
      active,
      type_name_forward: 'включает',
      type_name_reverse: 'входит в',
      source: thought(OTHER, { active: true }),
      target: thought(OWNER, { active: true }),
    },
  };
}

/** Строка-запись ответа backlinks/mentions. */
function recordHit(overrides: Partial<RecordHit> = {}): RecordHit {
  return {
    kind: 'record',
    comment_id: `comment-${Math.random().toString(36).slice(2)}`,
    valid_from: FROM,
    valid_to: null,
    use_time: true,
    snippet: 'Запись дня без автоссылок.',
    targets: [],
    owner_type: 'thought',
    owner_id: OWNER,
    ...overrides,
  };
}

/** Минимальный DOM-шим: сборка строк не требует раскладки и меню. */
function installMinimalDom(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  (globalThis as any).window = (globalThis as any).window ?? {};
}

/** Абзац-подпись среза среди прямых детей подблока (`.muted` без своего класса). */
function captionOf(block: { el: HTMLElement }): ShimElement | null {
  const children = (block.el as unknown as ShimElement).children;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index] as ShimElement | undefined;
    if (child !== undefined && child.tagName.toLowerCase() === 'p') return child;
  }
  return null;
}

/** Наблюдатель-счётчик: сколько полос осталось под наблюдением. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnects = 0;
  constructor(_callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(): void {
    // Раскладка в тестах не выполняется — наблюдение только учитывается.
  }
  disconnect(): void {
    this.disconnects += 1;
  }
}

describe('видимость строки-записи — по active первичной привязки (012b2dc6)', () => {
  it('привязка-мысль найдена: видимость строки — её `active`', () => {
    assert.equal(recordRowActive(recordHit({ targets: [thoughtTarget(OWNER, true)] })), true);
    assert.equal(recordRowActive(recordHit({ targets: [thoughtTarget(OWNER, false)] })), false);
  });

  it('привязка-связь найдена: видимость строки — `link.active`', () => {
    const active = recordHit({
      owner_type: 'link',
      owner_id: LINK,
      targets: [linkTarget(LINK, true)],
    });
    const inactive = recordHit({
      owner_type: 'link',
      owner_id: LINK,
      targets: [linkTarget(LINK, false)],
    });

    assert.equal(recordRowActive(active), true);
    assert.equal(recordRowActive(inactive), false);
  });

  it('привязки НЕТ в targets — строка видна (fallback «цель не разрешилась»)', () => {
    assert.equal(
      recordRowActive(recordHit({ targets: [] })),
      true,
      'записей без владельца не бывает: скрытие по неразрешённой привязке теряло бы запись',
    );
    assert.equal(
      recordRowActive(recordHit({ targets: [thoughtTarget(OTHER, false)] })),
      true,
      'чужая привязка не делает строку неактивной',
    );
  });

  it('show_inactive скрывает неактивные строки и возвращает их обратно', () => {
    const hits = [
      recordHit({ targets: [thoughtTarget(OWNER, true)] }),
      recordHit({ owner_id: OTHER, targets: [thoughtTarget(OTHER, false)] }),
    ];

    assert.deepEqual(visibleRecordRows(hits, false), [hits[0]], 'неактивная скрыта');
    assert.deepEqual(visibleRecordRows(hits, true), hits, 'настройка возвращает её в список');
  });

  it('K4: помеченная корзиной привязка (active=true) НЕ прячет строку — это не fallback', () => {
    // Маркировка удаления обратима и не убирает привязку из `targets`
    // (миграция 024): у строки-записи она не отнимает видимость — прятать
    // помеченное вправе только чипы-мысли (`show_trash`, lib/record-targets.ts).
    const marked = recordHit({
      targets: [
        { kind: 'thought', thought: thought(OWNER, { active: true, marked_for_deletion: true }) },
      ],
    });

    assert.equal(recordRowActive(marked), true, 'корзина не делает привязку неактуальной');
    assert.deepEqual(
      visibleRecordRows([marked], false),
      [marked],
      'строка видна при show_inactive=false (не путать с fallback «привязка не найдена»)',
    );

    installMinimalDom();
    const block = mountRecordRowsBlock({
      networkId: NETWORK,
      hits: [marked],
      homeId: null,
      showInactive: true,
      showTrash: false,
      onOpen: () => undefined,
    });
    const rows = block.el.querySelectorAll('.record-row');
    assert.equal(rows.length, 1, 'строка в подблоке');
    assert.equal(rows[0]?.classList.contains('dim'), false, 'приглушения нет: привязка активна');
    block.destroy();
  });

  it('порядок сервера (`valid_from` по убыванию) сохраняется', () => {
    const hits = [
      recordHit({ valid_from: '2026-11-10T12:00:00.000Z' }),
      recordHit({ valid_from: '2026-11-09T12:00:00.000Z' }),
      recordHit({ valid_from: '2026-11-08T12:00:00.000Z' }),
    ];

    assert.deepEqual(
      visibleRecordRows(hits, false).map((hit) => hit.valid_from),
      hits.map((hit) => hit.valid_from),
      'пересортировки нет — порядок ответа как есть',
    );
  });
});

describe('подблок: вид строки, потолок и подпись (DoD б задачи ae72e47e)', () => {
  it('M > N: показаны N строк и подпись «Показано N из M»', () => {
    installMinimalDom();
    const hits = Array.from({ length: RECORD_ROWS_LIMIT + 3 }, () => recordHit());

    const block = mountRecordRowsBlock({
      networkId: NETWORK,
      hits,
      homeId: null,
      showInactive: false,
      showTrash: false,
      onOpen: () => undefined,
    });

    const rows = block.el.querySelectorAll('.record-row');
    assert.equal(rows.length, RECORD_ROWS_LIMIT, 'строк не больше клиентского потолка N');
    assert.equal(block.total, hits.length, 'M — число строк-записей в ответе');
    assert.equal(
      block.visibleCount,
      hits.length,
      'счётчик группы считает ВСЕ найденные строки, а не только показанные',
    );
    const caption = captionOf(block);
    assert.ok(caption !== null, 'подпись среза — отдельный абзац');
    assert.equal(
      (caption.textContent ?? '').trim(),
      `Показано ${RECORD_ROWS_LIMIT} из ${hits.length}`,
      'подпись называет и N, и M',
    );
    block.destroy();
  });

  it('M ≤ N: все строки и НЕТ подписи', () => {
    installMinimalDom();
    const hits = [recordHit(), recordHit()];

    const block = mountRecordRowsBlock({
      networkId: NETWORK,
      hits,
      homeId: null,
      showInactive: false,
      showTrash: false,
      onOpen: () => undefined,
    });

    assert.equal(block.el.querySelectorAll('.record-row').length, hits.length);
    assert.equal(captionOf(block), null, 'скрывать нечего — подписи нет');
    block.destroy();
  });

  it('строка подблока — вид строки списка вкладки (`.mention-item`), неактивная приглушена', () => {
    installMinimalDom();
    const active = recordHit({ targets: [thoughtTarget(OWNER, true)] });
    const inactive = recordHit({ owner_id: OTHER, targets: [thoughtTarget(OTHER, false)] });

    const block = mountRecordRowsBlock({
      networkId: NETWORK,
      hits: [active, inactive],
      homeId: null,
      showInactive: true,
      showTrash: false,
      onOpen: () => undefined,
    });

    const rows = block.el.querySelectorAll('.record-row');
    assert.equal(rows.length, 2, 'show_inactive вернул неактивную строку в список');
    assert.equal(rows[0]?.classList.contains('mention-item'), true, 'вид строки вкладки');
    assert.equal(rows[0]?.classList.contains('dim'), false, 'актуальная строка не приглушена');
    assert.equal(rows[1]?.classList.contains('dim'), true, 'неактивная — приглушена (.dim)');
    block.destroy();
  });

  it('потолок считает только ВИДИМЫЕ строки (скрытые не занимают место в срезе)', () => {
    installMinimalDom();
    const hidden = Array.from({ length: RECORD_ROWS_LIMIT + 1 }, () =>
      recordHit({ owner_id: OTHER, targets: [thoughtTarget(OTHER, false)] }),
    );
    const visible = [recordHit({ targets: [thoughtTarget(OWNER, true)] })];

    const block = mountRecordRowsBlock({
      networkId: NETWORK,
      hits: [...hidden, ...visible],
      homeId: null,
      showInactive: false,
      showTrash: false,
      onOpen: () => undefined,
    });

    assert.equal(block.visibleCount, 1, 'счётчик группы — только видимые строки');
    assert.equal(block.total, 1, 'M подписи — видимые строки, а не весь ответ');
    assert.equal(captionOf(block), null, 'подписи нет: видимая одна');
    block.destroy();
  });

  it('destroy снимает обвязку ВСЕХ строк (наблюдатели не остаются)', () => {
    installMinimalDom();
    const observers = FakeResizeObserver.instances;
    (globalThis as any).ResizeObserver = FakeResizeObserver;
    try {
      const before = observers.length;
      const hits = Array.from({ length: 3 }, () =>
        recordHit({ targets: [thoughtTarget(OWNER, true)] }),
      );

      const block = mountRecordRowsBlock({
        networkId: NETWORK,
        hits,
        homeId: null,
        showInactive: false,
        showTrash: false,
        onOpen: () => undefined,
      });

      const mounted = observers.slice(before);
      assert.equal(mounted.length, hits.length, 'у каждой строки своя полоса чипов');
      block.destroy();
      assert.deepEqual(
        mounted.map((observer) => observer.disconnects),
        hits.map(() => 1),
        'destroy подблока снимает наблюдатели всех строк',
      );
      assert.equal(block.el.children.length, 0, 'подблок очищен');
    } finally {
      delete (globalThis as any).ResizeObserver;
    }
  });
});
