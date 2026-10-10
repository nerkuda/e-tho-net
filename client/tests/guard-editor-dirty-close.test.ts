/**
 * Сторож подключения диалогов-редакторов к подтверждению закрытия
 * (требование b58f6aad «Закрытие диалога-редактора с изменениями требует
 * подтверждения», задача d034c6a9, 0.9.1).
 *
 * Правило: каждый диалог-РЕДАКТОР сущности объявляет в вызове `showDialog`
 * признак «есть несохранённые изменения» (`dirty: { isDirty, save }`) — иначе
 * Esc/крестик закроют форму молча и потеряют правки.
 *
 * Полный перечень диалогов клиента (правило классификации) ведёт
 * `guard-list-dialogs.test.ts` (`DIALOG_FILES`). Здесь тот же перечень
 * разделён на две части:
 *   - {@link EDITOR_SPECS} — редакторы: у КАЖДОГО в секции диалога обязаны быть
 *     `dirty:`, `isDirty:` и `save:`;
 *   - {@link NON_EDITOR_DIALOG_FILES} — диалоги, которые редакторами НЕ являются
 *     (списки, пикеры, подтверждения, информационные окна, диалоги параметров
 *     операции), с причиной. У них `dirty` быть не должно.
 *
 * Сторож краснеет, когда: новый редактор не подключён к механизму; редактор
 * потерял `dirty`; файл диалога не классифицирован (не редактор и не в
 * allow-списке); у не-редактора появился `dirty`.
 *
 * Входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Секция диалога редактора: файл, человекочитаемое имя и границы в тексте. */
interface EditorSpec {
  file: string;
  name: string;
  /** Маркер начала (включён) — обычно сигнатура функции редактора. */
  start: string;
  /** Маркер конца (не включён); `'\0'` — до конца файла. */
  end: string;
}

/**
 * Диалоги-РЕДАКТОРЫ сущностей: форма с черновиком и записью по закрытию.
 * Перечень ведёт человек: новый редактор обязан быть добавлен сюда вместе с
 * подключением `dirty`.
 */
const EDITOR_SPECS: readonly EditorSpec[] = [
  {
    file: 'screens/type-manager.ts',
    name: 'редактор типа мысли',
    start: 'export function showThoughtTypeEditor(',
    end: '// Property-definition tables + property dialog',
  },
  {
    file: 'screens/type-manager.ts',
    name: 'правка описания свойства',
    start: 'function openDescriptionOverrideDialog(',
    end: '// Метаданные (задача 04cd9794)',
  },
  {
    file: 'screens/property-manager.ts',
    name: 'редактор свойства / типа связи',
    start: 'export function openPropertyManagerEditor(',
    end: '// Сборка PropertyConfig из черновика',
  },
  {
    file: 'screens/settings.ts',
    name: 'настройки',
    start: 'export function showSettingsDialog(',
    end: '\0',
  },
  {
    file: 'editor/comment-hotkeys-dialog.ts',
    name: 'настройка сочетаний клавиш комментария',
    start: 'export function showCommentHotkeysDialog(',
    end: '\0',
  },
  {
    file: 'screens/networks.ts',
    name: 'создание мыслесети (экран сетей)',
    start: 'export async function showCreateNetworkDialog(',
    end: '\0',
  },
  {
    file: 'screens/tabs/picker.ts',
    name: 'создание мыслесети (пикер)',
    start: 'async function showCreateDialog(',
    end: '/** Pulls the freshest',
  },
  {
    file: 'screens/layers.ts',
    name: 'свойства слоя',
    start: 'function showLayerPropsDialog(',
    end: '/** Create-layer dialog',
  },
  {
    file: 'screens/layers.ts',
    name: 'новый слой',
    start: 'function openCreateLayerDialog(',
    end: '/** Delete-layer dialog',
  },
  {
    file: 'selection/dialogs.ts',
    name: 'значения свойств выделенных мыслей',
    start: 'export function showSelectionPropertiesDialog(',
    end: '\0',
  },
  {
    file: 'editor/attachments.ts',
    name: 'добавление вложения',
    start: "title: 'Добавить вложение',",
    end: 'return root;',
  },
  {
    file: 'screens/thought-type/filter-dialog.ts',
    name: 'редактор отбора (представления)',
    start: 'const criteriaBase = criteria.buildWire();',
    end: '// Save flow',
  },
];

/**
 * Диалоги, которые редакторами сущностей НЕ являются: списки, пикеры,
 * подтверждения, информационные окна и диалоги параметров операции. Здесь —
 * причина по каждому; у таких диалогов `dirty` быть не должно.
 */
const NON_EDITOR_DIALOG_FILES: ReadonlyMap<string, string> = new Map([
  ['admin/admin.ts', 'панель-список + подтверждения/инфо; формы добавления — инлайн, не диалог'],
  ['canvas/add-dialog.ts', 'пикер дублей и вспомогательные окна списка'],
  ['editor/icon-dialog.ts', 'пикер иконки (выбор значения, не форма правки)'],
  ['editor/style-dialog.ts', 'оформление применяется сразу при каждом изменении — черновика нет'],
  ['editor/wiki-link.ts', 'подтверждение перехода к мысли'],
  ['import-export/export-dialog.ts', 'диалог параметров операции экспорта, не редактор сущности'],
  ['import-export/import-dialog.ts', 'диалог параметров операции импорта, не редактор сущности'],
  ['lib/entity-picker.ts', 'пикеры/списки выбора сущностей'],
  ['lib/saved-filter-bar.ts', 'диалог-список сохранённых отборов'],
  ['pinned/pins.ts', 'информационное сообщение о пределе закреплённых'],
  ['screens/about-dialog.ts', 'информационное окно «О программе»'],
  ['screens/activity/activity.ts', 'снимок события / свернуть-обрезать журнал (инфо и подтверждения)'],
  ['screens/workspace-menus.ts', 'диалог-список участников сети'],
  ['trash.ts', 'подтверждения удаления и диалог-список корзины'],
]);

/** Исходник файла рендерера. */
function source(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}

/** Тело секции: от маркера начала до маркера конца (конец не входит). */
function section(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `маркер начала не найден: ${startMarker}`);
  if (endMarker === '\0') return src.slice(start);
  const end = src.indexOf(endMarker, start + startMarker.length);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

/** Редакторы без подключённого `dirty` (по исходникам из `sources`). */
function editorsWithoutDirty(sources: ReadonlyMap<string, string>): string[] {
  const broken: string[] = [];
  for (const spec of EDITOR_SPECS) {
    const src = sources.get(spec.file);
    if (src === undefined) {
      broken.push(`${spec.file} :: ${spec.name} — файл отсутствует`);
      continue;
    }
    let sec: string;
    try {
      sec = section(src, spec.start, spec.end);
    } catch {
      broken.push(`${spec.file} :: ${spec.name} — не найдена секция диалога`);
      continue;
    }
    for (const token of ['dirty:', 'isDirty:', 'save:']) {
      if (!sec.includes(token)) {
        broken.push(`${spec.file} :: ${spec.name} — нет ${token}`);
      }
    }
  }
  return broken;
}

/** Все редакторские файлы из {@link EDITOR_SPECS} (без повторов). */
function editorFiles(): Set<string> {
  return new Set(EDITOR_SPECS.map((spec) => spec.file));
}

describe('сторож: диалоги-редакторы подключены к подтверждению закрытия (b58f6aad)', () => {
  it('каждый редактор объявляет dirty: { isDirty, save }', () => {
    const files = new Set<string>([
      ...editorFiles(),
      ...NON_EDITOR_DIALOG_FILES.keys(),
    ]);
    const sources = new Map<string, string>();
    for (const rel of files) sources.set(rel, source(RENDERER_ROOT, rel));
    const broken = editorsWithoutDirty(sources);
    assert.deepEqual(
      broken,
      [],
      'Редактор без подтверждения закрытия: Esc/крестик потеряют правки. ' +
        'Подключите dirty (требование b58f6aad). Нарушения: ' +
        broken.join('; '),
    );
  });

  it('классификация полна: редактор или allow-список, без пересечений', () => {
    const editors = editorFiles();
    const overlap = [...editors].filter((rel) => NON_EDITOR_DIALOG_FILES.has(rel));
    assert.deepEqual(
      overlap,
      [],
      `файл одновременно редактор и не-редактор: ${overlap.join(', ')}`,
    );
  });

  it('у диалогов-не-редакторов dirty нет (не заводится по ошибке)', () => {
    const stray: string[] = [];
    for (const rel of NON_EDITOR_DIALOG_FILES.keys()) {
      if (source(RENDERER_ROOT, rel).includes('dirty:')) stray.push(rel);
    }
    assert.deepEqual(
      stray,
      [],
      `у не-редактора появился dirty — либо подключите механизм осознанно и ` +
        `перенесите файл в редакторы, либо уберите: ${stray.join(', ')}`,
    );
  });

  it('правило «есть dirty» краснеет на редакторе без него', () => {
    // Синтетические исходники: у каждого редактора есть его секция и вызов
    // `showDialog`, но нет ни `dirty`, ни `isDirty`, ни `save`.
    const byFile = new Map<string, string>();
    for (const spec of EDITOR_SPECS) {
      const prev = byFile.get(spec.file) ?? '';
      byFile.set(
        spec.file,
        `${prev}\n${spec.start}\n  showDialog({ title, size: 'm', body });\n${spec.end}\n`,
      );
    }
    const broken = editorsWithoutDirty(byFile);
    assert.ok(
      broken.some((entry) => entry.includes('нет dirty:')),
      'редактор без dirty обязан попадать в нарушения',
    );
    assert.equal(broken.length, EDITOR_SPECS.length * 3, 'каждый токен отсутствует у каждого редактора');
  });
});
