/**
 * Правила принадлежности точки «лупе» (`image-zoom.ts`) для Ctrl+hover.
 *
 * Ошибка d0338c48: у облачка мысли с иконкой-вложением и заполненным
 * постоянным комментарием над иконкой открывались ДВА независимых попапа —
 * лупа (своя картинка рядом с курсором) и превью постоянного комментария
 * (панель `hover-preview.ts`). Оба движка слушают документ независимо, и
 * иконка не является триггером `hover-preview`, поэтому внешний триггер
 * облачка её не вытесняет.
 *
 * Модуль нейтральный (без импортов рендерера и без обращений к DOM на уровне
 * модуля): его используют ОБА движка, чтобы не разойтись в решении «лупа
 * покажет картинку или нет». `hover-preview.ts` не может импортировать
 * `image-zoom.ts` напрямую — тот тянет `editor/markdown-field.ts`, а тот
 * `canvas/canvas.ts`, который сам импортирует `hover-preview.ts` (цикл).
 */

/** Размер картинки в пикселях. */
export interface PictureSize {
  w: number;
  h: number;
}

/**
 * Картинка, к которой может прицепиться лупа: HTML `<img>` в любом месте UI
 * или SVG `<image>` (иконки мыслей мини-графа редактора — единственные
 * SVG-картинки клиента).
 */
export type ZoomAnchor = HTMLImageElement | SVGImageElement;

/**
 * True, когда увеличение имеет смысл: картинка загружена и хотя бы одна её
 * сторона отображается меньше натуральной.
 */
export function zoomable(natural: PictureSize, displayed: PictureSize): boolean {
  return natural.w > 0 && natural.h > 0 && (displayed.w < natural.w || displayed.h < natural.h);
}

/** Является ли узел картинкой, к которой цепляется лупа. */
export function isZoomAnchor(node: EventTarget | null): node is ZoomAnchor {
  return node instanceof HTMLImageElement || node instanceof SVGImageElement;
}

/** Вход чистого решения «картинка владеет точкой». */
export interface PictureOwnership {
  /** Иконка backed by attachment (`data-zoom-thought` + `data-zoom-attachment`,
   *  L16): у лупы всегда есть полная картинка вложения. */
  attachmentBacked: boolean;
  /** Натуральный размер; `null` — синхронно неизвестен (SVG `<image>`). */
  natural: PictureSize | null;
  /** Отображаемый размер; `null` — синхронно неизвестен (SVG `<image>`). */
  displayed: PictureSize | null;
}

/**
 * Владеет ли картинка точкой Ctrl+hover: тогда второй предпросмотр
 * (постоянный комментарий облачка) открываться не должен. Иконка-вложение
 * владеет точкой всегда — лупа покажет полную картинку независимо от размера
 * превью; обычная картинка — только если она отображается меньше натуральной
 * (тот же предикат {@link zoomable}, по которому лупа решает показываться).
 */
export function pictureOwnsCtrlPreview(input: PictureOwnership): boolean {
  if (input.attachmentBacked) return true;
  if (input.natural === null || input.displayed === null) return false;
  return zoomable(input.natural, input.displayed);
}

/**
 * Владеет ли точкой картинка под курсором. Для SVG `<image>` натуральный
 * размер измеряется лупой асинхронно, поэтому синхронный ответ возможен
 * только для иконки-вложения (data-атрибуты): единственные SVG-картинки
 * клиента — иконки мини-графа, и они не лежат внутри триггеров
 * `hover-preview` (триггером там помечено облачко-пилюля, а SVG-иконка —
 * его сосед в группе узла).
 */
export function imageOwnsCtrlPreview(node: EventTarget | null): boolean {
  if (!isZoomAnchor(node)) return false;
  const attachmentBacked =
    (node.dataset['zoomThought'] ?? '') !== '' && (node.dataset['zoomAttachment'] ?? '') !== '';
  if (node instanceof HTMLImageElement) {
    return pictureOwnsCtrlPreview({
      attachmentBacked,
      natural: { w: node.naturalWidth, h: node.naturalHeight },
      displayed: { w: node.width, h: node.height },
    });
  }
  return pictureOwnsCtrlPreview({ attachmentBacked, natural: null, displayed: null });
}
