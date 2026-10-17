/**
 * Регрессионное доказательство по ошибке db504c1a («Раскрытие ветви в
 * „Структурах мыслей“ игнорирует фильтр обхода по связям»).
 *
 * Проверяемый инвариант: ЛЮБОЙ запрос раскрытия/догрузки уровня дерева уходит
 * через одну точку (`fetchHierarchy` в `screens/structures/structures.ts`),
 * и эта точка добавляет в запрос фильтр обхода по связям — ровно тот, что
 * применён к текущему отбору (`appliedQuery.filter.link_filter`, собранный
 * единственным вызовом `buildTraversalFilter()` в `buildFilter()` спуска).
 *
 * Почему проверка структурная (по исходнику), а не прогоном: `structures.ts`
 * импортирует весь DOM-слой экрана (`app.js`, холст, редактор) — модуль не
 * поднимается в node:test. Поведение самого фильтра на проводе проверяют
 * соседние тесты: `rest-client.test.ts` (client → `link_filter` в query),
 * `server/tests/routes-structures-hierarchy.test.ts` и
 * `server/tests/structure-service.test.ts` (серверный отбор соседей).
 * Здесь пинится именно ПРОВОДКА — та, что была потеряна между слоями.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const STRUCTURES_TS = path.resolve(
  import.meta.dirname,
  '..',
  'src',
  'renderer',
  'screens',
  'structures',
  'structures.ts',
);

/** Единственный вызов домена раскрытия вместе с его аргументами. */
const HIERARCHY_CALL = /etn\.structures\.hierarchy\([\s\S]{0,400}/;

/** Исходник без комментариев: домен раскрытия упоминается и в JSDoc. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Инвариант проводки: одна точка раскрытия, и она несёт фильтр обхода. */
function wiringProblems(rawSource: string): string[] {
  const source = stripComments(rawSource);
  const problems: string[] = [];
  const calls = source.match(/etn\.structures\.hierarchy\(/g) ?? [];
  if (calls.length !== 1) {
    problems.push(
      `etn.structures.hierarchy(...) вызывается ${calls.length} раз(а): ` +
        'все запросы раскрытия обязаны идти через одну точку, иначе фильтр ' +
        'обхода легко потерять на одном из путей (ошибка db504c1a)',
    );
  }
  const call = source.match(HIERARCHY_CALL)?.[0];
  if (call !== undefined && !call.includes('linkFilter: appliedQuery?.filter.link_filter')) {
    problems.push('единственный вызов etn.structures.hierarchy(...) не передаёт фильтр обхода');
  }
  const viaFunnel = source.match(/await fetchHierarchy\(/g) ?? [];
  if (viaFunnel.length < 3) {
    problems.push(
      `через fetchHierarchy(...) идёт ${viaFunnel.length} запрос(ов): ` +
        'раскрытие узла, «Показать ещё» и перезапрос после realtime — все три ' +
        'обязаны использовать общую точку',
    );
  }
  // Спуск и раскрытие берут фильтр из одного места: панель → `buildFilter()`
  // → `appliedQuery.filter.link_filter` → запрос раскрытия. После пересборки
  // панели на единый редактор (задача 213bd2d2, ADR fc23f9c1, решение
  // 2026-10-12) фасада обхода у панели НЕТ: ограничение по связям выражается
  // строкой «в иерархии» дерева, а раскрытие по-прежнему берёт фильтр из общего
  // `appliedQuery` — значит обходит по тем же живым связям, что и сам отбор
  // (расхождения «отбор ↔ раскрытие» нет — ошибка db504c1a остаётся закрытой).
  if (!source.includes('appliedQuery?.filter.link_filter')) {
    problems.push('раскрытие обязано брать фильтр обхода из общего appliedQuery');
  }
  return problems;
}

describe('структуры: раскрытие ветви подчиняется фильтру обхода (ошибка db504c1a)', () => {
  const source = fs.readFileSync(STRUCTURES_TS, 'utf8');

  it('единственный вызов etn.structures.hierarchy(...) идёт из точки с фильтром обхода', () => {
    assert.deepEqual(wiringProblems(source), []);
  });

  it('инвариант краснеет, если из точки раскрытия убрать фильтр обхода', () => {
    const broken = source.replace(
      'linkFilter: appliedQuery?.filter.link_filter,',
      '',
    );
    assert.notEqual(broken, source, 'подстановка обязана что-то менять');
    assert.ok(
      wiringProblems(broken).some((p) => p.includes('не передаёт фильтр обхода')),
      'снятие linkFilter обязано ловиться',
    );
  });

  it('инвариант краснеет на обходном вызове домена раскрытия', () => {
    const bypass = `${source}\nasync function sneaky() {\n  return etn.structures.hierarchy(nid, id, { dir: 'children' });\n}\n`;
    assert.ok(
      wiringProblems(bypass).some((p) => p.includes('раз(а)')),
      'вызов в обход точки обязан ловиться',
    );
  });

  it('панель не строит фасадных parent_ids/link_filter (решение 2026-10-12)', () => {
    const panel = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        '..',
        'src',
        'renderer',
        'screens',
        'structures',
        'filter-panel.ts',
      ),
      'utf8',
    );
    for (const gone of ['buildTraversalFilter', 'linkFilterTypeIds', 'linkFilterStructural', "'parent_ids'"]) {
      assert.ok(
        !panel.includes(gone),
        `фасад обхода «${gone}» из панели убран: ограничение выражает строка «в иерархии»`,
      );
    }
  });
});
