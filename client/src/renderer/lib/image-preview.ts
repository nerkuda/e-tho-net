/**
 * Icon preview generation (workplan L16).
 *
 * A thought icon is a self-contained `data:` URL ≤ 256 KiB (server
 * `assertImageIcon`). Files picked as icons are uploaded as attachments in
 * full size; the icon itself becomes a small preview downscaled to fit a
 * 256×256 box. The preview is generated here, in the renderer, with a
 * `<canvas>` — no server-side image processing and no native dependencies.
 */

import { el } from './dom.js';

/** Icon size limit — mirrors the server (`assertImageIcon`). */
export const ICON_MAX_BYTES = 256 * 1024;

/** Preview box: the image fits inside 256×256 keeping its aspect ratio. */
export const ICON_PREVIEW_DIM = 256;

/** Rough decoded byte size of a `data:` URL (its base64 body). */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return 0;
  const b64 = dataUrl.slice(comma + 1).trim();
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/** Loads a `data:` URL into an `<img>` (never attached to the document). */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = el('img') as HTMLImageElement;
    img.addEventListener('load', () => resolve(img), { once: true });
    img.addEventListener('error', () => reject(new Error('image load failed')), { once: true });
    img.src = dataUrl;
  });
}

/**
 * Downscales an image into a preview `data:` URL ≤ {@link ICON_MAX_BYTES}:
 * fit the {@link ICON_PREVIEW_DIM} box, PNG first, then JPEG with decreasing
 * quality and smaller boxes until the limit holds (guaranteed for any image a
 * canvas can rasterize). Throws when the source is not a loadable image.
 */
export async function makeIconPreview(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl);
  // SVGs without intrinsic size get a default 256×256 box.
  const naturalW = img.naturalWidth > 0 ? img.naturalWidth : ICON_PREVIEW_DIM;
  const naturalH = img.naturalHeight > 0 ? img.naturalHeight : ICON_PREVIEW_DIM;
  for (const dim of [ICON_PREVIEW_DIM, 128, 64]) {
    const scale = Math.min(1, dim / naturalW, dim / naturalH);
    const w = Math.max(1, Math.round(naturalW * scale));
    const h = Math.max(1, Math.round(naturalH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx === null) continue;
    ctx.drawImage(img, 0, 0, w, h);
    const png = canvas.toDataURL('image/png');
    if (dataUrlBytes(png) <= ICON_MAX_BYTES) return png;
    for (const quality of [0.9, 0.75, 0.6, 0.5]) {
      const jpeg = canvas.toDataURL('image/jpeg', quality);
      if (dataUrlBytes(jpeg) <= ICON_MAX_BYTES) return jpeg;
    }
  }
  throw new Error('не удалось ужать картинку до лимита иконки');
}
