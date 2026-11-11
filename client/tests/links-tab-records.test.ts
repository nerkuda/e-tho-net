/**
 * Контракт вкладки «Упоминания» по строкам-записям (0.15.4, техпроект 43329662,
 * задача ae72e47e, требования 012b2dc6 и ce121e09).
 *
 * Поведение строки (видимость, потолок, подпись, клик) проверяется тестами
 * `record-rows-block.test.ts` и `record-open.test.ts`; здесь — ПРОВОДКА вкладки,
 * которую под Node не собрать целиком (экран тянет Electron-каркас):
 *  - компиляционная адаптация B1 (`kind === 'record'` с TODO(ae72e47e)) снята;
 *  - обе группы идут ОДНОЙ сборкой `buildHitListBody` и монтируют подблок строк;
 *  - строки-записи идут ПОДБЛОКОМ после владельческих строк;
 *  - счётчик группы публикуют ОБЕ группы (N8) и считает строки обоих видов;
 *  - клик по строке-записи идёт общим решением `lib/record-open.ts`;
 *  - группа «Публикации» не тронута.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

/** Исходник вкладки без комментариев: проверяется КОД, а не объяснения. */
function tabCode(): string {
  return readFileSync(resolve(RENDERER, 'editor', 'links-tab.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/** Тело функции по имени (до закрывающей скобки на нулевом отступе). */
function bodyOf(code: string, name: string): string {
  return new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(code)?.[0] ?? '';
}

describe('вкладка «Упоминания»: строки-записи (задача ae72e47e)', () => {
  it('компиляционная адаптация B1 снята: нет TODO и сужения ответа до владельческих строк', () => {
    const raw = readFileSync(resolve(RENDERER, 'editor', 'links-tab.ts'), 'utf8');
    assert.ok(!raw.includes('ae72e47e (B4)'), 'пояснение-заглушка «строки появятся позже» убрано');
    assert.ok(!/TODO\(ae72e47e\)/.test(raw), 'TODO(ae72e47e) снят вместе с адаптацией');

    const code = tabCode();
    assert.ok(
      !/await options\.load\(networkId\)\)\s*\.filter\(/.test(code),
      'ответ группы не сужается фильтром до `MentionHit`',
    );
    assert.match(
      code,
      /const recordHits = hits\.filter\(\(hit\): hit is RecordHit => hit\.kind === 'record'\)/,
      'строки-записи выделяются из union — иначе они не доходят до подблока',
    );
  });

  it('обе группы собираются одной сборкой и монтируют подблок строк-записей', () => {
    const code = tabCode();
    const backlinks = bodyOf(code, 'buildBacklinksBody');
    const mentions = bodyOf(code, 'buildMentionsBody');
    const shared = bodyOf(code, 'buildHitListBody');

    assert.ok(shared !== '', 'общая сборка тела группы существует');
    assert.match(
      backlinks,
      /return buildHitListBody\(ctx, lifecycle, \{/,
      '«Ссылки на мысль» — через общую сборку',
    );
    assert.match(
      mentions,
      /return buildHitListBody\(ctx, lifecycle, \{/,
      '«Упоминания в текстах» — через общую сборку',
    );
    assert.match(
      backlinks,
      /etn\.thoughts\.backlinks\(networkId, ctx\.ownerId\)/,
      'запрос группы «Ссылки на мысль»',
    );
    assert.match(
      mentions,
      /etn\.thoughts\.mentions\(networkId, ctx\.ownerId\)/,
      'запрос группы «Упоминания в текстах»',
    );

    assert.match(shared, /mountRecordRowsBlock\(\{/, 'строки-записи собирает общий подблок');
    assert.match(shared, /hits: recordHits,/, 'в подблок уходят именно строки-записи группы');
    assert.match(
      shared,
      /showInactive: store\.state\.showInactive,/,
      'настройка видимости вкладки — из состояния клиента',
    );
    assert.match(
      shared,
      /showTrash: store\.state\.showTrash,/,
      'настройка корзины — из состояния клиента',
    );
    assert.match(
      shared,
      /homeId: await homeIdForRows\(networkId\)/,
      'HOME сети для чипов строк-записей',
    );
  });

  it('строки-записи — ПОДБЛОКОМ после владельческих строк', () => {
    const shared = bodyOf(tabCode(), 'buildHitListBody');
    const ownerRow = shared.indexOf('box.append(item);');
    const recordBlock = shared.indexOf('box.append(mounted.el);');

    assert.ok(ownerRow >= 0, 'владельческие строки добавляются в тело группы');
    assert.ok(recordBlock > ownerRow, 'подблок строк-записей идёт ПОСЛЕ владельческих строк');
  });

  it('счётчик группы публикуют ОБЕ группы и считает строки обоих видов', () => {
    const shared = bodyOf(tabCode(), 'buildHitListBody');

    // N8: счётчика «Ссылок на мысль» не было вовсе — теперь он в общей сборке.
    assert.match(
      shared,
      /dispatchEvent\(\s*new CustomEvent\('etn:set-count'/,
      'счётчик группы публикуется',
    );
    assert.match(
      shared,
      /const found = visible\.length \+ \(mounted\?\.visibleCount \?\? 0\)/,
      'счётчик — владельческие строки + все найденные строки-записи (с учётом show_inactive)',
    );
    assert.match(shared, /detail: `\(\$\{found\}\)`/, 'счётчик уходит в заголовок группы');
    // Своей фильтрации строк-записей у вкладки нет: правило видимости одно.
    assert.ok(
      !shared.includes('recordRowActive'),
      'видимость строк-записей считает подблок, а не вкладка',
    );
    assert.ok(
      !shared.includes('RECORD_ROWS_LIMIT'),
      'потолок рендера живёт в общем модуле, а не во вкладке',
    );
  });

  it('клик по строке-записи идёт общим решением (запись, фокус только с карты)', () => {
    const code = tabCode();
    const shared = bodyOf(code, 'buildHitListBody');
    const actions = bodyOf(code, 'recordOpenActions');

    assert.match(
      shared,
      /openRecordTarget\(target, model\.commentId, recordOpenActions\(networkId\)\)/,
      'цель строки открывает общее решение lib/record-open.ts',
    );
    assert.match(actions, /openRecordInEditor,/, 'вход в редактор записи подключён');
    assert.match(actions, /openLinkInEditor,/, 'владелец-связь открывает редактор связи');
    assert.match(actions, /focusFromUi,/, 'фокус холста на открываемой привязке');
    // Ревизия 2026-11-11 (задача 7c380088): фокус — только с активного вида
    // «Карта мыслей»; предикат общий (`isMapViewActive`), своей копии на вкладке
    // нет.
    assert.match(actions, /isMapActive: isMapViewActive,/, 'предикат активного вида карты');
  });

  it('группа «Публикации» не тронута строками-записями', () => {
    const publications = bodyOf(tabCode(), 'buildPublicationsBody');

    assert.ok(publications !== '', 'тело группы «Публикации» на месте');
    for (const forbidden of [
      'mountRecordRowsBlock',
      'openRecordTarget',
      'recordRowActive',
      'RecordHit',
    ]) {
      assert.ok(!publications.includes(forbidden), `«Публикации» не использует ${forbidden}`);
    }
  });
});
