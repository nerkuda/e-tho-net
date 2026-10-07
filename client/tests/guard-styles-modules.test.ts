/**
 * Сторож целостности модульного CSS клиента (задача de23c709).
 *
 * `client/src/renderer/styles.css` — манифест: он не содержит правил, только
 * `@import` модулей каталога `./styles/`. Разделение на модули не должно
 * терять правила и не должно менять порядок каскада (грабли 36889dd6:
 * при равной специфичности исход решают порядок в бандле и порядок правил
 * внутри одного модуля — порядок `@import` это контракт, а не деталь).
 *
 * Правила сторожа:
 *  1. Манифест — только комментарии и `@import` (ни одного правила/свойства).
 *  2. Порядок `@import` совпадает с явным списком модулей (снимок состава).
 *  3. Каждый `@import` указывает на существующий файл и каждый `.css` под
 *     `styles/` импортирован ровно один раз — нет «потерянных» модулей и
 *     мёртвых файлов (barrel-дисциплина каталога стилей).
 *  4. Суммарный набор правил не скукожился: общее число правил не ниже
 *     порога, а ключевые селекторы крупных блоков на месте.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');
const MANIFEST = path.join(RENDERER_ROOT, 'styles.css');
const STYLES_ROOT = path.join(RENDERER_ROOT, 'styles');

/**
 * Явный снимок состава и порядка модулей. Новый модуль добавляется сюда
 * вместе с `@import` в манифесте — молча выпасть из порядка он не может.
 */
const EXPECTED_MODULES = [
  'styles/tokens.css',
  'styles/base.css',
  'styles/screens/onboarding-networks.css',
  'styles/layout.css',
  'styles/canvas.css',
  'styles/editor.css',
  'styles/markdown.css',
  'styles/screens/search.css',
  'styles/screens/selection.css',
  'styles/screens/structures.css',
  'styles/condition-combo.css',
  'styles/filter-panel.css',
  'styles/menus.css',
  'styles/dialogs.css',
  'styles/notifications.css',
  'styles/scrollbars.css',
  'styles/type-combobox.css',
  'styles/micro-interactions.css',
  'styles/screens/chronicle.css',
  'styles/layers.css',
  'styles/screens/events.css',
  'styles/screens/publications.css',
  'styles/legacy.css',
];

/**
 * Порог общего числа правил. Полное число на момент разделения — 1010;
 * порог ловит массовую потерю правил при переносах, но не мешает добавлять
 * новые. Осознанное крупное удаление правил сопровождается правкой порога.
 */
const MIN_RULES = 1000;

/** Ключевые селекторы крупных блоков — «снимок перечня». */
const KEY_SELECTORS = [
  ':root',
  "[data-theme='dark']",
  '.screen',
  '.workspace-body',
  '.top-row',
  '.tab',
  '.statusbar',
  '.links-overlay',
  '.cloud',
  '.editor-tabs',
  '.md-field-view',
  '.comment-view',
  '.search-panel',
  '.selection-panel',
  '.structures',
  '.st-filter',
  '.value-combo-row',
  '.fp-host',
  '.menu',
  '.dialog-box',
  '.admin-panel',
  '.notice',
  '.type-combo',
  '.form-row',
  '.attachments-list',
  '.settings-body',
  '.about-body',
  '.prop-grid',
  '.chron-table',
  '.mini-graph-edge',
  '.chronicle',
  '.activity',
  '::-webkit-scrollbar',
];

/** `@import '<путь>';` — путь без кавычек, в порядке появления. */
function parseManifestImports(css: string): string[] {
  const stripped = stripComments(css);
  const imports: string[] = [];
  for (const m of stripped.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*\)?\s*;/g)) {
    if (m[1]) imports.push(normalizeRel(m[1]));
  }
  return imports;
}

/** Канонический относительный путь: слеши `/`, без ведущего `./`. */
function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

/** Содержимое манифеста без комментариев и `@import` — должно быть пусто. */
function manifestResidue(css: string): string {
  return stripComments(css)
    .replace(/@import\s+(?:url\(\s*)?['"][^'"]+['"]\s*\)?\s*;/g, '')
    .trim();
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Все `.css` под `styles/` относительно корня `renderer/`, слеши `/`. */
function listModuleFiles(stylesRoot: string): string[] {
  const out: string[] = [];
  const stack = [stylesRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile() && entry.name.endsWith('.css')) out.push(abs);
    }
  }
  return out.map((abs) => path.relative(path.dirname(stylesRoot), abs).replace(/\\/g, '/')).sort();
}

/** Число правил верхнего уровня (блоков `{…}` вне других блоков). */
function countTopLevelRules(css: string): number {
  const text = stripComments(css);
  let depth = 0;
  let count = 0;
  for (const ch of text) {
    if (ch === '{') {
      if (depth === 0) count++;
      depth++;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
    }
  }
  return count;
}

/** Собирает CSS всех модулей манифеста в порядке импортов. */
function readModules(rendererRoot: string, imports: string[]): string {
  return imports
    .map((rel) => fs.readFileSync(path.join(rendererRoot, rel), 'utf8'))
    .join('\n');
}

describe('guard: модульный styles.css (de23c709)', () => {
  const manifest = fs.readFileSync(MANIFEST, 'utf8');
  const imports = parseManifestImports(manifest);
  const combined = readModules(RENDERER_ROOT, imports);

  it('манифест не содержит правил — только комментарии и @import', () => {
    assert.equal(
      manifestResidue(manifest),
      '',
      'styles.css обязан быть манифестом: правила живут в модулях styles/*.css',
    );
    assert.ok(imports.length > 0, 'манифест обязан импортировать модули');
  });

  it('порядок @import совпадает со снимком состава модулей', () => {
    assert.deepEqual(
      imports,
      EXPECTED_MODULES,
      'порядок @import — контракт каскада (грабли 36889dd6); новый модуль ' +
        'добавляется в манифест и в EXPECTED_MODULES одновременно',
    );
  });

  it('каждый модуль импортирован ровно один раз, лишних файлов нет', () => {
    const onDisk = listModuleFiles(STYLES_ROOT);
    assert.deepEqual(
      [...imports].sort(),
      onDisk,
      'каждый styles/**/*.css обязан быть импортирован манифестом ровно ' +
        'один раз — потерянный модуль теряет свои правила из бандла',
    );
    assert.equal(new Set(imports).size, imports.length, 'повторный @import модуля недопустим');
  });

  it('суммарный набор правил не скукожился', () => {
    const rules = countTopLevelRules(combined);
    assert.ok(
      rules >= MIN_RULES,
      `правил в модулях ${rules}, ожидалось не меньше ${MIN_RULES}: ` +
        'разделение на модули не должно терять правила',
    );
  });

  it('ключевые селекторы крупных блоков на месте', () => {
    const missing = KEY_SELECTORS.filter((sel) => !combined.includes(sel));
    assert.deepEqual(missing, [], `потеряны ключевые селекторы: ${missing.join(', ')}`);
  });

  it('сторож краснеет на потерянном модуле и на нарушении порядка', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-styles-'));
    try {
      fs.mkdirSync(path.join(dir, 'styles'));
      fs.writeFileSync(path.join(dir, 'styles', 'a.css'), '.a { color: red; }\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'styles', 'b.css'), '.b { color: red; }\n', 'utf8');
      fs.writeFileSync(
        path.join(dir, 'styles.css'),
        "@import './styles/a.css';\n",
        'utf8',
      );
      const manifest2 = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
      const imports2 = parseManifestImports(manifest2);
      assert.deepEqual(imports2, ['styles/a.css']);
      // b.css на диске, но не импортирован — расхождение обязано обнаруживаться
      const onDisk = listModuleFiles(path.join(dir, 'styles'));
      assert.notDeepEqual([...imports2].sort(), onDisk);

      // правило в манифесте (не @import) — тоже нарушение
      fs.writeFileSync(
        path.join(dir, 'styles.css'),
        "@import './styles/a.css';\n.a { color: red; }\n",
        'utf8',
      );
      assert.notEqual(
        manifestResidue(fs.readFileSync(path.join(dir, 'styles.css'), 'utf8')),
        '',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
