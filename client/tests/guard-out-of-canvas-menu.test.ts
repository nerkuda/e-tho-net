/**
 * Сторож единственного фасада меню мысли ВНЕ холста (задача d8941b76).
 *
 * Правило. Цепочка «прочитать сеть → `resolveSiblingParent` → после `await`
 * сверить сеть → открыть меню с явным `siblingParentId`/`siblingParentTitle`»
 * существует ровно в одном месте — фасаде
 * `canvas/context-menu.ts` → `showOutOfCanvasThoughtMenu`. Любой модуль вне
 * фасада зовёт фасад и больше ничего: своя копия резолва/сверки/передачи
 * родителя расходится с фасадом при первом же изменении правил «налево»
 * (так и появились шесть копий к `2baa78fb`), даёт разное поведение в разных
 * местах и теряет сверку сети (класс a3151e33).
 *
 * Что краснит сторож:
 *  - вызов `resolveSiblingParent(` вне фасада;
 *  - модуль вне фасада, где одновременно есть резолв родителя и открытие меню
 *    (`showThoughtContextMenu(`/`showThoughtMenuUnder(`) — копия цепочки;
 *  - явная передача `siblingParentId` в цель меню вне фасада — конструктор
 *    начинает получать родителя мимо фасада.
 *
 * Сторож статический (читает исходники реестра), входит в обычный прогон
 * `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
/** Единственный владелец цепочки: фасад, резолвер и конструктор меню. */
const FACADE_REL = 'canvas/context-menu.ts';

/** Вызов резолвера родителя «налево» (комментарии без `(` не считаются). */
const RESOLVER_CALL_RE = /\bresolveSiblingParent\s*\(/;
/** Открытие меню мысли напрямую — входы конструктора. */
const MENU_OPEN_RES: readonly RegExp[] = [
  /\bshowThoughtContextMenu\s*\(/,
  /\bshowThoughtMenuUnder\s*\(/,
];
/** Явная передача родителя в цель меню. */
const EXPLICIT_PARENT_RE = /\bsiblingParentId\b/;

/** Рекурсивно собирает `.ts`-файлы под каталогом (posix-пути от `renderer/`). */
function collectTsFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(abs, rel));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

const SOURCES = new Map(
  collectTsFiles(RENDERER_ROOT).map((rel) => [
    rel,
    fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8'),
  ]),
);

/** Модули вне фасада (по возрастанию пути — стабильные сообщения). */
const CONSUMERS = [...SOURCES.keys()].filter((rel) => rel !== FACADE_REL).sort();

describe('сторож: меню мысли вне холста — один фасад (задача d8941b76)', () => {
  it('резолвер родителя «налево» вызывается только в фасаде', () => {
    const offenders: string[] = [];
    for (const rel of CONSUMERS) {
      if (RESOLVER_CALL_RE.test(SOURCES.get(rel) ?? '')) offenders.push(rel);
    }
    assert.deepEqual(
      offenders,
      [],
      `resolveSiblingParent вызывается только в ${FACADE_REL}: модули должны звать ` +
        `showOutOfCanvasThoughtMenu (иначе копия резолва расползается): ${offenders.join(', ')}`,
    );
  });

  it('ни один модуль вне фасада не собирает копию цепочки «резолв → меню»', () => {
    const offenders: string[] = [];
    for (const rel of CONSUMERS) {
      const source = SOURCES.get(rel) ?? '';
      const resolvesParent = RESOLVER_CALL_RE.test(source);
      const opensMenu = MENU_OPEN_RES.some((re) => re.test(source));
      if (resolvesParent && opensMenu) offenders.push(rel);
    }
    assert.deepEqual(
      offenders,
      [],
      `цепочка «резолв родителя → открытие меню» живёт только в ${FACADE_REL}: ` +
        `вызывающий отдаёт цель/место/опции, а не повторяет шаги: ${offenders.join(', ')}`,
    );
  });

  it('родителя «налево» в меню вне фасада передаёт только фасад', () => {
    const offenders: string[] = [];
    for (const rel of CONSUMERS) {
      if (EXPLICIT_PARENT_RE.test(SOURCES.get(rel) ?? '')) offenders.push(rel);
    }
    assert.deepEqual(
      offenders,
      [],
      `siblingParentId/siblingParentTitle выставляет только ${FACADE_REL} ` +
        `(иначе имя якоря и сверка сети расходятся с фасадом): ${offenders.join(', ')}`,
    );
  });

  it('фасад действительно держит цепочку целиком', () => {
    const facade = SOURCES.get(FACADE_REL);
    assert.ok(facade !== undefined, `есть ${FACADE_REL}`);
    const start = facade.indexOf('export async function showOutOfCanvasThoughtMenu(');
    assert.ok(start >= 0, 'фасад объявляет showOutOfCanvasThoughtMenu');
    const stop = facade.indexOf('\n}\n', start);
    assert.ok(stop > start, 'тело фасада закрыто');
    const body = facade.slice(start, stop);
    assert.ok(RESOLVER_CALL_RE.test(body), 'фасад резолвит родителя «налево»');
    assert.ok(
      /store\.state\.networkId\s*!==\s*networkId/.test(body),
      'фасад сверяет сеть ПОСЛЕ await (класс a3151e33)',
    );
    assert.ok(/siblingParentId/.test(body), 'фасад передаёт родителя в меню явно');
    assert.ok(/siblingParentTitle/.test(body), 'фасад передаёт имя родителя в меню явно');
    assert.ok(
      /'event' in place/.test(body) && /showThoughtMenuUnder\(place\.anchor/.test(body),
      'фасад открывает меню и по событию, и под якорем',
    );
  });
});
