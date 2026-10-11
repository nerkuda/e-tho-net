/**
 * Развилка клика по легаси-ссылке `[[Имя]]` (0.12.2, задача 8e4e3dc5) —
 * чистые решатели и сбой источника кандидатов. Поведение согласовано
 * пользователем 2026-10-11 (карточка задачи, «Предполёт и итоговый DoD»):
 *
 *   1. ровно одна актуальная мысль по ТОЧНОМУ совпадению названия ИЛИ синонима
 *      и цель не захвачена — конвертация + открытие;
 *   2. несколько точных — поповер (≤10 + пометка обрезки);
 *   3. ни одной — создание;
 *   4. отказ — без изменений (решается развилкой на стороне вызова);
 *   плюс: захваченная единственная цель — открыть без конвертации;
 *   неактуальные исключаются из резолва; имя трактуется буквально
 *   (partial/`*`-синонимы — не совпадение).
 *
 * Чистая часть — без DOM; `resolveLegacyWikiCandidates` — с подменой
 * `window.etn` (живой прокси `lib/etn.ts`, как в `add-dialog.test.ts`).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { DuplicateHit } from '../src/main/ipc/contract.js';
import {
  decideLegacyFork,
  exactLegacyCandidates,
  legacyCandidateWindow,
  legacyNameKey,
  LEGACY_CANDIDATE_LIMIT,
  resolveLegacyWikiCandidates,
} from '../src/renderer/editor/wiki-link-resolver.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

let seq = 0;

/** Минимальный кандидат нужной формы (остальные поля цели не читаются). */
function hit(partial: Partial<DuplicateHit> & { title: string }): DuplicateHit {
  seq += 1;
  return {
    id: partial.id ?? `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    title: partial.title,
    synonyms: partial.synonyms ?? [],
    matched_on: partial.matched_on ?? 'title',
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    parent_title: partial.parent_title ?? null,
  };
}

describe('legacyNameKey: нормализация имени', () => {
  it('NFC + trim + lowercase, как серверный find_duplicates', () => {
    assert.equal(legacyNameKey('  Проба  '), 'проба');
    assert.equal(legacyNameKey('Ёлка'), 'ёлка');
  });
});

describe('exactLegacyCandidates: точное совпадение по названию ИЛИ синониму', () => {
  it('совпадение по названию — кандидат', () => {
    const hits = [hit({ title: 'Иванов' }), hit({ title: 'Петров' })];
    assert.deepEqual(
      exactLegacyCandidates(hits, 'Иванов').map((h) => h.title),
      ['Иванов'],
    );
  });

  it('совпадение по синониму — кандидат (буквально)', () => {
    const hits = [hit({ title: 'Пётр', synonyms: ['Петя', 'Petr'] })];
    assert.equal(exactLegacyCandidates(hits, 'Петя').length, 1);
  });

  it('partial-совпадение не берётся (имя буквально)', () => {
    const hits = [hit({ title: 'Ивановский', matched_on: 'partial' })];
    assert.deepEqual(exactLegacyCandidates(hits, 'Иванов'), []);
  });

  it('`*`-синоним, не равный имени буквально, не берётся', () => {
    // Синоним «Игорян*» матчит ввод «Игорянский» у find_duplicates — но имя
    // трактуется буквально, поэтому это НЕ точное совпадение.
    const hits = [hit({ title: 'Игорь', synonyms: ['Игорян*'], matched_on: 'synonym' })];
    assert.deepEqual(exactLegacyCandidates(hits, 'Игорянский'), []);
  });

  it('совпадения не зависят от регистра и пробелов', () => {
    const hits = [hit({ title: '  ПРОБА ' })];
    assert.equal(exactLegacyCandidates(hits, 'проба').length, 1);
  });

  it('пустое имя — пустой список', () => {
    assert.deepEqual(exactLegacyCandidates([hit({ title: 'x' })], '   '), []);
  });
});

describe('decideLegacyFork: ветки развилки', () => {
  it('нет кандидатов → создать (ветка 3)', () => {
    assert.equal(decideLegacyFork(0, false), 'create');
  });

  it('один свободный кандидат → конвертация и открытие (ветка 1)', () => {
    assert.equal(decideLegacyFork(1, false), 'convert-open');
  });

  it('один ЗАХВАЧЕННЫЙ кандидат → открыть без конвертации', () => {
    assert.equal(decideLegacyFork(1, true), 'open-only');
  });

  it('несколько кандидатов → поповер (ветка 2)', () => {
    assert.equal(decideLegacyFork(2, false), 'popover');
    assert.equal(decideLegacyFork(50, false), 'popover');
  });
});

describe('legacyCandidateWindow: лимит выдачи ≤10 + пометка', () => {
  it('≤10 — все, без пометки', () => {
    const items = Array.from({ length: LEGACY_CANDIDATE_LIMIT }, (_, i) => i);
    const { shown, truncated } = legacyCandidateWindow(items);
    assert.equal(shown.length, LEGACY_CANDIDATE_LIMIT);
    assert.equal(truncated, false);
  });

  it('>10 — первые 10 + пометка', () => {
    const items = Array.from({ length: 13 }, (_, i) => i);
    const { shown, truncated } = legacyCandidateWindow(items);
    assert.equal(shown.length, LEGACY_CANDIDATE_LIMIT);
    assert.deepEqual(shown, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(truncated, true);
  });
});

describe('resolveLegacyWikiCandidates: источник кандидатов (window.etn)', () => {
  const originalWindow = (globalThis as any).window;

  afterEach(() => {
    (globalThis as any).window = originalWindow;
  });

  /** Заглушка IPC: findDuplicates + resolve с картой актуальности. */
  function stubEtn(dupHits: DuplicateHit[], activeById: Record<string, boolean>): void {
    (globalThis as any).window = {
      etn: {
        thoughts: {
          findDuplicates: async (_networkId: string, _title: string) => dupHits,
          resolve: async (_networkId: string, ids: string[]) =>
            ids.map((id) => ({ id, active: activeById[id] !== false })),
        },
      },
    };
  }

  it('оставляет только точные совпадения (partial отсеивается)', async () => {
    stubEtn(
      [hit({ id: 'a0000000-0000-4000-8000-000000000001', title: 'Проба' }),
       hit({ id: 'b0000000-0000-4000-8000-000000000002', title: 'Пробный', matched_on: 'partial' })],
      {},
    );
    const out = await resolveLegacyWikiCandidates('net', 'Проба');
    assert.deepEqual(out.map((h) => h.title), ['Проба']);
  });

  it('неактуальные кандидаты исключаются из резолва', async () => {
    stubEtn(
      [hit({ id: 'a0000000-0000-4000-8000-000000000001', title: 'Проба' }),
       hit({ id: 'b0000000-0000-4000-8000-000000000002', title: 'Проба' })],
      { 'b0000000-0000-4000-8000-000000000002': false },
    );
    const out = await resolveLegacyWikiCandidates('net', 'Проба');
    assert.deepEqual(
      out.map((h) => h.id),
      ['a0000000-0000-4000-8000-000000000001'],
    );
  });
});
