/**
 * Состояние фоновой картинки карты в рендерере (0.16.1, задача 80324150;
 * операции 31ef478a, сценарии 88a8879d и 0ec86f0b).
 *
 * Состояние одно на приложение: его читают раздел «Оформление» настроек
 * (превью) и подложка холста карты (`canvas/wallpaper.ts`). Владелец сети и
 * файлов — главный процесс: `etn.me.getWallpaper(networkId)` отдаёт готовый
 * `data:`-URL (онлайн — с сервера, офлайн — из локального кэша), рендерер
 * только хранит и публикует результат.
 *
 * Картинка — принадлежность пары «пользователь × сеть» (ревизия 2026-11-13,
 * задача 5db41abf): состояние всегда относится к активной сети приложения, а
 * смена сети сбрасывает прежнюю подложку и читает картинку новой
 * ({@link syncWallpaperNetwork}). Записи «нет картинки» — штатный вид карты:
 * цветовой фон темы/слоя и точечная сетка (требование e6d586d3).
 */

import type { WallpaperState } from '../../main/ipc/contract.js';
import { store } from '../state.js';
import { etn } from './etn.js';
import { t } from './i18n.js';

/** Текущее состояние: `none` до первой загрузки. */
let current: WallpaperState = { status: 'none' };

/** Подписчики: применение на холсте и превью в настройках. */
const listeners = new Set<(state: WallpaperState) => void>();

/** Номер последнего запроса: поздний ответ не перебивает свежий. */
let loadSeq = 0;

/**
 * Сеть, для которой сейчас опубликовано состояние. `null` — активной сети нет
 * (старт/восстановление сессии); главный процесс в этом случае отдаёт картинку
 * последней сети, для которой её читали или писали (офлайн-старт из кэша).
 */
let loadedNetworkId: string | null = null;

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

/** Активная сеть обязательна: картинка выбирается для неё (задача 5db41abf). */
function requireActiveNetwork(): string {
  const networkId = store.state.networkId;
  if (networkId === null) throw new Error(t('app.networkNotOpen'));
  return networkId;
}

/**
 * Перечитать картинку у главного процесса: онлайн — свежая с сервера (кэш
 * обновляется), офлайн — последняя из кэша, без кэша — `none`. Сбои чтения не
 * показываются пользователю: это не действие пользователя (сценарий 0ec86f0b).
 */
export async function refreshWallpaper(): Promise<WallpaperState> {
  loadSeq += 1;
  const seq = loadSeq;
  const networkId = store.state.networkId;
  loadedNetworkId = networkId;
  let next: WallpaperState;
  try {
    // `null` — активной сети ещё нет: главный процесс отдаст картинку
    // последней сети этого профиля (офлайн-старт, сценарий 0ec86f0b).
    next = await etn.me.getWallpaper(networkId);
  } catch {
    next = { status: 'none' };
  }
  if (seq === loadSeq) publish(next);
  return current;
}

/**
 * Подхватить смену активной сети (задача 5db41abf): состояние прежней сети
 * сбрасывается сразу — чужая подложка не должна мигнуть, — затем читается
 * картинка новой сети. Вызывается из подписки на store (дешёвая проверка).
 */
export function syncWallpaperNetwork(): void {
  const networkId = store.state.networkId;
  if (networkId === loadedNetworkId) return;
  loadSeq += 1;
  loadedNetworkId = networkId;
  publish({ status: 'none' });
  void refreshWallpaper();
}

/**
 * Загрузить подготовленную картинку (`PUT /users/me/wallpaper?network_id=…`)
 * в активную сеть. Ошибка пробрасывается вызывающему: раздел «Оформление»
 * показывает её в футере и предлагает повторить позже (сценарий 88a8879d).
 */
export async function uploadWallpaper(input: {
  data_base64: string;
  mime_type: string;
  meta: import('@etn/shared').WallpaperMeta;
}): Promise<WallpaperState> {
  const networkId = requireActiveNetwork();
  const next = await etn.me.uploadWallpaper({ ...input, networkId });
  loadSeq += 1;
  loadedNetworkId = networkId;
  publish(next);
  return next;
}

/**
 * Убрать картинку активной сети (`DELETE /users/me/wallpaper?network_id=…`):
 * холст возвращается к цветовому фону и сетке. Ошибка пробрасывается — на
 * сервере картинка ещё есть, и делать вид, что её нет, нельзя.
 */
export async function removeWallpaper(): Promise<WallpaperState> {
  const networkId = requireActiveNetwork();
  const next = await etn.me.removeWallpaper(networkId);
  loadSeq += 1;
  loadedNetworkId = networkId;
  publish(next);
  return next;
}

/**
 * Сбросить состояние при отключении от сервера: картинка принадлежит паре
 * «пользователь × сеть», чужую показывать нельзя. Установочный кэш не трогаем —
 * он в главном процессе и переживает перезапуск (сценарий 0ec86f0b).
 */
export function resetWallpaperState(): void {
  loadSeq += 1;
  loadedNetworkId = null;
  publish({ status: 'none' });
}
