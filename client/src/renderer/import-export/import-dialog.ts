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

import { div, el } from '../lib/dom.js';
import { showDialog } from '../lib/dialog.js';

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
 */
export function showImportEtnxDialog(
  filePath: string,
  initial: Partial<ImportEtnxOptions> = {},
): Promise<DialogResult> {
  return new Promise<DialogResult>((resolve) => {
    const pathInput = el('input', 'text-input') as HTMLInputElement;
    pathInput.type = 'text';
    pathInput.id = 'etnx-import-filepath';
    pathInput.value = filePath;
    pathInput.spellcheck = false;
    pathInput.readOnly = true;

    const includeTypes = makeCheckbox(
      'Импортировать типы мыслей и связей',
      initial.include_types ?? DEFAULT_SLICES.include_types,
    );
    const includeAttachments = makeCheckbox(
      'Импортировать вложения (файлы внутри архива)',
      initial.include_attachments ?? DEFAULT_SLICES.include_attachments,
    );
    const includeChronology = makeCheckbox(
      'Импортировать хронологические комментарии',
      initial.include_chronology ?? DEFAULT_SLICES.include_chronology,
    );

    const pathField = div('field');
    const pathLabel = el('label', 'field-label');
    pathLabel.htmlFor = 'etnx-import-filepath';
    pathLabel.textContent = 'Файл архива';
    pathField.append(pathLabel, pathInput);

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
      width: 520,
      buttons: [
        {
          label: 'Отмена',
          onClick: () => resolve({ filePath: undefined, options: undefined }),
        },
        {
          label: 'Импортировать',
          primary: true,
          onClick: () => {
            const path = pathInput.value.trim();
            if (path === '') return;
            resolve({
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
    });
  });
}

/**
 * Same shape as `export-dialog.ts:makeCheckbox` — returns the wrapping
 * `<label>` AND the underlying `<input>`. Earlier revisions dropped the
 * label by returning only the input; that left a bare checkbox with no
 * caption. Always use both.
 */
function makeCheckbox(
  labelText: string,
  initial: boolean,
): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = el('label', 'checkbox-row');
  const input = el('input') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = initial;
  const text = el('span');
  text.textContent = labelText;
  row.append(input, text);
  return { row, input };
}
