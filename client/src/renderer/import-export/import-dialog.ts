/**
 * Import dialog (phase P, task P6).
 *
 * Reusable modal that lets the user pick a `.etnx` archive from disk and
 * choose which slices of the manifest to import (types/attachments/
 * chronology). Returns the chosen file path + slices via a Promise; the
 * caller dispatches to `etn.system.importEtnx` (see
 * `selection.ts:runImport` and `canvas/context-menu.ts:importToThought`).
 *
 * The actual `etn.system.importEtnx` IPC handles the file-pick fallback
 * when the user closes this dialog without choosing a file (it re-opens
 * the OS dialog) — this dialog only handles the «выбрали файл, настроили
 * параметры» flow.
 */

import { type ImportEtnxOptions } from '@etn/shared';
import { t } from '../lib/i18n.js';

import { div, el } from '../lib/dom.js';
import { showDialog } from '../lib/dialog.js';
import { checkboxRow } from '../lib/ui/choice-row.js';
import { fieldInput, fieldRow } from '../lib/ui/field.js';

interface DialogResult {
  /** `undefined` — the user cancelled. */
  filePath: string | undefined;
  options: ImportEtnxOptions | undefined;
}

/** Default slice toggles for the import dialog. */
const DEFAULT_SLICES: Required<ImportEtnxOptions> = {
  include_types: true,
  include_attachments: true,
  include_chronology: true,
};

/**
 * Open the import dialog pre-filled with `filePath` (a previously chosen
 * archive) and the default slice toggles. The user adjusts the toggles,
 * picks a different file via «Обзор…» if needed, and presses «Импортировать».
 * Resolves the chosen file + slices, or `{ filePath: undefined, options:
 * undefined }` when dismissed (any close path — «Отмена», Esc, ×, backdrop
 * click).
 */
export function showImportEtnxDialog(
  filePath: string,
  initial: Partial<ImportEtnxOptions> = {},
): Promise<DialogResult> {
  return new Promise<DialogResult>((resolve) => {
    /**
     * Единственная точка завершения промиса. Отмена — ЛЮБОЙ путь закрытия
     * каркаса (ошибка fd87099b): кнопки завершают его явно, а Esc и × —
     * через `onClose`. Флаг `settled` не даёт позднему событию
     * `remove` переиграть уже принятое решение.
     */
    let settled = false;
    const finish = (result: DialogResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const cancelled: DialogResult = { filePath: undefined, options: undefined };

    const pathInput = fieldInput({
      id: 'etnx-import-filepath',
      value: filePath,
      spellcheck: false,
      readonly: true,
    });

    const includeTypes = checkboxRow({
      label: 'Импортировать типы мыслей и связей',
      checked: initial.include_types ?? DEFAULT_SLICES.include_types,
    });
    const includeAttachments = checkboxRow({
      label: 'Импортировать вложения (файлы внутри архива)',
      checked: initial.include_attachments ?? DEFAULT_SLICES.include_attachments,
    });
    const includeChronology = checkboxRow({
      label: 'Импортировать хронологические комментарии',
      checked: initial.include_chronology ?? DEFAULT_SLICES.include_chronology,
    });

    const pathField = fieldRow({
      label: 'Файл архива',
      control: pathInput,
      id: 'etnx-import-filepath',
    });

    const optionsHead = el('h4', 'dialog-subhead');
    optionsHead.textContent = 'Что импортировать';

    const optionsStack = div('form-stack');
    optionsStack.append(
      includeTypes.row,
      includeAttachments.row,
      includeChronology.row,
    );

    const hint = el('p', 'dialog-text');
    hint.textContent =
      'Мысли с совпадающим id будут обновлены; по совпадению названия — переиспользованы (синонимы объединятся). Остальное создастся заново.';

    const body = div('form-stack');
    body.append(pathField, optionsHead, optionsStack, hint);

    showDialog({
      title: 'Импорт из .etnx',
      body,
      size: 'm',
      buttons: [
        {
          label: t('actions.cancel'),
          onClick: () => finish(cancelled),
        },
        {
          label: 'Импортировать',
          primary: true,
          onClick: () => {
            const path = pathInput.value.trim();
            if (path === '') return;
            finish({
              filePath: path,
              options: {
                include_types: includeTypes.input.checked,
                include_attachments: includeAttachments.input.checked,
                include_chronology: includeChronology.input.checked,
              },
            });
          },
        },
      ],
      // Esc и × — отмена: контракт «`{ filePath: undefined,
      // options: undefined }` on cancel», ровно как по кнопке «Отмена»
      // (ошибка fd87099b).
      onClose: () => finish(cancelled),
    });
  });
}
