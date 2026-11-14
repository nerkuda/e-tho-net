/**
 * Задачи — DTO материализованной проекции задач (0.16.1, задача
 * «0.16.1: сервер задач»; ADR d0c07f33, сущность `tasks` 46e00dde, операции
 * e6d65f51 (GET /tasks) и de4cee18 (PATCH /tasks)).
 *
 * Задача — строка `- [ ]` в `body_md` комментария (хроно-записи ИЛИ постоянного).
 * Текст — источник истины; таблицы `task_rows` / `task_row_dates` /
 * `task_row_subjects` — пере-создаваемая парсером проекция (`@etn/markdown`,
 * `parseTaskLines`), состояние — только чекбокс в тексте.
 *
 * **Нумерация строк.** `line_no` — номер строки `body_md` с нуля (операция
 * PATCH /tasks: «адресация строки: `comment_id` + `line_no` (нумерация с 0 по
 * строкам body_md)»). Парсер `TaskLine.lineNo` нумерует с единицы, поэтому
 * проекция сдвигает его на -1. Строка — СТРОКА СОДЕРЖИМОГО пункта: именно в
 * ней стоит маркер (у пункта `-\n  [ ] текст` — вторая строка записи).
 */

import type { CommentKind } from '../enums.js';
import type { Comment, CommentOwnerKind } from './comment.js';

/** Основа выборки GET /tasks (операция e6d65f51). */
export const TASK_SCOPES = ['open', 'done', 'overdue', 'undated'] as const;
export type TaskScope = (typeof TASK_SCOPES)[number];

/** Операции правки одной строки (PATCH /tasks, операция de4cee18). */
export const TASK_OPS = ['toggle', 'move', 'cancel'] as const;
export type TaskOpAction = (typeof TASK_OPS)[number];

/** Массовые команды группы «Задачи периода» (требование e6af8b9e). */
export const TASK_MASS_ACTIONS = ['cancel-all', 'move-all'] as const;
export type TaskMassAction = (typeof TASK_MASS_ACTIONS)[number];

/**
 * Состояние сущностей строки: худшее из состояний владельца комментария и
 * мыслей-субъектов строки (`inactive` — есть неактуальная/удалённая/пометенная
 * на удаление сущность). Показ неактуальных решает клиент по настройке сети.
 */
export const TASK_SUBJECT_STATES = ['active', 'inactive'] as const;
export type TaskSubjectState = (typeof TASK_SUBJECT_STATES)[number];

/** Адрес строки задачи: комментарий-источник + номер строки (с нуля). */
export interface TaskRef {
  comment_id: string;
  /** Номер строки `body_md` с нуля (строка содержимого пункта). */
  line_no: number;
}

/** Задача в выдаче REST/MCP — проекция строки `task_rows`. */
export interface TaskDTO extends TaskRef {
  /** Снапшот строки без маркера задачи (текст из парсера). */
  text: string;
  /** Первая date-ссылка строки (`YYYY-MM-DD`), `null` — строка без дат. */
  period_from: string | null;
  /** Последняя date-ссылка строки (`YYYY-MM-DD`), `null` — строка без дат. */
  period_to: string | null;
  /** Срок = последняя date-ссылка строки. */
  due: string | null;
  /** Единственное состояние задачи — чекбокс текста. */
  done: boolean;
  /** Мысли из ID-ссылок `[[#uuid]]` строки (legacy-имена не собираются). */
  subject_thoughts: string[];
  /** Худшее состояние владельца комментария и субъектов строки. */
  subject_state: TaskSubjectState;
  /** Ближайшая вышестоящая ЗАДАЧА того же списка (пункт чек-листа — не задача). */
  parent_task: TaskRef | null;
  /** Подстрока без собственной даты при наличии родителя-задачи. */
  subtask: boolean;
  /** Ревизия комментария-источника, которую видит текущий контекст слоя. */
  revision: number;
  /** Ревизия комментария, из которой построена строка проекции. */
  parsed_revision: number;
  /**
   * Владелец комментария-источника и его вид — адрес «Открыть источник»:
   * у постоянного комментария открывается карточка владельца (мысль/связь/
   * публикация), а не день строки (0.16.1, требование «задачи из постоянных
   * комментариев»).
   */
  owner_type: CommentOwnerKind;
  owner_id: string;
  /** Вид комментария-источника (`permanent` | `chronological`). */
  kind: CommentKind;
}

/**
 * Страница задач. `cursor` — keyset-курсор следующей страницы (`null` — хвоста
 * нет), `total` — только по явному флагу `count`, `max_revision` — глобальный
 * маркер сети: клиент сравнивает его со своим и показывает «Обновить».
 */
export interface TaskListPage {
  items: TaskDTO[];
  cursor: string | null;
  total?: number;
  max_revision: number;
}

/** Итог одной операции PATCH /tasks. */
export interface TaskOpResult extends TaskRef {
  ok: boolean;
  /** Код причины отказа: `line_not_found`, `not_a_task`, `undated`, `comment_not_found`. */
  error?: string;
}

/** Ответ PATCH /tasks: результаты по каждой строке + новые ревизии источников. */
export interface TaskPatchResult {
  results: TaskOpResult[];
  /** Новые ревизии изменённых комментариев (undo — данными прежней ревизии). */
  revisions: Comment[];
}

/** Фильтр массовой команды (по уже существующей проекции). */
export interface TaskMassFilter {
  scope?: TaskScope;
  from?: string;
  to?: string;
  thought_id?: string;
  comment_id?: string;
  /** Граница «сегодня» (локальные сутки клиента) — `YYYY-MM-DD`. */
  today?: string;
}
