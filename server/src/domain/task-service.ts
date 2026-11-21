/**
 * Задачи: чтение проекции и правка строк (0.16.1, задача 632eca85).
 *
 * Операции спецификации:
 *   * GET  /tasks — операция e6d65f51: scope open|done|overdue|undated, период
 *     from/to, thought_id/comment_id, keyset-курсор (стандарт 3f2fdc41),
 *     COUNT только по флагу (стандарт 5adebf61), граница «сегодня» — параметр
 *     клиента;
 *   * PATCH /tasks — операция de4cee18: ops toggle/move/cancel/set_due/undate
 *     плюс массовые cancel-all/move-all/undate-all по фильтру;
 *     `expected_revision` → 409.
 *
 * Автопериод (уточнение ТЗ 2026-11-16): строка-задача без date-ссылок в
 * хроно-записи живёт в периоде записи (срок — конец периода). Следствия для
 * правки строк:
 *   * `undate` («Сделать бессрочной») для строк хроно-записи — `BAD_REQUEST`:
 *     пере-парс вернул бы период записи, команда ничего не меняет по существу;
 *   * `set_due` и `move` для авто-строки ДОПИСЫВАЮТ явную `[[дату]]` (срок или
 *     сдвиг от конца периода) — задача закрепляется в тексте.
 *
 * Правка идёт в `body_md` источника (текст — источник истины): сервер меняет
 * указанную строку и пишет новую ревизию комментария; таблицы проекции
 * обновляет хук записи. Строки адресуются `comment_id` + `line_no` — номер
 * строки `body_md` С НУЛЯ (строка содержимого пункта, где стоит маркер);
 * маркер меняют примитивы `@etn/markdown` (`setTaskLineDone`,
 * `removeTaskLineMarker`) — грамматика `- [ ]` живёт только там.
 *
 * Даты строки — календарные date-ссылки `[[YYYY-MM-DD[ HH:MM]]]`. Перенос —
 * единый сдвиг ВСЕХ ссылок строки (требование 236d4472): 31-е при переносе
 * месяца нормализуется к последнему дню целевого месяца, период сохраняется.
 *
 * «Сегодня»/from/to приходят от клиента: сервер не хранит пояс и не решает,
 * какой сейчас день (требование fcdcd75f). Принимается календарный день
 * `YYYY-MM-DD` (единственная однозначная форма для date-ссылок) или
 * UTC-инстанс — из него берётся календарная дата по UTC. `scope=overdue` без
 * `today` — `BAD_REQUEST` (400): просрочку по своим часам сервер не считает
 * (операция e6d65f51).
 */

import {
  BASE_LAYER_ID,
  EtnError,
  type Comment,
  type TaskDTO,
  type TaskListPage,
  type TaskMassAction,
  type TaskMassFilter,
  type TaskNestedLine,
  type TaskOpAction,
  type TaskOpResult,
  type TaskPatchResult,
  type TaskScope,
  type TaskSubjectState,
  type ThoughtRef,
} from '@etn/shared';
import {
  findDateLinkSpans,
  isTaskLineMarker,
  parseDateLinkTarget,
  removeTaskLineDates,
  removeTaskLineMarker,
  setTaskLineDone,
} from '@etn/markdown';

import type { NetworkDb } from '../db/network-db.js';
import { getVisibleComment, updateComment } from './comment-service.js';
import { REF_COLUMNS, rowToThoughtRef } from './thought-ref.js';
import {
  buildTaskRows,
  readTaskProjectionMarker,
  taskRowContext,
  type ProjectionRow,
} from './task-projection.js';
import { taskRowVisibilitySql } from './task-visibility.js';

/** Предел страницы GET /tasks (как у остальных постраничных выборок). */
export const TASKS_MAX_LIMIT = 200;
/** Размер страницы по умолчанию. */
export const TASKS_DEFAULT_LIMIT = 50;

/** Параметры выборки GET /tasks. */
export interface TaskListOptions {
  scope?: TaskScope;
  from?: string;
  to?: string;
  thoughtId?: string;
  commentId?: string;
  cursor?: string;
  limit?: number;
  count?: boolean;
  /** Граница «сегодня» (локальные сутки клиента): `YYYY-MM-DD` или UTC-инстанс. */
  today?: string;
  /**
   * Дополнить страницу вложенными НЕ-задачными строками её задач (уточнение ТЗ
   * 2026-11-17, пункт F): пункты чек-листа родителя и обычные вложенные строки
   * списка. Проекция не меняется — вложенность восстанавливается по `depth` и
   * порядку строк комментария.
   */
  includeNested?: boolean;
  /**
   * Показывать ли содержимое корзины (per-user `show_trash`, по умолчанию
   * `true`). `false` — строки записей помеченных сущностей и строки-задачи,
   * адресованные помеченной мысли, не отдаются (пачка 11, задача 173e8368).
   */
  showTrash?: boolean;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Календарный день из параметра клиента: `YYYY-MM-DD` принимается как есть,
 * UTC-инстанс — по своей календарной дате в UTC. Невалидное — 400.
 */
function dayOf(value: string | undefined, field: string): string | null {
  if (value === undefined || value === '') return null;
  if (DAY_RE.test(value)) {
    // Календарная сверка (0.16.1, ошибка 47600057): форма `YYYY-MM-DD` ещё не
    // значит существующую дату — «2026-13-45» уходила в SQL-сравнение и молча
    // давала пустую или произвольную выборку. Правило календаря берём у
    // date-ссылок (`@etn/markdown`): месяц 1–12, день — по месяцу и високосности.
    if (parseDateLinkTarget(value) === null) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `${field} must be a calendar date (YYYY-MM-DD) or a UTC instant.`,
        {
          field,
        },
      );
    }
    return value;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `${field} must be a date (YYYY-MM-DD) or a UTC instant.`,
      {
        field,
      },
    );
  }
  return parsed.toISOString().slice(0, 10);
}

/** Decoded keyset position: due→period_from→id (comment_id, line_no). */
interface TaskCursor {
  v: 1;
  d: string;
  f: string;
  c: string;
  l: number;
}

/** Максимально поздняя дата — сортировочный сентинел «без срока» (в конце). */
const NO_DATE = '9999-12-31';

function encodeCursor(row: {
  due: string | null;
  period_from: string | null;
  comment_id: string;
  line_no: number;
}): string {
  const cursor: TaskCursor = {
    v: 1,
    d: row.due ?? NO_DATE,
    f: row.period_from ?? NO_DATE,
    c: row.comment_id,
    l: row.line_no,
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): TaskCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    parsed = null;
  }
  const cursor = parsed as Partial<TaskCursor> | null;
  if (
    cursor === null ||
    cursor.v !== 1 ||
    typeof cursor.d !== 'string' ||
    typeof cursor.f !== 'string' ||
    typeof cursor.c !== 'string' ||
    typeof cursor.l !== 'number'
  ) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Invalid tasks keyset cursor: the page cannot be continued.',
      { field: 'cursor' },
    );
  }
  return cursor as TaskCursor;
}

/** Условия выборки строк проекции (общие для страницы, COUNT и массовых). */
interface RowFilter {
  scope?: TaskScope;
  from?: string;
  to?: string;
  thoughtId?: string;
  commentId?: string;
  today?: string;
  /** Показывать содержимое корзины (по умолчанию `true`). */
  showTrash?: boolean;
}

interface FilterSql {
  /** JOIN с видимыми комментариями + предикат видимости строки. */
  from: string;
  where: string;
  params: unknown[];
}

/**
 * SQL-фильтр по проекции. Видимость строки — по видимости её комментария:
 * `comments_v` отдаёт победителя цепочки слоя, строка видима, когда её
 * `layer_id` совпадает со слоем победителя (`NULL` — основа).
 *
 * `scope=overdue`/`undated` — сквозные секции: `from`/`to` для отбора строк
 * игнорируются (требование 3616cfec/db1d9548). Задачи из постоянных
 * комментариев помеченных на удаление мысли/связи/публикации исключаются.
 */
function buildFilter(filter: RowFilter): FilterSql {
  const params: unknown[] = [BASE_LAYER_ID];
  const where: string[] = ['tr.is_task = 1'];
  const scope = filter.scope;

  const today = dayOf(filter.today, 'today');
  if (scope === 'open') where.push('tr.done = 0');
  if (scope === 'done') where.push('tr.done = 1');
  if (scope === 'overdue') {
    // «Сегодня» решает клиент (требование fcdcd75f): сервер не хранит пояс и не
    // подставляет сутки по своим часам — без переданной границы просрочку не
    // вычислить, это ошибка входа (операция e6d65f51).
    if (today === null) {
      throw new EtnError(
        'BAD_REQUEST',
        'scope=overdue requires today — the day boundary of the client (YYYY-MM-DD or a UTC instant).',
        { field: 'today' },
      );
    }
    where.push('tr.done = 0 AND tr.due IS NOT NULL AND tr.due < ?');
    params.push(today);
  }
  if (scope === 'undated') where.push('tr.done = 0 AND tr.period_from IS NULL');

  if (scope !== 'overdue' && scope !== 'undated') {
    const from = dayOf(filter.from, 'from');
    const to = dayOf(filter.to, 'to');
    if (from !== null) {
      where.push('tr.period_to IS NOT NULL AND tr.period_to >= ?');
      params.push(from);
    }
    if (to !== null) {
      where.push('tr.period_from IS NOT NULL AND tr.period_from <= ?');
      params.push(to);
    }
  }

  if (filter.commentId !== undefined) {
    where.push('tr.comment_id = ?');
    params.push(filter.commentId);
  }
  if (filter.thoughtId !== undefined) {
    where.push(
      `EXISTS (SELECT 1 FROM task_row_subjects s
               WHERE s.comment_id = tr.comment_id
                 AND COALESCE(s.layer_id, '') = COALESCE(tr.layer_id, '')
                 AND s.line_no = tr.line_no
                 AND s.thought_id = ?)`,
    );
    params.push(filter.thoughtId);
  }

  where.push(taskRowVisibilitySql('tr', 'v', filter.showTrash !== false));
  return {
    from: `FROM task_rows tr
           JOIN (SELECT c.id, c.layer_id, c.version, c.kind, c.owner_type, c.owner_id
                   FROM comments_v c) v
             ON v.id = tr.comment_id
            AND ((tr.layer_id IS NULL AND v.layer_id = ?) OR tr.layer_id = v.layer_id)`,
    where: where.join(' AND '),
    params,
  };
}

/**
 * Строка выборки до сборки DTO.
 */
interface TaskRow {
  comment_id: string;
  layer_id: string | null;
  line_no: number;
  text: string;
  period_from: string | null;
  period_to: string | null;
  due: string | null;
  done: number;
  subtask: number;
  parent_line_no: number | null;
  parsed_revision: number;
  auto_period: number;
  comment_revision: number;
  owner_type: string;
  owner_id: string;
  kind: string;
}

const ROW_COLUMNS = `tr.comment_id, tr.layer_id, tr.line_no, tr.text, tr.period_from, tr.period_to,
       tr.due, tr.done, tr.subtask, tr.parent_line_no, tr.parsed_revision, tr.auto_period,
       v.version AS comment_revision, v.owner_type, v.owner_id, v.kind`;

/** Прочитать состояния сущностей (мысль/связь/публикация) по id. */
function loadStates(ndb: NetworkDb, ids: readonly string[]): Map<string, boolean> {
  const states = new Map<string, boolean>();
  if (ids.length === 0) return states;
  const placeholders = ids.map(() => '?').join(', ');
  const read = (table: string, markDeletion: boolean): void => {
    const rows = ndb
      .prepare(
        `SELECT id, active${markDeletion ? ', marked_for_deletion' : ''} FROM ${table}
         WHERE id IN (${placeholders})`,
      )
      .all(...ids) as Array<{ id: string; active: number; marked_for_deletion?: number }>;
    for (const row of rows) {
      states.set(row.id, row.active === 1 && (row.marked_for_deletion ?? 0) === 0);
    }
  };
  read('thoughts_v', true);
  read('links_v', true);
  read('publications_v', true);
  return states;
}

/**
 * Мысли-субъекты строк страницы в каноне отображения (0.16.1, задача 739eb698):
 * название, иконка, цвета, стиль, `active`/`marked_for_deletion` — одним
 * чтением `thoughts_v` по `task_row_subjects`. Клиент рисует из этого набора
 * облачка строк и пункты списка «Ещё связанные мысли», не запрашивая мысль по
 * id (панель не держит собственного кэша визуала).
 */
function loadTaskSubjects(ndb: NetworkDb, ids: readonly string[]): ThoughtRef[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = ndb
    .prepare(
      `SELECT ${REF_COLUMNS} FROM thoughts_v t WHERE t.id IN (${placeholders}) ORDER BY t.id`,
    )
    .all(...ids) as Array<Parameters<typeof rowToThoughtRef>[0]>;
  return rows.map(rowToThoughtRef);
}

/**
 * Собрать DTO страницы: субъекты строки (ID-ссылки) и худшее состояние
 * владельца комментария и субъектов (`subject_state`).
 */
function toTaskDtos(
  ndb: NetworkDb,
  rows: readonly TaskRow[],
): { items: TaskDTO[]; subjects: ThoughtRef[] } {
  const commentIds = [...new Set(rows.map((row) => row.comment_id))];
  const subjects = new Map<string, string[]>();
  if (commentIds.length > 0) {
    const placeholders = commentIds.map(() => '?').join(', ');
    const subjectRows = ndb
      .prepare(
        `SELECT comment_id, layer_id, line_no, thought_id FROM task_row_subjects
         WHERE comment_id IN (${placeholders}) ORDER BY rowid`,
      )
      .all(...commentIds) as Array<{
      comment_id: string;
      layer_id: string | null;
      line_no: number;
      thought_id: string;
    }>;
    for (const row of subjectRows) {
      const key = `${row.comment_id}\u0000${row.layer_id ?? ''}\u0000${row.line_no}`;
      const list = subjects.get(key) ?? [];
      list.push(row.thought_id);
      subjects.set(key, list);
    }
  }

  const subjectIds = [...new Set([...subjects.values()].flat())];
  const ownerIds = [...new Set(rows.map((row) => row.owner_id))];
  const states = loadStates(ndb, [...new Set([...subjectIds, ...ownerIds])]);

  const items = rows.map((row) => {
    const key = `${row.comment_id}\u0000${row.layer_id ?? ''}\u0000${row.line_no}`;
    const subjectThoughts = subjects.get(key) ?? [];
    const ownerActive = states.get(row.owner_id) === true;
    const subjectsActive = subjectThoughts.every((id) => states.get(id) === true);
    const subjectState: TaskSubjectState = ownerActive && subjectsActive ? 'active' : 'inactive';
    return {
      comment_id: row.comment_id,
      line_no: row.line_no,
      text: row.text,
      period_from: row.period_from,
      period_to: row.period_to,
      due: row.due,
      auto_period: row.auto_period === 1,
      done: row.done === 1,
      subject_thoughts: subjectThoughts,
      subject_state: subjectState,
      parent_task:
        row.parent_line_no === null
          ? null
          : { comment_id: row.comment_id, line_no: row.parent_line_no },
      subtask: row.subtask === 1,
      revision: row.comment_revision,
      parsed_revision: row.parsed_revision,
      // Адрес «Открыть источник»: владелец комментария-источника и его вид.
      owner_type: row.owner_type as TaskDTO['owner_type'],
      owner_id: row.owner_id,
      kind: row.kind as TaskDTO['kind'],
    } satisfies TaskDTO;
  });
  return { items, subjects: loadTaskSubjects(ndb, subjectIds) };
}

/**
 * Вложенные НЕ-задачные строки страницы (уточнение ТЗ 2026-11-17, пункт F).
 *
 * Проекция (`task_rows`) хранит ВСЕ пункты списка, но выборка задач берёт только
 * `is_task = 1`. Пользователь обязан видеть под задачей её пункты чек-листа и
 * обычные вложенные строки, поэтому по флагу `include_nested` сервер дочитывает
 * строки тех же комментариев (`is_task = 0`) и привязывает их к ближайшей
 * вышестоящей ЗАДАЧЕ страницы.
 *
 * Вложенность восстанавливается без изменения проекции: строки комментария идут
 * в порядке `line_no`, уровень — `depth` парсера. Для пункта чек-листа есть
 * готовый `parent_line_no` (цепочка пунктов), для обычной строки текста —
 * ближайший по стеку предок с меньшим `depth`. Вложенные строки задач, которых
 * нет на странице (чужая страница/секция), не отдаются: панель рисует только
 * строки своих родителей.
 */
function loadNestedLines(ndb: NetworkDb, page: readonly TaskRow[]): TaskNestedLine[] {
  if (page.length === 0) return [];
  const commentIds = [...new Set(page.map((row) => row.comment_id))];
  const pageSet = new Set(page.map((row) => `${row.comment_id}:${row.line_no}`));
  // Тот же JOIN видимости слоя, что у выборки задач (params — [BASE_LAYER_ID]).
  const visibility = buildFilter({});
  const placeholders = commentIds.map(() => '?').join(', ');
  const all = ndb
    .prepare(
      `SELECT tr.comment_id, tr.line_no, tr.text, tr.is_task, tr.done, tr.depth, tr.parent_line_no
       ${visibility.from}
       WHERE v.id IN (${placeholders})
       ORDER BY tr.comment_id, tr.line_no`,
    )
    .all(...visibility.params, ...commentIds) as Array<{
    comment_id: string;
    line_no: number;
    text: string;
    is_task: number;
    done: number;
    depth: number;
    parent_line_no: number | null;
  }>;

  /** Задачи комментария (для разрешения цепочки чек-листа) и его строки по порядку. */
  const byComment = new Map<string, typeof all>();
  for (const row of all) {
    const list = byComment.get(row.comment_id) ?? [];
    list.push(row);
    byComment.set(row.comment_id, list);
  }

  const nested: TaskNestedLine[] = [];
  for (const [commentId, rows] of byComment) {
    /** Задачи комментария — цель привязки вложенной строки. */
    const taskAt = new Set(rows.filter((row) => row.is_task === 1).map((row) => row.line_no));
    /** Все строки комментария по номеру — цепочка пунктов чек-листа. */
    const rowAt = new Map(rows.map((row) => [row.line_no, row]));
    /** Стек предков текущей строки по `depth` (только строгие предки). */
    const stack: Array<{ lineNo: number; depth: number }> = [];
    for (const row of rows) {
      while (stack.length > 0 && stack[stack.length - 1]!.depth >= row.depth) stack.pop();
      if (row.is_task === 1) {
        stack.push({ lineNo: row.line_no, depth: row.depth });
        continue;
      }
      // Пункт чек-листа знает своего предка явно, но цепочка пунктов может быть
      // длиннее одного уровня — до задачи идём по `parent_line_no`.
      let parentTask: number | null = null;
      let cursor = row.parent_line_no;
      const seen = new Set<number>();
      while (cursor !== null && !seen.has(cursor)) {
        seen.add(cursor);
        if (taskAt.has(cursor)) {
          parentTask = cursor;
          break;
        }
        cursor = rowAt.get(cursor)?.parent_line_no ?? null;
      }
      // Обычная вложенная строка (`- текст`) предка в проекции не несёт —
      // ближайшая задача берётся из стека по `depth`.
      if (parentTask === null) {
        for (let index = stack.length - 1; index >= 0; index -= 1) {
          const ancestor = stack[index]!;
          if (taskAt.has(ancestor.lineNo)) {
            parentTask = ancestor.lineNo;
            break;
          }
        }
      }
      stack.push({ lineNo: row.line_no, depth: row.depth });
      if (parentTask === null) continue;
      if (!pageSet.has(`${commentId}:${parentTask}`)) continue;
      nested.push({
        comment_id: commentId,
        line_no: row.line_no,
        parent: { comment_id: commentId, line_no: parentTask },
        text: row.text,
        depth: row.depth,
        // Чекбокс строки — единственный признак пункта чек-листа в проекции.
        checkbox: row.parent_line_no !== null,
        // Отметка пункта — из проекции: панель показывает пункт чекбоксом
        // (0.16.1, задача 7446eb25) и не парсит источник ради галочки.
        done: row.done === 1,
      });
    }
  }
  return nested;
}

/**
 * Выборка страницы задач (GET /tasks). Читается только проекция; парсинг при
 * чтении не выполняется (ADR d0c07f33).
 */
export function listTasks(ndb: NetworkDb, options: TaskListOptions = {}): TaskListPage {
  const filter = buildFilter({
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(options.from !== undefined ? { from: options.from } : {}),
    ...(options.to !== undefined ? { to: options.to } : {}),
    ...(options.thoughtId !== undefined ? { thoughtId: options.thoughtId } : {}),
    ...(options.commentId !== undefined ? { commentId: options.commentId } : {}),
    ...(options.today !== undefined ? { today: options.today } : {}),
    ...(options.showTrash !== undefined ? { showTrash: options.showTrash } : {}),
  });
  const limit = Math.min(Math.max(options.limit ?? TASKS_DEFAULT_LIMIT, 1), TASKS_MAX_LIMIT);

  let total: number | undefined;
  if (options.count === true) {
    const row = ndb
      .prepare(`SELECT COUNT(*) AS c ${filter.from} WHERE ${filter.where}`)
      .get(...filter.params) as { c: number };
    total = row.c;
  }

  const params = [...filter.params];
  let keyset = '';
  if (options.cursor !== undefined && options.cursor !== '') {
    const cursor = decodeCursor(options.cursor);
    keyset = ` AND (COALESCE(tr.due, '${NO_DATE}'), COALESCE(tr.period_from, '${NO_DATE}'),
             tr.comment_id, tr.line_no) > (?, ?, ?, ?)`;
    params.push(cursor.d, cursor.f, cursor.c, cursor.l);
  }

  const rows = ndb
    .prepare(
      `SELECT ${ROW_COLUMNS} ${filter.from}
       WHERE ${filter.where}${keyset}
       ORDER BY COALESCE(tr.due, '${NO_DATE}'), COALESCE(tr.period_from, '${NO_DATE}'),
                tr.comment_id, tr.line_no
       LIMIT ?`,
    )
    .all(...params, limit + 1) as TaskRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null;
  const dtos = toTaskDtos(ndb, page);

  return {
    items: dtos.items,
    // Субъекты страницы — всегда (пустой массив = субъектов нет): наличие поля
    // отличает новый сервер от старого (клиент доразрешает по id) — 739eb698.
    subjects: dtos.subjects,
    cursor,
    ...(total !== undefined ? { total } : {}),
    ...(options.includeNested === true ? { nested: loadNestedLines(ndb, page) } : {}),
    max_revision: readTaskProjectionMarker(ndb),
  };
}

// ---------------------------------------------------------------------------
// Правка строк (PATCH /tasks)
// ---------------------------------------------------------------------------

/** Одна операция над строкой задачи. */
export interface TaskOpInput {
  comment_id: string;
  line_no: number;
  action: TaskOpAction;
  /** `toggle`: желаемое состояние; не задано — инверсия. */
  done?: boolean;
  /** `move`: сдвиг в днях (ровно один из `days`/`months`). */
  days?: number;
  /** `move`: сдвиг в месяцах. */
  months?: number;
  /** `set_due`: целевой срок `YYYY-MM-DD`. */
  date?: string;
  /** Ревизия комментария, которую видел клиент (обязательна для первой op записи). */
  expected_revision?: number;
}

/** Результат правки плюс изменённые комментарии (для событий и журнала). */
export interface TaskPatchOutcome extends TaskPatchResult {
  /** Комментарии, у которых появилась новая ревизия. */
  changed: Comment[];
}

/** Последний день месяца `month` (1..12) года `year`. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Единый сдвиг одной календарной даты. Перенос месяца нормализует 31-е к
 * последнему дню целевого месяца (требование 236d4472: 30.01/31.01 +месяц →
 * 28.02/28.02).
 */
export function shiftIsoDate(date: string, shift: { days?: number; months?: number }): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  if (shift.months !== undefined && shift.months !== 0) {
    const total = year * 12 + (month - 1) + shift.months;
    const nextYear = Math.floor(total / 12);
    const nextMonth = (((total % 12) + 12) % 12) + 1;
    const nextDay = Math.min(day, lastDayOfMonth(nextYear, nextMonth));
    return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`;
  }
  const base = new Date(Date.UTC(year, month - 1, day + (shift.days ?? 0)));
  return base.toISOString().slice(0, 10);
}

/**
 * Сдвинуть ВСЕ date-ссылки строки; `null` — в строке нет дат.
 *
 * Грамматику даёт только `@etn/markdown` ({@link findDateLinkSpans}): позиции
 * ссылок и целей приходят из правила `wiki_link` единого рендерера. Поэтому
 * inline-code (`` `[[2026-12-01]]` ``) и цели, которые date-ссылкой не
 * являются (`[[2026-01-05T10:00]]` — legacy-ссылка по имени), не трогаются,
 * а у ссылки с алиасом (`[[2026-11-20|созвон]]`) меняется только дата.
 */
export function shiftTaskLineDates(
  line: string,
  shift: { days?: number; months?: number },
): string | null {
  const spans = findDateLinkSpans(line);
  if (spans.length === 0) return null;
  // С конца: замены не сдвигают позиции ещё не обработанных ссылок.
  let next = line;
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const span = spans[i]!;
    const shifted = shiftIsoDate(span.parts.date, shift);
    const target = span.parts.time === null ? shifted : `${shifted} ${span.parts.time}`;
    next = `${next.slice(0, span.targetStart)}${target}${next.slice(span.targetEnd)}`;
  }
  return next;
}

/**
 * Календарных дней от `from` до `to` (обе даты `YYYY-MM-DD`, UTC-арифметика).
 */
function calendarDayDelta(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/**
 * Задать срок строки (операция `set_due`, ошибка 3f9ea2ee).
 *
 *  • в строке есть date-ссылки — все они сдвигаются так, чтобы ПОСЛЕДНЯЯ
 *    (срок) встала на `target`; период строки сохраняется (тот же единый сдвиг,
 *    что у `move`, требование 236d4472), время ссылки не меняется;
 *  • дат нет — в КОНЕЦ текста строки добавляется новая date-ссылка `[[target]]`
 *    (бессрочная задача получает срок и попадает в отборы по датам).
 *
 * `null` — строка не задача (маркера нет) или цель совпала со сроком строки:
 * двигать нечего, писать новую ревизию незачем.
 */
export function setTaskLineDue(line: string, target: string): string | null {
  if (!isTaskLineMarker(line)) return null;
  const spans = findDateLinkSpans(line);
  if (spans.length === 0) return `${line.replace(/[ \t]+$/, '')} [[${target}]]`;
  const due = spans[spans.length - 1]!;
  const days = calendarDayDelta(due.parts.date, target);
  if (days === 0) return null;
  return shiftTaskLineDates(line, { days });
}

/** Проверить сдвиг `move`: ровно один ненулевой целый сдвиг. */
function validateShift(shift: { days?: number; months?: number }): {
  days?: number;
  months?: number;
} {
  const hasDays = shift.days !== undefined;
  const hasMonths = shift.months !== undefined;
  if (hasDays === hasMonths) {
    throw new EtnError('VALIDATION_ERROR', 'move requires exactly one of days or months.', {
      field: 'ops',
    });
  }
  const value = hasDays ? shift.days! : shift.months!;
  if (!Number.isInteger(value) || value === 0) {
    throw new EtnError('VALIDATION_ERROR', 'move shift must be a non-zero integer.', {
      field: hasDays ? 'days' : 'months',
    });
  }
  return hasDays ? { days: value } : { months: value };
}

/**
 * Применить ops к строкам задач: правка `body_md` источника одной новой
 * ревизией на комментарий. Первая op каждой записи обязана нести
 * `expected_revision`; несовпадение — `VERSION_CONFLICT` (409).
 *
 * Ошибка отдельной строки (нет строки, не задача, нет дат) не отменяет
 * остальные: она попадает в `results` с `ok: false`. Ошибки входа (нет
 * `expected_revision`, неверный сдвиг) — общий 400/422, ошибка ревизии — 409.
 */
export function applyTaskOps(
  ndb: NetworkDb,
  ops: readonly TaskOpInput[],
  actorUserId: string,
): TaskPatchOutcome {
  const groups = new Map<string, TaskOpInput[]>();
  for (const op of ops) {
    const group = groups.get(op.comment_id) ?? [];
    group.push(op);
    groups.set(op.comment_id, group);
  }

  const results: TaskOpResult[] = [];
  const changed: Comment[] = [];

  for (const [commentId, group] of groups) {
    const comment = getVisibleComment(ndb, commentId);
    if (comment === null) {
      for (const op of group) {
        results.push({
          comment_id: commentId,
          line_no: op.line_no,
          ok: false,
          error: 'comment_not_found',
        });
      }
      continue;
    }
    const expected = group[0]?.expected_revision;
    if (expected === undefined) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'expected_revision is required for the first operation of each comment.',
        { field: 'ops', comment_id: commentId },
      );
    }
    if (comment.version !== expected) {
      throw new EtnError('VERSION_CONFLICT', 'comment version mismatch', {
        entity: 'comment',
        id: commentId,
        expected,
        current: comment.version,
      });
    }

    const lines = comment.body_md.split('\n');
    // Строка адресуется номером С НУЛЯ; `buildTaskRows` уже отдаёт его так же.
    // Контекст источника нужен авто-строкам: у задачи без дат период берётся из
    // записи, и перенос обязан закрепить задачу явной датой (уточнение 2026-11-16).
    const rows = new Map<number, ProjectionRow>(
      buildTaskRows(comment.body_md, taskRowContext(ndb, comment)).map((row) => [row.lineNo, row]),
    );
    let dirty = false;

    for (const op of group) {
      const row = rows.get(op.line_no);
      if (op.line_no < 0 || op.line_no >= lines.length) {
        results.push({
          comment_id: commentId,
          line_no: op.line_no,
          ok: false,
          error: 'line_not_found',
        });
        continue;
      }
      if (row === undefined || !row.isTask) {
        results.push({
          comment_id: commentId,
          line_no: op.line_no,
          ok: false,
          error: 'not_a_task',
        });
        continue;
      }
      const line = lines[op.line_no]!;
      let next: string | null = null;
      let error: string | undefined;
      if (op.action === 'toggle') {
        next = setTaskLineDone(line, op.done ?? !row.done);
      } else if (op.action === 'cancel') {
        next = removeTaskLineMarker(line);
      } else if (op.action === 'undate') {
        // Строка хроно-записи бессрочной не бывает: период вернул бы пере-парс
        // (уточнение 2026-11-16). Команда недоступна и в UI — 400 страхует
        // устаревший клиент и агента.
        if (comment.kind === 'chronological') {
          throw new EtnError(
            'BAD_REQUEST',
            'undate is not allowed for tasks of chronological records: the record period is restored on re-parse; use set_due to pin an explicit date.',
            { field: 'ops', comment_id: commentId, line_no: op.line_no },
          );
        }
        // Дат нет — операция ничего не меняет (успешный no-op): массовая
        // команда «Сделать бессрочными» не падает на уже бессрочных строках.
        next = removeTaskLineDates(line) ?? line;
      } else if (op.action === 'set_due') {
        // Тот же no-op, если выбранная дата уже равна сроку строки.
        next = setTaskLineDue(line, op.date ?? '') ?? line;
      } else {
        const shift = validateShift(op);
        // Авто-строка дат в тексте не имеет: перенос отсчитывается от конца
        // периода записи и ДОПИСЫВАЕТ явную дату — задача закрепляется
        // (уточнение 2026-11-16: «перенос дописывает дату»).
        const anchor = row.autoPeriod ? row.periodTo : null;
        if (anchor !== null) {
          next = setTaskLineDue(line, shiftIsoDate(anchor, shift)) ?? line;
        } else {
          next = shiftTaskLineDates(line, shift);
          if (next === null) error = 'undated';
        }
      }
      if (next === null) {
        results.push({
          comment_id: commentId,
          line_no: op.line_no,
          ok: false,
          error: error ?? 'not_a_task',
        });
        continue;
      }
      if (next !== line) {
        lines[op.line_no] = next;
        dirty = true;
      }
      results.push({ comment_id: commentId, line_no: op.line_no, ok: true });
    }

    if (dirty) {
      const updated = updateComment(
        ndb,
        commentId,
        { body_md: lines.join('\n') },
        expected,
        actorUserId,
      );
      changed.push(updated);
    }
  }

  return { results, revisions: changed, changed };
}

// ---------------------------------------------------------------------------
// Массовые команды (требование e6af8b9e, операция de4cee18)
// ---------------------------------------------------------------------------

/** Массовая команда PATCH /tasks. */
export interface TaskMassInput {
  action: TaskMassAction;
  filter: TaskMassFilter;
  days?: number;
  months?: number;
}

/** Строка проекции для массовой команды (без DTO-обвязки). */
interface MassRow {
  comment_id: string;
  layer_id: string | null;
  line_no: number;
  is_task: number;
  subtask: number;
  parent_line_no: number | null;
  /** Период взят из записи-источника (даты в тексте нет). */
  auto_period: number;
  /** Срок строки: у авто-строки — конец периода записи (якорь переноса). */
  due: string | null;
}

/** Строки проекции, попадающие под фильтр массовой команды. */
function selectMassRows(ndb: NetworkDb, filter: TaskMassFilter): MassRow[] {
  const built = buildFilter({
    scope: filter.scope ?? 'open',
    ...(filter.from !== undefined ? { from: filter.from } : {}),
    ...(filter.to !== undefined ? { to: filter.to } : {}),
    ...(filter.thought_id !== undefined ? { thoughtId: filter.thought_id } : {}),
    ...(filter.comment_id !== undefined ? { commentId: filter.comment_id } : {}),
    ...(filter.today !== undefined ? { today: filter.today } : {}),
  });
  return ndb
    .prepare(
      `SELECT tr.comment_id, tr.layer_id, tr.line_no, tr.is_task, tr.subtask, tr.parent_line_no,
              tr.auto_period, tr.due
       ${built.from}
       WHERE ${built.where} AND tr.done = 0
       ORDER BY tr.comment_id, tr.line_no`,
    )
    .all(...built.params) as MassRow[];
}

/**
 * Массовая команда: одна транзакция на команду (вызывающий уже открыл её
 * обёрткой записи), правка текстов источников, undo — данными прежней ревизии
 * (клиент сохраняет тело до вызова).
 *
 * `cancel-all` снимает маркер у задач и их подстрок-подзадач; `move-all`
 * переносит все date-ссылки выбранных строк единым сдвигом (строки без дат и
 * без авто-периода пропускаются с `undated`; авто-строки хроно-записи
 * закрепляются явной датой от конца периода записи); `undate-all` удаляет все
 * date-ссылки строк («Сделать бессрочными», ошибка 3cef7466), уже бессрочные
 * строки — no-op, а строки хроно-записей пропускаются с `undate_not_allowed`
 * (период вернул бы пере-парс, уточнение 2026-11-16).
 */
export function applyTaskMassCommand(
  ndb: NetworkDb,
  command: TaskMassInput,
  actorUserId: string,
): TaskPatchOutcome {
  const shift =
    command.action === 'move-all'
      ? validateShift({
          ...(command.days !== undefined ? { days: command.days } : {}),
          ...(command.months !== undefined ? { months: command.months } : {}),
        })
      : null;

  const selected = selectMassRows(ndb, command.filter);
  const results: TaskOpResult[] = [];
  const changed: Comment[] = [];

  /** comment_id → строки для правки (с учётом подзадач при отмене). */
  const byComment = new Map<
    string,
    Array<{ line_no: number; task: boolean; autoDue: string | null }>
  >();
  const commentLayer = new Map<string, string | null>();
  for (const row of selected) {
    const list = byComment.get(row.comment_id) ?? [];
    list.push({
      line_no: row.line_no,
      task: row.is_task === 1,
      // Якорь переноса авто-строки — конец периода записи (у обычной строки null).
      autoDue: row.auto_period === 1 ? row.due : null,
    });
    byComment.set(row.comment_id, list);
    commentLayer.set(row.comment_id, row.layer_id);
  }

  if (command.action === 'cancel-all' && byComment.size > 0) {
    // Подстроки-подзадачи выбранных задач снимаются вместе с ними.
    const ids = [...byComment.keys()];
    const placeholders = ids.map(() => '?').join(', ');
    const allRows = ndb
      .prepare(
        `SELECT comment_id, layer_id, line_no, is_task, subtask, parent_line_no
         FROM task_rows
         WHERE comment_id IN (${placeholders}) AND subtask = 1
         ORDER BY comment_id, line_no`,
      )
      .all(...ids) as MassRow[];
    for (const [commentId, list] of byComment) {
      const parentSet = new Set(list.filter((entry) => entry.task).map((entry) => entry.line_no));
      let grown = true;
      // Замыкание вложенных подзадач по цепочке parent_line_no.
      while (grown) {
        grown = false;
        for (const row of allRows) {
          if (row.comment_id !== commentId || row.layer_id !== commentLayer.get(commentId))
            continue;
          if (parentSet.has(row.line_no) || row.parent_line_no === null) continue;
          if (!parentSet.has(row.parent_line_no)) continue;
          parentSet.add(row.line_no);
          list.push({ line_no: row.line_no, task: false, autoDue: null });
          grown = true;
        }
      }
    }
  }

  for (const [commentId, entries] of byComment) {
    const comment = getVisibleComment(ndb, commentId);
    if (comment === null) {
      for (const entry of entries) {
        results.push({
          comment_id: commentId,
          line_no: entry.line_no,
          ok: false,
          error: 'comment_not_found',
        });
      }
      continue;
    }
    const lines = comment.body_md.split('\n');
    const seen = new Set<number>();
    let dirty = false;
    for (const entry of entries) {
      if (seen.has(entry.line_no)) continue;
      seen.add(entry.line_no);
      if (entry.line_no < 0 || entry.line_no >= lines.length) {
        results.push({
          comment_id: commentId,
          line_no: entry.line_no,
          ok: false,
          error: 'line_not_found',
        });
        continue;
      }
      const line = lines[entry.line_no]!;
      let next: string | null;
      let error: string | undefined;
      if (command.action === 'cancel-all') {
        next = removeTaskLineMarker(line);
        if (next === null) error = 'not_a_task';
      } else if (command.action === 'undate-all') {
        // Строка хроно-записи бессрочной не бывает: период вернул бы пере-парс
        // (уточнение 2026-11-16). Одиночная команда отвечает 400, массовая —
        // пропускает такие строки, чтобы команда работала по остальным.
        if (comment.kind === 'chronological') {
          results.push({
            comment_id: commentId,
            line_no: entry.line_no,
            ok: false,
            error: 'undate_not_allowed',
          });
          continue;
        }
        // Уже бессрочная строка — успешный no-op (в выборке могут быть такие).
        next = removeTaskLineDates(line) ?? line;
      } else if (entry.autoDue !== null) {
        // Авто-строка хроно-записи: дат в тексте нет — перенос отсчитывается от
        // конца периода записи и дописывает явную дату (задача закрепляется).
        next = setTaskLineDue(line, shiftIsoDate(entry.autoDue, shift!)) ?? line;
      } else {
        next = shiftTaskLineDates(line, shift!);
        if (next === null) error = 'undated';
      }
      if (next === null) {
        results.push({
          comment_id: commentId,
          line_no: entry.line_no,
          ok: false,
          error: error ?? 'not_a_task',
        });
        continue;
      }
      if (next !== line) {
        lines[entry.line_no] = next;
        dirty = true;
      }
      results.push({ comment_id: commentId, line_no: entry.line_no, ok: true });
    }
    if (dirty) {
      const updated = updateComment(
        ndb,
        commentId,
        { body_md: lines.join('\n') },
        undefined,
        actorUserId,
      );
      changed.push(updated);
    }
  }

  return { results, revisions: changed, changed };
}
