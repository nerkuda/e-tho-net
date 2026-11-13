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
 *    при активной картинке — полупрозрачная тематическая плашка (85 %
 *    `--surface`) и приглушённый текст (92 % `--text`): круг 3 давал
 *    непрозрачную плашку и полный `--text`, и подпись читалась «полноценным
 *    участником карты». Вложенные состояния подписи
 *    (`loadingState`/`errorState`) наследуют цвет плашки — их собственные
 *    `--text-dim`/`--danger` не дают контраста на плашке во всех темах;
 *  • текст подписи читается на КОМПОЗИТЕ её подложки: плашка над картинкой
 *    средней светлоты 0…1, текст — 92 % `--text` поверх этой плашки, ≥ 4.5 : 1
 *    (порог AA для мелкого текста) во всех 12 блоках тем; худший случай
 *    4.77 : 1 (catppuccin light над чёрной картинкой). Без картинки вид канвы
 *    не меняется (плашки и перекраски нет);
 *  • счётчики зон перекрашиваются при смене темы/режима/слоя НЕМЕДЛЕННО
 *    (ошибка f245c5ac): inline-цвет пересчитывается точечно из живых токенов
 *    (`--surface` + фактический фон — `--layer-bg` слоя либо `--bg` темы), без
 *    полного рендера канвы;
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
import { before, describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

import { parseCssColor, relativeLuminance } from '../src/renderer/lib/css-color.js';
import {
  ZONE_COUNT_CONTRAST_MIN,
  ZONE_COUNT_PLATE_SURFACE_SHARE,
  zoneCountTextColor,
} from '../src/renderer/lib/pure.js';
import { store } from '../src/renderer/state.js';
import { ShimElement } from './dom-shim.js';
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

/**
 * Порог читаемости подписи на КОМПОЗИТЕ её подложки: WCAG AA для мелкого
 * текста. Счётчик зоны держит более строгие 7 : 1 (он — часть карты), подпись
 * по решению заказчика — «информатор», ей достаточно AA.
 */
const LABEL_CONTRAST_MIN = 4.5;

/** Доля `--surface` в подложке подписи при картинке (круг 4, «тихая» плашка). */
const LABEL_PLATE_SURFACE_PERCENT = 85;
/** Доля `--text` в цвете подписи: текст приглушён, но читаем на композите. */
const LABEL_TEXT_PERCENT = 92;

/** Ожидаемые объявления подписи при картинке — те же числа, что в CSS. */
const LABEL_PLATE_BACKGROUND = `color-mix(in srgb, var(--surface) ${LABEL_PLATE_SURFACE_PERCENT}%, transparent)`;
const LABEL_TEXT_COLOR = `color-mix(in srgb, var(--text) ${LABEL_TEXT_PERCENT}%, transparent)`;

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

/** Смешение каналов в sRGB: `share` — доля верхнего цвета (альфа-композиция). */
function blendChannels(top: number[], under: number[], share: number): number[] {
  return [0, 1, 2].map((index) => share * top[index]! + (1 - share) * under[index]!);
}

/** Относительная яркость WCAG → нейтральный серый sRGB (0..255). */
function grayForLuminance(luminance: number): number[] {
  const channel =
    luminance <= 0.0031308 ? luminance * 12.92 : 1.055 * luminance ** (1 / 2.4) - 0.055;
  const value = Math.round(Math.max(0, Math.min(1, channel)) * 255);
  return [value, value, value];
}

/** Средние светлоты картинки, на которых проверяется подпись (0…1 шагом 0.05). */
const LABEL_BACKDROP_LUMINANCES = Array.from({ length: 21 }, (_, index) => index / 20);

/**
 * Нарушения читаемости подписи на КОМПОЗИТЕ её подложки: плашка (доля из CSS)
 * над картинкой средней светлоты, текст (доля из CSS) поверх этой плашки.
 * Средняя светлота перебирается по всей шкале 0…1 — инвариант держится при
 * любой картинке, а не только на «удачной»; худший край — чёрная/белая.
 */
function labelCompositeProblems(css: string): string[] {
  const body = ruleBody(css, ":root[data-canvas-wallpaper='on'] .zone-empty");
  if (body === null) return ['нет правила подписи при картинке'];
  const background = declaration(body, 'background') ?? '';
  const plateMatch = /var\(--surface\)\s+([\d.]+)%/.exec(background);
  if (plateMatch === null) {
    return [
      `подложка подписи не color-mix с --surface: ${background === '' ? '(нет)' : background}`,
    ];
  }
  const color = declaration(body, 'color') ?? '';
  const textMatch = /var\(--text\)\s+([\d.]+)%/.exec(color);
  if (textMatch === null) {
    return [`текст подписи не color-mix с --text: ${color === '' ? '(нет)' : color}`];
  }
  const plateShare = Number(plateMatch[1]) / 100;
  const textShare = Number(textMatch[1]) / 100;
  const problems: string[] = [];
  for (const theme of THEMES) {
    for (const mode of THEME_MODES) {
      const tokens = themeTokens(theme, mode);
      const surface = parseCssColor(tokens.get('--surface') ?? '');
      const text = parseCssColor(tokens.get('--text') ?? '');
      assert.ok(surface !== null, `${theme} (${mode}): --surface не цвет`);
      assert.ok(text !== null, `${theme} (${mode}): --text не цвет`);
      for (const luminance of LABEL_BACKDROP_LUMINANCES) {
        const plate = blendChannels(surface!, grayForLuminance(luminance), plateShare);
        const foreground = blendChannels(text!, plate, textShare);
        const value = contrastRatio(foreground, plate);
        if (value < LABEL_CONTRAST_MIN) {
          problems.push(`${theme} (${mode}, светлота ${luminance}): ${value.toFixed(2)} : 1`);
        }
      }
    }
  }
  return problems;
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
  // Круг 3/4: подпись читается за счёт полупрозрачной плашки и приглушённого
  // текста; оба числа — предмет инварианта читаемости ниже.
  const labelPlate = ruleBody(css, ":root[data-canvas-wallpaper='on'] .zone-empty");
  if (labelPlate === null) {
    problems.push('нет правила плашки подписи при картинке');
  } else {
    const background = declaration(labelPlate, 'background');
    if (background !== LABEL_PLATE_BACKGROUND) {
      problems.push(`плашка подписи при картинке: ${background ?? '(нет)'}`);
    }
    const color = declaration(labelPlate, 'color');
    if (color !== LABEL_TEXT_COLOR) {
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

  it('подписи канвы выше сетки зоны и читаемы на картинке «тихой» плашкой', () => {
    const z = declaration(ruleBody(canvasCss, '.zone-empty'), 'z-index');
    assert.equal(z, '2', 'подпись обязана быть выше сетки зоны (z=1)');
    const body = ruleBody(canvasCss, ":root[data-canvas-wallpaper='on'] .zone-empty");
    assert.ok(body !== null, 'нет правила плашки подписи при картинке');
    assert.equal(
      declaration(body, 'background'),
      LABEL_PLATE_BACKGROUND,
      'подложка подписи — 85 % --surface (информатор, а не элемент карты)',
    );
    assert.equal(
      declaration(body, 'color'),
      LABEL_TEXT_COLOR,
      'текст подписи приглушён — 92 % --text',
    );
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

describe('сторож: подписи канвы — «информатор» на композите подложки (круг 4)', () => {
  it('доли подложки и текста — 85 % / 92 %, как в инварианте', () => {
    // Числа не «на глаз»: пара 80 %/88 % из брифа давала 3.96 : 1 (ниже AA) на
    // чёрной картинке в catppuccin light, пара 85 %/92 % — 4.77 : 1.
    const body = ruleBody(canvasCss, ":root[data-canvas-wallpaper='on'] .zone-empty");
    assert.ok(body !== null, 'нет правила подписи при картинке');
    assert.equal(declaration(body, 'background'), LABEL_PLATE_BACKGROUND);
    assert.equal(declaration(body, 'color'), LABEL_TEXT_COLOR);
  });

  it('все 12 блоков: текст на композите подложки ≥ 4.5 : 1 при любой светлоте картинки', () => {
    // Унаследованный цвет вложенных состояний (`color: inherit`) проверяется
    // отдельно выше — значит, инвариантом покрыт весь текст подписи, включая
    // «Загрузка…» и сообщение об ошибке. Худший случай — catppuccin light над
    // чёрной картинкой (4.77 : 1).
    const problems = labelCompositeProblems(canvasCss);
    assert.deepEqual(
      problems,
      [],
      `текст подписи обязан читаться на композите подложки (≥ ${LABEL_CONTRAST_MIN} : 1):\n  ${problems.join('\n  ')}`,
    );
  });

  it('мутации: непрозрачная плашка, полный текст и отклонённые 80 %/88 % ловятся', () => {
    assert.deepEqual(labelCompositeProblems(canvasCss), [], 'рабочий файл обязан быть чистым');
    // 1. Возврат непрозрачной плашки круга 3 — «громкая» подпись.
    const opaquePlate = mutateFirstDeclaration(
      canvasCss,
      ":root[data-canvas-wallpaper='on'] .zone-empty,",
      'background',
      'var(--surface)',
    );
    assert.ok(
      labelCompositeProblems(opaquePlate).length > 0,
      'непрозрачная плашка обязана ловиться',
    );
    // 2. Полный `--text` без приглушения.
    const fullText = mutateFirstDeclaration(
      canvasCss,
      ":root[data-canvas-wallpaper='on'] .zone-empty,",
      'color',
      'var(--text)',
    );
    assert.ok(labelCompositeProblems(fullText).length > 0, 'полный --text обязан ловиться');
    // 3. Отклонённая пара брифа 80 %/88 % (3.96 : 1 на худшем фоне).
    const quietPlate = mutateFirstDeclaration(
      canvasCss,
      ":root[data-canvas-wallpaper='on'] .zone-empty,",
      'background',
      'color-mix(in srgb, var(--surface) 80%, transparent)',
    );
    const quietBoth = mutateFirstDeclaration(
      quietPlate,
      ":root[data-canvas-wallpaper='on'] .zone-empty,",
      'color',
      'color-mix(in srgb, var(--text) 88%, transparent)',
    );
    assert.ok(labelCompositeProblems(quietBoth).length > 0, 'пара 80 %/88 % обязана ловиться');
    // 4. `--text-dim` вместо приглушённого текста (не проходит AA на плашке).
    const dimText = mutateFirstDeclaration(
      canvasCss,
      ":root[data-canvas-wallpaper='on'] .zone-empty,",
      'color',
      'var(--text-dim)',
    );
    assert.ok(labelCompositeProblems(dimText).length > 0, '--text-dim обязан ловиться');
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

/**
 * Живая проба перекраски счётчиков (ошибка f245c5ac): монтируется НАСТОЯЩИЙ
 * `mountCanvas` в DOM-ши́ме, затем тема/режим переключаются как в продукте
 * (`applyUiTheme` → атрибуты корня + тик store), без рендера и ресайза.
 * Сверяется, что inline-цвет ВСЕХ `.zone-count` совпадает с расчётным от
 * живых токенов и читается (≥ 7 : 1). Дефект «фон перекрасился, текст нет»
 * проходит именно потому, что раньше цвет считался только в `updateFocusBand`.
 */
describe('сторож: смена режима перекрашивает текст счётчиков (ошибка f245c5ac)', () => {
  type CanvasModule = typeof import('../src/renderer/canvas/canvas.js');
  type ThemeModule = typeof import('../src/renderer/lib/theme.js');

  const NETWORK_ID = '00000000-0000-4000-8000-000000000001';
  const FOCUS_ID = '00000000-0000-4000-8000-000000000100';

  let canvas: CanvasModule;
  let themeLib: ThemeModule;
  let mountHost: ShimElement | null = null;

  function thought(id: string, title: string): Record<string, unknown> {
    return {
      id,
      title,
      type_id: null,
      icon: null,
      icon_kind: 'emoji',
      icon_attachment_id: null,
      active: true,
      is_protected: false,
      is_root: false,
      marked_for_deletion: false,
      marked_for_deletion_at: null,
      marked_for_deletion_by: null,
      fg_color: null,
      bg_color: null,
      font_bold: null,
      font_italic: null,
      font_underline: null,
      font_strike: null,
      synonyms: [],
      version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
  }

  function focusResponse(): Record<string, unknown> {
    return {
      focused: thought(FOCUS_ID, 'Фокус'),
      parents: [],
      siblings: [],
      children: [],
      edges: [],
      sorts: {
        parents: { sort: 'created', order: 'asc' },
        children: { sort: 'created', order: 'asc' },
        siblings: { sort: 'created', order: 'asc' },
      },
    };
  }

  function installEtn(): void {
    const api = {
      ui: { getState: async () => null, setState: async () => undefined },
      thoughts: {
        focus: async () => focusResponse(),
        get: async () => ({ meta: { views: [] } }),
        resolve: async () => [],
      },
      thoughtTypeViews: { list: async () => ({ data: [], meta: { effective: [] } }) },
      comments: { list: async () => [] },
      attachments: { list: async () => [] },
      propertyRegistry: { list: async () => [] },
      structures: { edges: async () => [] },
    };
    (globalThis as any).etn = api;
    const w = (globalThis as any).window as { etn?: unknown } | undefined;
    if (w !== undefined) w.etn = api;
  }

  function installGlobals(): void {
    Object.defineProperty(ShimElement.prototype, 'offsetHeight', {
      get: () => 20,
      configurable: true,
    });
    (globalThis as any).CSS = { escape: (value: string) => value };
    const documentElement = new ShimElement('html');
    (globalThis as any).document = {
      createElement: (tag: string) => new ShimElement(tag),
      createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
      documentElement,
      body: new ShimElement('body'),
      querySelector: (selector: string) => (selector === '.canvas-host' ? mountHost : null),
      querySelectorAll: () => [] as ShimElement[],
      elementFromPoint: () => null,
      activeElement: null,
    };
    const raf = (callback: (time: number) => void): ReturnType<typeof setTimeout> =>
      setTimeout(() => callback(Date.now()), 0);
    (globalThis as any).requestAnimationFrame = raf;
    (globalThis as any).getComputedStyle = (element: { style: unknown }) => element.style;
    (globalThis as any).window = {
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getComputedStyle: (element: { style: unknown }) => element.style,
      matchMedia: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      requestAnimationFrame: raf,
      setTimeout: (callback: (...args: unknown[]) => void, ms?: number) => setTimeout(callback, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    };
    (globalThis as any).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }

  async function settle(times = 25): Promise<void> {
    for (let index = 0; index < times; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  function sizeDom(element: ShimElement): void {
    const sized = element as unknown as {
      clientWidth: number;
      clientHeight: number;
      scrollHeight: number;
    };
    sized.clientWidth = 800;
    sized.clientHeight = 600;
    sized.scrollHeight = 2000;
    for (const child of element.children) sizeDom(child);
  }

  /** Пишет в корень документа токены блока темы — так же, как их дал бы CSS. */
  function setThemeTokens(theme: string, mode: (typeof THEME_MODES)[number]): void {
    const tokens = themeTokens(theme, mode);
    const style = (globalThis as any).document.documentElement.style as {
      setProperty(name: string, value: string): void;
      removeProperty(name: string): void;
    };
    for (const name of ['--surface', '--bg', '--text']) {
      style.setProperty(name, tokens.get(name) ?? '');
    }
    style.removeProperty('--layer-bg');
  }

  /** Дополнительные токены поверх темы (граничные пары для проб). */
  function setRootTokens(values: Record<string, string>): void {
    const style = (globalThis as any).document.documentElement.style as {
      setProperty(name: string, value: string): void;
    };
    for (const [name, value] of Object.entries(values)) style.setProperty(name, value);
  }

  function counters(): ShimElement[] {
    return mountHost === null ? [] : mountHost.querySelectorAll('.zone-count');
  }

  /**
   * Нарушения «внешнего вида» счётчиков: inline-цвет каждого равен расчётному от
   * живых токенов (и, если `checkContrast`, читается на фактической плашке).
   * Вынесено функцией, чтобы негативная проба гоняла ТУ ЖЕ проверку.
   */
  function counterColorProblems(checkContrast = true): string[] {
    if (mountHost === null) return ['холст не смонтирован'];
    const elements = counters();
    if (elements.length === 0) return ['на холсте нет счётчиков зон'];
    const doc = (globalThis as any).document;
    const rootStyle = (globalThis as any).getComputedStyle(doc.documentElement);
    const surfaceText = String(rootStyle.getPropertyValue('--surface') ?? '');
    const layerBg = String(rootStyle.getPropertyValue('--layer-bg') ?? '').trim();
    const bgText = layerBg !== '' ? layerBg : String(rootStyle.getPropertyValue('--bg') ?? '');
    const wallpaper = doc.documentElement.getAttribute('data-canvas-wallpaper') === 'on';
    const surface = parseCssColor(surfaceText);
    const background = parseCssColor(bgText);
    if (surface === null || background === null) {
      return [`токены не читаются: --surface «${surfaceText}», фон «${bgText}»`];
    }
    const plate = wallpaper
      ? surface
      : blendChannels(surface, background, ZONE_COUNT_PLATE_SURFACE_SHARE);
    const expected = zoneCountTextColor(surfaceText, bgText, wallpaper);
    const problems: string[] = [];
    for (const element of elements) {
      const color = String(element.style.color ?? '');
      if (color !== expected) {
        problems.push(`inline-цвет счётчика «${color || '(нет)'}» ≠ расчётному «${expected}»`);
      }
      const foreground = parseCssColor(color);
      if (foreground === null) {
        problems.push(`inline-цвет счётчика не разбирается: «${color}»`);
        continue;
      }
      const value = contrastRatio(foreground, plate);
      if (checkContrast && value < ZONE_COUNT_CONTRAST_MIN) {
        problems.push(`контраст счётчика ${value.toFixed(2)} : 1`);
      }
    }
    return problems;
  }

  async function mount(
    themeName: string,
    mode: (typeof THEME_MODES)[number],
    tokens?: Record<string, string>,
  ): Promise<() => void> {
    setThemeTokens(themeName, mode);
    if (tokens !== undefined) setRootTokens(tokens);
    installEtn();
    themeLib.applyUiTheme({ theme: themeName as never, mode });
    store.update({
      networkId: NETWORK_ID,
      focus: null,
      editorTarget: null,
      selectedLinkId: null,
      activeView: 'map',
      canvasZoom: 1,
      cloudWidth: 180,
      currentLayer: null,
      layers: [],
    });
    mountHost = new ShimElement('section', 'canvas-host');
    const dispose = canvas.mountCanvas(mountHost as unknown as HTMLElement);
    sizeDom(mountHost);
    store.update({ focus: focusResponse() as never });
    await settle();
    return dispose;
  }

  before(async () => {
    installGlobals();
    installEtn();
    canvas = await import('../src/renderer/canvas/canvas.js');
    themeLib = await import('../src/renderer/lib/theme.js');
  });

  it('светлый → тёмный → светлый: цифры перекрашены и читаемы без рендера', async () => {
    const dispose = await mount('current', 'light');
    const lightColors = counters().map((element) => String(element.style.color));
    assert.ok(lightColors.length > 0, 'на холсте обязаны быть счётчики зон');
    assert.ok(
      lightColors.every((color) => color === '#1f242d'),
      `светлая тема — тёмные цифры, получено: ${lightColors.join(', ')}`,
    );
    assert.deepEqual(counterColorProblems(), [], 'светлая тема: цифры по живой плашке');

    // Переключение режима: токены темы + `applyUiTheme` (атрибуты + store), как
    // в продукте. Полного рендера и ресайза между шагами НЕТ.
    setThemeTokens('current', 'dark');
    themeLib.applyUiTheme({ theme: 'current' as never, mode: 'dark' });
    await settle(2);
    const darkColors = counters().map((element) => String(element.style.color));
    assert.notDeepEqual(darkColors, lightColors, 'смена режима обязана перекрасить счётчики');
    assert.ok(
      darkColors.every((color) => color === '#ffffff'),
      `тёмная тема — светлые цифры, получено: ${darkColors.join(', ')}`,
    );
    assert.deepEqual(counterColorProblems(), [], 'тёмная тема: цифры читаются (≥ 7 : 1)');

    // Обратное направление.
    setThemeTokens('current', 'light');
    themeLib.applyUiTheme({ theme: 'current' as never, mode: 'light' });
    await settle(2);
    assert.deepEqual(
      counters().map((element) => String(element.style.color)),
      lightColors,
      'возврат в светлую тему — прежний цвет цифр',
    );
    assert.deepEqual(counterColorProblems(), []);
    dispose();
    mountHost = null;
  });

  it('негативная проба: плашка перекрасилась, текст остался — краснеет', async () => {
    const dispose = await mount('current', 'light');
    const staleColor = String(counters()[0]?.style.color ?? '');
    assert.equal(staleColor, '#1f242d', 'исходный цвет светлой темы');
    // Ровно дефект f245c5ac: фон/плашка ушли в тёмную тему, а inline-цвет нет.
    setThemeTokens('current', 'dark');
    themeLib.applyUiTheme({ theme: 'current' as never, mode: 'dark' });
    for (const element of counters()) element.style.color = staleColor;
    const problems = counterColorProblems();
    assert.ok(problems.length > 0, 'устаревший цвет на тёмной плашке обязан ловиться');
    assert.ok(
      problems.some((problem) => problem.includes('≠')),
      `причина — расхождение с расчётным цветом: ${problems.join('; ')}`,
    );
    assert.ok(
      problems.some((problem) => problem.includes('контраст')),
      `и контраст ниже порога: ${problems.join('; ')}`,
    );
    dispose();
    mountHost = null;
  });

  it('смена слоя с собственными цветами перекрашивает цифры от --layer-bg', async () => {
    // Граничная пара токенов: плашка без слоя (78 % серого над тёмным фоном)
    // темнее порога → белый текст; со светлым фоном слоя (`--layer-bg`) та же
    // плашка светлее порога → тёмный текст. На реальных темах решение не
    // переключается, поэтому проба синтетическая — она проверяет именно
    // ЧТЕНИЕ эффективного фона (венгерская пара специально не держит 7 : 1:
    // этот инвариант охраняет 12-блочная проба на реальных темах выше).
    const dispose = await mount('current', 'light', {
      '--surface': '#aaaaaa',
      '--bg': '#101010',
    });
    assert.ok(
      counters().every((element) => element.style.color === '#ffffff'),
      'без слоя плашка тёмная — цифры белые',
    );
    assert.deepEqual(counterColorProblems(false), [], 'без слоя цвет считается от --bg');

    // Слой с собственными цветами: `refreshLayerTheme` пишет `--layer-bg`, затем
    // тик store меняет `currentLayer` — счётчики обязаны пересчитаться.
    setRootTokens({ '--layer-bg': '#ffffff' });
    store.update({ currentLayer: { id: 'layer-own', title: 'Свой слой' } });
    await settle(2);
    assert.ok(
      counters().every((element) => element.style.color === '#1f242d'),
      'на светлом фоне слоя цифры обязаны стать тёмными',
    );
    assert.deepEqual(counterColorProblems(false), [], 'цвет считается от --layer-bg, не от --bg');
    dispose();
    mountHost = null;
  });

  it('правка цвета фона активного слоя (id тот же) перекрашивает каждый счётчик', async () => {
    // Блокер проверки fef9350f: путь продукта «Свойства слоя» → «Фон холста» →
    // Сохранить кладёт `currentLayer` с ПРЕЖНИМ id (`screens/layers.ts`), а
    // `refreshLayerTheme` перезаписывает `--layer-bg` (`lib/layer-colors.ts`).
    // Ключ по id такой правки не видел — цифры оставались от старого фона
    // (белые на светлой плашке, ≈1.9 : 1) до ближайшего рендера. Ключ по
    // ФАКТИЧЕСКОМУ фону ловит её сразу, без рендера и без смены id.
    const LAYER = { id: 'layer-own', title: 'Свой слой' };
    const layerEcho = (background: string): Record<string, unknown> => ({
      id: LAYER.id,
      title: LAYER.title,
      is_base: false,
      colors: {
        background: { light: background, dark: background },
        focus_stripe: { light: '#7e57c2', dark: '#7e57c2' },
      },
    });
    const dispose = await mount('current', 'light', {
      '--surface': '#aaaaaa',
      '--bg': '#101010',
    });
    store.update({ layers: [layerEcho('#101010')] as never, currentLayer: { ...LAYER } });
    setRootTokens({ '--layer-bg': '#101010' });
    await settle(2);
    const darkLayerColors = counters().map((element) => String(element.style.color));
    assert.ok(
      darkLayerColors.length > 0 && darkLayerColors.every((color) => color === '#ffffff'),
      `тёмный фон слоя — белые цифры, получено: ${darkLayerColors.join(', ')}`,
    );
    assert.deepEqual(counterColorProblems(false), []);

    // Правка цвета «Фон холста» = #ffffff при том же id слоя.
    setRootTokens({ '--layer-bg': '#ffffff' });
    store.update({ layers: [layerEcho('#ffffff')] as never, currentLayer: { ...LAYER } });
    await settle(2);
    const afterEditColors = counters().map((element) => String(element.style.color));
    assert.notDeepEqual(
      afterEditColors,
      darkLayerColors,
      'смена фона слоя при неизменном id обязана перекрасить счётчики',
    );
    assert.ok(
      afterEditColors.every((color) => color === '#1f242d'),
      `светлый фон слоя — тёмные цифры, получено: ${afterEditColors.join(', ')}`,
    );
    assert.deepEqual(
      counterColorProblems(false),
      [],
      'после правки фон читается как --layer-bg, а не прежний',
    );
    dispose();
    mountHost = null;
  });
});
