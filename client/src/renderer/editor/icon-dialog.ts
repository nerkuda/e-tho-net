/**
 * Диалог выбора иконки мысли/типа (08-ui-spec.md §6.8) — АДАПТЕР
 * универсального диалога выбора ресурса (задача d1a56d76).
 *
 * Раньше диалог был самостоятельной реализацией; теперь вся общая механика
 * (вкладки-источники, доступность «Применить», «Очистить»/«Отменить»/«Применить»,
 * закрытие) живёт в {@link createResourcePicker}, а здесь остаётся только
 * конфигурация под иконку и мостик к прежнему контракту `onPick`.
 *
 * Источники: «Эмодзи» (полный набор Unicode 16.0), «Иконки мыслей» (сетка
 * иконок типов), «Файл» (системный выбор картинки с превью ≤256 КиБ) и «URL»
 * (адрес с предпросмотром). «Эмодзи»/«Иконки мыслей» применяются сразу по
 * клику; «Файл»/«URL» — нижней «Применить».
 */

import type { IconKind } from '@etn/shared';
import { t } from '../lib/i18n.js';
import { store } from '../state.js';
import {
  createResourcePicker,
  emojiSourceTab,
  fileImageSourceTab,
  thoughtIconSourceTab,
  urlSourceTab,
  type ResourceFileSource,
  type ResourceSourceContext,
} from './resource-picker.js';

/** The original picked file, carried to the caller for the attachment upload. */
export type IconPickSource = ResourceFileSource;

/** Outcome of the dialog: an icon + kind (+ original file), or `null` to clear. */
export interface IconPickResult {
  icon: string | null;
  kind: IconKind;
  /** Present when the icon came from the OS file picker (L16). */
  source?: IconPickSource;
}

/** Opens the icon picker. `onPick` should persist the result and return success. */
export function showIconDialog(opts: {
  current: { icon: string | null; kind: IconKind };
  onPick: (result: IconPickResult) => Promise<boolean>;
}): void {
  const { current, onPick } = opts;

  /** Применяет результат и закрывает диалог при успехе сохранения. */
  const submit =
    (result: IconPickResult) =>
    async (ctx: ResourceSourceContext): Promise<void> => {
      if (await onPick(result)) ctx.close();
    };

  createResourcePicker({
    title: 'Иконка',
    size: 'm',
    // Открытие на «URL», если текущая иконка — картинка (как было в диалоге).
    activeTab: current.kind === 'image' ? 'url' : 'emoji',
    applyLabel: t('actions.apply'),
    noneLabel: t('actions.reset'),
    noneDanger: true,
    nonePlacement: 'leading',
    onNone: (close) => {
      void onPick({ icon: null, kind: 'emoji' }).then((ok) => {
        if (ok) close();
      });
    },
    tabs: [
      emojiSourceTab((glyph, ctx) => submit({ icon: glyph, kind: 'emoji' })(ctx)),
      thoughtIconSourceTab({
        types: store.state.thoughtTypes,
        onPick: (icon, kind, ctx) => submit({ icon, kind })(ctx),
      }),
      fileImageSourceTab({
        types: store.state.thoughtTypes,
        onTypeIcon: (icon, kind, ctx) => submit({ icon, kind })(ctx),
        onFile: (preview, source, ctx) =>
          submit({ icon: preview, kind: 'image', source })(ctx),
      }),
      urlSourceTab({
        placeholder: 'URL изображения',
        previewHint: 'Предпросмотр',
        onApply: (url, ctx) => submit({ icon: url, kind: 'image' })(ctx),
      }),
    ],
  });
}
