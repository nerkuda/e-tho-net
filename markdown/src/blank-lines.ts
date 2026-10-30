/**
 * Пустые строки markdown-исходника в просмотре (ошибка `7f017ce1`
 * «При просмотре комментариев исчезают переводы строк»).
 *
 * markdown-it по природе markdown нормализует вертикальные пробелы: одиночный
 * перевод строки после `breaks: true` становится `<br>` (паритет из задачи
 * `5de0332d`, п. 3), но ПУСТЫЕ строки он выбрасывает — серия из N пустых строк
 * всегда даёт один разрыв абзацев, а ведущие/хвостовые пустые строки теряются
 * полностью. Режим правки показывает исходник построчно, поэтому в нём видны
 * ВСЕ пустые строки, а просмотр их скрывал: между пунктами списка (`li` без
 * полей) — целиком, между абзацами — схлопывал серию до одной.
 *
 * Правило этого плагина: **каждая пустая строка исходника — ровно одна пустая
 * строка строкового ритма в просмотре**. Плагин идёт по block-токенам
 * markdown-it ПОсле разбора (карты строк `token.map` уже проставлены) и в
 * каждом контейнере (корень документа, цитата, элемент и маркер списка)
 * сравнивает конец предыдущего блока с началом следующего — разница строк и
 * есть пустые строки. На каждый разрыв выводится один токен
 * {@link BLANK_LINE_TOKEN}: `<div class="md-blank-line"><br>…</div>`, где число
 * `<br>` равно числу пустых строк. Высота блока — ровно N строковых ритмов
 * без какой-либо зависимости от CSS-отступов блоков.
 *
 * Почему маркер, а не CSS-отступ: зазор `--md-block-gap` в просмотре стоял
 * только у `p/ul/ol` (`:has(+ *)`) и у `pre/table` (проза Web Awesome). У
 * `li` его не было, и серия пустых строк неразличима по определению. Маркер
 * же несёт число строк из исходника, поэтому одинаково работает для списков,
 * цитат, таблиц и вложенных конструкций; единственная правка стилей — снять
 * автоматический зазор у блока, за которым стоит маркер (иначе первая пустая
 * строка считалась бы дважды), см. `styles/editor.css`.
 *
 * Границы:
 *   * маркеры ставятся только внутри значимых контейнеров — таблицы и её
 *     секции не разбираются (пустых строк внутри таблицы в markdown нет, а
 *     строка-разделитель `| --- |` пустой строкой не является);
 *   * пустые строки на границе контейнера и следующего блока принадлежат
 *     родительскому потоку: маркер ставится ПОСЛЕ закрытия контейнера
 *     (`</ul>`, `</ol>`, `</blockquote>`), а не внутри него — иначе к пустой
 *     строке добавлялся бы внешний зазор блока и она считалась бы дважды
 *     (ошибка 7f017ce1, круг 2);
 *   * пустая строка — это разрыв МЕЖДУ блоками: внутри абзаца одиночный
 *     перевод строки даёт `<br>` и пустой строкой не считается;
 *   * хвостовые пустые строки документа считаются как у редактора: у
 *     последней строки, завершённой переводом строки, остаётся пустая строка
 *     (в правке она видна как строка под текстом).
 */

import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

/** Класс блока пустых строк в выводе рендерера (вид — `styles/editor.css`). */
export const BLANK_LINE_CLASS = 'md-blank-line';

/** Внутренний тип токена-маркера (в разметке markdown его нет). */
const BLANK_LINE_TOKEN = 'md_blank_line';

/**
 * Контейнеры, внутри которых пустая строка исходника значима: цитата, элемент
 * списка и сам список (разрывы между пунктами). Прочие контейнеры (таблица,
 * ячейка, абзац) блоков через пустые строки не разделяют.
 */
const BLANK_CONTAINERS = new Set([
  'blockquote_open',
  'list_item_open',
  'bullet_list_open',
  'ordered_list_open',
]);

/** Открытый контейнер обхода. */
interface Frame {
  /** Уровень вложенности дочерних block-токенов (`open.level + 1`). */
  childLevel: number;
  /** Уровень открывающего токена (по нему же закрывается контейнер). */
  openLevel: number;
  /** Первая строка содержимого (0-based). */
  contentStart: number;
  /** Граница содержимого, эксклюзивно (0-based, `map[1]`). */
  contentEnd: number;
  /** Конец последнего дочернего блока с картой строк, `null` — детей ещё нет. */
  lastEnd: number | null;
  /**
   * Пустые строки, оставшиеся после ЗАКРЫТОГО дочернего контейнера. Они
   * принадлежат уже потоку этого кадра и выводятся перед следующим его блоком
   * (или на закрытии самого кадра) — то есть ВНЕ закрытого контейнера: иначе
   * маркер попадает в содержимое (`<li>`, `<ul>`) и к пустой строке
   * добавляется внешний зазор блока (ошибка 7f017ce1, круг 2).
   */
  pending: number;
  /**
   * Сколько строк первой строки контейнера занято его собственным маркером:
   * у элемента списка на первой строке стоит `-`/`1.` (не пустая строка), у
   * цитаты и списка — стоит.
   */
  firstLineIsMarkup: boolean;
}

/** Создаёт токен-маркер пустых строк. */
function blankToken(state: { Token: typeof Token }, count: number, level: number): Token {
  const token = new state.Token(BLANK_LINE_TOKEN, 'div', 0);
  token.block = true;
  token.level = level;
  token.content = String(count);
  return token;
}

/**
 * Собирает карту «индекс токена, ПЕРЕД которым вставить маркеры» → число
 * пустых строк. Концы контейнеров (`map[1]`) включают их хвостовые пустые
 * строки, поэтому разрывы считаются как разница карт строк и не зависят от
 * того, кому markdown-it «приписал» пустую строку — предыдущему блоку или
 * следующему.
 */
function collectBlankLines(tokens: readonly Token[], lineCount: number): Map<number, number> {
  const inserts = new Map<number, number>();
  const add = (at: number, count: number): void => {
    if (count > 0) inserts.set(at, (inserts.get(at) ?? 0) + count);
  };

  const frames: Frame[] = [
    {
      childLevel: 0,
      openLevel: -1,
      contentStart: 0,
      contentEnd: lineCount,
      lastEnd: null,
      pending: 0,
      firstLineIsMarkup: false,
    },
  ];

  /** Учитывает block-токен как ребёнка текущего контейнера (разрыв + конец). */
  const child = (frame: Frame, index: number, map: readonly [number, number]): void => {
    const start = map[0];
    const end = map[1];
    const from = frame.lastEnd ?? frame.contentStart + (frame.firstLineIsMarkup ? 1 : 0);
    // pending — пустые строки после закрытого дочернего контейнера: они уже
    // вне его разметки и выводятся здесь, перед следующим блоком родителя.
    add(index, frame.pending + (start - from));
    frame.pending = 0;
    frame.lastEnd = end;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    // Строчное содержимое блока: карта строк повторяет карту родителя.
    if (token.type === 'inline') continue;
    const frame = frames[frames.length - 1]!;
    const map = token.map;

    if (token.nesting === 1) {
      // Новый контейнер: сначала это ребёнок текущего, затем — его собственный кадр.
      if (map !== null && token.level === frame.childLevel) child(frame, i, map);
      if (map !== null && BLANK_CONTAINERS.has(token.type)) {
        frames.push({
          childLevel: token.level + 1,
          openLevel: token.level,
          contentStart: map[0],
          contentEnd: map[1],
          lastEnd: null,
          pending: 0,
          firstLineIsMarkup: token.type === 'list_item_open',
        });
      }
      continue;
    }

    if (token.nesting === -1) {
      // Хвостовые пустые строки контейнера НЕ выводятся внутри него: маркер
      // стал бы содержимым (`<li>`, `<ul>`), а внешний зазор блока остался бы —
      // пустая строка после списка считалась бы дважды (ошибка 7f017ce1,
      // круг 2). Передаём их родителю: они вставятся перед его следующим
      // блоком, то есть уже после закрытия контейнера.
      const current = frames[frames.length - 1]!;
      if (current.openLevel !== token.level) continue;
      const trailing =
        current.pending + (current.lastEnd !== null ? current.contentEnd - current.lastEnd : 0);
      if (frames.length > 1) {
        frames.pop();
        frames[frames.length - 1]!.pending += trailing;
      }
      continue;
    }

    // Одиночный block-токен без обёртки: fence, hr, html_block, code_block.
    if (map !== null && token.level === frame.childLevel) child(frame, i, map);
  }

  // Хвостовые пустые строки документа (как последняя строка в редакторе).
  const root = frames[0]!;
  if (root.lastEnd !== null) add(tokens.length, root.pending + (lineCount - root.lastEnd));
  return inserts;
}

/** Регистрирует правило пустых строк на общем рендерере. */
export function blankLinesPlugin(md: MarkdownIt): void {
  md.core.ruler.push('blank_lines', (state) => {
    const lineCount = state.src.split('\n').length;
    const inserts = collectBlankLines(state.tokens, lineCount);
    if (inserts.size === 0) return;

    const out: Token[] = [];
    for (let i = 0; i <= state.tokens.length; i++) {
      const count = inserts.get(i);
      // Уровень маркера не участвует в разборе — он уже завершён.
      if (count !== undefined) out.push(blankToken(state, count, 0));
      if (i < state.tokens.length) out.push(state.tokens[i]!);
    }
    state.tokens = out;
  });

  md.renderer.rules[BLANK_LINE_TOKEN] = (tokens, idx) => {
    const parsed = Number.parseInt(tokens[idx]!.content, 10);
    const count = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    return `<div class="${BLANK_LINE_CLASS}" aria-hidden="true">${'<br>'.repeat(count)}</div>\n`;
  };
}
