/**
 * Сторож общего drag-фасада `lib/ui` (задача d13fd645, ADR fadf99e0).
 *
 * Правило: логика ручного порядка перетаскиванием живёт ТОЛЬКО в общем
 * компоненте `lib/ui/drag-list.ts`. Рабочая область открытой публикации не
 * заводит собственную сортировку — ни pointer-drag (его запрет уже несёт
 * `guard-splitter`), ни нативный HTML5 DnD (`draggable`,
 * `dragstart`/`dragover`/`drop`), который раньше стоял в оглавлении и не умел
 * холст просмотра. Фасад `createDragList`/`dragHandle` берётся из `lib/ui`.
 *
 * Вне области правила — перетаскивание ПУБЛИКАЦИЙ между полками библиотеки
 * (`publications.ts`, отдельная операция состава полки, не порядок узлов).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, collectViolations, type GuardRule } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

/** Область правила: рабочая область открытой публикации (ручной порядок узлов). */
function inPublications(rel: string): boolean {
  return rel === 'screens/publications/workspace.ts';
}

/** Комментарий — упоминание конструкций в пояснении не является использованием. */
function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Нативная HTML5-сортировка: свойство/атрибут `draggable` и события DnD. */
const OWN_DND = /\bdraggable\b|['"](?:dragstart|dragover|dragleave|dragend|drop)['"]/;

const RULES: GuardRule[] = [
  {
    name: 'no-own-dnd-in-publications',
    description:
      'Ручной порядок узлов публикации — через общий drag-фасад ' +
      '`lib/ui/drag-list.ts` (задача d13fd645): нативного HTML5 DnD ' +
      '(`draggable`/`dragstart`/`drop`) в рабочей области быть не должно.',
    pattern: OWN_DND,
    include: inPublications,
    allow: (_rel, line) => isComment(line),
  },
];

describe('guard: общий drag-фасад lib/ui (d13fd645)', () => {
  it('фасад объявлен и экспортируется из barrel lib/ui', () => {
    const source = fs.readFileSync(
      path.join(RENDERER_ROOT, 'lib', 'ui', 'drag-list.ts'),
      'utf8',
    );
    assert.match(source, /export function createDragList</, 'фасад createDragList объявлен');
    assert.match(source, /export function dragHandle\s*\(/, 'фасад грипа dragHandle объявлен');
    const index = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'ui', 'index.ts'), 'utf8');
    assert.match(index, /from '\.\/drag-list\.js'/, 'drag-list реэкспортируется из barrel');
  });

  it('оглавление и холст просмотра подключают фасад, а не свой DnD', () => {
    const workspace = fs.readFileSync(
      path.join(RENDERER_ROOT, 'screens', 'publications', 'workspace.ts'),
      'utf8',
    );
    assert.match(workspace, /createDragList/, 'рабочая область строит сортировку фасадом');
    assert.match(workspace, /dragHandle/, 'ручка-аффорданс берётся из фасада');
    assert.match(
      workspace,
      /from '\.\.\/\.\.\/lib\/ui\/drag-list\.js'/,
      'фасад импортируется из lib/ui',
    );
  });

  it('в экранах и карточке публикации нет собственного нативного DnD', () => {
    assertGuardClean(RENDERER_ROOT, RULES);
  });

  it('правило краснеет на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-drag-list-'));
    try {
      fs.mkdirSync(path.join(dir, 'screens', 'publications'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'screens', 'publications', 'workspace.ts'),
        "node.draggable = true;\nnode.addEventListener('drop', () => reorder());\n",
        'utf8',
      );
      const violations = collectViolations(dir, RULES);
      assert.ok(
        violations.some((v) => v.rule === 'no-own-dnd-in-publications'),
        'собственный HTML5 DnD обязан попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
