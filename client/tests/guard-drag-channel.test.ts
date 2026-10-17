/**
 * Сторож канала перетаскивания (задача 31b228f0, этап 1; ADR `442e7ff5`,
 * ADR `e538090f`).
 *
 * Правило: drag-логика живёт ТОЛЬКО в общем фасаде `lib/ui`. Модули фильтров и
 * дерева условий не заводят собственный нативный HTML5 DnD (`draggable`,
 * `dragstart`/`dragover`/`drop`) и не навешивают pointer-слушатели
 * перетаскивания — они передают фасаду ключи/пути и получают готовый дроп.
 * Кросс-групповой канал — `lib/ui/drag-tree.ts`; второго определения
 * `createDragTree` быть не может.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test` и краснеет на
 * умышленном нарушении (проверяется мутацией ниже).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertGuardClean,
  collectViolations,
  type GuardRule,
} from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

/** Модуль фильтров/дерева условий: собственного drag-канала быть не должно. */
function inFilterModule(rel: string): boolean {
  const base = path.posix.basename(rel);
  return /(^|\/)filter[^/]*\.ts$/.test(rel) || /^filter[^/]*\.ts$/.test(base);
}

/** Комментарий — упоминание конструкций в пояснении не является использованием. */
function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Собственный drag-канал: HTML5 DnD, pointer-слушатели и присваивание обработчиков. */
const OWN_DRAG =
  /\bdraggable\b|['"](?:dragstart|dragenter|dragover|dragleave|dragend|drop)['"]|addEventListener\??\.?\(\s*['"](?:pointerdown|pointermove|pointerup|pointercancel|lostpointercapture)['"]|(?:\.|\b)on(?:pointerdown|pointermove|pointerup|pointercancel|lostpointercapture|dragstart|dragenter|dragover|dragleave|dragend|drop)\s*=|\[\s*['"]on(?:pointerdown|pointermove|pointerup|pointercancel|lostpointercapture|dragstart|dragenter|dragover|dragleave|dragend|drop)['"]\s*\]\s*=/;

const RULES: GuardRule[] = [
  {
    name: 'no-own-drag-in-filter-modules',
    description:
      'Канал перетаскивания условий — только `lib/ui` (drag-tree/drag-list): ' +
      'модули фильтров не навешивают `draggable`, нативные DnD-события и ' +
      'pointer-слушатели перетаскивания.',
    pattern: OWN_DRAG,
    include: inFilterModule,
    allow: (_rel, line) => isComment(line),
  },
];

describe('guard: канал перетаскивания в lib/ui (31b228f0)', () => {
  it('фасад drag-tree объявлен, использует pointer-канал и экспортируется из barrel', () => {
    const source = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'ui', 'drag-tree.ts'), 'utf8');
    assert.match(source, /export function createDragTree\s*\(/, 'фасад createDragTree объявлен');
    assert.match(source, /addEventListener(?:\?\.)?\('pointerdown'/, 'захват — pointer-событием');
    assert.doesNotMatch(source, /['"](?:dragstart|dragover|drop)['"]/, 'нативного HTML5 DnD нет');
    assert.doesNotMatch(source, /from ['"][^'"]*filter/, 'фильтр-специфичных импортов нет');
    const index = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'ui', 'index.ts'), 'utf8');
    assert.match(index, /from '\.\/drag-tree\.js'/, 'drag-tree реэкспортируется из barrel');
    const register = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'ui', 'register.ts'), 'utf8');
    assert.match(register, /import '\.\/drag-tree\.css'/, 'вид drag-tree подключён в register');
  });

  it('createDragTree определён ровно в одном модуле lib/ui', () => {
    const owners: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        const source = fs.readFileSync(abs, 'utf8');
        if (/export function createDragTree\s*\(/.test(source)) {
          owners.push(path.relative(RENDERER_ROOT, abs).replace(/\\/g, '/'));
        }
      }
    };
    walk(RENDERER_ROOT);
    assert.deepEqual(owners, ['lib/ui/drag-tree.ts'], 'канал кросс-группового drag — один');
  });

  it('модули фильтров не заводят собственного drag-канала', () => {
    assertGuardClean(RENDERER_ROOT, RULES);
  });

  it('правило краснеет на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-drag-channel-'));
    try {
      fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
      // Каждая мутация проверяется отдельно: присваивание обработчика
      // (`el.onpointerdown = …`) — не менее запрещённая форма, чем
      // `addEventListener`, и обязано попадать в нарушение.
      const mutations = [
        'node.draggable = true;\n',
        "node.addEventListener('pointerdown', startDrag);\n",
        'node.onpointerdown = startDrag;\n',
        'node.ondragstart = startDrag;\n',
        "node['ondragover'] = startDrag;\n",
      ];
      for (const source of mutations) {
        fs.writeFileSync(path.join(dir, 'lib', 'filter-tree.ts'), source, 'utf8');
        const violations = collectViolations(dir, RULES);
        assert.ok(
          violations.some((v) => v.rule === 'no-own-drag-in-filter-modules'),
          `нарушение обязано ловиться: ${source.trim()}`,
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
