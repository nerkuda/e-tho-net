/**
 * Сторож баннера рекомендованной версии клиента (элемент ed068706, компонент
 * 06d88619, задача b57910b5; усилен по замечанию приёмки — задача 61cec451).
 *
 * Правило: напоминание о рекомендованной версии клиента — РОВНО один модуль
 * `lib/update-banner.ts`. Рядом с ним второй баннер легко заводится «по месту»
 * (экран, статус-бар, тост), и тогда состояние `recommended-update` начнёт
 * показываться дважды и разными словами. Проверяются четыре инварианта:
 *
 * 1. **Разметка баннера — только в модуле.** Классы `.update-banner*` в
 *    исходниках рендерера объявляет/использует только `lib/update-banner.ts`
 *    (вид — `styles/layout.css`); импорт модуля разрешён.
 * 2. **Состояние `banner` читает только модуль.** Поле `banner` вердикта
 *    совместимости (сущность 89aad200) — проекция ровно для баннера; другие
 *    модули обязаны смотреть на `status`/`blocking`, иначе появятся самодельные
 *    напоминания. Приёмы чтения и их защита:
 *
 *    | Приём | Ловится |
 *    |---|---|
 *    | `result.banner`, `result?.banner` | правило свойства |
 *    | `result['banner']` | правило свойства (скобочный доступ) |
 *    | `const { banner } = result` | правило деструктуризации |
 *    | `const { status, banner } = result` | правило деструктуризации |
 *    | `const { banner: b } = result` | правило деструктуризации |
 *    | `({ banner } = result)` | правило деструктуризации |
 *    | `function f({ banner })`, `({ banner }) => …` | правило деструктуризации |
 *    | `const key = 'banner'; result[key]` | НЕ ловится — динамический ключ; сторож держит формы прямого чтения |
 *
 * 3. **Без тоста.** Баннер не использует `notice()`/тост: тот автозакрывается
 *    и не содержит действий (границы компонента 06d88619).
 * 4. **Страница релиза — только у баннера и блокирующего диалога.** Поле
 *    `downloadUrl` в рендерере читают только эти две точки: остальные ветки
 *    обновления клиента переехали в ТП обновления сервера 2d9f5cc7 (ТП
 *    52b33158 п. К6).
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

/** Модуль — единственный владелец баннера. */
const BANNER_MODULE = 'lib/update-banner.ts';

/** Комментарий (строчный, блочный или JSDoc) — не разметка. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Импорт самого модуля баннера — разрешённый способ им пользоваться. */
function isBannerImport(line: string): boolean {
  return /from\s+['"][^'"]*lib\/update-banner\.js['"]/.test(line);
}

/** Класс семьи `.update-banner*` (разметка или имя в строке). */
const UPDATE_BANNER_CLASS = /\bupdate-banner(-[a-z0-9-]+)?\b/;

/** Чтение поля `banner` свойством или скобочным доступом. */
const BANNER_PROPERTY_READ = /(?:\??\.\s*banner\b|\[\s*['"]banner['"]\s*\])/;

/**
 * Чтение `banner` деструктуризацией: объявление (`const { banner } = …`),
 * присваивание (`({ banner: b } = …)`) и параметр функции/стрелки
 * (`function f({ banner })`, `({ banner }) => …`).
 *
 * Объектный литерал-аргумент (`render({ banner: 'x' })`) под правило не
 * попадает: у параметров `}` отделён от `=>`/тела функции, а у литерала после
 * `)` идёт `;`/`,`/конец вызова. Аннотация типа (`const m: { banner: X } = …`)
 * тоже не попадает: перед `{` стоит `const m:`, а не `const`.
 */
const BANNER_DESTRUCTURE_READ =
  /(?:(?:const|let|var)\s*\{[^{}]*\bbanner\b[^{}]*\}\s*=|\(\s*\{[^{}]*\bbanner\b[^{}]*\}\s*=|\(\s*\{[^{}]*\bbanner\b[^{}]*\}\s*(?::[^)]*)?\)\s*(?:=>|\{|:))/;

/** Разрешено: сам модуль баннера и комментарии. */
function isBannerModuleOrComment(rel: string, line: string): boolean {
  return rel === BANNER_MODULE || isCommentLine(line);
}

const BANNER_READ_RULES: GuardRule[] = [
  {
    name: 'banner-projection-single-reader',
    description:
      'Поле `banner` вердикта совместимости (89aad200) — проекция для ' +
      'баннера: читает его только `lib/update-banner.ts`; остальным нужны ' +
      '`status`/`blocking`.',
    pattern: BANNER_PROPERTY_READ,
    allow: isBannerModuleOrComment,
  },
  {
    name: 'banner-projection-single-reader-destructure',
    description:
      'Поле `banner` нельзя читать и деструктуризацией: ' +
      '`const { banner } = result`, `({ banner } = result)`, ' +
      '`function f({ banner })` — это тот же обход единственной точки показа.',
    pattern: BANNER_DESTRUCTURE_READ,
    filePattern: BANNER_DESTRUCTURE_READ,
    allow: isBannerModuleOrComment,
  },
];

/** Временный каталог с файлами-фикстурами (в репозиторий не попадает). */
function makeBannerReaderFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-banner-guard-'));
  const write = (name: string, body: string): void => {
    fs.writeFileSync(path.join(dir, name), `${body}\n`, 'utf8');
  };
  // Нарушения — все формы чтения `banner` вне модуля баннера.
  write('property.ts', 'const value = result.banner;');
  write('optional.ts', 'const value = result?.banner;');
  write('bracket.ts', "const value = result['banner'];");
  write('destructure.ts', 'const { banner } = result;');
  write('destructure-alias.ts', 'const { banner: projection } = result;');
  write('destructure-mixed.ts', 'const { status, banner } = result;');
  write('assign.ts', '({ banner } = result);');
  write('param.ts', 'function render({ banner }: CompatibilityResult) { return banner; }');
  write('arrow.ts', 'const render = ({ banner }: CompatibilityResult) => banner;');
  write('multiline.ts', 'const {\n  status,\n  banner,\n} = result;\n');
  // Чистые формы: другие поля, создание объекта и аннотация типа — не чтение.
  write('other-field.ts', 'const value = result.status;');
  write('object-literal.ts', "render({ banner: 'hidden' });");
  write('type-annotation.ts', "const model: { banner: string } = { banner: 'hidden' };");
  return dir;
}

describe('guard: единственная точка баннера рекомендованной версии (b57910b5)', () => {
  it('классы баннера объявлены только в lib/update-banner.ts', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'update-banner-single-point',
        description:
          'Баннер рекомендованной версии — единственная точка показа ' +
          '(элемент ed068706): классы `.update-banner*` вне ' +
          '`lib/update-banner.ts` запрещены, иначе рядом появится второй баннер.',
        pattern: UPDATE_BANNER_CLASS,
        allow: (rel, line) =>
          rel === BANNER_MODULE || isCommentLine(line) || isBannerImport(line),
      },
    ]);
  });

  it('поле banner вердикта читает только модуль баннера', () => {
    assertGuardClean(RENDERER_ROOT, BANNER_READ_RULES);
  });

  it('сторож ловит деструктуризацию и скобочный доступ (fixture)', () => {
    const dir = makeBannerReaderFixture();
    const hits = collectViolations(dir, BANNER_READ_RULES);
    const flagged = new Set(hits.map((v) => v.file));

    for (const file of [
      'property.ts',
      'optional.ts',
      'bracket.ts',
      'destructure.ts',
      'destructure-alias.ts',
      'destructure-mixed.ts',
      'assign.ts',
      'param.ts',
      'arrow.ts',
      'multiline.ts',
    ]) {
      assert.ok(flagged.has(file), `ожидалось нарушение в ${file}`);
    }
    // Обход приёмки `const { banner } = result` — обязательно ловится.
    assert.ok(flagged.has('destructure.ts'), 'деструктуризация banner — нарушение');
    assert.ok(
      hits.some(
        (v) =>
          v.file === 'destructure.ts' &&
          v.rule === 'banner-projection-single-reader-destructure',
      ),
      'деструктуризацию ловит отдельное правило',
    );

    // Создание объекта и аннотация типа чтением не считаются.
    assert.ok(!flagged.has('other-field.ts'), 'другое поле вердикта читать можно');
    assert.ok(!flagged.has('object-literal.ts'), 'объектный литерал — не чтение banner');
    assert.ok(!flagged.has('type-annotation.ts'), 'аннотация типа — не чтение banner');
  });

  it('баннер не использует тосты', () => {
    assertGuardClean(
      RENDERER_ROOT,
      [
        {
          name: 'no-toast-in-update-banner',
          description:
            'Баннер не использует `notice()`/тост: тот автозакрывается и не ' +
            'содержит действий (границы компонента 06d88619).',
          pattern: /\b(?:notice|toast)\s*\(/,
          include: (rel) => rel === BANNER_MODULE,
          allow: (_rel, line) => isCommentLine(line),
        },
      ],
      { extensions: ['.ts'] },
    );
  });

  it('страницу релиза клиента открывают только баннер и блокирующий диалог', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'release-page-single-point',
        description:
          'Поле `downloadUrl` в рендерере читают только `lib/update-banner.ts` ' +
          '(«Обновить клиент» в баннере) и `lib/compatibility-dialog.ts` ' +
          '(блокирующий диалог 8623b9ff): остальное обновление клиента — ТП ' +
          '2d9f5cc7 (ТП 52b33158 п. К6).',
        pattern: /\bdownloadUrl\b/,
        allow: (rel, line) =>
          rel === BANNER_MODULE ||
          rel === 'lib/compatibility-dialog.ts' ||
          isCommentLine(line),
      },
    ]);
  });
});
