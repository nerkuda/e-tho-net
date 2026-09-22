/**
 * Регрессионное доказательство по ошибке 8bbc9542 («Дерево Структур не
 * помечает соседа в корзине»).
 *
 * Серверный фикс (`REF_COLUMNS` несёт `marked_for_deletion`) и фабрика
 * облачка (`createThoughtCloud` рисует метку по флагу — см.
 * `thought-cloud.test.ts`, профиль `tree`) покрывают отображение. Здесь
 * пинится ПРОВОДКА дерева «Структур»: узел передаёт ссылку фабрике целиком
 * (флаг доезжает) и метка корзины кликабельна — открывает тот же диалог
 * восстановления/удаления, что на карте (общий `openThoughtDeleteDialog`).
 *
 * Почему проверка структурная (по исходнику), а не прогоном: `structures.ts`
 * импортирует весь DOM-слой экрана (`app.js`, холст, редактор) — модуль не
 * поднимается в node:test (см. соседний `structures-hierarchy-link-filter`).
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

/** Исходник без комментариев: домен/диалог упоминаются и в JSDoc. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Достаёт тело `buildCloud` (до закрывающей `\n}` на нулевом отступе). */
function buildCloudBody(source: string): string {
  const start = source.indexOf('function buildCloud(');
  assert.ok(start >= 0, 'buildCloud must be defined');
  return source.slice(start, source.indexOf('\n}\n', start));
}

/** Инварианты проводки метки корзины в дереве. */
function wiringProblems(rawSource: string): string[] {
  const source = stripComments(rawSource);
  const problems: string[] = [];
  const body = buildCloudBody(source);
  if (
    !body.includes('ref ?? { id: row.thoughtId') ||
    !body.includes('createThoughtCloud(')
  ) {
    problems.push('узел дерева обязан отдавать фабрике ссылку мысли целиком (флаг marked_for_deletion едет в ней)');
  }
  if (!body.includes('onTrashBadgeClick:')) {
    problems.push('метка корзины в дереве обязана быть кликабельной (onTrashBadgeClick)');
  }
  if (!body.includes("import('../../trash.js')") || !body.includes('openThoughtDeleteDialog')) {
    problems.push('клик по метке обязан открывать общий диалог удаления/восстановления (openThoughtDeleteDialog)');
  }
  // Статический импорт trash.js в structures.ts замкнул бы цикл: trash.ts
  // статически тянет scheduleStructuresRefresh из этого модуля.
  if (/^import .*from '..\/..\/trash\.js'/m.test(source)) {
    problems.push('импорт trash.js должен быть ленивым (цикл через scheduleStructuresRefresh)');
  }
  return problems;
}

describe('структуры: узел дерева помечает соседа в корзине (ошибка 8bbc9542)', () => {
  const source = fs.readFileSync(STRUCTURES_TS, 'utf8');

  it('узел отдаёт ссылку фабрике и открывает диалог корзины по метке', () => {
    assert.deepEqual(wiringProblems(source), []);
  });

  it('инвариант краснеет, если метку корзины снять с узла', () => {
    const broken = source.replace('onTrashBadgeClick:', 'onTrashBadgeClickRemoved:');
    assert.notEqual(broken, source, 'подстановка обязана что-то менять');
    assert.ok(
      wiringProblems(broken).some((p) => p.includes('onTrashBadgeClick')),
      'снятие обработчика метки обязано ловиться',
    );
  });

  it('инвариант краснеет на статическом импорте trash.js (цикл)', () => {
    const broken = `import { openThoughtDeleteDialog } from '../../trash.js';\n${source}`;
    assert.ok(
      wiringProblems(broken).some((p) => p.includes('ленивым')),
      'статический импорт trash.js обязан ловиться',
    );
  });
});
