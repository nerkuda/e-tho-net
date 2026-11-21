/**
 * Сторож шрифтового бандла клиента (задача e622824e, ADR 7f1f924f «Шрифты
 * клиента — бандл woff2 в поставке», требование b8719e86 «Технические принципы
 * UI», стандарт «Правило без теста-сторожа не считается введённым»).
 *
 * Правило: клиент поставляет шрифты внутри себя и подключает их токенами.
 * Сторож держит границы ADR:
 *   1. `@font-face` объявлен ровно в одном модуле — `styles/fonts.css`; ни в
 *      другом CSS, ни в скриптах рендерера объявлений нет.
 *   2. Все `src` — локальные относительные woff2-файлы из
 *      `src/renderer/assets/fonts/`; внешних источников (http/https, CDN,
 *      `data:`, `blob:`) и абсолютных путей нет. Файлы существуют и непусты.
 *   3. Состав начертаний — только перечень ADR: Inter 400/500/600 и JetBrains
 *      Mono 400, подмножества latin + cyrillic, стиль normal. Лишний вес,
 *      подсемейство или пропущенный файл — красный.
 *   4. Лицензии SIL OFL 1.1 обоих семейств лежат в `public/licenses/` — из
 *      `public` они попадают в сборку (`out/renderer/licenses/`) и едут в
 *      поставке.
 *   5. CSP `font-src` — только локальные источники (`'self'`, `file:`); ни
 *      `http:`, ни `data:`/`blob:` без обоснования.
 *   6. Подключение — токены: `--user-font-ui` начинается с Inter,
 *      `--md-mono` (он же `--user-font-mono`) — с JetBrains Mono, фолбэк на
 *      системные стеки сохранён; собственных литеральных `font-family` в CSS
 *      рендерера нет.
 *
 * Каждая проверка снабжена мутацией: сторож обязан краснеть на подменённом
 * входе, иначе он не сторож.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { collectViolations, type GuardRule } from './guard-helpers.js';
import { readRendererCss, RENDERER_ROOT } from './renderer-css.js';

const FONTS_CSS = path.join(RENDERER_ROOT, 'styles', 'fonts.css');
const FONT_DIR = path.join(RENDERER_ROOT, 'assets', 'fonts');
const LICENSES_DIR = path.join(RENDERER_ROOT, 'public', 'licenses');
const INDEX_HTML = path.join(RENDERER_ROOT, 'index.html');

/** Перечень ADR: семейство → разрешённые веса и подмножества. */
const ALLOWED_FAMILIES: ReadonlyArray<{
  family: string;
  weights: readonly number[];
  prefixes: readonly string[];
}> = [
  { family: 'Inter', weights: [400, 500, 600], prefixes: ['inter'] },
  { family: 'JetBrains Mono', weights: [400], prefixes: ['jetbrains-mono'] },
];

/** Подмножества, которые обязаны поставляться у каждого веса. */
const ALLOWED_SUBSETS = ['latin', 'cyrillic'] as const;

/** Ожидаемые лицензии (SIL OFL 1.1) в поставке. */
const LICENSE_FILES = ['inter-OFL-1.1.txt', 'jetbrains-mono-OFL-1.1.txt'] as const;

/** Одно разобранное объявление `@font-face`. */
interface FontFace {
  /** Гарнитура без кавычек. */
  family: string;
  /** Значение `font-weight` как есть. */
  weight: string;
  /** Значение `font-style` как есть. */
  style: string;
  /** Значение `font-display` как есть. */
  display: string;
  /** Все `url(...)` из `src`. */
  urls: string[];
  /** Подсказка формата из `src` (`format(...)`), если задана. */
  format: string | null;
  /** Значение `unicode-range` (пустая строка — не задан). */
  unicodeRange: string;
}

/** Значение CSS-свойства из тела блока `@font-face` (или `null`). */
function declaration(body: string, name: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+);`).exec(body);
  return match?.[1] !== undefined ? match[1].trim() : null;
}

/** Все объявления `@font-face` из текста CSS в порядке появления. */
function parseFaces(css: string): FontFace[] {
  const faces: FontFace[] = [];
  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = match[1] ?? '';
    const urls: string[] = [];
    for (const url of body.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      if (url[1] !== undefined) urls.push(url[1].trim());
    }
    faces.push({
      family: (declaration(body, 'font-family') ?? '').replace(/^['"]|['"]$/g, ''),
      weight: declaration(body, 'font-weight') ?? '',
      style: declaration(body, 'font-style') ?? '',
      display: declaration(body, 'font-display') ?? '',
      urls,
      format: /format\(\s*['"]([^'"]+)['"]\s*\)/.exec(body)?.[1] ?? null,
      unicodeRange: declaration(body, 'unicode-range') ?? '',
    });
  }
  return faces;
}

/** Файл — непустой? */
function nonEmptyFile(file: string): boolean {
  return fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size > 0;
}

/** Сигнатура контейнера woff2 — первые 4 байта файла. */
const WOFF2_SIGNATURE = 'wOF2';

/**
 * Проблема файла шрифта или `null`: файл существует, непуст и это ДЕЙСТВИТЕЛЬНО
 * контейнер woff2 (первые 4 байта `wOF2`). Существования и непустоты мало:
 * подменённый/обкусанный файл ломал бы загрузку молча.
 */
function woff2Problem(file: string): string | null {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return 'файл не найден';
  if (fs.statSync(file).size === 0) return 'файл пуст';
  const head = Buffer.alloc(4);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString('latin1') !== WOFF2_SIGNATURE) return 'нет сигнатуры wOF2 (это не woff2)';
  return null;
}

/**
 * Строка начинается внутри блочного комментария `/* … *\/`?
 * Однострочной проверки мало: перенесённая строка комментария начинается с
 * текста, и упоминание `@font-face` в ней — не объявление.
 */
function startsInComment(content: string, lineNo: number): boolean {
  const lines = content.split('\n');
  let inBlock = false;
  for (let i = 0; i < lineNo; i += 1) {
    const line = lines[i] ?? '';
    const startsInBlock = inBlock;
    let index = 0;
    while (index < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', index);
        if (end === -1) break;
        inBlock = false;
        index = end + 2;
      } else {
        const start = line.indexOf('/*', index);
        if (start === -1) break;
        inBlock = true;
        index = start + 2;
      }
    }
    if (i === lineNo - 1) {
      return startsInBlock || line.trim().startsWith('//') || line.trim().startsWith('/*');
    }
  }
  return false;
}

/** Строка — комментарий (однострочный или внутри блочного)? */
function commentLine(line: string, lineNo: number, content: string): boolean {
  const t = line.trim();
  return (
    t.startsWith('//') ||
    t.startsWith('*') ||
    t.startsWith('/*') ||
    startsInComment(content, lineNo)
  );
}

/**
 * Нарушения состава объявлений: только локальные woff2, только перечень ADR,
 * все файлы на месте, подмножества разделены `unicode-range`.
 */
function faceViolations(css: string, fontDir: string): string[] {
  const out: string[] = [];
  const faces = parseFaces(css);
  if (faces.length === 0) return ['в styles/fonts.css нет ни одного @font-face'];

  const seen = new Set<string>();
  for (const face of faces) {
    const allowed = ALLOWED_FAMILIES.find((f) => f.family === face.family);
    if (allowed === undefined) {
      out.push(`неразрешённая гарнитура «${face.family}» (ADR: только Inter и JetBrains Mono)`);
      continue;
    }
    const weight = Number(face.weight);
    if (!allowed.weights.includes(weight)) {
      out.push(
        `неразрешённый вес ${face.weight} у «${face.family}» ` +
          `(ADR: ${allowed.weights.join('/')})`,
      );
    }
    if (face.style !== 'normal') {
      out.push(`стиль «${face.style}» у «${face.family}» ${face.weight}: только normal`);
    }
    if (face.display !== 'swap') {
      out.push(`font-display «${face.display}» у «${face.family}» ${face.weight}: ожидается swap`);
    }
    if (face.format !== 'woff2') {
      out.push(
        `у «${face.family}» ${face.weight} формат «${face.format ?? '—'}»: поставляется только woff2`,
      );
    }

    if (face.urls.length !== 1) {
      out.push(
        `у «${face.family}» ${face.weight} ${face.urls.length} url в src: ` +
          'ожидается ровно один локальный woff2',
      );
    }
    for (const url of face.urls) {
      if (/^[a-z]+:/i.test(url)) {
        out.push(`внешний источник шрифта «${url}»: только локальные файлы (ADR)`);
        continue;
      }
      if (url.startsWith('/')) {
        out.push(`абсолютный путь «${url}»: в сборке клиента он указывает в корень диска`);
        continue;
      }
      if (!url.endsWith('.woff2')) {
        out.push(`«${url}»: поставляется только woff2`);
      }
      if (!url.startsWith('../assets/fonts/')) {
        out.push(`«${url}»: файлы шрифтов живут в src/renderer/assets/fonts/`);
      }
      const name = path.basename(url);
      const abs = path.join(fontDir, name);
      const fileProblem = woff2Problem(abs);
      if (fileProblem !== null) {
        out.push(`шрифт ${name}: ${fileProblem}`);
      }
      const target = ALLOWED_FAMILIES.find((f) => f.family === face.family);
      const parsed = /^(inter|jetbrains-mono)-(latin|cyrillic)-(\d+)-normal\.woff2$/.exec(name);
      if (parsed === null) {
        out.push(`имя файла «${name}» вне схемы <семейство>-<подмножество>-<вес>-normal.woff2`);
      } else {
        const [, prefix, subset, fileWeight] = parsed;
        if (!target?.prefixes.includes(prefix ?? '')) {
          out.push(`файл «${name}» не соответствует гарнитуре «${face.family}»`);
        }
        if (!(ALLOWED_SUBSETS as readonly string[]).includes(subset ?? '')) {
          out.push(`подмножество «${subset}» в «${name}» вне перечня latin/cyrillic`);
        }
        if (fileWeight !== face.weight) {
          out.push(`вес в имени файла «${name}» не совпадает с font-weight ${face.weight}`);
        }
        const key = `${face.family}/${face.weight}/${subset}`;
        if (seen.has(key)) out.push(`дубль начертания ${key}`);
        seen.add(key);
      }
    }
    if (face.unicodeRange === '') {
      out.push(
        `у «${face.family}» ${face.weight} нет unicode-range: подмножества latin/cyrillic ` +
          'перекрыли бы друг друга',
      );
    }
  }

  for (const family of ALLOWED_FAMILIES) {
    for (const weight of family.weights) {
      for (const subset of ALLOWED_SUBSETS) {
        if (!seen.has(`${family.family}/${weight}/${subset}`)) {
          out.push(`нет начертания ${family.family} ${weight} ${subset}`);
        }
      }
    }
  }
  return out;
}

/** Нарушения поставки лицензий: файлы на месте и это тексты SIL OFL 1.1. */
function licenseViolations(dir: string): string[] {
  const out: string[] = [];
  for (const name of LICENSE_FILES) {
    const file = path.join(dir, name);
    if (!nonEmptyFile(file)) {
      out.push(`нет файла лицензии public/licenses/${name}`);
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    if (!/SIL OPEN FONT LICENSE/i.test(text) || !/Version 1\.1/.test(text)) {
      out.push(`public/licenses/${name} не содержит текста SIL OFL 1.1`);
    }
    if (!/Copyright/i.test(text)) {
      out.push(`public/licenses/${name} не содержит строки Copyright`);
    }
  }
  return out;
}

/** Нарушения источников: внешние шрифтовые CDN и `@font-face` вне общего модуля. */
function sourceViolations(root: string): string[] {
  const rules: GuardRule[] = [
    {
      name: 'no-external-font-host',
      description:
        'Внешний источник шрифтов (fonts.googleapis.com/gstatic, CDN) запрещён: ' +
        'шрифты едут в поставке (ADR 7f1f924f).',
      pattern:
        /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/i,
      allow: (_rel, line, lineNo, content) => commentLine(line, lineNo, content),
    },
    {
      name: 'font-face-single-module',
      description:
        '@font-face объявляется только в styles/fonts.css — единая точка загрузчика ' +
        '(ADR 7f1f924f).',
      pattern: /@font-face/,
      include: (rel) => rel !== 'styles/fonts.css',
      allow: (_rel, line, lineNo, content) => commentLine(line, lineNo, content),
    },
    {
      name: 'no-remote-url-in-styles',
      description: 'В CSS рендерера нет url() с внешним или протокольным адресом.',
      pattern: /url\(\s*['"]?(?:[a-z]+:)?\/\//i,
      include: (rel) => rel.endsWith('.css'),
    },
  ];
  return collectViolations(root, rules, {
    extensions: ['.ts', '.js', '.mjs', '.cjs', '.css', '.html'],
  }).map((v) => `${v.file}:${v.line} [${v.rule}] — ${v.text}`);
}

/** Нарушения CSP: `font-src` объявлен и допускает только локальные источники. */
function cspViolations(html: string): string[] {
  const out: string[] = [];
  const meta = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/.exec(html);
  if (meta === null || meta[1] === undefined)
    return ['в index.html нет meta Content-Security-Policy'];
  const directives = new Map<string, string[]>();
  for (const part of meta[1].split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const [name, ...values] = tokens;
    if (name !== undefined) directives.set(name.toLowerCase(), values);
  }
  const fontSrc = directives.get('font-src');
  if (fontSrc === undefined) {
    out.push('в CSP нет директивы font-src: источники шрифтов не ограничены явно (ADR)');
    return out;
  }
  // Замер на собранном клиенте (задача e622824e, доработка по приёмке):
  // `font-src 'self'` покрывает и файлы `file://` — бандл грузится 8/8 без
  // ослабления политики; `font-src 'none'` даёт DOMException, то есть директива
  // действительно действует. Платформы, где 'self' не покрывает file://, не
  // воспроизвелось — `file:` в политику не возвращаем.
  const allowed = new Set(["'self'"]);
  for (const value of fontSrc) {
    if (!allowed.has(value)) {
      out.push(`CSP font-src допускает «${value}»: достаточно 'self' (локальные файлы сборки)`);
    }
  }
  if (fontSrc.length === 0) out.push('CSP font-src пуст');
  return out;
}

/** Нарушения подключения: токены с Inter/JetBrains Mono и фолбэком, без литералов. */
function tokenViolations(css: string): string[] {
  const out: string[] = [];
  const value = (token: string): string => {
    const match = new RegExp(`\\${token}\\s*:\\s*([^;]+);`).exec(css);
    return (match?.[1] ?? '').replace(/\s+/g, ' ').trim();
  };
  const ui = value('--user-font-ui');
  if (!/^'Inter'/.test(ui)) {
    out.push(`--user-font-ui не начинается с 'Inter': ${ui || 'токен не объявлен'}`);
  }
  if (!/system-ui/.test(ui)) {
    out.push('--user-font-ui потерял фолбэк на системный стек (system-ui)');
  }
  const mono = value('--md-mono');
  if (!/^'JetBrains Mono'/.test(mono)) {
    out.push(`--md-mono не начинается с 'JetBrains Mono': ${mono || 'токен не объявлен'}`);
  }
  if (!/ui-monospace/.test(mono)) {
    out.push('--md-mono потерял фолбэк на системный моноширинный стек (ui-monospace)');
  }
  if (!/--user-font-mono\s*:\s*var\(--md-mono\)/.test(css)) {
    out.push('--user-font-mono обязан ссылаться на --md-mono (единый источник)');
  }
  return out;
}

/**
 * Нарушения связки с вендорской дизайн-системой: Web Awesome ставит `body`,
 * заголовкам и длинному тексту собственные `--wa-font-family-*`, и без
 * маппинга на токены ETN шрифт из бандла не применяется (проверено пробой
 * стенда: `body` считался `ui-sans-serif, system-ui, sans-serif`).
 */
function waFontMappingViolations(css: string): string[] {
  const out: string[] = [];
  for (const token of [
    '--wa-font-family-body',
    '--wa-font-family-heading',
    '--wa-font-family-longform',
  ]) {
    if (!new RegExp(`\\${token}\\s*:\\s*var\\(--user-font-ui\\)`).test(css)) {
      out.push(`${token} не связан с var(--user-font-ui): вендор подставит свой системный стек`);
    }
  }
  if (!/--wa-font-family-code\s*:\s*var\(--md-mono\)/.test(css)) {
    out.push('--wa-font-family-code не связан с var(--md-mono)');
  }
  return out;
}

/** Литеральные `font-family` вне объявления токенов и модуля шрифтов. */
function literalFontFamilyViolations(root: string): string[] {
  const rules: GuardRule[] = [
    {
      name: 'no-literal-font-family',
      description:
        'Литеральная гарнитура в CSS рендерера запрещена: шрифт берётся из ' +
        '--user-font-ui/--user-font-mono (ADR 7f1f924f).',
      pattern: /font-family\s*:(?!\s*(?:var\(|inherit))/,
      include: (rel) => rel.endsWith('.css') && rel !== 'styles/fonts.css',
      allow: (_rel, line, lineNo, content) => commentLine(line, lineNo, content),
    },
  ];
  return collectViolations(root, rules, { extensions: ['.css'] }).map(
    (v) => `${v.file}:${v.line} [${v.rule}] — ${v.text}`,
  );
}

/**
 * Нарушения жирности: решение заказчика (приёмка задачи e622824e) — максимум
 * 600. Бандл не везёт начертание 700, поэтому `font-weight: 700` всё равно
 * рисуется шестым весом, но остаётся ложным намерением в CSS. Дополнительно
 * проверяется токен `--md-strong-weight` — он задаёт жирность markdown-«strong».
 *
 * Правило «максимум 600» шире одного значения: запрещены `bold`/`bolder`
 * (синонимы 700) и веса 700/800/900 — в любой форме CSS-объявления.
 */
const WEIGHT_ABOVE_600 = '(?:bold|bolder|[7-9]00)';

function fontWeightViolations(root: string): string[] {
  const rules: GuardRule[] = [
    {
      name: 'no-font-weight-above-600',
      description:
        'font-weight выше 600 (700/800/900, bold, bolder) в CSS рендерера запрещён: ' +
        'максимум 600 (начертаний выше 600 в бандле нет, решение заказчика приёмки e622824e).',
      pattern: new RegExp(`font-weight\\s*:\\s*${WEIGHT_ABOVE_600}\\b`, 'i'),
      include: (rel) => rel.endsWith('.css'),
      allow: (_rel, line, lineNo, content) => commentLine(line, lineNo, content),
    },
    {
      name: 'no-strong-weight-above-600',
      description:
        'Токен --md-strong-weight не задаёт вес выше 600: жирность markdown — не выше 600 ' +
        '(решение заказчика приёмки e622824e).',
      pattern: new RegExp(`--md-strong-weight\\s*:\\s*${WEIGHT_ABOVE_600}\\b`, 'i'),
      include: (rel) => rel.endsWith('.css'),
      allow: (_rel, line, lineNo, content) => commentLine(line, lineNo, content),
    },
  ];
  return collectViolations(root, rules, { extensions: ['.css'] }).map(
    (v) => `${v.file}:${v.line} [${v.rule}] — ${v.text}`,
  );
}

/**
 * Жирность выше 600 в TypeScript: inline-стили, SVG-атрибуты, объекты стилей и
 * тернарники. CSS-сторож такие значения не видит, а на экране они дают то же
 * ложное намерение веса 700.
 *
 * Литерал ищется в ЛЮБОМ контексте после свойства: прямой присваиваемый
 * литерал (`= '700'`), объект стилей (`{ fontWeight: 700 }`), SVG-атрибут
 * (`setAttribute('font-weight', '700')`), тернарник
 * (`flags.bold ? 'bold' : ''`) — между свойством и литералом допускается
 * выражение до конца инструкции. Строковая и числовая формы проверяются
 * отдельно: числовая без кавычек — `fontWeight: 700`, `fontWeight = 800`.
 */
function fontWeightLiteralViolations(root: string): string[] {
  const property = '(?:font-weight|fontWeight)[\'"]?\\s*[:=,]\\s*';
  const rules: GuardRule[] = [
    {
      name: 'no-ts-font-weight-above-600',
      description:
        'Строковый литерал жирности выше 600 (700/800/900, bold, bolder) в исходниках ' +
        'рендерера запрещён в любом контексте (inline-стиль, SVG-атрибут, объект стилей, ' +
        'тернарник): подчиняется правилу «максимум 600» (приёмка e622824e).',
      pattern: new RegExp(`${property}[^;{}\\n]*?['"]${WEIGHT_ABOVE_600}['"]`, 'i'),
      include: (rel) => rel.endsWith('.ts'),
      allow: (_rel, line, lineNo, content) => commentLine(line, lineNo, content),
    },
    {
      name: 'no-ts-font-weight-number-above-600',
      description:
        'Числовой литерал жирности выше 600 (700/800/900) в исходниках рендерера ' +
        'запрещён в любом контексте (inline-стиль, объект стилей): подчиняется правилу ' +
        '«максимум 600» (приёмка e622824e).',
      pattern: new RegExp(`${property}${WEIGHT_ABOVE_600}\\b`, 'i'),
      include: (rel) => rel.endsWith('.ts'),
      allow: (_rel, line, lineNo, content) => commentLine(line, lineNo, content),
    },
  ];
  return collectViolations(root, rules, { extensions: ['.ts'] }).map(
    (v) => `${v.file}:${v.line} [${v.rule}] — ${v.text}`,
  );
}

/** Временный каталог для мутаций — как у соседних сторожей: без гонок путей. */
function withTempDir<T>(prefix: string, run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('guard: шрифтовой бандл клиента (e622824e)', () => {
  const fontsCss = fs.readFileSync(FONTS_CSS, 'utf8');

  it('состав @font-face — только перечень ADR, все src локальные и на месте', () => {
    assert.deepEqual(faceViolations(fontsCss, FONT_DIR), []);
    assert.equal(parseFaces(fontsCss).length, 8, 'ожидаются 8 начертаний: Inter 3×2 + JBM 1×2');
  });

  it('лицензии SIL OFL 1.1 обоих семейств лежат в public/licenses', () => {
    assert.deepEqual(licenseViolations(LICENSES_DIR), []);
  });

  it('все файлы бандла — настоящие woff2 (сигнатура wOF2)', () => {
    const faces = parseFaces(fontsCss);
    const files = [...new Set(faces.flatMap((face) => face.urls.map((url) => path.basename(url))))];
    assert.equal(files.length, 8, `файлов бандла ${files.length}, ожидалось 8`);
    for (const name of files) {
      assert.equal(woff2Problem(path.join(FONT_DIR, name)), null, `битый файл ${name}`);
    }
    withTempDir('etn-guard-fonts-signature-', (dir) => {
      fs.cpSync(FONT_DIR, dir, { recursive: true });
      assert.deepEqual(faceViolations(fontsCss, dir), []);
      fs.writeFileSync(path.join(dir, 'inter-latin-400-normal.woff2'), 'not a woff2 file', 'utf8');
      const violations = faceViolations(fontsCss, dir);
      assert.ok(
        violations.some((v) => v.includes('wOF2')),
        `подмена файла обязана краснить: ${violations.join('; ')}`,
      );
    });
  });

  it('в исходниках нет внешних шрифтовых источников и второго @font-face', () => {
    const violations = sourceViolations(RENDERER_ROOT);
    assert.deepEqual(
      violations,
      [],
      `Запрещённые источники шрифтов:\n${violations.map((v) => `  • ${v}`).join('\n')}`,
    );
  });

  it('CSP font-src допускает только локальные источники', () => {
    assert.deepEqual(cspViolations(fs.readFileSync(INDEX_HTML, 'utf8')), []);
    // Ослабление политики `file:` (замер приёмки: не нужно) и внешний хост —
    // обе формы обязаны краснить.
    assert.notDeepEqual(
      cspViolations(
        '<meta http-equiv="Content-Security-Policy" content="font-src \'self\' file:;">',
      ),
      [],
    );
    assert.notDeepEqual(
      cspViolations(
        '<meta http-equiv="Content-Security-Policy" content="font-src \'self\' https://fonts.gstatic.com;">',
      ),
      [],
    );
  });

  it('шрифты подключены токенами, системный фолбэк сохранён', () => {
    assert.deepEqual(tokenViolations(readRendererCss()), []);
  });

  it('вендорские гарнитуры Web Awesome связаны с токенами ETN', () => {
    const waCss = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'ui', 'tokens.css'), 'utf8');
    assert.deepEqual(waFontMappingViolations(waCss), []);
    assert.notDeepEqual(waFontMappingViolations(':root { }'), []);
  });

  it('в CSS рендерера нет литеральных font-family', () => {
    const violations = literalFontFamilyViolations(RENDERER_ROOT);
    assert.deepEqual(
      violations,
      [],
      `Литеральные гарнитуры в CSS:\n${violations.map((v) => `  • ${v}`).join('\n')}`,
    );
  });

  it('жирность не выше 600: CSS, токен strong и строки TS', () => {
    const violations = [...fontWeightViolations(RENDERER_ROOT), ...fontWeightLiteralViolations(RENDERER_ROOT)];
    assert.deepEqual(
      violations,
      [],
      `Жирность выше 600:\n${violations.map((v) => `  • ${v}`).join('\n')}`,
    );
    withTempDir('etn-guard-fonts-weight-', (dir) => {
      fs.mkdirSync(path.join(dir, 'styles'));
      // Каждая форма запрещённого веса обязана краснить: 700/800/900/bold/bolder.
      for (const css of [
        '.x { font-weight: 700; }\n',
        '.x { font-weight: 800; }\n',
        '.x { font-weight: 900; }\n',
        '.x { font-weight: bold; }\n',
        '.x { font-weight: bolder; }\n',
      ]) {
        fs.writeFileSync(path.join(dir, 'styles', 'x.css'), css, 'utf8');
        assert.notDeepEqual(fontWeightViolations(dir), [], `обязано краснить: ${css.trim()}`);
      }
      // 500/600 — разрешённый диапазон, ложных срабатываний нет.
      fs.writeFileSync(path.join(dir, 'styles', 'x.css'), '.x { font-weight: 600; }\n', 'utf8');
      assert.deepEqual(fontWeightViolations(dir), [], 'вес 600 обязан быть чистым');
      fs.writeFileSync(
        path.join(dir, 'styles', 'x.css'),
        ':root { --md-strong-weight: 700; }\n',
        'utf8',
      );
      assert.notDeepEqual(fontWeightViolations(dir), [], 'токен strong 700 обязан краснить');
      // Литералы в TS: inline-стиль, SVG-атрибут, объект стилей, тернарник.
      fs.mkdirSync(path.join(dir, 'lib'));
      const tsCases = [
        "el.style.fontWeight = 'bold';\n",
        "text.setAttribute('font-weight', '700');\n",
        "render({ fontWeight: '800' });\n",
        "target.style.fontWeight = flags.bold ? 'bold' : '';\n",
        'render({ fontWeight: 700 });\n',
        'el.style.fontWeight = 800;\n',
      ];
      for (const ts of tsCases) {
        fs.writeFileSync(path.join(dir, 'lib', 'x.ts'), ts, 'utf8');
        assert.notDeepEqual(
          fontWeightLiteralViolations(dir),
          [],
          `литерал в TS обязан краснить: ${ts.trim()}`,
        );
      }
      // Разрешённые формы — без ложных срабатываний.
      for (const ts of [
        "el.style.fontWeight = '600';\n",
        "render({ fontWeight: 600 });\n",
        "render({ tag: tags.strong, fontWeight: 'var(--md-strong-weight)' });\n",
      ]) {
        fs.writeFileSync(path.join(dir, 'lib', 'x.ts'), ts, 'utf8');
        assert.deepEqual(
          fontWeightLiteralViolations(dir),
          [],
          `разрешённая форма обязана быть чистой: ${ts.trim()}`,
        );
      }
      // Негативная проба на РЕАЛЬНОМ файле: тернарник с 'bold' вернулся в dom.ts.
      const domSource = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'dom.ts'), 'utf8');
      const boldTernary = domSource.replace(
        "flags.bold ? '600' : ''",
        "flags.bold ? 'bold' : ''",
      );
      assert.notEqual(boldTernary, domSource, 'мутация dom.ts не применилась');
      fs.writeFileSync(path.join(dir, 'lib', 'dom.ts'), boldTernary, 'utf8');
      assert.notDeepEqual(
        fontWeightLiteralViolations(dir),
        [],
        "тернарник flags.bold ? 'bold' : '' в dom.ts обязан краснить",
      );
    });
  });

  it('сторож краснеет на внешнем src, лишнем весе и пропавшем файле', () => {
    const external = fontsCss.replace(
      "url('../assets/fonts/inter-latin-400-normal.woff2')",
      "url('https://cdn.example.com/inter-latin-400-normal.woff2')",
    );
    assert.notDeepEqual(faceViolations(external, FONT_DIR), []);

    const extraWeight = fontsCss.replace(
      "@font-face {\n  font-family: 'Inter';\n  font-style: normal;\n  font-display: swap;\n  font-weight: 400;",
      "@font-face {\n  font-family: 'Inter';\n  font-style: normal;\n  font-display: swap;\n  font-weight: 700;",
    );
    assert.notDeepEqual(faceViolations(extraWeight, FONT_DIR), []);

    withTempDir('etn-guard-fonts-files-', (dir) => {
      assert.notDeepEqual(
        faceViolations(fontsCss, dir),
        [],
        'пустой каталог файлов обязан краснить',
      );
    });

    const missingRange = fontsCss.replace(/ {2}unicode-range: [^;]+;\n/, '');
    assert.notDeepEqual(faceViolations(missingRange, FONT_DIR), []);
  });

  it('сторож краснеет на отсутствии лицензии и на внешнем CDN в исходниках', () => {
    withTempDir('etn-guard-fonts-license-', (dir) => {
      assert.notDeepEqual(licenseViolations(dir), []);
      fs.writeFileSync(path.join(dir, 'inter-OFL-1.1.txt'), 'not a license', 'utf8');
      assert.notDeepEqual(licenseViolations(dir), []);
    });

    withTempDir('etn-guard-fonts-cdn-', (dir) => {
      fs.mkdirSync(path.join(dir, 'styles'));
      fs.writeFileSync(
        path.join(dir, 'index.html'),
        '<meta http-equiv="Content-Security-Policy" content="font-src https://fonts.gstatic.com;">',
        'utf8',
      );
      fs.writeFileSync(
        path.join(dir, 'styles', 'fonts.css'),
        "@font-face { font-family: 'Inter'; src: url(https://fonts.gstatic.com/inter.woff2); }",
        'utf8',
      );
      assert.notDeepEqual(sourceViolations(dir), []);
      assert.notDeepEqual(cspViolations(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')), []);
    });

    withTempDir('etn-guard-fonts-second-face-', (dir) => {
      fs.mkdirSync(path.join(dir, 'styles'));
      fs.writeFileSync(
        path.join(dir, 'styles', 'fonts.css'),
        "@font-face { font-family: 'Inter'; }\n",
        'utf8',
      );
      fs.writeFileSync(
        path.join(dir, 'styles', 'extra.css'),
        "@font-face { font-family: 'Inter'; }\n",
        'utf8',
      );
      const second = sourceViolations(dir).filter((v) => v.includes('[font-face-single-module]'));
      assert.equal(second.length, 1, 'второй @font-face вне styles/fonts.css обязан краснить');
    });

    // Перенесённая строка блочного комментария — не объявление: иначе
    // документация о запрете сама делала бы сторож красным (поймано на
    // комментарии `lib/ui/tokens.css`).
    withTempDir('etn-guard-fonts-comment-', (dir) => {
      fs.mkdirSync(path.join(dir, 'styles'));
      fs.writeFileSync(
        path.join(dir, 'styles', 'comment.css'),
        '/*\n * Перенесённая строка: @font-face здесь — не объявление.\n */\n.a { color: red; }\n',
        'utf8',
      );
      assert.deepEqual(sourceViolations(dir), [], 'упоминание в комментарии — не объявление');
    });

    withTempDir('etn-guard-fonts-token-', (dir) => {
      fs.mkdirSync(path.join(dir, 'styles'));
      fs.writeFileSync(
        path.join(dir, 'styles', 'extra.css'),
        '.x { font-family: Arial, sans-serif; }\n',
        'utf8',
      );
      assert.notDeepEqual(literalFontFamilyViolations(dir), []);
    });
  });
});
