/**
 * Блочная обёртка развёрнутых трансклюзий в едином рендерере (ТП2,
 * задача `a2b68d72`, ADR `c425202a`, ADR `85a7a01e`, требование `29a3c17a`,
 * элемент интерфейса `2b116d37`).
 *
 * Развёртка трансклюзий (`expandTransclusions`) помещает вставленный текст
 * между маркерами-границами — HTML-комментариями с префиксом
 * `etn:transclusion` (ADR `85a7a01e`). Обычный рендерер такие комментарии
 * СКРЫВАЕТ (`html-comment.ts`), поэтому уровни вложенности в готовом HTML
 * теряются. Чтобы клиент мог подкрашивать фон по глубине (ADR `c425202a`) и
 * показывать состояния ошибок источника (требование `fc60d763`), рендерер —
 * по явной опции вызывающего (`env.transclusionLabels`) — оборачивает каждый
 * развёрнутый фрагмент в `<div class="md-transclusion" data-transclusion-depth=N>`,
 * а нераскрытые/ошибочные маркеры превращает в контейнеры с текстом ошибки.
 *
 * Разбор трансклюзий по-прежнему живёт только в `transclusion.ts`: этот файл
 * лишь распознаёт УЖЕ СФОРМИРОВАННЫЕ маркеры ADR и не разбирает `![[…]]`.
 *
 * Опция выключена по умолчанию: без `transclusionLabels` маркеры скрываются
 * как раньше, и вывод {@link renderMarkdown} байт-в-байт не меняется.
 */

import type MarkdownIt from 'markdown-it';

import { TRANSCLUSION_MARKER_PREFIX, TRANSCLUSION_MAX_DEPTH } from './transclusion.js';

/** Корневой класс обёртки блока трансклюзии. */
export const TRANSCLUSION_BLOCK_CLASS = 'md-transclusion';
/** Класс контейнера «нет источника/раздела» (требование `fc60d763`). */
export const TRANSCLUSION_MISSING_CLASS = 'md-transclusion--missing';
/** Класс контейнера нераскрытой ссылки (цикл/предел глубины). */
export const TRANSCLUSION_SKIPPED_CLASS = 'md-transclusion--skipped';
/** Атрибут глубины вложенности (1..5) на обёртке. */
export const TRANSCLUSION_DEPTH_ATTR = 'data-transclusion-depth';
/** Атрибут id мысли-источника на обёртке. */
export const TRANSCLUSION_SOURCE_ATTR = 'data-transclusion-source';
/** Атрибут имени раздела источника (когда ссылка адресовала раздел). */
export const TRANSCLUSION_SECTION_ATTR = 'data-transclusion-section';

/** Локализованные подписи контейнеров ошибок/пропуска (клиент передаёт `t()`). */
export interface TransclusionLabels {
  /** «нет источника трансклюзии». */
  noSource: string;
  /** «нет раздела в источнике трансклюзии». */
  noSection: string;
  /** Нераскрытая ссылка (цикл или предел глубины). */
  skipped: string;
}

/** Опция рендера, включающая блочную обёртку трансклюзий. */
export interface TransclusionRenderOptions {
  labels: TransclusionLabels;
}

/** Часть `env`, которую читает этот плагин. */
interface TransclusionBlockEnv {
  transclusionLabels?: TransclusionLabels;
  /** Стек открытых обёрток текущего рендера (для производной глубины). */
  transclusionStack?: number[];
}

/** Строка-маркер целиком: `<!-- etn:transclusion <kind> … -->`. */
const MARKER_RE = new RegExp(
  `^<!--\\s*${TRANSCLUSION_MARKER_PREFIX}\\s+(begin|end|skip|missing)\\b(.*?)-->$`,
);

/** HTML-escape текста и значений атрибутов. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Значение атрибута маркера `name=<value>` / `name="<value>"`. */
function attr(rest: string, name: string): string | null {
  const quoted = new RegExp(`${name}="((?:\\\\.|[^"\\\\])*)"`).exec(rest);
  if (quoted !== null) return quoted[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const bare = new RegExp(`${name}=(\\S+)`).exec(rest);
  return bare === null ? null : bare[1]!;
}

/** Глубина из атрибута `depth=<N>` (положительное целое) либо `null`. */
function depthAttr(rest: string): number | null {
  const raw = attr(rest, 'depth');
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Стек открытых обёрток текущего рендера. */
function stackOf(env: TransclusionBlockEnv): number[] {
  env.transclusionStack ??= [];
  return env.transclusionStack;
}

/** Обёртка открытия блока: класс, глубина, источник и (опц.) раздел. */
function openTag(depth: number, source: string | null, section: string | null): string {
  let out = `<div class="${TRANSCLUSION_BLOCK_CLASS}" ${TRANSCLUSION_DEPTH_ATTR}="${depth}"`;
  if (source !== null) out += ` ${TRANSCLUSION_SOURCE_ATTR}="${esc(source)}"`;
  if (section !== null) out += ` ${TRANSCLUSION_SECTION_ATTR}="${esc(section)}"`;
  return `${out}>`;
}

/** Контейнер ошибки/пропуска с локализованной подписью внутри. */
function errorTag(depth: number, source: string | null, section: string | null, cls: string, label: string): string {
  let out = `<div class="${TRANSCLUSION_BLOCK_CLASS} ${cls}" ${TRANSCLUSION_DEPTH_ATTR}="${depth}"`;
  if (source !== null) out += ` ${TRANSCLUSION_SOURCE_ATTR}="${esc(source)}"`;
  if (section !== null) out += ` ${TRANSCLUSION_SECTION_ATTR}="${esc(section)}"`;
  return `${out}>${esc(label)}</div>`;
}

/**
 * Регистрирует блочную обёртку трансклюзий. Правило стоит ПЕРЕД правилом
 * скрытия HTML-комментариев и с `alt: ['paragraph', …]`: маркер на отдельной
 * строке завершает абзац и становится собственным блоком (ADR `85a7a01e`
 * требует, чтобы маркеры шли отдельными строками).
 */
export function transclusionBlockPlugin(md: MarkdownIt): void {
  md.block.ruler.before(
    'html_comment',
    'transclusion_marker',
    (state, startLine, _endLine, silent) => {
      const start = state.bMarks[startLine]! + state.tShift[startLine]!;
      const end = state.eMarks[startLine]!;
      const line = state.src.slice(start, end).trim();
      const match = MARKER_RE.exec(line);
      if (match === null) return false;

      const env = state.env as TransclusionBlockEnv;
      const labels = env.transclusionLabels;
      // Обёртка выключена — маркер уходит правилу html_comment (скрыт, как раньше).
      if (labels === undefined) return false;

      const kind = match[1]!;
      const rest = match[2] ?? '';
      const stack = stackOf(env);
      // Закрывающий маркер без открытого блока (открытие было внутристрочным и
      // скрыто) — не эмитим, иначе HTML остался бы с висячим `</div>`.
      if (kind === 'end' && stack.length === 0) return false;
      if (silent) return true;

      const source = attr(rest, 'source');
      const section = attr(rest, 'section');
      let html: string;
      if (kind === 'begin') {
        const depth = depthAttr(rest) ?? stack.length + 1;
        stack.push(depth);
        html = openTag(depth, source, section);
      } else if (kind === 'end') {
        stack.pop();
        html = '</div>';
      } else if (kind === 'skip') {
        const depth = Math.min(stack.length + 1, TRANSCLUSION_MAX_DEPTH);
        html = errorTag(depth, source, section, TRANSCLUSION_SKIPPED_CLASS, labels.skipped);
      } else {
        // Причину различает атрибут `reason` маркера (ADR `85a7a01e`,
        // требование `fc60d763`): `section` — раздел не найден, иначе источник.
        // Атрибут `section` есть у обеих причин и подпись по нему не выбрать.
        const reason = attr(rest, 'reason');
        const label = reason === 'section' ? labels.noSection : labels.noSource;
        const depth = Math.min(stack.length + 1, TRANSCLUSION_MAX_DEPTH);
        html = errorTag(depth, source, section, TRANSCLUSION_MISSING_CLASS, label);
      }

      const token = state.push('html_block', '', 0);
      token.content = html;
      token.map = [startLine, startLine + 1];
      state.line = startLine + 1;
      return true;
    },
    { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
  );
}
