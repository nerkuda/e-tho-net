/**
 * Export dialog (phase P, task P5).
 *
 * Reusable modal that captures the user's intent for a `.etnx` export:
 * the output filename, which slices of the graph to include, and how deep
 * the subtree walk should go. Returns the chosen options via a Promise so
 * callers can dispatch directly to `etn.system.export` (see
 * `selection.ts:runExport` and `canvas/context-menu.ts:exportSingleThought`).
 *
 * DOM follows the project's checkbox-row convention (`<label class="checkbox-row">`
 * wraps both the `<input>` and the visible label so clicking the text toggles
 * the checkbox). Layout reuses `.field`, `.text-input`, `.field-label` from
 * `styles.css` — no new CSS classes here.
 */

import {
  ETNX_SUBTREE_DEPTH_MAX,
  type ExportEtnxOptions,
} from '@etn/shared';

import { div, el } from '../lib/dom.js';
import { showDialog } from '../lib/dialog.js';

interface DialogResult {
  /** `undefined` — the user cancelled. */
  options: ExportEtnxOptions | undefined;
  /** Output filename hint (without extension). Defaults to a network+date slug. */
  filename: string | undefined;
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
    filenameLabel.textContent = 'Имя файла (без расширения)';
    filenameField.append(filenameLabel, filenameInput);

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
    depthInput.disabled = !includeSubtree.checked;
    includeSubtree.addEventListener('change', () => {
      depthInput.disabled = !includeSubtree.checked;
      if (depthInput.disabled) depthInput.classList.add('text-input-disabled');
      else depthInput.classList.remove('text-input-disabled');
    });

    const depthField = div('field');
    const depthLabel = el('label', 'field-label');
    depthLabel.htmlFor = 'etnx-export-depth';
    depthLabel.textContent = `Глубина подчинённости (1..${ETNX_SUBTREE_DEPTH_MAX})`;
    depthField.append(depthLabel, depthInput);

    const optionsStack = div('form-stack');
    optionsStack.append(
      includeTypes,
      includeAttachments,
      includeChronology,
      includeSubtree,
      depthField,
    );

    const hint = el('p', 'dialog-text');
    hint.textContent = `Будет экспортировано мыслей: ${thoughtCount}.`;

    const body = div('form-stack');
    body.append(hint, filenameField, optionsStack);

    showDialog({
      title: 'Экспорт в .etnx',
      body,
      width: 520,
      buttons: [
        {
          label: 'Отмена',
          onClick: () => resolve({ options: undefined, filename: undefined }),
        },
        {
          label: 'Экспортировать',
          primary: true,
          onClick: () => {
            const depth = clampDepth(depthInput.valueAsNumber);
            const filename = filenameInput.value.trim() || defaultFilename;
            resolve({
              options: {
                include_types: includeTypes.checked,
                include_attachments: includeAttachments.checked,
                include_chronology: includeChronology.checked,
                include_subtree: includeSubtree.checked,
                subtree_depth: depth,
              },
              filename,
            });
          },
        },
      ],
    });
  });
}

/**
 * Build a checkbox row in the project's standard form:
 *   <label class="checkbox-row"><input type="checkbox"/><span>text</span></label>
 * Clicking the label text toggles the checkbox (native label behaviour).
 * Returns the underlying `<input>` so callers can read `checked` and bind events.
 */
function makeCheckbox(labelText: string, initial: boolean): HTMLInputElement {
  const row = el('label', 'checkbox-row');
  const cb = el('input') as HTMLInputElement;
  cb.type = 'checkbox';
  cb.checked = initial;
  const text = el('span');
  text.textContent = labelText;
  row.append(cb, text);
  return cb;
}

function clampDepth(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(ETNX_SUBTREE_DEPTH_MAX, Math.floor(v)));
}

/** Default filename: `etnx-YYYY-MM-DD`. The `.etnx` extension is appended
 *  by the download route (or by the browser, which keeps the original
 *  content-disposition name). */
export function defaultExportName(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `etnx-${y}-${m}-${d}`;
}
