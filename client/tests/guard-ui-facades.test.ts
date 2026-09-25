/**
 * Сводные сторожа фасадной дисциплины `lib/ui` (задача 35b9cc05, ADR 03eb2c61).
 *
 * ADR «Основа lib/ui: готовые Web Components за фасадами» запрещает голые Web
 * Components в экранах и модулях, требует единой точки доступа через
 * `lib/ui/index.ts` и оставляет каркас диалога `lib/dialog.ts` единственным
 * источником диалогов. Три правила:
 *
 * 1. **Вендор — только внутри `lib/ui/`.** Вендорские пакеты
 *    (`@awesome.me/webawesome`, отдельные `@vaadin/*`) и их элементы
 *    (`wa-*`, `vaadin-*`) импортируются/создаются только в модулях-фасадах
 *    `lib/ui/`; экраны обязаны ходить через фасад.
 * 2. **Barrel-дисциплина.** Каждый модуль `lib/ui/*.ts` реэкспортируется из
 *    `lib/ui/index.ts` — иначе фасад существует, но недоступен потребителям
 *    и правило «единая точка доступа» обходится импортом файла напрямую.
 * 3. **Диалоги — только через `lib/dialog`.** Каркас диалога
 *    (`dialog-box`) объявляется в `lib/dialog.ts`, `showDialog`
 *    определяется там же; самодельных окон-диалогов в рендерере нет.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, collectViolations } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');
const UI_ROOT = path.join(RENDERER_ROOT, 'lib', 'ui');

/** Комментарий (JS/CSS) — упоминание в пояснении не является использованием. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('#')
  );
}

/** Импорт вендорского пакета: Web Awesome Core или отдельный `@vaadin/*`. */
const VENDOR_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]@(?:awesome\.me\/webawesome|vaadin\/[\w-]+)(?:['"/])/;

/** Литерал имени вендорского custom element (`wa-button`, `vaadin-grid`). */
const VENDOR_ELEMENT = /['"`](?:wa|vaadin)-[a-z][\w-]*['"`]/;

describe('guard: фасады lib/ui (35b9cc05, ADR 03eb2c61)', () => {
  it('вендорский пакет импортируется только внутри lib/ui', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'vendor-import-only-in-lib-ui',
        description:
          'Вендорские пакеты (`@awesome.me/webawesome`, `@vaadin/*`) ' +
          'импортируются только модулями-фасадами lib/ui (ADR 03eb2c61): ' +
          'экраны и прочие модули ходят через фасад.',
        filePattern: VENDOR_IMPORT,
        allow: (rel) => rel.startsWith('lib/ui/'),
      },
    ]);
  });

  it('голые вендорские элементы (wa-*, vaadin-*) не создаются вне lib/ui', () => {
    assertGuardClean(
      RENDERER_ROOT,
      [
        {
          name: 'no-bare-vendor-elements',
          description:
            'Голые Web Components (`wa-*`, `vaadin-*`) в экранах и модулях ' +
            'запрещены (ADR 03eb2c61): только через фасады lib/ui.',
          pattern: VENDOR_ELEMENT,
          allow: (rel, line) => rel.startsWith('lib/ui/') || isCommentLine(line),
        },
      ],
      { extensions: ['.ts', '.js', '.tsx', '.css'] },
    );
  });

  it('каждый модуль lib/ui реэкспортирован через lib/ui/index.ts', () => {
    const missing = findMissingBarrelExports(UI_ROOT);
    assert.deepEqual(
      missing,
      [],
      `Модули lib/ui без реэкспорта в index.ts: ${missing.join(', ')}. ` +
        'Единая точка доступа требует реэкспорта (ADR 03eb2c61).',
    );
  });

  it('правило barrel-дисциплины краснеет на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-barrel-'));
    try {
      fs.writeFileSync(path.join(dir, 'index.ts'), "export {} from './known.js';\n", 'utf8');
      fs.writeFileSync(path.join(dir, 'known.ts'), 'export const a = 1;\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'orphan.ts'), 'export const b = 2;\n', 'utf8');
      const missing = findMissingBarrelExports(dir);
      assert.deepEqual(missing, ['orphan.ts'], 'модуль без реэкспорта обязан попадать в нарушение');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('правило «вендор только в lib/ui» краснеет на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-vendor-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'screen.ts'),
        "import '@awesome.me/webawesome/dist/components/button/button.js';\n" +
          "const el = 'wa-button';\n",
        'utf8',
      );
      const rules = [
        { name: 'vendor-import-only-in-lib-ui', description: '', filePattern: VENDOR_IMPORT },
        { name: 'no-bare-vendor-elements', description: '', pattern: VENDOR_ELEMENT },
      ];
      const violations = collectViolations(dir, rules, { extensions: ['.ts', '.css'] });
      assert.ok(
        violations.some((v) => v.rule === 'vendor-import-only-in-lib-ui'),
        'импорт вендора вне lib/ui обязан попадать в нарушение',
      );
      assert.ok(
        violations.some((v) => v.rule === 'no-bare-vendor-elements'),
        'голый элемент wa-* вне lib/ui обязан попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('правило «диалог только через lib/dialog» краснеет на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-dialogframe-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'screen.ts'),
        "const box = div('dialog-box');\n",
        'utf8',
      );
      const violations = collectViolations(
        dir,
        [
          {
            name: 'dialog-frame-only-in-lib-dialog',
            description: '',
            pattern: /['"]dialog-box['"]/,
            include: (rel) => rel.endsWith('.ts'),
          },
        ],
        { extensions: ['.ts'] },
      );
      assert.ok(
        violations.some((v) => v.rule === 'dialog-frame-only-in-lib-dialog'),
        'самодельный каркас диалога обязан попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('каркас диалога объявляется только в lib/dialog.ts', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'dialog-frame-only-in-lib-dialog',
        description:
          'Самодельные окна-диалоги запрещены (требование 88a9225a): каркас ' +
          '`dialog-box` объявляет только `lib/dialog.ts`.',
        pattern: /['"]dialog-box['"]/,
        include: (rel) => rel.endsWith('.ts'),
        allow: (rel) => rel === 'lib/dialog.ts',
      },
      {
        name: 'showDialog-defined-only-in-lib-dialog',
        description:
          'Каркас диалога — единственный источник диалогов (требование ' +
          '88a9225a): `showDialog` определяется только в `lib/dialog.ts`.',
        pattern: /(?:export\s+)?(?:async\s+)?function\s+showDialog\b/,
        allow: (rel) => rel === 'lib/dialog.ts',
      },
    ]);
  });

  it('каждый CSS-модуль lib/ui подключён (нет осиротевших стилей)', () => {
    const orphan = findOrphanUiStyles(UI_ROOT);
    assert.deepEqual(
      orphan,
      [],
      `CSS-модули lib/ui без импорта: ${orphan.join(', ')}. Осиротевший стиль ` +
        'молча не попадает в бандл — вид компонента ломается без ошибки ' +
        '(ADR 03eb2c61): подключи его из `lib/ui/register.ts`.',
    );
  });

  it('реэкспорты index.ts не ссылаются на несуществующие модули', () => {
    const stale = findStaleBarrelImports(UI_ROOT);
    assert.deepEqual(
      stale,
      [],
      `lib/ui/index.ts реэкспортирует отсутствующие модули: ${stale.join(', ')}`,
    );
  });

  it('правила подключения CSS и реэкспорта краснеют на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-ui-modules-'));
    try {
      fs.writeFileSync(path.join(dir, 'index.ts'), "export {} from './ghost.js';\n", 'utf8');
      fs.writeFileSync(path.join(dir, 'real.ts'), 'export const a = 1;\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'orphan.css'), '.orphan { color: red; }\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'wired.css'), '.wired { color: red; }\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'wired.ts'), "import './wired.css';\n", 'utf8');

      assert.deepEqual(findOrphanUiStyles(dir), ['orphan.css']);
      assert.deepEqual(findStaleBarrelImports(dir), ['ghost.js']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Модули `lib/ui/*.ts` (кроме самого `index.ts`), отсутствующие среди
 * реэкспортов `index.ts`. Реэкспорт — любое упоминание `'./<имя>.js'`.
 */
function findMissingBarrelExports(uiDir: string): string[] {
  const index = fs.readFileSync(path.join(uiDir, 'index.ts'), 'utf8');
  return fs
    .readdirSync(uiDir)
    .filter((name) => name.endsWith('.ts') && name !== 'index.ts')
    .filter((name) => {
      const base = name.slice(0, -'.ts'.length);
      return !new RegExp(`['"]\\./${base}\\.js['"]`).test(index);
    })
    .sort();
}

/**
 * CSS-модули `lib/ui/*.css`, не подключённые ни одним `.ts` того же каталога.
 * Осиротевший стиль не попадает в бандл и ломает вид компонента молча.
 */
function findOrphanUiStyles(uiDir: string): string[] {
  const ts = fs
    .readdirSync(uiDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => fs.readFileSync(path.join(uiDir, name), 'utf8'))
    .join('\n');
  return fs
    .readdirSync(uiDir)
    .filter((name) => name.endsWith('.css'))
    .filter((name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return !new RegExp(`['"]\\./${escaped}['"]`).test(ts);
    })
    .sort();
}

/**
 * Реэкспорты `'./<имя>.js'` из `index.ts`, для которых нет `<имя>.ts`.
 * Мёртвая ссылка в barrel — ошибка сборки или потерянный модуль.
 */
function findStaleBarrelImports(uiDir: string): string[] {
  const index = fs.readFileSync(path.join(uiDir, 'index.ts'), 'utf8');
  const stale = new Set<string>();
  for (const m of index.matchAll(/['"]\.\/([\w.-]+)\.js['"]/g)) {
    if (m[1] && !fs.existsSync(path.join(uiDir, `${m[1]}.ts`))) stale.add(`${m[1]}.js`);
  }
  return [...stale].sort();
}
