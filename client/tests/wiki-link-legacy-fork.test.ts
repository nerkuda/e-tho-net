/**
 * Развилка клика по легаси-ссылке `[[Имя]]` (0.12.2, задача 8e4e3dc5) —
 * чистые решатели и сбой источника кандидатов. Поведение согласовано
 * пользователем (уточнение 2026-10-11, вечер):
 *
 *   ПРОСМОТР — конвертации НЕТ НИКОГДА (`convert: false`): ссылка остаётся
 *     `[[Имя]]`, работает только переход по развилке (одна → открыть;
 *     несколько → поповер → открыть выбранную; ни одной → создать → открыть
 *     созданную).
 *   ПРАВКА — конвертация в буфер без перехода (`convert: true`,
 *     `navigate: false`), КРОМЕ единственной ЗАХВАЧЕННОЙ цели — её открыть
 *     без конвертации.
 *   Кандидат — точное совпадение по названию ИЛИ синониму среди актуальных;
 *   точность классифицирует СЕРВЕР (`matched_on`: title/synonym/partial), в т.ч.
 *   `*`-синонимы («исправ* ошиб*» → «исправленные ошибки», уточнение дефекта
 *   визуальной проверки 2026-10-11).
 *
 * Чистая часть — без DOM; `resolveLegacyWikiCandidates` — с подменой
 * `window.etn` (живой прокси `lib/etn.ts`, как в `add-dialog.test.ts`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import type { DuplicateHit } from '../src/main/ipc/contract.js';
import {
  decideLegacyFork,
  exactLegacyCandidates,
  legacyCandidateWindow,
  legacyNameKey,
  LEGACY_CANDIDATE_LIMIT,
  planLegacyFork,
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
    ...(partial.matched_synonym !== undefined ? { matched_synonym: partial.matched_synonym } : {}),
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

describe('exactLegacyCandidates: точность по классификации сервера (matched_on)', () => {
  it('точное название (matched_on=title) — кандидат', () => {
    const hits = [hit({ title: 'Иванов' }), hit({ title: 'Петров', matched_on: 'partial' })];
    assert.deepEqual(
      exactLegacyCandidates(hits, 'Иванов').map((h) => h.title),
      ['Иванов'],
    );
  });

  it('точный синоним (matched_on=synonym) — кандидат', () => {
    const hits = [hit({ title: 'Пётр', synonyms: ['Петя', 'Petr'], matched_on: 'synonym' })];
    assert.equal(exactLegacyCandidates(hits, 'Петя').length, 1);
  });

  it('partial-совпадение не берётся', () => {
    const hits = [hit({ title: 'Ивановский', matched_on: 'partial' })];
    assert.deepEqual(exactLegacyCandidates(hits, 'Иванов'), []);
  });

  it('WILDCARD-синоним («исправ* ошиб*» → «исправленные ошибки») — кандидат (дефект визуальной проверки)', () => {
    // Красная фиксация: `find_duplicates` уже вернул `matched_on: 'synonym'`
    // для совпавшего `*`-паттерна синонима (общий матчер `synonymPatternToRegex`,
    // анкорится на ВСЁ имя). Прежняя ЛИТЕРАЛЬНАЯ фильтрация клиента сравнивала
    // «исправ* ошиб*» с «исправленные ошибки» буквально и отсеивала кандидата —
    // тест краснеет на литеральном сравнении.
    const hits = [
      hit({
        title: 'Ошибки',
        synonyms: ['исправ* ошиб*'],
        matched_on: 'synonym',
        matched_synonym: 'исправ* ошиб*',
      }),
    ];
    assert.deepEqual(
      exactLegacyCandidates(hits, 'исправленные ошибки').map((h) => h.title),
      ['Ошибки'],
    );
  });

  it('пустое имя — пустой список', () => {
    assert.deepEqual(exactLegacyCandidates([hit({ title: 'x' })], '   '), []);
  });
});

describe('ветка «создать»: просмотр не отказывает уведомлением (дефект визуальной проверки)', () => {
  it('в wiki-link.ts упразднено уведомление об отсутствии мысли', () => {
    // Красная фиксация дефекта: раньше ветка `create` при отсутствии контекста
    // владельца звала notice «Мысль «…» не найдена.» вместо открытия диалога.
    const src = readFileSync(
      new URL('../src/renderer/editor/wiki-link.ts', import.meta.url),
      'utf8',
    );
    assert.equal(src.includes('» не найдена.'), false);
  });

  it('tryCreateThoughtFromLegacyLink не гейтит диалог контекстом владельца', () => {
    const src = readFileSync(
      new URL('../src/renderer/editor/wiki-link-create.ts', import.meta.url),
      'utf8',
    );
    // Раннего отказа по отсутствию контекста (`if (ctx === null) return false`)
    // больше нет — диалог открывается на любой поверхности.
    assert.equal(src.includes('return false'), false);
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

describe('planLegacyFork: просмотр — без конвертации; правка — буфер (уточнение 2026-10-11, вечер)', () => {
  it('ПРОСМОТР: все ветки — только переход, конвертации НЕТ', () => {
    // одна свободная, одна захваченная, несколько, ни одной — везде convert=false.
    for (const [count, locked] of [
      [1, false],
      [1, true],
      [2, false],
      [11, false],
      [0, false],
    ] as const) {
      const plan = planLegacyFork(count, locked, true);
      assert.equal(plan.convert, false, `просмотр, count=${count}, locked=${locked}: без конвертации`);
      assert.equal(plan.navigate, true, `просмотр, count=${count}, locked=${locked}: переход`);
    }
  });

  it('ПРАВКА: одна свободная — конвертация в буфер, без перехода', () => {
    assert.deepEqual(planLegacyFork(1, false, false), {
      action: 'convert-open',
      convert: true,
      navigate: false,
    });
  });

  it('ПРАВКА: несколько — конвертация выбранной в буфер, без перехода', () => {
    assert.deepEqual(planLegacyFork(3, false, false), {
      action: 'popover',
      convert: true,
      navigate: false,
    });
  });

  it('ПРАВКА: ни одной — создание, затем конвертация в буфер (без перехода)', () => {
    assert.deepEqual(planLegacyFork(0, false, false), {
      action: 'create',
      convert: true,
      navigate: false,
    });
  });

  it('ПРАВКА: единственная ЗАХВАЧЕННАЯ — ОТКРЫТЬ без конвертации', () => {
    assert.deepEqual(planLegacyFork(1, true, false), {
      action: 'open-only',
      convert: false,
      navigate: true,
    });
  });

  it('ПРОСМОТР: единственная захваченная — тоже просто открыть (конвертации нет)', () => {
    assert.deepEqual(planLegacyFork(1, true, true), {
      action: 'open-only',
      convert: false,
      navigate: true,
    });
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
