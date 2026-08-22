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
 * DOM follows the project's checkbox-row convention (`<label class="checkbox-row">`
 * wraps both the `<input>` and the visible label so clicking the text toggles
 * the checkbox). Layout reuses `.field`, `.text-input`, `.field-label`,
 * `.input-with-btn`, `.dialog-text`, `.dialog-subhead` from `styles.css`.
 */

import {
  ETNX_SUBTREE_DEPTH_MAX,
  type ExportEtnxOptions,
} from '@etn/shared';

import { div, el, button } from '../lib/dom.js';
import { showDialog } from '../lib/dialog.js';
import { etn } from '../lib/etn.js';

interface DialogResult {
  /** `undefined` — the user cancelled. */
  options: ExportEtnxOptions | undefined;
  /** Absolute file path the archive will be written to. `undefined` on cancel. */
  targetPath: string | undefined;
}

/** Open the dialog and resolve with the chosen options or `undefined`. */
export function showExportEtnxDialog(
  thoughtCount: number,
  initial: Partial<ExportEtnxOptions> = {},
  defaultFilename: string = defaultExportName(),
): Promise<DialogResult> {
  return new Promise<DialogResult>((resolve) => {
    const filenameInput = el('input', 'text-input') as HTMLInputElement;
    filenameInput.type = 'text';
    filenameInput.id = 'etnx-export-filename';
    filenameInput.value = defaultFilename;
    filenameInput.placeholder = defaultFilename;
    filenameInput.spellcheck = false;

    const filenameField = div('field');
    const filenameLabel = el('label', 'field-label');
    filenameLabel.htmlFor = 'etnx-export-filename';
    filenameLabel.textContent = 'Имя файла';
    const filenameRow = div('input-with-btn');
    filenameRow.append(filenameInput);
    const browseBtn = button('Обзор…', () => void browse());
    browseBtn.type = 'button';
    browseBtn.classList.add('dialog-btn');
    filenameRow.append(browseBtn);
    filenameField.append(filenameLabel, filenameRow);

    const depthInput = el('input', 'text-input') as HTMLInputElement;
    depthInput.type = 'number';
    depthInput.id = 'etnx-export-depth';
    depthInput.min = '1';
    depthInput.max = String(ETNX_SUBTREE_DEPTH_MAX);
    depthInput.step = '1';
    depthInput.value = String(initial.subtree_depth ?? 1);

    const includeTypes = makeCheckbox(
      'Включить типы мыслей и связей',
      initial.include_types ?? true,
    );
    const includeAttachments = makeCheckbox(
      'Включить вложения (файлы внутри архива)',
      initial.include_attachments ?? true,
    );
    const includeChronology = makeCheckbox(
      'Включить хронологические комментарии',
      initial.include_chronology ?? true,
    );
    const includeSubtree = makeCheckbox(
      'Включить подчинённые мысли',
      initial.include_subtree ?? false,
    );
    depthInput.disabled = !includeSubtree.input.checked;
    includeSubtree.input.addEventListener('change', () => {
      depthInput.disabled = !includeSubtree.input.checked;
      if (depthInput.disabled) depthInput.classList.add('text-input-disabled');
      else depthInput.classList.remove('text-input-disabled');
    });

    const depthField = div('field');
    const depthLabel = el('label', 'field-label');
    depthLabel.htmlFor = 'etnx-export-depth';
    depthLabel.textContent = `Глубина подчинённости (1..${ETNX_SUBTREE_DEPTH_MAX})`;
    depthField.append(depthLabel, depthInput);

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

    async function browse(): Promise<void> {
      const suggested = filenameInput.value.trim() || defaultFilename;
      const picked = await etn.system.pickSavePath(suggested, 'etnx');
      if (picked.cancelled || picked.filePath === null) return;
      filenameInput.value = picked.filePath;
    }

    showDialog({
      title: 'Экспорт в .etnx',
      body,
      width: 520,
      buttons: [
        {
          label: 'Отмена',
          onClick: () => resolve({ options: undefined, targetPath: undefined }),
        },
        {
          label: 'Экспортировать',
          primary: true,
          onClick: () => {
            const targetPath = filenameInput.value.trim();
            if (targetPath === '') return; // validation: a path is required
            const depth = clampDepth(depthInput.valueAsNumber);
            resolve({
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
    });
  });
}

/**
 * A labelled checkbox row: returns the wrapping `<label>` (so the visible
 * caption stays attached to the checkbox in the DOM) AND the underlying
 * `<input>` so callers can read `checked` / bind `change` events.
 *
 *   <label class="checkbox-row"><input type="checkbox"/><span>text</span></label>
 *
 * Earlier revisions returned the bare `<input>` and the wrapping label was
 * silently dropped — the checkbox row appeared with no caption (visible only
 * as a bare tick box). Always use the wrapping label.
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
