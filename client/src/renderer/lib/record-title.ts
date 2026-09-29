/**
 * Производный заголовок дневниковой записи (0.10.2, задача 8e4a965f).
 *
 * ОДНА реализация разбора для ленты экрана «Дневник»
 * (`screens/chronicle/diary.ts`, `screens/chronicle/chronicle.ts`) и вкладки
 * «Дневник» редактора (`editor/chrono-tab.ts`). Редактор не должен зависеть от
 * экранов (`editor/` ← `screens/`), поэтому разбор живёт в `lib/`.
 *
 * Заголовок записи — поле `title`; когда оно пусто, берётся первая непустая
 * строка тела заметки со снятием ведущих markdown-маркеров и
 * разэкранированием HTML-сущностей серверной выжимки, обрезанная по
 * максимальной длине с многоточием. Максимальная длина — ПАРАМЕТР: лента
 * показывает 150 символов, вкладка редактора — 250 (спека «Вкладка «Дневник»
 * редактора» 7310d077).
 *
 * Модуль без DOM и сети — проверяется юнит-тестами
 * (`tests/chronicle-record-groups.test.ts`).
 */

/** Предел длины производного заголовка в ленте «Дневника». */
export const RECORD_DISPLAY_TITLE_MAX = 150;

/** Предел длины производного заголовка во вкладке «Дневник» редактора. */
export const EDITOR_RECORD_TITLE_MAX = 250;

/** Ведущие markdown-маркеры строки: `#`, `-`/`*`/`+`, номера списков, `>`. */
const LEADING_MD_MARKER_RE = /^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/;

/**
 * Разэкранирование HTML-сущностей серверной выжимки `snippet`: сервер отдаёт
 * `snippet` как HTML-экранированный текст (`makeSnippet` → `escapeHtml`), а
 * заголовок ленты — обычный текст. Одна замена по чередованию, без повторного
 * разбора результата, поэтому `&amp;lt;` не превращается в `<`.
 */
const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (m) => HTML_ENTITIES[m] ?? m);
}

/**
 * Первая непустая строка текста записи со снятием ведущих markdown-маркеров и
 * разэкранированием HTML-сущностей (без обрезки). `''` — тело пустое.
 */
export function recordTitleFromBody(bodyText: string): string {
  for (const raw of bodyText.split(/\r?\n/)) {
    let text = decodeHtmlEntities(raw.replace(/<[^>]*>/g, '')).trim();
    if (text === '') continue;
    // Снимаем маркеры повторно: «> - пункт» даёт вложенную разметку.
    for (let guard = 0; guard < 8; guard += 1) {
      const next = text.replace(LEADING_MD_MARKER_RE, '').trim();
      if (next === text) break;
      text = next;
    }
    if (text !== '') return text;
  }
  return '';
}

/**
 * Отображаемый заголовок записи: поле `title`, а при его отсутствии — первая
 * непустая строка тела со снятием разметки, снятием чужого хвостового «…» и
 * обрезкой по `maxLength` с многоточием. `''` — ни заголовка, ни тела
 * (вызывающий подставляет своё пустое состояние из словаря).
 */
export function recordDisplayTitle(
  title: string | null | undefined,
  bodyText: string,
  maxLength: number = RECORD_DISPLAY_TITLE_MAX,
): string {
  const own = (title ?? '').trim();
  if (own !== '') return own;
  // Серверная выжимка `snippet` могла быть обрезана своим многоточием — снимаем
  // его, чтобы своё усечение по `maxLength` не дало «……».
  const line = recordTitleFromBody(bodyText).replace(/…+$/, '').trimEnd();
  return line.length > maxLength ? `${line.slice(0, maxLength)}…` : line;
}
