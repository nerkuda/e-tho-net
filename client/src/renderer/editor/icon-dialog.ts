/**
 * Диалог выбора иконки мысли/типа (08-ui-spec.md §6.8) — АДАПТЕР
 * универсального диалога выбора ресурса (задача d1a56d76).
 *
 * Раньше диалог был самостоятельной реализацией; теперь вся общая механика
 * (вкладки-источники, доступность «Применить», «Очистить»/«Отменить»/«Применить»,
 * закрытие) живёт в {@link createResourcePicker}, а здесь остаётся только
 * конфигурация под иконку и мостик к прежнему контракту `onPick`.
 *
 * Источники: «Эмодзи» (полный набор Unicode 16.0), «Библиотека» (значки
 * иконочной библиотеки с поиском), «Иконки мыслей» (сетка иконок типов),
 * «Вложения» (системный выбор картинки с превью ≤256 КиБ; 0.12.1, ошибка
 * e748e323 — терминология как у вкладки «Вложения» диалога обложки) и «URL»
 * (адрес с предпросмотром). «Эмодзи»/«Библиотека»/«Иконки мыслей» применяются
 * сразу по клику; «Вложения»/«URL» — нижней «Применить». Порядок вкладок:
 * «Эмодзи» — первая, «Библиотека» — следующая (элемент интерфейса 91367509).
 *
 * При открытии диалог встаёт на вкладку ВИДА текущей иконки и отмечает текущий
 * выбор (ошибки e2407f6d, 846c426a, 844c426a): `emoji`/`icon` → «Эмодзи»/
 * «Библиотека», `image`-файл (вложение мысли `icon_attachment_id` либо
 * самодостаточное `data:`-превью типа) → «Вложения» (текущая картинка показана
 * выбранной, применение без изменений её сохраняет), `image`-URL → «URL».
 * Разворачивается категория эмодзи и выделяется текущий значок; на вкладке
 * «Библиотека» уже выбранный значок делает «Применить» активной — смена только
 * цвета не требует повторного поиска.
 */

import type { IconKind } from '@etn/shared';
import { t } from '../lib/i18n.js';
import { store } from '../state.js';
import {
  createResourcePicker,
  emojiSourceTab,
  fileImageSourceTab,
  libraryIconSourceTab,
  thoughtIconSourceTab,
  urlSourceTab,
  type ResourceFileSource,
  type ResourceSourceContext,
} from './resource-picker.js';

/** The original picked file, carried to the caller for the attachment upload. */
export type IconPickSource = ResourceFileSource;

/** Outcome of the dialog: an icon + kind + colour (+ original file), or `null` to clear. */
export interface IconPickResult {
  icon: string | null;
  kind: IconKind;
  /**
   * Цвет символа иконки (HEX `#rrggbb`) или `null` — цвет не задан
   * (0.12.1, задача 4105bd6a). Задаётся только на вкладке «Библиотека»; для
   * остальных видов и «Очистить» сбрасывается в `null`.
   */
  color: string | null;
  /** Present when the icon came from the OS file picker (L16). */
  source?: IconPickSource;
  /**
   * Уже загруженное вложение-иконка, сохраняемое без повторной загрузки
   * (ошибка 846c426a): применение вложения без изменений НЕ сбрасывает
   * `icon_attachment_id` и не требует новой загрузки файла.
   */
  attachmentId?: string | null;
}

/** Opens the icon picker. `onPick` should persist the result and return success. */
export function showIconDialog(opts: {
  current: {
    icon: string | null;
    kind: IconKind;
    color: string | null;
    /**
     * id вложения текущей иконки-файла (`icon_attachment_id`); не `null` —
     * иконка загружена из файла (ошибка 846c426a).
     */
    attachmentId?: string | null;
  };
  onPick: (result: IconPickResult) => Promise<boolean>;
}): void {
  const { current, onPick } = opts;

  const attachmentId = current.attachmentId ?? null;
  /**
   * Иконка-ФАЙЛ (не URL): вид `image` из вложения мысли (`icon_attachment_id`)
   * либо самодостаточное `data:`-превью — иконка-картинка ТИПА мысли, у типов
   * вложений нет (ошибки 846c426a, 844c426a).
   */
  const isFileImage =
    current.kind === 'image' &&
    (attachmentId !== null || (current.icon?.startsWith('data:') ?? false));

  /**
   * Вкладка при открытии — по ВИДУ текущей иконки (ошибки e2407f6d, 846c426a,
   * 844c426a): `emoji` → «Эмодзи», `icon` → «Библиотека», `image`-файл (вложение
   * или `data:`-превью) → «Вложения» (текущая картинка показана выбранной),
   * `image`-URL → «URL».
   */
  const activeTab =
    current.kind === 'icon'
      ? 'library'
      : isFileImage
        ? 'file'
        : current.kind === 'image'
          ? 'url'
          : 'emoji';
  /** Начальное значение вкладки «URL» — адрес картинки (не `data:`-превью). */
  const initialUrl =
    current.kind === 'image' && !isFileImage && current.icon !== null
      ? current.icon
      : undefined;

  /** Применяет результат и закрывает диалог при успехе сохранения. */
  const submit =
    (result: IconPickResult) =>
    async (ctx: ResourceSourceContext): Promise<void> => {
      if (await onPick(result)) ctx.close();
    };

  createResourcePicker({
    title: 'Иконка',
    size: 'm',
    // Открытие на вкладке вида текущей иконки; без выбора — «Эмодзи».
    activeTab,
    applyLabel: t('actions.apply'),
    noneLabel: t('actions.reset'),
    noneDanger: true,
    nonePlacement: 'leading',
    onNone: (close) => {
      void onPick({ icon: null, kind: 'emoji', color: null }).then((ok) => {
        if (ok) close();
      });
    },
    tabs: [
      emojiSourceTab(
        (glyph, ctx) => submit({ icon: glyph, kind: 'emoji', color: null })(ctx),
        { initial: current.kind === 'emoji' ? current.icon : null },
      ),
      libraryIconSourceTab({
        initialIcon: current.kind === 'icon' ? current.icon : null,
        initialColor: current.color,
        onPick: (name, color, ctx) => submit({ icon: name, kind: 'icon', color })(ctx),
      }),
      thoughtIconSourceTab({
        types: store.state.thoughtTypes,
        fill: true,
        onPick: (icon, kind, color, ctx) => submit({ icon, kind, color })(ctx),
      }),
      fileImageSourceTab({
        types: store.state.thoughtTypes,
        ...(isFileImage && current.icon !== null
          ? { initial: { preview: current.icon, attachmentId } }
          : {}),
        onTypeIcon: (icon, kind, color, ctx) => submit({ icon, kind, color })(ctx),
        onFile: (pick, ctx) =>
          submit({
            icon: pick.preview,
            kind: 'image',
            color: null,
            ...(pick.attachmentId !== undefined ? { attachmentId: pick.attachmentId } : {}),
            ...(pick.source !== undefined ? { source: pick.source } : {}),
          })(ctx),
      }),
      urlSourceTab({
        placeholder: 'URL изображения',
        previewHint: 'Предпросмотр',
        ...(initialUrl !== undefined ? { initial: initialUrl } : {}),
        onApply: (url, ctx) => submit({ icon: url, kind: 'image', color: null })(ctx),
      }),
    ],
  });
}
