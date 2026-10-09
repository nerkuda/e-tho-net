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
 * выбор (ошибка e2407f6d): `emoji`/`icon`/`image` → «Эмодзи»/«Библиотека»/«URL»,
 * разворачивается категория эмодзи и выделяется текущий значок; на вкладке
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
}

/** Opens the icon picker. `onPick` should persist the result and return success. */
export function showIconDialog(opts: {
  current: { icon: string | null; kind: IconKind; color: string | null };
  onPick: (result: IconPickResult) => Promise<boolean>;
}): void {
  const { current, onPick } = opts;

  /**
   * Вкладка при открытии — по ВИДУ текущей иконки (ошибка e2407f6d): `emoji` →
   * «Эмодзи», `icon` → «Библиотека», `image` → «URL» (картинка-адрес).
   */
  const activeTab =
    current.kind === 'icon' ? 'library' : current.kind === 'image' ? 'url' : 'emoji';
  /** Начальное значение вкладки «URL» — адрес картинки (не `data:`-превью). */
  const initialUrl =
    current.kind === 'image' && current.icon !== null && !current.icon.startsWith('data:')
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
        onTypeIcon: (icon, kind, color, ctx) => submit({ icon, kind, color })(ctx),
        onFile: (preview, source, ctx) =>
          submit({ icon: preview, kind: 'image', color: null, source })(ctx),
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
