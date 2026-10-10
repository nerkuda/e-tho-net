/**
 * Диалог вставки картинки в текст комментария (0.12.1, задача 87c455db,
 * элемент интерфейса d87b8f32, ADR d85e17b6) — АДАПТЕР универсального каркаса
 * выбора ресурса `editor/resource-picker.ts`.
 *
 * Открывается командой контекстного меню «Вставить картинку». Вкладки:
 * «Эмодзи» (глиф), «Иконки мыслей» (только эмодзи-иконки типов), «Вложения»
 * (общий компонент `editor/attachment-picker.ts`) и «URL». Выбранное
 * возвращается вызывающему ({@link InsertResourceResult}) и вставляется В
 * ПОЗИЦИЮ КУРСОРА, а не назначается иконкой объекта — единственное отличие от
 * диалога иконки (`showIconDialog`).
 *
 * Вкладка «Библиотека» намеренно ОТСУТСТВУЕТ: ADR 348c9f68 запрещает вставлять
 * библиотечные (шрифтовые) значки в markdown-текст. «Иконки мыслей» отдаёт
 * только значки вида `icon_kind='emoji'` — они по природе глифы Unicode.
 *
 * Загрузку/дедупликацию вложения и создание владельца выполняет ВЫЗЫВАЮЩАЯ
 * сторона (ADR d85e17b6): диалог лишь возвращает выбор. Каркас владеет футером,
 * закрытием и доступностью «Вставить»; контролы — фасады `lib/ui`, строки — `t()`.
 */

import type { Attachment } from '@etn/shared';
import { t } from '../lib/i18n.js';
import { store } from '../state.js';
import { attachmentPickerSourceTab, type AttachmentPick } from './attachment-picker.js';
import {
  createResourcePicker,
  emojiSourceTab,
  thoughtIconSourceTab,
  urlSourceTab,
  type ResourceFileSource,
  type ResourceSourceContext,
} from './resource-picker.js';

/** Что вернул диалог вставки картинки. */
export type InsertResourceResult =
  /** Эмодзи (или эмодзи-иконка типа) — вставляется глифом. */
  | { kind: 'emoji'; glyph: string }
  /** URL-картинка — вставляется `![…](<url>)`. */
  | { kind: 'url'; url: string }
  /** Существующее вложение сети — вставляется `![…](etnimg://attachment/<id>)`. */
  | { kind: 'attachment'; attachment: Attachment }
  /** Новый локальный файл — загружает вызывающая сторона на владельца. */
  | { kind: 'file'; source: ResourceFileSource };

/**
 * Открывает диалог вставки картинки. Выбор уходит в `onPick`; закрытие диалога
 * выполняет сам диалог после возврата результата.
 */
export function showInsertImageDialog(opts: {
  onPick: (result: InsertResourceResult) => void;
}): void {
  createResourcePicker({
    title: t('insertImage.title'),
    size: 'm',
    activeTab: 'emoji',
    applyLabel: t('insertImage.apply'),
    tabs: [
      emojiSourceTab((glyph, ctx) => {
        opts.onPick({ kind: 'emoji', glyph });
        ctx.close();
      }),
      thoughtIconSourceTab({
        // Только эмодзи-иконки: библиотечные значки в текст не вставляются
        // (ADR 348c9f68), картинки-иконки типов — самодостаточные data:-превью,
        // непригодные для текста.
        types: store.state.thoughtTypes.filter(
          (type) => type.icon_kind === 'emoji' && (type.icon ?? '') !== '',
        ),
        emptyHint: t('insertImage.iconsEmpty'),
        onPick: (icon, kind, _color, ctx) => {
          if (kind !== 'emoji') return;
          opts.onPick({ kind: 'emoji', glyph: icon });
          ctx.close();
        },
      }),
      attachmentPickerSourceTab({
        label: t('publication.cover.tab.attachments'),
        onPick: (pick: AttachmentPick, ctx: ResourceSourceContext) => {
          if (pick.attachment !== undefined) {
            opts.onPick({ kind: 'attachment', attachment: pick.attachment });
            ctx.close();
            return;
          }
          if (pick.source !== undefined) {
            opts.onPick({ kind: 'file', source: pick.source });
            ctx.close();
          }
          // Текущее превью без записи вложения — вставлять нечего.
        },
      }),
      urlSourceTab({
        placeholder: t('insertImage.urlPlaceholder'),
        previewHint: t('insertImage.preview'),
        onApply: (url, ctx) => {
          opts.onPick({ kind: 'url', url });
          ctx.close();
        },
      }),
    ],
  });
}
