/**
 * Инфраструктура тестов-сторожей (задача 8d1f8b79, веха 1 версии 0.8.2).
 *
 * Сторож — тест, который сканирует исходники на запрещённые конструкции
 * и падает на каждом совпадении: правило чистоты проверяется обычным
 * прогоном `npm test`, а не ревью. Правило без сторожа не считается
 * введённым, а сторож подключается только зелёным — в том же изменении,
 * которое устраняет нарушения (стандарт «Правило без теста-сторожа
 * не считается введённым» в мыслесети ETN).
 *
 * Пример зелёного сторожа — `guard-renderer-electron.test.ts` в этом же
 * каталоге; запреты вех 2–7 (`guard-thought-cloud`, `guard-entity-picker`,
 * `guard-value-editor`, `guard-filter-builder`) подключаются по тому же
 * образцу. Сам хелпер проверяется тестом `guard-helpers.test.ts`.
 *
 * Копия этого файла живёт в тестах обоих пакетов (`client/tests` и
 * `server/tests`) — пакеты не импортируют тестовый код друг друга;
 * при правке API обновляй обе копии.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Одно найденное нарушение. */
export interface GuardViolation {
  /** Идентификатор правила из {@link GuardRule.name}. */
  rule: string;
  /** Путь к файлу относительно корня сканирования (слеши `/`). */
  file: string;
  /** Номер строки (с 1). */
  line: number;
  /** Текст строки с нарушением (обрезан по краям). */
  text: string;
}

/** Одно запрещающее правило сторожа. */
export interface GuardRule {
  /** Короткий идентификатор — попадает в сообщение об ошибке. */
  name: string;
  /** Человекочитаемое описание запрета — в сообщение об ошибке. */
  description: string;
  /** Регулярка, применяемая к каждой строке файла. */
  pattern?: RegExp;
  /**
   * Регулярка, применяемая к содержимому файла целиком — для многострочных
   * конструкций (например, импортов с переносами). Номер строки вычисляется
   * по позиции совпадения.
   */
  filePattern?: RegExp;
  /**
   * Фильтр файлов по относительному пути: вернула `false` — файл этим
   * правилом не сканируется. По умолчанию сканируются все файлы.
   */
  include?: (relPath: string) => boolean;
  /**
   * Исключения: вернула `true` — строка не считается нарушением. Сюда
   * попадают разрешённые места (сам общий модуль, легаси-файлы на время
   * переноса) и допустимые формы конструкции (например, `import type`).
   * `content` — содержимое файла целиком: нужно контекстным исключениям,
   * которые проверяют охватывающий код, а не номер строки. Всегда сырое:
   * комментарии не вырезаются, даже если правило просит
   * {@link GuardRule.stripComments}.
   */
  allow?: (relPath: string, line: string, lineNo: number, content: string) => boolean;
  /**
   * Сканировать файл без комментариев ({@link stripSourceComments}): строка,
   * где запрещённая конструкция лишь упомянута в пояснении, нарушением не
   * считается. Номера строк сохраняются — вырезанный текст заменяется
   * пробелами. Строковые литералы остаются: правило про SQL в строках
   * продолжает работать. По умолчанию комментарии сканируются как код.
   */
  stripComments?: boolean;
}

/** Настройки сканирования. */
export interface GuardScanOptions {
  /** Расширения файлов для сканирования. По умолчанию {@link DEFAULT_GUARD_EXTENSIONS}. */
  extensions?: string[];
  /**
   * Пути для пропуска (относительно корня, слеши `/`): точное совпадение
   * с файлом или префикс каталога.
   */
  exclude?: string[];
}

/**
 * Расширения, которые сторож считает исходниками. Сопоставление
 * регистронезависимо: `.TS` — тот же исходник, что `.ts`.
 */
export const DEFAULT_GUARD_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs'];

/** Каталоги, которые сторож не сканирует никогда. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'release', '.git']);

/** Нормализует относительный путь к виду `a/b.ts` (слеши `/`, без `./`). */
function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

/** Рекурсивно собирает файлы для сканирования (в обход SKIP_DIRS и exclude). */
export function listSourceFiles(root: string, options: GuardScanOptions = {}): string[] {
  const extensions = new Set((options.extensions ?? DEFAULT_GUARD_EXTENSIONS).map((ext) => ext.toLowerCase()));
  const exclude = (options.exclude ?? []).map(normalizeRel);
  const result: string[] = [];
  const stack = [path.resolve(root)];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // недоступный каталог — не вина сторожа
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = normalizeRel(path.relative(root, abs));
      if (!extensions.has(path.extname(entry.name).toLowerCase())) continue;
      if (exclude.some((e) => rel === e || rel.startsWith(`${e}/`))) continue;
      result.push(abs);
    }
  }
  return result.sort();
}

/**
 * Вырезает комментарии, сохраняя переводы строк (номера строк не съезжают).
 * Строковые литералы не трогаются: `https://` внутри строки — не комментарий,
 * а SQL в строке остаётся виден правилу. Шаблонные литералы обрабатываются
 * как строки; `//` внутри `${}` комментарием не считается — в разбираемых
 * файлах такого нет.
 */
export function stripSourceComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < source.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        const c = source[i]!;
        out += c;
        i += 1;
        if (c === '\\') {
          if (i < source.length) {
            out += source[i];
            i += 1;
          }
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Прогоняет правила по дереву и собирает нарушения. */
export function collectViolations(
  root: string,
  rules: GuardRule[],
  options: GuardScanOptions = {},
): GuardViolation[] {
  const violations: GuardViolation[] = [];
  const seen = new Set<string>(); // дедупликация по (правило, файл, строка)
  const push = (v: GuardViolation) => {
    const key = `${v.rule}\0${v.file}\0${v.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push(v);
  };
  for (const file of listSourceFiles(root, options)) {
    const rel = normalizeRel(path.relative(root, file));
    const content = fs.readFileSync(file, 'utf8');
    for (const rule of rules) {
      if (rule.include && !rule.include(rel)) continue;
      // Комментарии вырезаются только по запросу правила; `allow` всегда
      // получает сырой текст — контекстные исключения смотрят на пояснения.
      const scanned = rule.stripComments ? stripSourceComments(content) : content;
      if (rule.pattern) {
        // Без флагов g/y — test() по строке не запоминает позицию.
        const re = new RegExp(rule.pattern.source, rule.pattern.flags.replace(/[gy]/g, ''));
        const lines = scanned.split('\n');
        lines.forEach((line, i) => {
          if (!re.test(line)) return;
          if (rule.allow && rule.allow(rel, line, i + 1, content)) return;
          push({ rule: rule.name, file: rel, line: i + 1, text: line.trim() });
        });
      }
      if (rule.filePattern) {
        const re = new RegExp(rule.filePattern.source, `g${rule.filePattern.flags.replace(/[gy]/g, '')}`);
        for (const match of scanned.matchAll(re)) {
          const index = match.index ?? 0;
          const lineNo = scanned.slice(0, index).split('\n').length;
          const lineStart = scanned.lastIndexOf('\n', index) + 1;
          const lineEndRaw = scanned.indexOf('\n', index);
          const line = scanned.slice(lineStart, lineEndRaw === -1 ? scanned.length : lineEndRaw);
          if (rule.allow && rule.allow(rel, line, lineNo, content)) continue;
          push({ rule: rule.name, file: rel, line: lineNo, text: line.trim() });
        }
      }
    }
  }
  return violations;
}

/** Читаемое перечисление нарушений для сообщения об ошибке. */
export function formatViolations(violations: GuardViolation[]): string {
  return violations
    .map((v) => `  • ${v.file}:${v.line} [${v.rule}] — ${v.text}`)
    .join('\n');
}

/**
 * Сторож-утверждение: падает с читаемым сообщением, если в дереве есть
 * нарушения. Это единственная функция, которую использует guard-тест.
 */
export function assertGuardClean(root: string, rules: GuardRule[], options: GuardScanOptions = {}): void {
  const violations = collectViolations(root, rules, options);
  if (violations.length === 0) return;
  const rulesInfo = rules.map((r) => `  • ${r.name}: ${r.description}`).join('\n');
  throw new Error(
    `Сторож нашёл запрещённые конструкции (${violations.length}):\n` +
      `${formatViolations(violations)}\n\nПравила:\n${rulesInfo}`,
  );
}
