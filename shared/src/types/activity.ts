/**
 * Activity-log DTO (задача f2eca5a4 «Журнал activity_log: запись, миграция,
 * REST /activity», требование b0c7a57c «activity_log — состав записи»,
 * операция 70dfe81d «/activity — лента, свёртка и обрезка»,
 * docs/03-server-api.md §13d).
 *
 * Журнал долговременный (не ветвится, как `object_locks` из миграции 034):
 * сервер пишет в `activity_log` ровно одну строку на каждую операцию
 * изменения сущности сети. Снимок `entity_title` сохраняет смысл записи
 * после удаления самой сущности — лимит 256 символов, обрезка с «…»
 * выполняется централизованно в `server/src/domain/activity-snapshot.ts`.
 *
 * `user_name` в wire-shape присутствует как опциональное разрешённое поле —
 * сервер резолвит его при чтении через системную таблицу `users` или
 * агрегацию по участникам сети; в самой `activity_log` хранится только id.
 *
 * События захвата (`edit.*`), per-user real-time (audience=user) и операции
 * чтения в журнал не пишутся.
 */

/**
 * Действия, оставляющие запись в `activity_log` (требование b0c7a57c).
 * Состав растёт вместе с доменом — текстовое поле без CHECK, чтобы новые
 * действия не требовали миграции.
 */
export type ActivityAction =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'trashed'
  | 'restored';

/**
 * Виды сущностей, изменение которых оставляет запись в `activity_log`.
 * Состав совпадает с LockEntityType и расширен «comment»/«attachment»/
 * «layer», которые захватываются, но не пишутся в журнал под `edit.*`.
 */
export type ActivityEntityType =
  | 'thought'
  | 'link'
  | 'thought_type'
  | 'link_type'
  | 'property'
  | 'comment'
  | 'attachment'
  | 'layer';

/** Лимит длины снимка `entity_title` — формируется в activity-snapshot.ts. */
export const ACTIVITY_TITLE_MAX = 256;

/**
 * Запись журнала активности (`activity_log`). Один и тот же DTO используется
 * в REST `GET /activity` и в MCP `etn.activity.list` — паритет операций
 * (стандарт 9e5cff3f).
 */
export interface ActivityRow {
  /** UUID записи журнала. */
  id: string;
  /** Исполнитель операции (id пользователя). */
  user_id: string;
  /**
   * Имя пользователя на момент чтения — резолвится сервером из
   * `users`/участников сети; в самой `activity_log` не хранится.
   * Отсутствует, если пользователь удалён.
   */
  user_name?: string | null;
  /** Что произошло с сущностью. */
  action: ActivityAction | string;
  /** Вид сущности. */
  entity_type: ActivityEntityType | string;
  /** Id сущности внутри `entity_type`. */
  entity_id: string;
  /** Краткий снимок описания сущности на момент события (≤ 256 символов). */
  entity_title: string;
  /** Слой на момент операции — снимок, не условие фильтра ленты. */
  layer_id: string | null;
  /** Wall-clock время события, миллисекунды с эпохи. */
  occurred_at_ms: number;
}

/** Параметры фильтра/пагинации `GET /activity` и `etn.activity.list`. */
export interface ActivityListParams {
  /** Идентификатор сети (уже задан URL'ом, но нужен доменному сервису). */
  networkId: string;
  /** Включать события не раньше этого `occurred_at_ms`. */
  from_ms?: number;
  /** Включать события не позже этого `occurred_at_ms`. */
  to_ms?: number;
  /** Оставить только записи конкретного исполнителя. */
  user_id?: string;
  /** Оставить только записи по сущностям указанного вида. */
  entity_type?: string;
  /** Оставить только записи по конкретной сущности (требует `entity_type`). */
  entity_id?: string;
  /** Размер страницы (default 50, max 200 — как у других list-эндпоинтов). */
  limit?: number;
  /** Смещение для пагинации. */
  offset?: number;
}
