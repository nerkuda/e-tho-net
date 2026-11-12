/**
 * DOM-адаптер подготовки фоновой картинки (0.16.1, задача 80324150; сценарий
 * d9e8dba7, ADR a5888535).
 *
 * Единственное место, где картинка декодируется и кодируется браузером:
 * `Image` → `canvas` → `ImageData` → чистые функции `wallpaper-image.ts` →
 * `canvas.toDataURL`. Всё, что можно проверить без браузера (пороги, подложка,
 * метаданные, тинт), живёт в чистых функциях; здесь — только проводка.
 *
 * Результат — байты, готовые к `PUT /users/me/wallpaper`: клиент отправляет уже
 * уменьшенную копию с пересчитанными метаданными (сервер картинки не трогает).
 */

import type { WallpaperMeta } from '@etn/shared';

import {
  WALLPAPER_JPEG_QUALITY,
  WALLPAPER_MAX_BYTES,
  WALLPAPER_SOURCE_MAX_BYTES,
  alphaBackdropColor,
  flattenPixels,
  formatMegabytes,
  hasTransparency,
  measurePixels,
  planWallpaper,
  wallpaperMeta,
} from './wallpaper-image.js';

/** Готовая к отправке картинка. */
export interface PreparedWallpaper {
  data_base64: string;
  mime_type: string;
  file_size: number;
  meta: WallpaperMeta;
}

/** Итог подготовки: либо байты, либо понятная причина отказа (в футер). */
export type PrepareWallpaperResult =
  { status: 'ok'; prepared: PreparedWallpaper } | { status: 'error'; message: string };

/** Вход подготовки: то, что вернул системный выбор изображения. */
export interface PrepareWallpaperInput {
  data_url: string;
  mime: string;
  size: number;
}

/** Ошибка «файл не декодируется» — одна на все ветки отказа `Image`. */
const DECODE_ERROR = 'wallpaperErrorNotImage';

/**
 * Декодировать `data:`-URL в изображение. `Image.decode()` отклоняется на
 * повреждённом файле — вызывающий превращает это в понятное сообщение.
 */
async function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return image;
}

/** Пиксели канвы как RGBA-буфер. */
function readPixels(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): ImageData {
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** Перекодировать канву в `data:`-URL; `null` — кодировщик не поддержан. */
function encode(canvas: HTMLCanvasElement, mime: string): string | null {
  if (mime === 'image/jpeg') return canvas.toDataURL('image/jpeg', WALLPAPER_JPEG_QUALITY);
  if (mime === 'image/png') return canvas.toDataURL('image/png');
  if (mime === 'image/webp') return canvas.toDataURL('image/webp', 1);
  return null;
}

/** Размер байтов, закодированных в `data:`-URL (без повторного base64). */
function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const base64 = dataUrl.slice(comma + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** `data:`-URL → base64-полезная нагрузка (сервер ждёт её в JSON). */
function dataUrlBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma < 0 ? '' : dataUrl.slice(comma + 1);
}

/**
 * Подготовить картинку к отправке: посчитать метаданные, при необходимости
 * уменьшить до 3840 px, свести прозрачность на подложку и закодировать.
 *
 * Отказы (сообщения — ключи словаря, UI переводит их):
 *   * исходник больше {@link WALLPAPER_SOURCE_MAX_BYTES} — `wallpaperErrorTooLargeSource`;
 *   * не декодируется — `wallpaperErrorNotImage`;
 *   * после даунскейла всё ещё > 5 МиБ — `wallpaperErrorTooLargeResult`.
 */
export async function prepareWallpaper(
  input: PrepareWallpaperInput,
): Promise<PrepareWallpaperResult> {
  if (input.size > WALLPAPER_SOURCE_MAX_BYTES) {
    return {
      status: 'error',
      message: `wallpaperErrorTooLargeSource:${formatMegabytes(WALLPAPER_SOURCE_MAX_BYTES)}`,
    };
  }
  let image: HTMLImageElement;
  try {
    image = await decodeImage(input.data_url);
  } catch {
    return { status: 'error', message: DECODE_ERROR };
  }
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { status: 'error', message: DECODE_ERROR };
  }

  // Промежуточная канва исходного размера нужна, чтобы узнать о прозрачности
  // ДО решения о плане (PNG бывает непрозрачным, а MIME об этом не говорит).
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = sourceWidth;
  sourceCanvas.height = sourceHeight;
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (sourceContext === null) {
    return { status: 'error', message: DECODE_ERROR };
  }
  sourceContext.drawImage(image, 0, 0);
  const sourcePixels = readPixels(sourceCanvas, sourceContext).data;
  const plan = planWallpaper({
    width: sourceWidth,
    height: sourceHeight,
    byteLength: input.size,
    hasAlpha: hasTransparency(sourcePixels),
    mime: input.mime,
  });

  // Сведение прозрачности: подложка выбирается по светлоте видимых пикселей
  // (ревизия и2), поэтому её считаем ДО смешивания.
  let pixels: Uint8ClampedArray = sourcePixels;
  if (plan.flatten) {
    const { avg_luminance } = measurePixels(sourcePixels);
    pixels = flattenPixels(sourcePixels, alphaBackdropColor(avg_luminance));
  }

  // Итоговая канва: размер после даунскейла; рисуем уже подготовленные пиксели
  // (или источник, если сведение не требуется и масштаб прежний).
  const target = document.createElement('canvas');
  target.width = plan.width;
  target.height = plan.height;
  const context = target.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    return { status: 'error', message: DECODE_ERROR };
  }
  if (plan.flatten) {
    const flattened = context.createImageData(sourceWidth, sourceHeight);
    flattened.data.set(pixels);
    if (plan.width === sourceWidth && plan.height === sourceHeight) {
      context.putImageData(flattened, 0, 0);
    } else {
      const stage = document.createElement('canvas');
      stage.width = sourceWidth;
      stage.height = sourceHeight;
      const stageContext = stage.getContext('2d');
      if (stageContext === null) return { status: 'error', message: DECODE_ERROR };
      stageContext.putImageData(flattened, 0, 0);
      context.drawImage(stage, 0, 0, plan.width, plan.height);
    }
  } else {
    context.drawImage(image, 0, 0, plan.width, plan.height);
  }

  const finalPixels = readPixels(target, context).data;
  const meta = wallpaperMeta(plan.width, plan.height, finalPixels);

  // Кодирование: планируемый тип; если он не поддержан или файл всё ещё больше
  // лимита — одна попытка JPEG q0.85, затем честный отказ (сценарий d9e8dba7).
  let mime = plan.encode_mime ?? input.mime;
  let dataUrl = encode(target, mime);
  if (dataUrl === null) {
    mime = 'image/png';
    dataUrl = encode(target, mime);
  }
  if (dataUrl === null) return { status: 'error', message: DECODE_ERROR };
  if (dataUrlByteLength(dataUrl) > WALLPAPER_MAX_BYTES && mime !== 'image/jpeg') {
    mime = 'image/jpeg';
    dataUrl = encode(target, mime);
    if (dataUrl === null) return { status: 'error', message: DECODE_ERROR };
  }
  const fileSize = dataUrlByteLength(dataUrl);
  if (fileSize > WALLPAPER_MAX_BYTES) {
    return {
      status: 'error',
      message: `wallpaperErrorTooLargeResult:${formatMegabytes(WALLPAPER_MAX_BYTES)}`,
    };
  }

  return {
    status: 'ok',
    prepared: {
      data_base64: dataUrlBase64(dataUrl),
      mime_type: mime,
      file_size: fileSize,
      meta,
    },
  };
}
