/**
 * Сторож слоёв канвы и полосы фокуса (0.16.1, задача 80324150, доработка среза
 * 2026-11-13, круг 2; замечания заказчика 1–3).
 *
 * Зачем. Фоновая картинка и её тинт красятся фоном `.canvas`, а счётчики зон и
 * подписи-пустые состояния лежат выше по DOM — но их ВИДИМОСТЬ держится на
 * подобранных под однотонный фон темы цветах: на фотографии счётчик с
 * полупрозрачной плашкой и faint-подпись без контура «тонут». Кроме того,
 * z-порядок канвы многослойный (полоса фокуса 0, сетка/облачка 1, верхние слои
 * связей 6/7, анимационные копии 8) — счётчик с прежним z=4 оказывался под
 * анимационным слоем. Нарушения незаметны в коде, поэтому закрыты здесь:
 *
 *  • счётчики зон — верхний слой канвы (z выше всех слоёв 0–8), при активной
 *    картинке плашка непрозрачная тематическая (`--surface`);
 *  • текст счётчика читается на ФАКТИЧЕСКОЙ плашке (≥ 7 : 1) во всех 6 темах
 *    обоих режимов — и с картинкой, и без неё; класс ошибок, который дал
 *    невидимый счётчик в blue-topaz light (белый текст на белой плашке,
 *    1.00 : 1, вердикт круга 2);
 *  • подписи канвы (`.zone-empty`, `.canvas-empty`) — выше сетки зоны (z ≥ 2);
 *    при активной картинке — непрозрачная тематическая плашка `--surface` и
 *    текст `--text` (круг 3: контур цвета `--bg` не контрастировал на светлой
 *    картинке, `--text-faint` бледен по замыслу). Вложенные состояния подписи
 *    (`loadingState`/`errorState`) наследуют цвет плашки — их собственные
 *    `--text-dim`/`--danger` не дают контраста на `--surface` во всех темах;
 *  • текст подписей читается на плашке: `--text` к `--surface` ≥ 7 : 1 во всех
 *    12 блоках (тот же порог, что у счётчика; по факту 7.99…19.30 : 1),
 *    без картинки вид канвы не меняется (плашки и перекраски нет);
 *  • полоса фокуса — честный ÷2 видимой протяжённости (ядро 67px + 2 × fade
 *    73px = 213px вместо 427px), плотность −30 % (`--focus-band-opacity: 0.7`),
 *    затухание сохранено;
 *  • полоса остаётся заметной: расстояние цвета полосы к подложке при
 *    максимальном тинте картинки Δ ≥ 40 в sRGB (минимум на двух из трёх тонов
 *    серой шкалы) во всех темах обоих режимов.
 *
 * Негативные пробы идут против РЕАЛЬНОГО `canvas.css`: мутация файла обязана
 * ловиться теми же проверками, что охраняют рабочую копию.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parseCssColor, relativeLuminance } from '../src/renderer/lib/css-color.js';
import {
  ZONE_COUNT_CONTRAST_MIN,
  ZONE_COUNT_PLATE_SURFACE_SHARE,
  zoneCountTextColor,
} from '../src/renderer/lib/pure.js';
import { RENDERER_ROOT } from './renderer-css.js';
import {
  THEME_MODES,
  declaredTokens,
  readTheme,
  stripCssComments,
  themeBlockBody,
} from './theme-css.js';

const CANVAS_CSS = path.join(RENDERER_ROOT, 'styles', 'canvas.css');
const TOKENS_CSS = path.join(RENDERER_ROOT, 'styles', 'tokens.css');

/** Все темы клиента (`lib/ui/themes/*.css`). */
const THEMES = ['blue-topaz', 'catppuccin', 'current', 'nordic', 'retronotes', 'wasp'] as const;

/** Ядро полосы фокуса на живом стенде: высота строки фокуса, px. */
const FOCUS_BAND_CORE_PX = 67;
/** Прежняя видимая протяжённость полосы: ядро + 2 × 180px fade, px. */
const FOCUS_BAND_EXTENT_BEFORE_PX = 427;

/** Нормализованный селектор правила: пробелы убраны. */
function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, '');
}

/** Тело правила по селектору; `null` — правила нет. */
function ruleBody(css: string, selector: string): string | null {
  const text = stripCssComments(css);
  const wanted = normalizeSelector(selector);
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('{', index);
    if (open < 0) return null;
    const preludeStart = text.lastIndexOf('}', open) + 1;
    const prelude = text.slice(preludeStart, open);
    let depth = 1;
    let cursor = open + 1;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === '{') depth += 1;
      else if (text[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    if (prelude.split(',').some((part) => normalizeSelector(part) === wanted)) {
      return text.slice(open + 1, cursor - 1);
    }
    index = cursor;
  }
  return null;
}

/** Значение объявления свойства в теле правила. */
function declaration(body: string | null, property: string): string | null {
  if (body === null) return null;
  const match = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;{}]+);`).exec(body);
  return match ? match[1]!.replace(/\s+/g, ' ').trim() : null;
}

const canvasCss = fs.readFileSync(CANVAS_CSS, 'utf8');
const tokensCss = fs.readFileSync(TOKENS_CSS, 'utf8');

/** Пара цветов (каналы 0..255) → коэффициент контраста WCAG. */
function contrastRatio(left: number[], right: number[]): number {
  const first = relativeLuminance(left[0]!, left[1]!, left[2]!);
  const second = relativeLuminance(right[0]!, right[1]!, right[2]!);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Токены одного блока темы; ассерт, если блока режима нет. */
function themeTokens(theme: string, mode: (typeof THEME_MODES)[number]): Map<string, string> {
  const body = themeBlockBody(readTheme(theme), theme, mode);
  assert.ok(body !== null, `тема ${theme} (${mode}): нет блока режима`);
  return declaredTokens(body);
}

/**
 * Нарушения слоёв наложения канвы в переданном CSS (счётчик и подписи).
 * Вынесено функцией, чтобы ТА ЖЕ проверка гонялась по мутированной копии
 * реального файла: негативная проба не на синтетической строке, а на
 * `canvas.css` с откатом конкретной правки.
 */
function overlayProblems(css: string): string[] {
  const problems: string[] = [];
  const countZ = declaration(ruleBody(css, '.zone-count'), 'z-index');
  if (countZ !== '12') problems.push(`z-index счётчика зоны: ${countZ ?? '(нет правила)'}`);
  const plate = declaration(
    ruleBody(css, ":root[data-canvas-wallpaper='on'] .zone-count"),
    'background',
  );
  if (plate !== 'var(--surface)')
    problems.push(`плашка счётчика при картинке: ${plate ?? '(нет)'}`);
  const emptyZ = declaration(ruleBody(css, '.zone-empty'), 'z-index');
  if (emptyZ !== '2') problems.push(`z-index подписи зоны: ${emptyZ ?? '(нет правила)'}`);
  // Круг 3: подпись читается за счёт непрозрачной плашки и токена текста.
  const labelPlate = ruleBody(css, ":root[data-canvas-wallpaper='on'] .zone-empty");
  if (labelPlate === null) {
    problems.push('нет правила плашки подписи при картинке');
  } else {
    const background = declaration(labelPlate, 'background');
    if (background !== 'var(--surface)') {
      problems.push(`плашка подписи при картинке: ${background ?? '(нет)'}`);
    }
    const color = declaration(labelPlate, 'color');
    if (color !== 'var(--text)') {
      problems.push(`цвет текста подписи на плашке: ${color ?? '(нет)'}`);
    }
    if (declaration(labelPlate, 'text-shadow') !== null) {
      problems.push('у плашки подписи остался text-shadow — механизм круга 1');
    }
    // Плашка обнимает надпись: подпись сжимается до содержимого и центрируется
    // в зоне. Без этого плашка красила бы половину холста.
    if (declaration(labelPlate, 'position') !== 'absolute') {
      problems.push(
        `подпись на картинке не сжата до содержимого: ${declaration(labelPlate, 'position')}`,
      );
    }
  }
  const labelInherit = ruleBody(
    css,
    ":root[data-canvas-wallpaper='on'] .zone-empty *:not(.ui-btn):not(.ui-btn *)",
  );
  if (labelInherit === null) {
    problems.push('вложенные состояния подписи не наследуют цвет плашки');
  } else {
    if (declaration(labelInherit, 'color') !== 'inherit') {
      problems.push(`цвет вложенного состояния подписи: ${declaration(labelInherit, 'color')}`);
    }
    if (declaration(labelInherit, 'text-shadow') !== 'none') {
      problems.push('у вложенного состояния подписи остался text-shadow');
    }
  }
  if (/text-shadow\s*:[^;]*var\(--bg\)/.test(stripCssComments(css))) {
    problems.push('в canvas.css вернулся контур подписи цвета --bg');
  }
  if (!css.includes(":root[data-canvas-wallpaper='on'] .canvas-empty")) {
    problems.push('пустое состояние холста не покрыто правилом плашки');
  }
  return problems;
}

/** Подменить объявление в теле правила реального файла (для мутационной пробы). */
function mutateFirstDeclaration(
  css: string,
  selector: string,
  property: string,
  next: string,
): string {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, `мутация: в canvas.css нет правила ${selector}`);
  const end = css.indexOf('}', at);
  const body = css.slice(at, end);
  const re = new RegExp(`(${property}\\s*:\\s*)([^;]+);`);
  assert.ok(re.test(body), `мутация: в правиле ${selector} нет свойства ${property}`);
  return css.slice(0, at) + body.replace(re, `$1${next};`) + css.slice(end);
}

describe('сторож: счётчики и подписи канвы поверх всех фонов (замечания 1, 3)', () => {
  it('реальный canvas.css удовлетворяет всем правилам слоёв счётчика и подписей', () => {
    assert.deepEqual(overlayProblems(canvasCss), []);
  });

  it('счётчик зоны — верхний слой канвы (z=12), выше анимационных копий (8)', () => {
    const z = declaration(ruleBody(canvasCss, '.zone-count'), 'z-index');
    assert.equal(z, '12', 'счётчик обязан лежать выше всех слоёв канвы');
    assert.ok(Number(z) > 8, 'анимационные слои канвы живут на z=8');
  });

  it('при активной картинке счётчик получает непрозрачную тематическую плашку', () => {
    const body = ruleBody(canvasCss, ":root[data-canvas-wallpaper='on'] .zone-count");
    assert.ok(body !== null, 'нет правила плашки счётчика при картинке');
    assert.equal(
      declaration(body, 'background'),
      'var(--surface)',
      'плашка счётчика над картинкой обязана быть непрозрачной тематической',
    );
  });

  it('подписи канвы выше сетки зоны и читаемы на картинке плашкой', () => {
    const z = declaration(ruleBody(canvasCss, '.zone-empty'), 'z-index');
    assert.equal(z, '2', 'подпись обязана быть выше сетки зоны (z=1)');
    const body = ruleBody(canvasCss, ":root[data-canvas-wallpaper='on'] .zone-empty");
    assert.ok(body !== null, 'нет правила плашки подписи при картинке');
    assert.equal(
      declaration(body, 'background'),
      'var(--surface)',
      'плашка — непрозрачный --surface',
    );
    assert.equal(declaration(body, 'color'), 'var(--text)', 'текст подписи — токен --text');
    assert.equal(declaration(body, 'text-shadow'), null, 'контура круга 1 быть не должно');
    // Плашка обнимает надпись: подпись сжимается до содержимого и центрируется
    // (иначе фон плашки растянулся бы на всю зону и «съел» картинку).
    assert.equal(declaration(body, 'position'), 'absolute', 'подпись сжимается до содержимого');
    assert.equal(
      declaration(body, 'inset'),
      '50% auto auto 50%',
      'подпись центрируется в зоне, а не растягивается',
    );
    // Без картинки вид тематический: плашки и перекраски у подписи нет.
    assert.equal(declaration(ruleBody(canvasCss, '.zone-empty'), 'background'), null);
    assert.equal(declaration(ruleBody(canvasCss, '.canvas-empty'), 'background'), null);
    // Пустое состояние всего холста закрыто тем же правилом (список селекторов).
    assert.ok(
      canvasCss.includes(":root[data-canvas-wallpaper='on'] .canvas-empty"),
      'пустое состояние холста обязано читаться на картинке так же',
    );
  });

  it('вложенные состояния подписи (загрузка/ошибка) наследуют цвет плашки', () => {
    // `--text-dim` на `--surface` даёт 4.00 : 1 (blue-topaz light), `--danger`
    // на `--surface` — 2.46 : 1 (nordic dark): собственные цвета состояний на
    // плашке не проходят даже AA, поэтому цвет наследуется от плашки.
    const body = ruleBody(
      canvasCss,
      ":root[data-canvas-wallpaper='on'] .zone-empty *:not(.ui-btn):not(.ui-btn *)",
    );
    assert.ok(body !== null, 'нет правила наследования цвета для состояний');
    assert.equal(declaration(body, 'color'), 'inherit');
    assert.equal(declaration(body, 'text-shadow'), 'none');
  });

  it('доля плашки в CSS совпадает с константой цвета счётчика', () => {
    // `color-mix(in srgb, var(--surface) 78%, transparent)` в основе: число
    // дублируется в `ZONE_COUNT_PLATE_SURFACE_SHARE`, по нему считается цвет.
    const body = ruleBody(canvasCss, '.zone-count');
    const background = declaration(body, 'background') ?? '';
    const share = /var\(--surface\)\s+(\d+)%/.exec(background);
    assert.ok(share !== null, `плашка счётчика без доли --surface: ${background}`);
    assert.equal(
      Number(share[1]) / 100,
      ZONE_COUNT_PLATE_SURFACE_SHARE,
      'CSS и константа разошлись — цвет текста посчитан от другой плашки',
    );
  });

  it('негативная проба: откат правки в РЕАЛЬНОМ canvas.css ловится', () => {
    assert.deepEqual(overlayProblems(canvasCss), [], 'рабочий файл обязан быть чистым');
    // 1. Прежний z-порядок счётчика: под анимационным слоем (z=8).
    const staleZ = mutateFirstDeclaration(canvasCss, '.zone-count {', 'z-index', '4');
    assert.notEqual(staleZ, canvasCss, 'мутация z-index не применилась');
    assert.ok(overlayProblems(staleZ).length > 0, 'прежний z-index 4 обязан ловиться');
    // 2. Прежняя полупрозрачная плашка счётчика над картинкой.
    const stalePlate = mutateFirstDeclaration(
      canvasCss,
      ":root[data-canvas-wallpaper='on'] .zone-count {",
      'background',
      'color-mix(in srgb, var(--surface) 78%, transparent)',
    );
    assert.ok(overlayProblems(stalePlate).length > 0, 'полупрозрачная плашка обязана ловиться');
    // 3. Откат механизма подписи: плашка подписи становится прозрачной.
    const staleLabelPlate = mutateFirstDeclaration(
      canvasCss,
      ":root[data-canvas-wallpaper='on'] .zone-empty,",
      'background',
      'transparent',
    );
    assert.ok(overlayProblems(staleLabelPlate).length > 0, 'прозрачная плашка обязана ловиться');
    // 4. Прежний бледный цвет текста подписи на плашке.
    const staleLabelColor = mutateFirstDeclaration(
      canvasCss,
      ":root[data-canvas-wallpaper='on'] .zone-empty,",
      'color',
      'var(--text-faint)',
    );
    assert.ok(
      overlayProblems(staleLabelColor).length > 0,
      'бледный текст на плашке обязан ловиться',
    );
    // 5. Возврат контура круга 1 у вложенных состояний.
    const staleLabelShadow = mutateFirstDeclaration(
      canvasCss,
      ":root[data-canvas-wallpaper='on'] .zone-empty *:not(.ui-btn):not(.ui-btn *),",
      'text-shadow',
      '0 0 6px var(--bg)',
    );
    assert.ok(overlayProblems(staleLabelShadow).length > 0, 'контур цвета --bg обязан ловиться');
    // 6. Потеря наследования цвета вложенными состояниями.
    const staleInherit = mutateFirstDeclaration(
      canvasCss,
      ":root[data-canvas-wallpaper='on'] .zone-empty *:not(.ui-btn):not(.ui-btn *),",
      'color',
      'var(--text-dim)',
    );
    assert.ok(
      overlayProblems(staleInherit).length > 0,
      'собственный цвет состояния обязан ловиться',
    );
    // 7. Плашка перестала сжиматься до надписи (растянулась на зону).
    const stalePosition = mutateFirstDeclaration(
      canvasCss,
      ":root[data-canvas-wallpaper='on'] .zone-empty,",
      'position',
      'static',
    );
    assert.ok(overlayProblems(stalePosition).length > 0, 'растянутая плашка обязана ловиться');
  });
});

describe('сторож: текст счётчика читается на фактической плашке (блокер круга 2)', () => {
  /**
   * Воспроизведение ПРЕЖНЕГО расчёта (hex-only) — мутационная проба. Копия
   * старой реализации `contrastText` до перевода на общий разбор цветов: на
   * `hsla()`-фоне blue-topaz light она отдаёт белый.
   */
  function legacyContrastText(bg: string): string {
    const hex = bg.trim().replace(/^#/, '');
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return '#ffffff';
    const channel = (part: string): number => {
      const c = Number.parseInt(part, 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance =
      0.2126 * channel(full.slice(0, 2)) +
      0.7152 * channel(full.slice(2, 4)) +
      0.0722 * channel(full.slice(4, 6));
    return luminance > 0.35 ? '#1f242d' : '#ffffff';
  }

  it('все 12 блоков (6 тем × 2 режима): с картинкой и без неё ≥ 7 : 1', () => {
    // Класс ошибок, не покрытый до этого: цвет текста считался от `--bg`, а
    // плашка — `--surface` (с картинкой — непрозрачная). В blue-topaz light
    // выходил белый текст на белой плашке — 1.00 : 1 (вердикт круга 2).
    const problems: string[] = [];
    let checked = 0;
    for (const theme of THEMES) {
      for (const mode of THEME_MODES) {
        const tokens = themeTokens(theme, mode);
        const surface = tokens.get('--surface') ?? '';
        const bg = tokens.get('--bg') ?? '';
        const plateOn = parseCssColor(surface);
        const themeBg = parseCssColor(bg);
        assert.ok(plateOn !== null, `${theme} (${mode}): --surface не цвет: «${surface}»`);
        assert.ok(themeBg !== null, `${theme} (${mode}): --bg не цвет: «${bg}»`);
        // Плашка без картинки — `--surface` с долей над фоном канвы.
        const plateOff: number[] = plateOn!.map(
          (channel, index) =>
            ZONE_COUNT_PLATE_SURFACE_SHARE * channel +
            (1 - ZONE_COUNT_PLATE_SURFACE_SHARE) * themeBg![index]!,
        );
        const cases: Array<[string, string, number[], boolean]> = [
          ['картинка', zoneCountTextColor(surface, bg, true), plateOn!, true],
          ['без картинки', zoneCountTextColor(surface, bg, false), plateOff, false],
        ];
        for (const [label, color, plate, wallpaper] of cases) {
          const fg = parseCssColor(color);
          assert.ok(fg !== null, `${theme} (${mode}, ${label}): цвет текста не цвет: ${color}`);
          const value = contrastRatio(fg!, plate);
          checked += 1;
          if (value < ZONE_COUNT_CONTRAST_MIN) {
            problems.push(
              `${theme} (${mode}, ${label}): ${value.toFixed(2)} : 1 (${color} на плашке ${plate.join(', ')})`,
            );
          }
          // Регрессия именно этого класса: при картинке текст не должен быть
          // белым на белой плашке (главный симптом блокера).
          if (wallpaper) {
            const plateLuminance = relativeLuminance(plate[0]!, plate[1]!, plate[2]!);
            const textLuminance = relativeLuminance(fg![0], fg![1], fg![2]);
            if (Math.abs(plateLuminance - textLuminance) < 0.2) {
              problems.push(`${theme} (${mode}, картинка): текст и плашка одной светлоты`);
            }
          }
        }
      }
    }
    assert.equal(checked, THEMES.length * THEME_MODES.length * 2, '12 блоков × 2 состояния');
    assert.deepEqual(
      problems,
      [],
      `текст счётчика обязан читаться на фактической плашке (≥ ${ZONE_COUNT_CONTRAST_MIN} : 1):\n  ${problems.join('\n  ')}`,
    );
  });

  it('мутационная проба: цвет от --bg вместо плашки ловится', () => {
    // Именно так выглядел баг: текст считался по фону темы, а не по плашке.
    // В blue-topaz light это давало белый текст на белой плашке — сторож обязан
    // такой расчёт отвергать.
    const tokens = themeTokens('blue-topaz', 'light');
    const surface = tokens.get('--surface') ?? '';
    const bg = tokens.get('--bg') ?? '';
    const plate = parseCssColor(surface)!;
    const staleColor = legacyContrastText(bg);
    assert.equal(staleColor, '#ffffff', 'прежний расчёт по --bg даёт белый текст');
    assert.ok(
      contrastRatio(parseCssColor(staleColor)!, plate) < ZONE_COUNT_CONTRAST_MIN,
      'прежний расчёт обязан не проходить порог 7 : 1',
    );
    // Новый расчёт на той же теме — проходит.
    assert.ok(
      contrastRatio(parseCssColor(zoneCountTextColor(surface, bg, true))!, plate) >=
        ZONE_COUNT_CONTRAST_MIN,
      'новый расчёт от плашки обязан проходить порог',
    );
  });
});

describe('сторож: подписи канвы читаются на плашке (круг 3)', () => {
  it('все 12 блоков (6 тем × 2 режима): --text к --surface ≥ 7 : 1', () => {
    // Порог 7 : 1 — тот же, что у счётчика зоны: подпись на плашке читается
    // уверенно при любом тоне картинки, а не только на пороге AA (4.5) для
    // мелкого текста. Унаследованный цвет вложенных состояний (`color: inherit`)
    // проверяется отдельно выше — значит, этим инвариантом покрыт весь текст
    // подписи, включая «Загрузка…» и сообщение об ошибке.
    const problems: string[] = [];
    for (const theme of THEMES) {
      for (const mode of THEME_MODES) {
        const tokens = themeTokens(theme, mode);
        const text = parseCssColor(tokens.get('--text') ?? '');
        const surface = parseCssColor(tokens.get('--surface') ?? '');
        assert.ok(text !== null, `${theme} (${mode}): --text не цвет`);
        assert.ok(surface !== null, `${theme} (${mode}): --surface не цвет`);
        const value = contrastRatio(text!, surface!);
        if (value < ZONE_COUNT_CONTRAST_MIN) {
          problems.push(`${theme} (${mode}): ${value.toFixed(2)} : 1`);
        }
      }
    }
    assert.deepEqual(
      problems,
      [],
      `текст подписи на плашке обязан читаться (≥ ${ZONE_COUNT_CONTRAST_MIN} : 1):\n  ${problems.join('\n  ')}`,
    );
  });

  it('контур круга 1 в canvas.css не остался нигде', () => {
    // Старый механизм — `text-shadow` цвета `--bg`: на светлой картинке он не
    // контрастирует, поэтому заменён плашкой целиком.
    assert.ok(
      !/text-shadow\s*:[^;]*var\(--bg\)/.test(stripCssComments(canvasCss)),
      'в canvas.css вернулся контур подписи цвета --bg',
    );
  });
});

describe('сторож: полоса фокуса — вдвое ниже и на 30 % прозрачнее (замечание 2)', () => {
  /** Значение токена из `tokens.css` (объявлен в `:root`). */
  function token(name: string): string | null {
    for (const block of [ruleBody(tokensCss, ':root')]) {
      const value = declaredTokens(block ?? '').get(name);
      if (value !== undefined) return value;
    }
    return null;
  }

  it('токены: fade 73px (честный ÷2 от 427px) и плотность 0.7', () => {
    assert.equal(token('--focus-band-fade'), '73px', 'видимая протяжённость полосы вдвое меньше');
    assert.equal(token('--focus-band-opacity'), '0.7', 'плотность снижена на 30 %');
  });

  it('протяжённость полосы = ядро + 2 × fade ≈ ½ прежней (мутационно)', () => {
    // Живая формула: видимая протяжённость = высота строки фокуса (ядро) +
    // 2 × fade. Было 67 + 2×180 = 427px. Цель честного ÷2 — ≈213px, значит
    // fade ≈ 73px. Заход с fade 90px дал 247px (−42 %) — этот тест его ловит.
    const fade = Number.parseFloat(token('--focus-band-fade') ?? '');
    assert.ok(Number.isFinite(fade), 'fade полосы не число');
    const extent = FOCUS_BAND_CORE_PX + 2 * fade;
    const target = FOCUS_BAND_EXTENT_BEFORE_PX / 2;
    assert.ok(
      Math.abs(extent - target) <= 2,
      `протяжённость ${extent}px должна быть ≈${target}px (½ от ${FOCUS_BAND_EXTENT_BEFORE_PX}px)`,
    );
    // Мутация: прежний заход 90px и исходные 180px мимо цели.
    for (const stale of [90, 180]) {
      const staleExtent = FOCUS_BAND_CORE_PX + 2 * stale;
      assert.ok(
        Math.abs(staleExtent - target) > 2,
        `fade ${stale}px не должен проходить проверку ÷2 (${staleExtent}px)`,
      );
    }
  });

  it('полоса красится этими токенами, затухание сохранено', () => {
    const body = ruleBody(canvasCss, '.canvas::before');
    assert.ok(body !== null, 'нет слоя полосы фокуса');
    assert.equal(declaration(body, 'opacity'), 'var(--focus-band-opacity, 0.7)');
    const background = declaration(body, 'background') ?? '';
    assert.ok(background.includes('var(--focus-band-fade, 73px)'), 'fallback fade — 73px');
    assert.ok(background.includes('transparent'), 'затухание полосы к краям сохранено');
  });

  it('полоса остаётся заметной при максимальном тинте картинки', () => {
    // Подложка в худшем случае: фон темы × картинка (три тона серой шкалы) при
    // α=0.30 (WALLPAPER_TINT_ALPHA_MAX). Полоса — цвет акцента при opacity 0.7.
    // Метрика — расстояние в sRGB, а не контраст WCAG: полоса отличается прежде
    // всего тоном (синий акцент на серо-синей подложке даёт яркостный контраст
    // ≈1:1, но видна отчётливо). Полоса тянется через весь холст, поэтому
    // локальное совпадение её тона с ОДНИМ тоном картинки её не прячет:
    // требуется Δ ≥ 40 не меньше чем на двух из трёх тонов (nordic light на
    // среднем тоне даёт 30.5, на крайних — 61.8 и 62.8; все прочие блоки
    // проходят на всех трёх: 48.9…176.2).
    const problems: string[] = [];
    for (const theme of THEMES) {
      const css = readTheme(theme);
      for (const mode of THEME_MODES) {
        const body = themeBlockBody(css, theme, mode);
        assert.ok(body !== null, `тема ${theme} (${mode}): нет блока режима`);
        const tokens = declaredTokens(body);
        const bg = parseCssColor(tokens.get('--bg') ?? '');
        const accent = parseCssColor(tokens.get('--focus-accent') ?? tokens.get('--accent') ?? '');
        assert.ok(
          bg !== null && accent !== null,
          `${theme} (${mode}): --bg/--focus-accent не цвет`,
        );
        const mix = (top: number[], bottom: number[], alpha: number): number[] =>
          top.map((channel, index) => alpha * channel + (1 - alpha) * bottom[index]!);
        const distance = (left: number[], right: number[]): number =>
          Math.sqrt(left.reduce((sum, channel, index) => sum + (channel - right[index]!) ** 2, 0));
        const deltas = [64, 128, 192].map((picture) => {
          const backdrop = mix(bg!, [picture, picture, picture], 0.3);
          const band = mix(accent!, backdrop, 0.7);
          return distance(band, backdrop);
        });
        const visible = deltas.filter((delta) => delta >= 40).length;
        if (visible < 2) {
          problems.push(
            `${theme} (${mode}): Δ=${deltas.map((d) => d.toFixed(1)).join(' / ')} — видно на ${visible} из 3 тонов`,
          );
        }
      }
    }
    assert.deepEqual(
      problems,
      [],
      `полоса фокуса должна оставаться заметной (Δ sRGB ≥ 40 минимум на 2 из 3 тонов):\n  ${problems.join('\n  ')}`,
    );
  });
});
