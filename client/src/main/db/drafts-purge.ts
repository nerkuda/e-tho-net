/**
 * Чистка незаписанных черновиков при старте клиента (ошибка fb9d6058,
 * решение пользователя 2026-10-29, директива в хроно ошибки; устойчивость и
 * безобманный счётчик — ошибка 351068ed пп.3, 5, 6).
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
 *
 * Устойчивость (351068ed п.5): сбой чтения или удаления одной строки не
 * отменяет зачистку остальных и не валит старт клиента — ошибки считаются в
 * {@link DraftPurgeResult.failed} и журналируются вызывающим (main).
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
  entity_type: string;
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

/** Итог пуржа: удалено, сколько из них с текстом и сколько операций сорвалось. */
export interface DraftPurgeResult {
  /** Число удалённых строк (все незавершённые статусы). */
  deleted: number;
  /**
   * Число удалённых `pending`-строк с непустым текстом — только про них
   * пользователю показывается стартовое сообщение. `conflict`/`failed` не
   * считаются: о них пользователь уже получил сообщение в прошлой сессии
   * (351068ed п.3) — второй отчёт был бы дублем. Пустой `comment-new` и прочие
   * пустые значения текстом не считаются (351068ed п.6).
   */
  deletedWithText: number;
  /**
   * Число сорванных операций (чтение списка + удаление строк): пурж продолжает
   * работу, main пишет след в журнал (351068ed п.5).
   */
  failed: number;
}

/**
 * Несёт ли строка пользовательский текст, о потере которого надо сообщить.
 *
 * `comment-new` хранит не текст, а JSON-конверт `{ownerType, ownerId, bodyMd}`
 * (`drafts.ts`): `trim()` по всему конверту всегда непустой, поэтому пустой
 * черновик нового комментария раньше давал ложное стартовое сообщение
 * (351068ed п.6). Разбираем `bodyMd`; битый конверт считаем текстом — молча
 * терять потенциально пользовательское содержимое нельзя.
 */
function draftHasText(row: DraftPurgeRow): boolean {
  const raw = row.value ?? '';
  if (row.entity_type !== 'comment-new') return raw.trim() !== '';
  try {
    const parsed = JSON.parse(raw) as { bodyMd?: unknown };
    return typeof parsed.bodyMd === 'string' && parsed.bodyMd.trim() !== '';
  } catch {
    return raw.trim() !== '';
  }
}

/**
 * Удаляет незавершённые черновики прошлых запусков. Вызывается из main сразу
 * после открытия локальной БД и ДО регистрации IPC/создания окна: renderer не
 * должен успеть увидеть строку прошлого запуска, а первый `connected` сессии
 * досылает только черновики, набранные в этой сессии.
 *
 * Никогда не бросает: сбой чтения даёт нулевой результат с `failed: 1`, сбой
 * удаления строки — `failed + 1` и продолжение зачистки (351068ed п.5).
 */
export function purgeStaleDrafts(store: DraftPurgeStore): DraftPurgeResult {
  const unfinished = new Set<string>(UNFINISHED_DRAFT_STATUSES);
  let rows: DraftPurgeRow[];
  try {
    rows = store.listAllDrafts();
  } catch {
    return { deleted: 0, deletedWithText: 0, failed: 1 };
  }
  let deleted = 0;
  let deletedWithText = 0;
  let failed = 0;
  for (const row of rows) {
    if (!unfinished.has(row.status)) continue;
    try {
      store.deleteDraft(row.id);
    } catch {
      // Одна недоступная строка не отменяет зачистку остальных.
      failed += 1;
      continue;
    }
    deleted += 1;
    // Стартовое сообщение — только о `pending`: о конфликтах и недостижимых
    // целях пользователь уже уведомлён в прошлой сессии.
    if (row.status === 'pending' && draftHasText(row)) deletedWithText += 1;
  }
  return { deleted, deletedWithText, failed };
}
