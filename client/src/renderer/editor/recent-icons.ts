/**
 * История последних выбранных иконок диалога выбора иконки (задача 0fc95a2b).
 *
 * Клиент-ЛОКАЛЬНАЯ история (localStorage), ключ — В РАЗРЕЗЕ ПОЛЬЗОВАТЕЛЕЙ
 * (id из `store.state.me`); сервер и API не затрагиваются. Паттерн —
 * `editor/recent-values.ts`: безопасный доступ к storage, чистая merge-логика
 * «в начало, без дублей, кэп 10», parse с отбрасыванием мусора.
 *
 * Над вкладками диалога строка ≤10 ячеек 24×24 (рендер — {@link renderRecentIcons});
 * клик по ячейке применяет ТОТ ЖЕ результат выбора, что и обычный клик на вкладке.
 * В localStorage НЕ хранятся громоздкие `data:`-превью: картинка-вложение
 * хранится по `attachmentId` (превью резолвится лениво при показе), картинка-URL —
 * по адресу. Самодостаточное `data:`-превью иконки ТИПА мысли (у типов вложений
 * нет) не хранится — вид без `data:` не представим, такая иконка в истории не
 * оседает.
 */

import { button, clear, el } from '../lib/dom.js';

/** Длина истории (продуктовое решение: 10). */
export const RECENT_ICONS_MAX = 10;

/** Вид записи истории — различает способ хранения и восстановления. */
export type RecentIconKind = 'emoji' | 'icon' | 'image-url' | 'image-attachment';

/**
 * Запись истории: чем и как восстановить выбор. Эмодзи — глифом; библиотечный
 * значок — именем каталога + цветом; картинка-URL — адресом; картинка-вложение —
 * `attachmentId` (превью резолвится лениво).
 */
export type RecentIconEntry =
  | { kind: 'emoji'; icon: string; color: null }
  | { kind: 'icon'; icon: string; color: string | null }
  | { kind: 'image-url'; icon: string; color: null }
  | { kind: 'image-attachment'; attachmentId: string; color: null };

/** Ключ localStorage истории одного пользователя. */
export function recentIconsStorageKey(userId: string): string {
  return `icons.recent.${userId}`;
}

/** Идентичность записи для дедупа: вид + значение (у значка ещё цвет). */
export function recentIconKey(entry: RecentIconEntry): string {
  const value = entry.kind === 'image-attachment' ? entry.attachmentId : entry.icon;
  return `${entry.kind}\u0000${value}\u0000${entry.kind === 'icon' ? (entry.color ?? '') : ''}`;
}

/** Проверка формы одной записи при разборе storage-блоба. */
function isEntry(value: unknown): value is RecentIconEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v['kind']) {
    case 'emoji':
    case 'image-url':
      return typeof v['icon'] === 'string' && v['icon'] !== '' && v['color'] === null;
    case 'icon':
      return (
        typeof v['icon'] === 'string' &&
        v['icon'] !== '' &&
        (v['color'] === null || typeof v['color'] === 'string')
      );
    case 'image-attachment':
      return typeof v['attachmentId'] === 'string' && v['attachmentId'] !== '';
    default:
      return false;
  }
}

/**
 * Разбирает storage-блоб истории: только корректные записи, без дублей,
 * не длиннее {@link RECENT_ICONS_MAX}. Испорченный/чужой JSON → пустая история.
 */
export function parseRecentIcons(raw: string | null): RecentIconEntry[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: RecentIconEntry[] = [];
  for (const item of parsed) {
    if (!isEntry(item)) continue;
    const key = recentIconKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= RECENT_ICONS_MAX) break;
  }
  return out;
}

/**
 * Добавляет запись в историю: она встаёт ПЕРВОЙ; повторная (та же
 * идентичность) поднимается наверх без дублей; список обрезается до
 * {@link RECENT_ICONS_MAX}. Чистая — персист на вызывающем; прежний массив не
 * мутируется.
 */
export function mergeRecentIcon(
  prev: readonly RecentIconEntry[],
  entry: RecentIconEntry,
): RecentIconEntry[] {
  const key = recentIconKey(entry);
  return [entry, ...prev.filter((item) => recentIconKey(item) !== key)].slice(0, RECENT_ICONS_MAX);
}

/** localStorage behind a guard: unavailable (Node tests, hardened contexts) → null. */
function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Читает историю пользователя (пусто, если storage недоступен/испорчен). */
export function loadRecentIcons(userId: string): RecentIconEntry[] {
  const ls = storage();
  if (ls === null) return [];
  try {
    return parseRecentIcons(ls.getItem(recentIconsStorageKey(userId)));
  } catch {
    return [];
  }
}

/** Записывает успешно применённую иконку в историю пользователя (best effort). */
export function recordRecentIcon(userId: string, entry: RecentIconEntry): void {
  const ls = storage();
  if (ls === null) return;
  const key = recentIconsStorageKey(userId);
  let prev: RecentIconEntry[];
  try {
    prev = parseRecentIcons(ls.getItem(key));
  } catch {
    prev = [];
  }
  try {
    ls.setItem(key, JSON.stringify(mergeRecentIcon(prev, entry)));
  } catch {
    // Full or unavailable — the history is a convenience, not critical data.
  }
}

// ---------------------------------------------------------------------------
// Отрисовка строки
// ---------------------------------------------------------------------------

/** Колбэки отрисовки, инъектируемые вызывающим (домен живёт в адаптере диалога). */
export interface RecentIconsRenderHooks {
  /** Рисует библиотечный значок в ячейку (ленивый каталог — фасад `lib/ui/icon`). */
  renderLibrary: (cell: HTMLElement, name: string, color: string | null) => void;
  /** Лениво резолвит превью вложения (`data:`/URL); `null` — ячейку пропустить. */
  resolveAttachment: (attachmentId: string) => Promise<string | null>;
  /** Клик по ячейке: запись + (для вложения) её разрешённое превью. */
  onPick: (entry: RecentIconEntry, preview?: string) => void;
  /** Подпись ячейки (`title`) для доступности. */
  labelFor: (entry: RecentIconEntry) => string;
}

/**
 * Рисует строку последних иконок в `host`. Пустой список — пустая строка
 * (класс `hidden`). Неразрешимое вложение при показе ПРОПУСКАЕТСЯ (ячейка
 * убирается), но из истории не удаляется — {@link renderRecentIcons} читает
 * готовый список и в storage не пишет.
 */
export function renderRecentIcons(
  host: HTMLElement,
  entries: readonly RecentIconEntry[],
  hooks: RecentIconsRenderHooks,
): void {
  clear(host);
  for (const entry of entries) {
    // Разрешённое превью вложения (для клика); у остальных видов не нужно.
    let resolvedPreview: string | undefined;
    const cell = button(
      '',
      () => {
        if (entry.kind === 'image-attachment' && resolvedPreview === undefined) return;
        hooks.onPick(entry, resolvedPreview);
      },
      'recent-icon-cell',
    );
    cell.title = hooks.labelFor(entry);
    if (entry.kind === 'emoji') {
      cell.textContent = entry.icon;
    } else if (entry.kind === 'icon') {
      hooks.renderLibrary(cell, entry.icon, entry.color);
    } else if (entry.kind === 'image-url') {
      const img = el('img');
      img.src = entry.icon;
      img.alt = '';
      cell.append(img);
    } else {
      // Вложение: превью резолвится ЛЕНИВО существующими загрузчиками; пока
      // грузится — ячейка помечена, клик по ней ничего не делает.
      cell.classList.add('recent-icon-cell-loading');
      void hooks.resolveAttachment(entry.attachmentId).then((preview) => {
        if (preview === null) {
          cell.remove();
          host.classList.toggle('hidden', host.children.length === 0);
          return;
        }
        resolvedPreview = preview;
        const img = el('img');
        img.src = preview;
        img.alt = '';
        cell.classList.remove('recent-icon-cell-loading');
        cell.append(img);
      });
    }
    host.append(cell);
  }
  host.classList.toggle('hidden', host.children.length === 0);
}
