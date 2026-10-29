/**
 * Чистка незаписанных черновиков при старте клиента (ошибка fb9d6058,
 * решение пользователя 2026-10-29, директива в хроно ошибки).
 *
 * Пока клиент запущен, он борется за черновики: `pending` досылается на каждом
 * восстановлении связи. Но перезапуск может состояться через неизвестное время,
 * а за это время в сети могли появиться правильные записи через других
 * клиентов или MCP/REST. Черновик с устаревшей `base_version` способен их
 * затереть, черновик с удалённой целью — вечно ретраиться (`NOT_FOUND`,
 * fb9d6058). Поэтому черновики НЕ переживают перезапуск: main удаляет всё, что
 * осталось от прошлых запусков, до создания окна и до первого connect.
 *
 * Модуль намеренно без `better-sqlite3` и Electron: клиентские тесты не
 * поднимают настоящий better-sqlite3 (сборка под Electron ABI), поэтому пурж
 * проверяется через фейк-хранилище (интерфейс {@link DraftPurgeStore}). Политика
 * (какие статусы незавершённые) живёт здесь и покрыта юнит-тестом.
 */

/**
 * Статусы, которые считаются незавершёнными (решение п.5, fb9d6058):
 * - `pending` — очередь авто-досылки;
 * - `conflict` — текст сохранён, авто-досылки нет (ошибка 5726744b);
 * - `failed` — цель недостижима (`NOT_FOUND`), терминальный (fb9d6058).
 *
 * `sent` не удаляется: текущий код строки в этом статусе не оставляет
 * (успешная отправка удаляет строку), но старые БД его содержат — запись уже
 * отправлена, терять нечего.
 */
export const UNFINISHED_DRAFT_STATUSES = ['pending', 'conflict', 'failed'] as const;

/** Минимальная строка черновика, нужная пуржу (срез `DraftRow`). */
export interface DraftPurgeRow {
  id: string;
  value: string | null;
  status: string;
}

/** Хранилище черновиков: срез `LocalDb` без SQLite/Electron (тестовый шов). */
export interface DraftPurgeStore {
  /** Все черновики всех профилей и сетей. */
  listAllDrafts(): DraftPurgeRow[];
  /** Удаляет строку по id. */
  deleteDraft(id: string): void;
}

/** Итог пуржа: всего удалено и сколько из них с непустым текстом. */
export interface DraftPurgeResult {
  /** Число удалённых строк (все незавершённые статусы). */
  deleted: number;
  /**
   * Число удалённых строк с непустым текстом — только про них пользователю
   * показывается стартовое сообщение (пустой черновик терять нечего).
   */
  deletedWithText: number;
}

/**
 * Удаляет незавершённые черновики прошлых запусков. Вызывается из main сразу
 * после открытия локальной БД и ДО регистрации IPC/создания окна: renderer не
 * должен успеть увидеть строку прошлого запуска, а первый `connected` сессии
 * досылает только черновики, набранные в этой сессии.
 */
export function purgeStaleDrafts(store: DraftPurgeStore): DraftPurgeResult {
  const unfinished = new Set<string>(UNFINISHED_DRAFT_STATUSES);
  let deleted = 0;
  let deletedWithText = 0;
  for (const row of store.listAllDrafts()) {
    if (!unfinished.has(row.status)) continue;
    store.deleteDraft(row.id);
    deleted += 1;
    if ((row.value ?? '').trim() !== '') deletedWithText += 1;
  }
  return { deleted, deletedWithText };
}
