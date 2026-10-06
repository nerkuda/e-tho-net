/**
 * Чистые преобразования markdown для команд форматирования поля комментария
 * (0.12.1, задача ab0c4470, ТП1 «Команды редактирования комментария»).
 *
 * Модуль не зависит от DOM и CodeMirror: на входе — {@link EditorSnapshot}
 * (текст + главное выделение), на выходе — {@link TextEdit} (правки и новое
 * выделение). Это делает поведение команд полностью проверяемым юнит-тестами
 * (DoD задачи: «тесты преобразования выделения/блока»), а редактор остаётся
 * тонким исполнителем транзакций (`MdEditor.applyEdit`).
 *
 * Соглашения markdown:
 *  • внутристрочные команды — оборачивание/разворачивание пары маркеров;
 *  • блочные — маркер в начале каждой выделенной строки (с учётом отступа),
 *    повторный вызов снимает маркер (toggle);
 *  • перемещение строк и сдвиг — необратимые команды, возвращают `null`,
 *    когда применять нечего.
 */

import type {
  MdEditorChange,
  MdEditorEdit,
  MdEditorSnapshot as EditorSnapshot,
} from './md-editor.js';

export type { MdEditorEdit, MdEditorSnapshot as EditorSnapshot } from './md-editor.js';

/** Результат преобразования: правки и итоговое выделение. */
export type TextEdit = MdEditorEdit;

/* ------------------------------------------------------------------ *
 * Перепрокладка позиций после асинхронного ожидания.
 * ------------------------------------------------------------------ */

/**
 * Актуальные границы выделения для правки, позиции которой сняты ДО
 * асинхронного ожидания (чтение/запись буфера обмена, разворот трансклюзий).
 *
 * Возвращает `{ from, to }` ТЕКУЩЕГО выделения, если оно всё ещё содержит тот
 * же текст, что и выделение снимка `before`; иначе `null` — контекст изменился
 * и правку применять нельзя (ошибка `486d0ef1`).
 *
 * Абсолютные офсеты `before` после ожидания могли сместиться: правки, вставшие
 * ДО выделения, редактор (CM6) перепрокладывает вместе с выделением, поэтому
 * сверять одни числа нельзя — сверяется содержимое. У пустого выделения
 * (каретка) содержимого нет, поэтому для него возвращается текущая каретка:
 * вставка идёт туда, где каретка стоит сейчас.
 */
export function relocatedSelection(
  before: EditorSnapshot,
  after: EditorSnapshot,
): { from: number; to: number } | null {
  const selected = before.text.slice(before.from, before.to);
  if (after.text.slice(after.from, after.to) !== selected) return null;
  return { from: after.from, to: after.to };
}

/* ------------------------------------------------------------------ *
 * Разбор строк и блоков.
 * ------------------------------------------------------------------ */

/** Начало строки, содержащей `pos`. */
export function lineStartAt(text: string, pos: number): number {
  const index = text.lastIndexOf('\n', Math.max(0, pos - 1));
  return index + 1;
}

/** Конец строки, содержащей `pos` (без завершающего перевода строки). */
export function lineEndAt(text: string, pos: number): number {
  const index = text.indexOf('\n', pos);
  return index === -1 ? text.length : index;
}

/** Индекс строки (с нуля), содержащей `pos`. */
function lineIndexAt(text: string, pos: number): number {
  return text.slice(0, pos).split('\n').length - 1;
}

/** Диапазон полных строк, покрытых выделением. */
function blockRange(snap: EditorSnapshot): { start: number; end: number } {
  const start = lineStartAt(snap.text, snap.from);
  const endPos = snap.to > snap.from ? snap.to - 1 : snap.to;
  const end = lineEndAt(snap.text, Math.max(start, endPos));
  return { start, end };
}

/** Строки, покрытые выделением. */
function blockLines(snap: EditorSnapshot): string[] {
  const { start, end } = blockRange(snap);
  return snap.text.slice(start, end).split('\n');
}

/** Разбивает строку на отступ и содержимое. */
function splitLine(line: string): { indent: string; body: string } {
  const match = /^([ \t]*)([\s\S]*)$/.exec(line);
  return { indent: match?.[1] ?? '', body: match?.[2] ?? '' };
}

/** Непустые «тела» строк блока (без отступа). */
function blockBodies(snap: EditorSnapshot): string[] {
  return blockLines(snap)
    .map((line) => splitLine(line).body)
    .filter((body) => body !== '');
}

/** Позиция каретки после маркера строки (нет маркера — после отступа). */
function caretAfter(newLine: string, marker: RegExp): number {
  const match = marker.exec(newLine);
  if (match !== null) return match[0].length;
  return /^[ \t]*/.exec(newLine)?.[0].length ?? 0;
}

/**
 * Применяет пофункциональное преобразование к каждой строке блока. Если ничего
 * не изменилось — возвращает пустую правку с прежним выделением.
 *
 * `caretOffset` включается только при каретке (пустое выделение): он даёт
 * позицию каретки ВНУТРИ строки каретки — так блочная команда на пустой
 * строке вставляет маркер и ставит каретку после него (элемент `1ab005ca`).
 * При непустом выделении результат выделяет весь блок.
 */
function editBlock(
  snap: EditorSnapshot,
  map: (body: string, indent: string, index: number, count: number) => string,
  caretOffset?: (newLine: string, lineIndex: number) => number,
): TextEdit {
  const { start, end } = blockRange(snap);
  const lines = snap.text.slice(start, end).split('\n');
  const next = lines.map((line, index) => {
    const { indent, body } = splitLine(line);
    return map(body, indent, index, lines.length);
  });
  if (next.every((line, index) => line === lines[index])) {
    return { changes: [], selection: { anchor: snap.from, head: snap.to } };
  }
  const insert = next.join('\n');
  const changes: MdEditorChange[] = [{ from: start, to: end, insert }];
  if (snap.from === snap.to && caretOffset !== undefined) {
    const caretLine = snap.text.slice(start, snap.from).split('\n').length - 1;
    let pos = start;
    for (let i = 0; i < caretLine; i += 1) pos += (next[i]?.length ?? 0) + 1;
    const col = caretOffset(next[caretLine] ?? '', caretLine);
    return { changes, selection: { anchor: pos + col, head: pos + col } };
  }
  return { changes, selection: { anchor: start, head: start + insert.length } };
}

/* ------------------------------------------------------------------ *
 * Внутристрочные команды.
 * ------------------------------------------------------------------ */

/**
 * Оборачивает/разворачивает выделение парой маркеров. При каретке вставляет
 * пару и ставит каретку между маркерами; при повторном вызове внутри уже
 * обёрнутого фрагмента маркеры снимаются.
 */
export function toggleInline(snap: EditorSnapshot, open: string, close: string = open): TextEdit {
  const { text, from, to } = snap;
  // Маркеры непосредственно снаружи выделения/каретки.
  const outside =
    from >= open.length &&
    text.slice(from - open.length, from) === open &&
    text.slice(to, to + close.length) === close;
  if (outside) {
    const changes: MdEditorChange[] = [
      { from: from - open.length, to: from, insert: '' },
      { from: to, to: to + close.length, insert: '' },
    ];
    return {
      changes,
      selection: { anchor: from - open.length, head: to - open.length },
    };
  }
  if (from !== to) {
    const selected = text.slice(from, to);
    // Выделение уже целиком в маркерах — разворачиваем внутренность.
    if (
      selected.length > open.length + close.length &&
      selected.startsWith(open) &&
      selected.endsWith(close)
    ) {
      const inner = selected.slice(open.length, selected.length - close.length);
      return { changes: [{ from, to, insert: inner }], selection: { anchor: from, head: from + inner.length } };
    }
    const insert = open + selected + close;
    return {
      changes: [{ from, to, insert }],
      selection: { anchor: from + open.length, head: to + open.length },
    };
  }
  // Каретка внутри уже обёрнутого фрагмента — снимаем формат.
  const enclosing = findEnclosing(snap, open, close);
  if (enclosing !== null) {
    const changes: MdEditorChange[] = [
      { from: enclosing.openFrom, to: enclosing.openFrom + open.length, insert: '' },
      { from: enclosing.closeTo - close.length, to: enclosing.closeTo, insert: '' },
    ];
    const caret = from - open.length;
    return { changes, selection: { anchor: caret, head: caret } };
  }
  const insert = open + close;
  return {
    changes: [{ from, to: from, insert }],
    selection: { anchor: from + open.length, head: from + open.length },
  };
}

/**
 * Пара маркеров, внутри которой стоит каретка (`**he|llo**`). Возвращает
 * границы обёртки либо `null`. Маркер не считается частью более длинной серии
 * того же символа (чтобы `*` не «поймался» внутри `**…**`), обёртка не
 * пересекает перевод строки.
 */
function findEnclosing(
  snap: EditorSnapshot,
  open: string,
  close: string,
): { openFrom: number; closeTo: number } | null {
  if (snap.from !== snap.to) return null;
  const { text, from } = snap;
  // Ищем открывающий маркер СТРОГО до каретки (`from - 1`): если каретка стоит
  // перед закрывающим маркером, `lastIndexOf(open, from)` вернул бы его самого.
  const left = from === 0 ? -1 : text.lastIndexOf(open, from - 1);
  if (left === -1) return null;
  if (left > 0 && text[left - 1] === open[0]) return null;
  const innerStart = left + open.length;
  if (innerStart > from) return null;
  const right = text.indexOf(close, from);
  if (right === -1) return null;
  if (right + close.length < text.length && text[right + close.length] === close[0]) return null;
  if (text.slice(innerStart, right).includes('\n')) return null;
  return { openFrom: left, closeTo: right + close.length };
}

/** Активна ли внутристрочная команда для текущего выделения/каретки. */
export function isInlineActive(snap: EditorSnapshot, open: string, close: string = open): boolean {
  const { text, from, to } = snap;
  if (
    from >= open.length &&
    text.slice(from - open.length, from) === open &&
    text.slice(to, to + close.length) === close
  ) {
    return true;
  }
  if (from === to) return findEnclosing(snap, open, close) !== null;
  const selected = text.slice(from, to);
  return selected.length > open.length + close.length && selected.startsWith(open) && selected.endsWith(close);
}

/* ------------------------------------------------------------------ *
 * Блочные команды (маркер в начале строки).
 * ------------------------------------------------------------------ */

/** Любой блочный маркер (заголовок/список/задача/цитата), снимаемый при переоформлении. */
const ANY_BLOCK_MARKER = /^(?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] |#{1,6} |> )/;

const BULLET_OWN = /^[-*+] (?!\[[ xX]\] )/;
const ORDERED_OWN = /^\d+[.)] /;
const TASK_OWN = /^[-*+] \[[ xX]\] /;
const QUOTE_OWN = /^> ?/;

/** Цикл toggle: если у ВСЕХ непустых строк уже свой маркер — снимаем. */
function allOwn(bodies: string[], own: RegExp): boolean {
  return bodies.length > 0 && bodies.every((body) => own.test(body));
}

/**
 * Заголовок H1–H3 (toggle: повторный вызов снимает заголовок). На пустой
 * строке/пустом поле маркер ставится, каретка — после него.
 */
export function toggleHeading(snap: EditorSnapshot, level: 1 | 2 | 3): TextEdit {
  const marker = `${'#'.repeat(level)} `;
  const own = new RegExp(`^#{${level}} `);
  const isAll = allOwn(blockBodies(snap), own);
  return editBlock(
    snap,
    (body, indent) => {
      if (isAll) return indent + body.replace(own, '');
      return `${indent}${marker}${body.replace(/^#{1,6} /, '')}`;
    },
    (line) => caretAfter(line, /^[ \t]*#{1,6} /),
  );
}

/** Маркированный список (`- `). */
export function toggleBulletList(snap: EditorSnapshot): TextEdit {
  const isAll = allOwn(blockBodies(snap), BULLET_OWN);
  return editBlock(
    snap,
    (body, indent) => {
      if (isAll) return indent + body.replace(/^[-*+] /, '');
      return `${indent}- ${body.replace(ANY_BLOCK_MARKER, '')}`;
    },
    (line) => caretAfter(line, /^[ \t]*[-*+] (?!\[[ xX]\] )/),
  );
}

/** Нумерованный список (`1. `, `2. `, … — нумерация подряд). */
export function toggleOrderedList(snap: EditorSnapshot): TextEdit {
  const isAll = allOwn(blockBodies(snap), ORDERED_OWN);
  let counter = 0;
  return editBlock(
    snap,
    (body, indent) => {
      if (isAll) return indent + body.replace(ORDERED_OWN, '');
      counter += 1;
      return `${indent}${counter}. ${body.replace(ANY_BLOCK_MARKER, '')}`;
    },
    (line) => caretAfter(line, /^[ \t]*\d+[.)] /),
  );
}

/** Список задач (`- [ ] `). */
export function toggleTaskList(snap: EditorSnapshot): TextEdit {
  const isAll = allOwn(blockBodies(snap), TASK_OWN);
  return editBlock(
    snap,
    (body, indent) => {
      if (isAll) return indent + body.replace(TASK_OWN, '');
      return `${indent}- [ ] ${body.replace(ANY_BLOCK_MARKER, '')}`;
    },
    (line) => caretAfter(line, /^[ \t]*[-*+] \[[ xX]\] /),
  );
}

/** Цитата (`> `). */
export function toggleBlockquote(snap: EditorSnapshot): TextEdit {
  const isAll = allOwn(blockBodies(snap), QUOTE_OWN);
  return editBlock(
    snap,
    (body, indent) => {
      if (isAll) return indent + body.replace(QUOTE_OWN, '');
      return `${indent}> ${body}`;
    },
    (line) => caretAfter(line, /^[ \t]*> /),
  );
}

/** Активность блочного маркера: все непустые строки уже имеют маркер. */
export function isBlockMarkerActive(snap: EditorSnapshot, own: RegExp): boolean {
  return allOwn(blockBodies(snap), own);
}

/** Предикаты активности блочных команд для состояния кнопок. */
export const blockMarker = {
  bullet: BULLET_OWN,
  ordered: ORDERED_OWN,
  task: TASK_OWN,
  quote: QUOTE_OWN,
} as const;

/** Активен ли заголовок указанного уровня на текущей строке. */
export function isHeadingActive(snap: EditorSnapshot, level: 1 | 2 | 3): boolean {
  const own = new RegExp(`^#{${level}} `);
  const bodies = blockBodies(snap);
  return bodies.length > 0 && bodies.every((body) => own.test(body));
}

/* ------------------------------------------------------------------ *
 * Блоки-вставки.
 * ------------------------------------------------------------------ */

/** Блок кода: оборачивает выделенные строки забором; при каретке — пустой блок. */
export function insertCodeBlock(snap: EditorSnapshot): TextEdit {
  const fence = '```';
  if (snap.from === snap.to) {
    const insert = `${fence}\n\n${fence}`;
    const caret = snap.from + fence.length + 1;
    return { changes: [{ from: snap.from, to: snap.from, insert }], selection: { anchor: caret, head: caret } };
  }
  const { start, end } = blockRange(snap);
  const block = snap.text.slice(start, end);
  const insert = `${fence}\n${block}\n${fence}`;
  return {
    changes: [{ from: start, to: end, insert }],
    selection: { anchor: start, head: start + insert.length },
  };
}

/** Разделитель `---` отдельной строкой. */
export function insertSeparator(snap: EditorSnapshot): TextEdit {
  const { text, from } = snap;
  const start = lineStartAt(text, from);
  const end = lineEndAt(text, from);
  if (snap.from === snap.to && text.slice(start, end).trim() === '') {
    const caret = start + 3;
    return { changes: [{ from: start, to: end, insert: '---' }], selection: { anchor: caret, head: caret } };
  }
  const insert = from === start ? '---\n' : '\n---\n';
  const caret = from + insert.length;
  return { changes: [{ from, to: from, insert }], selection: { anchor: caret, head: caret } };
}

/** Таблица — шаблон 2×2 без языковых строк. */
export function insertTable(snap: EditorSnapshot): TextEdit {
  const { text, from } = snap;
  const start = lineStartAt(text, from);
  const template = '|  |  |\n| --- | --- |\n|  |  |';
  const insert = from > start ? `\n${template}` : template;
  const caret = from + insert.length;
  return { changes: [{ from, to: from, insert }], selection: { anchor: caret, head: caret } };
}

/** HTML-комментарий: оборачивает выделение либо вставляет пустой с кареткой внутри. */
export function insertHtmlComment(snap: EditorSnapshot): TextEdit {
  const { text, from, to } = snap;
  if (from !== to) {
    const inner = text.slice(from, to);
    const insert = `<!-- ${inner} -->`;
    return {
      changes: [{ from, to, insert }],
      selection: { anchor: from + 5, head: from + 5 + inner.length },
    };
  }
  const insert = '<!--  -->';
  const caret = from + 5;
  return { changes: [{ from, to: from, insert }], selection: { anchor: caret, head: caret } };
}

/* ------------------------------------------------------------------ *
 * Перемещение строк и сдвиг.
 * ------------------------------------------------------------------ */

/** Можно ли переместить строку в заданном направлении. */
export function canMoveLine(snap: EditorSnapshot, direction: 'up' | 'down'): boolean {
  const lines = snap.text.split('\n');
  const startLine = lineIndexAt(snap.text, lineStartAt(snap.text, snap.from));
  const endLine = lineIndexAt(snap.text, blockRange(snap).end);
  if (direction === 'up') return startLine > 0;
  const effective = snap.text.endsWith('\n') ? lines.length - 1 : lines.length;
  return endLine < effective - 1;
}

/** Перемещает строку (блок строк) выше/ниже; `null` — перемещать нечего. */
export function moveLine(snap: EditorSnapshot, direction: 'up' | 'down'): TextEdit | null {
  if (!canMoveLine(snap, direction)) return null;
  const lines = snap.text.split('\n');
  const startLine = lineIndexAt(snap.text, lineStartAt(snap.text, snap.from));
  const endLine = lineIndexAt(snap.text, blockRange(snap).end);
  let removed = '';
  if (direction === 'up') {
    removed = lines.splice(startLine - 1, 1)[0] ?? '';
    lines.splice(endLine, 0, removed);
  } else {
    removed = lines.splice(endLine + 1, 1)[0] ?? '';
    lines.splice(startLine, 0, removed);
  }
  const newText = lines.join('\n');
  const delta = direction === 'up' ? -(removed.length + 1) : removed.length + 1;
  const shift = (pos: number): number => Math.max(0, Math.min(newText.length, pos + delta));
  return {
    changes: [{ from: 0, to: snap.text.length, insert: newText }],
    selection: { anchor: shift(snap.from), head: shift(snap.to) },
  };
}

/** Сдвиг строк вправо (два пробела) или влево (снять отступ). */
export function indentLines(snap: EditorSnapshot, direction: 'in' | 'out'): TextEdit {
  return editBlock(snap, (body, indent, _index, _count) => {
    const line = indent + body;
    if (line.trim() === '') return line;
    if (direction === 'in') return `  ${line}`;
    return line.replace(/^(\t| {1,2})/, '');
  });
}

/** Есть ли что снимать при сдвиге влево (отступ или вложенность списка). */
export function canOutdent(snap: EditorSnapshot): boolean {
  return blockLines(snap).some((line) => line.trim() !== '' && /^[ \t]/.test(line));
}
