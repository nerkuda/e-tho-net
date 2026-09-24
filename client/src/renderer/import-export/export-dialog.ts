/**
 * Export dialog (phase P, task P5).
 *
 * Reusable modal that captures the user's intent for a `.etnx` export:
 * the output file path, which slices of the graph to include, and how deep
 * the subtree walk should go. Returns the chosen options via a Promise so
 * callers can dispatch directly to `etn.system.export` (see
 * `selection.ts:runExport` and `canvas/context-menu.ts:exportSingleThought`).
 *
 * The file destination is picked via the OS save dialog up-front (the
 * «Обзор…» button next to the filename input) — when the user presses
 * «Экспортировать», the bytes are streamed straight into that file. The
 * server's temp archive is deleted the moment the response is read
 * (`export-service.ts:getExportJobContent`), so no cleanup is left over.
 *
 * DOM собран фасадами `lib/ui` (задача f351b894): поле пути — `filePathField`
 * («поле + Обзор…»), флажки — `checkboxRow` (подпись в `<label>`), числовое
 * поле — `fieldInput`. Раскладка — `.input-with-btn`, `.dialog-text`,
 * `.dialog-subhead` из `styles.css`.
 */

import {
  ETNX_SUBTREE_DEPTH_MAX,
  type ExportEtnxOptions,
} from '@etn/shared';
import { t } from '../lib/i18n.js';

import { div, el } from '../lib/dom.js';
import { showDialog } from '../lib/dialog.js';
import { etn } from '../lib/etn.js';
import { checkboxRow } from '../lib/ui/choice-row.js';
import { fieldInput, fieldRow } from '../lib/ui/field.js';
import { filePathField } from '../lib/ui/file-path-field.js';

interface DialogResult {
  /** `undefined` — the user cancelled. */
  options: ExportEtnxOptions | undefined;
  /** Absolute file path the archive will be written to. `undefined` on cancel. */
  targetPath: string | undefined;
}

/**
 * Open the dialog and resolve with the chosen options or `undefined`.
 * Dismissal by any close path («Отмена», Esc, ×, backdrop click) resolves
 * `{ options: undefined, targetPath: undefined }`.
 */
export function showExportEtnxDialog(
  thoughtCount: number,
  initial: Partial<ExportEtnxOptions> = {},
  defaultFilename: string = defaultExportName(),
): Promise<DialogResult> {
  return new Promise<DialogResult>((resolve) => {
    /**
     * Единственная точка завершения промиса. Отмена — ЛЮБОЙ путь закрытия
     * каркаса (ошибка e5ec74de): кнопки завершают его явно, а Esc и × —
     * через `onClose`. Флаг `settled` не даёт позднему событию
     * `remove` переиграть уже принятое решение.
     */
    let settled = false;
    const finish = (result: DialogResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const cancelled: DialogResult = { options: undefined, targetPath: undefined };

    const filename = filePathField({
      id: 'etnx-export-filename',
      value: defaultFilename,
      placeholder: defaultFilename,
      spellcheck: false,
      onPick: async (current) => {
        const suggested = current.trim() || defaultFilename;
        const picked = await etn.system.pickSavePath(suggested, 'etnx');
        if (picked.cancelled || picked.filePath === null) return null;
        return picked.filePath;
      },
    });
    const filenameField = fieldRow({
      label: 'Имя файла',
      control: filename.root,
      id: 'etnx-export-filename',
    });
    const filenameInput = filename.input;

    const depthInput = fieldInput({
      type: 'number',
      id: 'etnx-export-depth',
      min: 1,
      max: ETNX_SUBTREE_DEPTH_MAX,
      step: 1,
      value: String(initial.subtree_depth ?? 1),
    });

    const includeTypes = checkboxRow({
      label: 'Включить типы мыслей и связей',
      checked: initial.include_types ?? true,
    });
    const includeAttachments = checkboxRow({
      label: 'Включить вложения (файлы внутри архива)',
      checked: initial.include_attachments ?? true,
    });
    const includeChronology = checkboxRow({
      label: 'Включить хронологические комментарии',
      checked: initial.include_chronology ?? true,
    });
    const includeSubtree = checkboxRow({
      label: 'Включить подчинённые мысли',
      checked: initial.include_subtree ?? false,
    });
    depthInput.disabled = !includeSubtree.input.checked;
    includeSubtree.input.addEventListener('change', () => {
      depthInput.disabled = !includeSubtree.input.checked;
    });

    const depthField = fieldRow({
      label: `Глубина подчинённости (1..${ETNX_SUBTREE_DEPTH_MAX})`,
      control: depthInput,
      id: 'etnx-export-depth',
    });

    const optionsHead = el('h4', 'dialog-subhead');
    optionsHead.textContent = 'Что включить в архив';

    const optionsStack = div('form-stack');
    optionsStack.append(
      includeTypes.row,
      includeAttachments.row,
      includeChronology.row,
      includeSubtree.row,
      depthField,
    );

    const hint = el('p', 'dialog-text');
    hint.textContent = `Будет экспортировано мыслей: ${thoughtCount}.`;

    const body = div('form-stack');
    body.append(hint, filenameField, optionsHead, optionsStack);

    showDialog({
      title: 'Экспорт в .etnx',
      body,
      size: 'm',
      buttons: [
        {
          label: t('actions.cancel'),
          onClick: () => finish(cancelled),
        },
        {
          label: 'Экспортировать',
          primary: true,
          onClick: () => {
            const targetPath = filenameInput.value.trim();
            if (targetPath === '') return; // validation: a path is required
            const depth = clampDepth(depthInput.valueAsNumber);
            finish({
              options: {
                include_types: includeTypes.input.checked,
                include_attachments: includeAttachments.input.checked,
                include_chronology: includeChronology.input.checked,
                include_subtree: includeSubtree.input.checked,
                subtree_depth: depth,
              },
              targetPath,
            });
          },
        },
      ],
      // Esc и × — отмена: контракт «`{ options: undefined,
      // targetPath: undefined }` on cancel», ровно как по кнопке «Отмена»
      // (ошибка e5ec74de).
      onClose: () => finish(cancelled),
    });
  });
}

function clampDepth(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(ETNX_SUBTREE_DEPTH_MAX, Math.floor(v)));
}

/** Default filename: `etnx-YYYY-MM-DD`. The user picks a folder via «Обзор…». */
export function defaultExportName(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `etnx-${y}-${m}-${d}`;
}
