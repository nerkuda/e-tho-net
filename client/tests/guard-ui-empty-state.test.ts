/**
 * Сторож осмысленных пустых состояний списков, таблиц и панелей (задача
 * d7b7c367, требование e514768f «Пустые состояния списков, таблиц и панелей
 * объясняют, что делать», инвентаризация 3fc7c54d, стандарт «Правило без
 * теста-сторожа не считается введённым»).
 *
 * Правило: состояние «данных нет / грузятся / ошибка» собирает единый
 * компонент `lib/ui/empty-state.ts` (`emptyState`/`loadingState`/`errorState`),
 * тексты берутся из словаря. Собственные `muted`-заглушки «Загрузка…»,
 * литеральные «Пусто»/«Нет данных» и литеральный текст пустого состояния в
 * переведённых местах запрещены.
 *
 * Проверяется три запрета и два инварианта:
 *   1. литерал «Загрузка…» вне словаря и общего компонента — запрещён (текст
 *      грузится через `loadingState()` / `t('common.loading')`);
 *   2. литеральные «Пусто»/«Нет данных»/«Ничего нет» — запрещены;
 *   3. в переведённых местах `emptyText`/`emptyHint` — только из словаря
 *      (`t('…')`), не литералом;
 *   4. списочные фасады (`table`/`tree`/`chip-list`) умеют пустое состояние с
 *      подсказкой (`emptyHint`) и рисуют его общим компонентом;
 *   5. таблица умеет менять пустое состояние (`setEmpty`) — текст зависит от
 *      фильтра.
 *
 * **Обоснованные края (allow).** Загрузочный литерал разрешён в словаре
 * (`lib/locales/ru.ts` — сам текст строки) и в легаси-файлах, ещё не
 * переведённых на общий компонент (список `LEGACY`, вне объёма задачи
 * d7b7c367). Это долг, а не образец: при переводе файла запись снимается.
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

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');
const UI_ROOT = path.join(RENDERER_ROOT, 'lib', 'ui');

/** Словарь строк — единственное место, где живёт текст «Загрузка…». */
const LOCALE = 'lib/locales/ru.ts';

/** Переведённые места: текст состояния — только из словаря. */
const TRANSLATED: ReadonlySet<string> = new Set([
  'lib/property-list.ts',
  'lib/saved-filter-bar.ts',
  'lib/entity-picker.ts',
  'lib/users.ts',
  'lib/filter-form.ts',
  'trash.ts',
  'admin/admin.ts',
  'screens/activity/activity.ts',
  'screens/chronicle/chronicle.ts',
  'screens/property-manager.ts',
  'screens/type-manager.ts',
]);

/** Легаси: собственные заглушки до перевода (вне объёма d7b7c367). */
const LEGACY: ReadonlySet<string> = new Set([
  'editor/chrono-tab.ts',
  'editor/attachments.ts',
  'editor/links-tab.ts',
  'editor/properties.ts',
  'screens/layers.ts',
  'screens/settings-logs.ts',
  'selection/dialogs.ts',
  'selection/selection.ts',
]);

/** Строка — комментарий? (примеры в пояснениях допустимы). */
function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Переведённое место: `lib/ui/**` или явный список. */
function isTranslated(rel: string): boolean {
  return rel.startsWith('lib/ui/') || TRANSLATED.has(rel);
}

function rules(): GuardRule[] {
  return [
    {
      name: 'no-loading-literal',
      description:
        'Литерал «Загрузка…» вне словаря запрещён: состояние грузится общим ' +
        'компонентом `loadingState()` (lib/ui/empty-state.ts), текст — ' +
        "`t('common.loading')`.",
      pattern: /['"`][^'"`\n]*Загрузка…[^'"`\n]*['"`]/,
      allow: (rel, line) => isComment(line) || rel === LOCALE || LEGACY.has(rel),
    },
    {
      name: 'no-bare-empty-literal',
      description:
        'Литеральные «Пусто»/«Нет данных»/«Ничего нет» запрещены: пустое ' +
        'состояние объясняет, что здесь появится и что сделать (emptyState).',
      pattern: /['"`](?:Пусто|Нет данных|Ничего нет)['"`]/,
      allow: (rel, line) => isComment(line) || rel === LOCALE,
    },
    {
      name: 'no-literal-empty-text',
      description:
        'В переведённых местах текст пустого состояния (`emptyText`/`emptyHint`) ' +
        "— только из словаря через `t('…')`, не литералом.",
      pattern: /(?:emptyText|emptyHint)\s*[:=]\s*['"`][^'"`\n]*[А-Яа-яЁё]/,
      include: isTranslated,
      allow: (_rel, line) => isComment(line),
    },
  ];
}

/** Читает исходник модуля словаря `lib/ui`. */
function readUi(file: string): string {
  return fs.readFileSync(path.join(UI_ROOT, file), 'utf8');
}

describe('guard: осмысленные пустые состояния (d7b7c367, e514768f)', () => {
  it('нет литеральных заглушек «Загрузка…»/«Пусто» и литерального текста состояния', () => {
    assertGuardClean(RENDERER_ROOT, rules());
  });

  it('списочные фасады рисуют пустое состояние общим компонентом и умеют подсказку', () => {
    const missing: string[] = [];
    for (const file of ['table.ts', 'tree.ts', 'chip-list.ts']) {
      const src = readUi(file);
      if (!src.includes("from './empty-state.js'") || !src.includes('emptyState(')) {
        missing.push(`${file} — не использует lib/ui/empty-state.ts`);
      }
      if (!src.includes('emptyHint')) missing.push(`${file} — нет опции подсказки emptyHint`);
    }
    assert.deepEqual(missing, [], `Пустое состояние списочных фасадов:\n  • ${missing.join('\n  • ')}`);
  });

  it('таблица умеет менять пустое состояние (текст зависит от фильтра)', () => {
    const src = readUi('table.ts');
    assert.ok(
      src.includes('setEmpty('),
      'TableHandle.setEmpty отсутствует — список с поиском не может сменить текст состояния',
    );
  });

  it('общий компонент состояний и его реэкспорт на месте', () => {
    const module = readUi('empty-state.ts');
    for (const name of ['export function emptyState', 'export function loadingState', 'export function errorState']) {
      assert.ok(module.includes(name), `lib/ui/empty-state.ts не экспортирует ${name}`);
    }
    const index = readUi('index.ts');
    assert.ok(
      /['"]\.\/empty-state\.js['"]/.test(index),
      'lib/ui/index.ts не реэкспортирует empty-state (barrel-дисциплина ADR 03eb2c61)',
    );
  });

  it('правило «нет литеральных заглушек» краснеет на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-empty-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'screen.ts'),
        "const a = el('span', 'muted', 'Загрузка…');\nconst b = 'Пусто';\n",
        'utf8',
      );
      const violations = collectViolations(dir, rules(), { extensions: ['.ts'] });
      assert.ok(
        violations.some((v) => v.rule === 'no-loading-literal'),
        'loading-литерал обязан распознаваться',
      );
      assert.ok(
        violations.some((v) => v.rule === 'no-bare-empty-literal'),
        'голое «Пусто» обязано распознаваться',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
