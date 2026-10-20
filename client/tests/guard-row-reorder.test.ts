/**
 * Сторож единственного канала переупорядочивания строк (0.14.1, задача
 * 223f7d50; ADR `cce0ce7c`, уточнение аудита цикла 1).
 *
 * Правила:
 *  1) перетаскивание строк живёт в общем канале `lib/ui/drag-list.ts`, а
 *     потребительский фасад — `lib/row-reorder.ts`; локальные DnD-обработчики
 *     (нативный HTML5 DnD, pointer-драг) в новых файлах запрещены;
 *  2) `Alt+↑/↓` разбирается только общим ядром `lib/ui/nav-core.ts`; собственные
 *     Alt-обработчики переупорядочивания вне ядра/фасада запрещены
 *     (`guard-list-nav` остаётся сторожем общей клавиатурной навигации).
 *
 * Легитимные исключения — уже существующие drag-каналы другого назначения
 * (перенос мысли в меню, чипы, карточки публикаций, ресайзеры) и деревья
 * условий; они перечислены явно, чтобы новый файл не проскочил молча.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  assertGuardClean,
  collectViolations,
  type GuardRule,
} from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');
const ROW_REORDER = path.join(RENDERER_ROOT, 'lib', 'row-reorder.ts');
const DEMO_SCENARIO = path.join(
  CLIENT_ROOT,
  'scripts',
  'ui-probe.223f7d50-row-reorder.scenario.json',
);

function read(abs: string): string {
  return fs.readFileSync(abs, 'utf8');
}

/** Комментарий — упоминание конструкций в пояснении не является использованием. */
function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * Существующие DnD/pointer-каналы НЕ переупорядочивания строк. Новый файл с
 * такими конструкциями обязан либо использовать `row-reorder`, либо получить
 * явное исключение здесь с обоснованием.
 */
const DND_ALLOW = new Set([
  // Общий канал перетаскивания `lib/ui` (единственный разрешённый механизм).
  'lib/ui/drag-list.ts',
  'lib/ui/drag-tree.ts',
  // Перенос мысли в контекстное меню (canvas/context-menu.ts).
  'canvas/context-menu.ts',
  // Перетаскивание чипов выбора сущности.
  'lib/entity-picker.ts',
  // Перетаскивание карточки публикации мышью.
  'screens/publications/publications.ts',
  // Ресайзеры и перетаскивание вкладок — не переупорядочивание строк.
  'screens/editor-resizer.ts',
  'screens/selection-resizer.ts',
  'screens/tabs/tabs.ts',
  // Клик вне панели поиска (pointerdown — закрытие, не drag).
  'search/search.ts',
  // Зоны приёма файлов/мыслей и drop текста в редактор — не переупорядочивание строк.
  'canvas/add-dialog.ts',
  'editor/attachments.ts',
  'editor/markdown-field.ts',
  // Общие фасады `lib/ui` с pointer-жестами другого назначения:
  // закрытие поповера кликом вне и ресайзер-сплиттер.
  'lib/ui/popover.ts',
  'lib/ui/splitter.ts',
]);

/** Нативный HTML5 DnD и pointer-драг. */
const DND_SIGNAL =
  /\bdraggable\s*=|['"](?:dragstart|dragenter|dragover|dragleave|dragend|drop)['"]|addEventListener\??\.?\(\s*['"](?:pointerdown|pointermove|pointerup|pointercancel|lostpointercapture)['"]|(?:\.|\b)on(?:pointerdown|pointermove|pointerup|pointercancel|lostpointercapture|dragstart|dragenter|dragover|dragleave|dragend|drop)\s*=/;

/**
 * Собственный разбор Alt+↑/↓ или использование действий перестановки вне
 * общего ядра и фасада.
 */
const ALT_REORDER_SIGNAL =
  /Alt\+Arrow(?:Up|Down)|['"](?:moveUp|moveDown)['"]|isReorderAction\s*\(|(?:altKey[\s\S]{0,120}Arrow(?:Up|Down)|Arrow(?:Up|Down)[\s\S]{0,120}altKey)/;

/** Ядро и узаконенные потребители Alt-перестановки. */
const ALT_ALLOW = new Set([
  'lib/row-reorder.ts',
  'lib/ui/nav-core.ts',
  'lib/ui/list.ts',
  'lib/ui/drag-list.ts',
  'lib/ui/drag-tree.ts',
  // Дерево условий — перенос узлов деревом, не строк списка.
  'lib/filter-tree.ts',
  // Перемещение строк комментария (Alt+↑/↓ в редакторе markdown).
  'lib/keymap.ts',
]);

const RULES: GuardRule[] = [
  {
    name: 'no-local-row-dnd',
    description:
      'Перетаскивание строк — только `lib/row-reorder.ts` поверх `lib/ui/drag-list.ts`: ' +
      'локальные HTML5-DnD и pointer-драг вне общего канала запрещены.',
    pattern: DND_SIGNAL,
    allow: (rel, line) => isComment(line) || DND_ALLOW.has(rel),
  },
  {
    name: 'no-own-alt-reorder',
    description:
      'Alt+↑/↓ разбирается общим ядром `lib/ui/nav-core.ts`; собственные ' +
      'Alt-обработчики переупорядочивания вне `row-reorder`/ядра запрещены.',
    pattern: ALT_REORDER_SIGNAL,
    allow: (rel, line) => isComment(line) || ALT_ALLOW.has(rel),
  },
];

describe('guard: единственный канал row-reorder (223f7d50)', () => {
  it('компонента объявлена и переиспользует общий drag-фасад, а не свой жест', () => {
    const source = read(ROW_REORDER);
    assert.match(
      source,
      /export function createRowReorder(?:<[^>]*>)?\s*\(/,
      'фасад createRowReorder объявлен',
    );
    assert.match(source, /from '\.\/ui\/drag-list\.js'/, 'DnD делегирован общему drag-фасаду');
    assert.doesNotMatch(
      source,
      /addEventListener\??\.?\(\s*['"](?:pointer|keydown)/,
      'своих pointer/keydown-обработчиков у компоненты нет',
    );
    assert.doesNotMatch(source, /['"]Alt\+Arrow(?:Up|Down)['"]/, 'Alt-разбор не дублируется');
  });

  it('демо-стенд поставлен вместе с задачей (список-прототип, не потребители)', () => {
    assert.ok(fs.existsSync(DEMO_SCENARIO), 'сценарий стенда row-reorder существует');
    const scenario = JSON.parse(read(DEMO_SCENARIO)) as {
      steps?: Array<Record<string, unknown>>;
    };
    const steps = scenario.steps ?? [];
    assert.ok(
      steps.some((step) => typeof step['drag'] === 'object'),
      'сценарий показывает перетаскивание',
    );
    assert.ok(
      steps.some((step) => {
        const key = step['key'];
        return (
          typeof key === 'object' &&
          key !== null &&
          (key as { key?: string }).key === 'ArrowDown'
        );
      }),
      'сценарий показывает клавиатурный сдвиг',
    );
  });

  it('в рендерере нет локальных DnD и Alt-перестановки вне общего канала', () => {
    assertGuardClean(RENDERER_ROOT, RULES);
  });

  it('правила краснеют на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-row-reorder-'));
    try {
      const mutations: Array<{ rel: string; source: string; rule: string }> = [
        {
          rel: 'editor/new-properties.ts',
          source: 'node.draggable = true;\n',
          rule: 'no-local-row-dnd',
        },
        {
          rel: 'editor/new-properties.ts',
          source: "node.addEventListener('pointerdown', startDrag);\n",
          rule: 'no-local-row-dnd',
        },
        {
          rel: 'screens/new-type-manager.ts',
          source: "const chord = 'Alt+ArrowUp';\n",
          rule: 'no-own-alt-reorder',
        },
        {
          rel: 'screens/new-type-manager.ts',
          source: 'if (isReorderAction(action)) move();\n',
          rule: 'no-own-alt-reorder',
        },
        {
          rel: 'screens/new-type-manager.ts',
          source: "if (event.altKey && event.key === 'ArrowUp') move();\n",
          rule: 'no-own-alt-reorder',
        },
      ];
      for (const [index, mutation] of mutations.entries()) {
        const caseDir = path.join(dir, `case-${index}`);
        fs.mkdirSync(path.join(caseDir, path.dirname(mutation.rel)), { recursive: true });
        fs.writeFileSync(path.join(caseDir, mutation.rel), mutation.source, 'utf8');
        const violations = collectViolations(caseDir, RULES);
        assert.ok(
          violations.some((violation) => violation.rule === mutation.rule),
          `нарушение обязано ловиться: ${mutation.source.trim()}`,
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
