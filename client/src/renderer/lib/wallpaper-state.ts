/**
 * Состояние фоновой картинки карты в рендерере (0.16.1, задача 80324150;
 * операции 31ef478a, сценарии 88a8879d и 0ec86f0b).
 *
 * Состояние одно на приложение: его читают раздел «Оформление» настроек
 * (превью) и подложка холста карты (`canvas/wallpaper.ts`). Владелец сети и
 * файлов — главный процесс: `etn.me.getWallpaper` отдаёт готовый `data:`-URL
 * (онлайн — с сервера, офлайн — из локального кэша), рендерер только хранит и
 * публикует результат.
 *
 * Записей «нет картинки» в этом состоянии — штатный вид карты: цветовой фон
 * темы/слоя и точечная сетка (требование e6d586d3).
 */

import type { WallpaperState } from '../../main/ipc/contract.js';
import { etn } from './etn.js';

/** Текущее состояние: `none` до первой загрузки. */
let current: WallpaperState = { status: 'none' };

/** Подписчики: применение на холсте и превью в настройках. */
const listeners = new Set<(state: WallpaperState) => void>();

/** Номер последнего запроса: поздний ответ не перебивает свежий. */
let loadSeq = 0;

/** Текущее состояние картинки (синхронный снимок). */
export function getWallpaperState(): WallpaperState {
  return current;
}

/** Подписка на изменение состояния; возвращает отписку. */
export function subscribeWallpaper(listener: (state: WallpaperState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Опубликовать состояние подписчикам. */
function publish(next: WallpaperState): void {
  current = next;
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      // Подписчик не должен ломать остальных: сбой превью не отменяет холст.
    }
  }
}

/**
 * Перечитать картинку у главного процесса: онлайн — свежая с сервера (кэш
 * обновляется), офлайн — последняя из кэша, без кэша — `none`. Сбои чтения не
 * показываются пользователю: это не действие пользователя (сценарий 0ec86f0b).
 */
export async function refreshWallpaper(): Promise<WallpaperState> {
  loadSeq += 1;
  const seq = loadSeq;
  let next: WallpaperState;
  try {
    next = await etn.me.getWallpaper();
  } catch {
    next = { status: 'none' };
  }
  if (seq === loadSeq) publish(next);
  return current;
}

/**
 * Загрузить подготовленную картинку (`PUT /users/me/wallpaper`). Ошибка
 * пробрасывается вызывающему: раздел «Оформление» показывает её в футере и
 * предлагает повторить позже (сценарий 88a8879d).
 */
export async function uploadWallpaper(input: {
  data_base64: string;
  mime_type: string;
  meta: import('@etn/shared').WallpaperMeta;
}): Promise<WallpaperState> {
  const next = await etn.me.uploadWallpaper(input);
  loadSeq += 1;
  publish(next);
  return next;
}

/**
 * Убрать картинку (`DELETE /users/me/wallpaper`): холст возвращается к
 * цветовому фону и сетке. Ошибка пробрасывается — на сервере картинка ещё
 * есть, и делать вид, что её нет, нельзя.
 */
export async function removeWallpaper(): Promise<WallpaperState> {
  const next = await etn.me.removeWallpaper();
  loadSeq += 1;
  publish(next);
  return next;
}

/**
 * Сбросить состояние при отключении от сервера: картинка принадлежит
 * пользователю сервера, чужую показывать нельзя. Установочный кэш не трогаем —
 * он в главном процессе и переживает перезапуск (сценарий 0ec86f0b).
 */
export function resetWallpaperState(): void {
  loadSeq += 1;
  publish({ status: 'none' });
}
