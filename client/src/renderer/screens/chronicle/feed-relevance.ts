/**
 * Релевантность realtime-события ЛЕНТЕ «Дневника» (0.16.1, пачка 3, пункт 6
 * ревью реактивности).
 *
 * Лента показывает только хронологические записи применённого периода, но
 * маршрутизатор гасит её ключ на ЛЮБОЕ `comment.*` в сети. Правка постоянного
 * комментария мысли (ленте не видного) и удаление записи, которой в ленте нет,
 * состав ленты не меняют — перезапрос и перерисовка были вхолостую.
 *
 * Функция чистая: решение принимается по причине-событию и id загруженных
 * записей. Неизвестное событие (нет данных/локальная причина) считается
 * релевантным — перестраховка дешевле пропущенного изменения.
 */

import type { RealtimeCause } from '../../lib/live/query-registry.js';

/** Минимум, который нужен от загруженной записи ленты. */
export interface FeedRowRef {
  id: string;
}

/**
 * Влияет ли причина-событие на содержимое ленты.
 * `cause === null` — локальная мутация/сигнал: ленту перечитываем.
 */
export function feedEventRelevant(
  cause: RealtimeCause | null,
  rows: readonly FeedRowRef[],
): boolean {
  if (cause === null) return true;
  if (cause.type === 'comment.updated') {
    // Постоянный комментарий в ленте не показывается ни при каком отборе.
    const kind = (cause.data as { kind?: string }).kind;
    return kind !== 'permanent';
  }
  if (cause.type === 'comment.deleted') {
    const id = (cause.data as { id?: string }).id;
    // Удаление незагруженной записи состава ленты не меняет.
    return id === undefined || rows.some((row) => row.id === id);
  }
  if (cause.type === 'comment.created') {
    // Новый постоянный комментарий — не запись ленты.
    const comment = (cause.data as { comment?: { kind?: string } }).comment;
    return comment?.kind !== 'permanent';
  }
  return true;
}
