/**
 * Черновик постоянного комментария не должен впитывать текст правки блока
 * трансклюзии (ошибка 59d9b5f3, 0.12.1).
 *
 * Симптом: пока блок трансклюзии в правке, в поле вместо ссылки-трансклюзии лежит
 * текст источника. Поле уведомляет владельца о каждом изменении
 * (`onInput` → `scheduleDraft`, `comments.ts`), поэтому подменённый текст уходил
 * в черновик, и после аварийного закрытия предложенный черновик содержал
 * «растворённую» трансклюзию — сохранение портило контейнер.
 *
 * Решение (вариант а): пока идёт правка блока, владельцу не сообщается ничего.
 *
 * Тест бьёт по САМОЙ ОБВЯЗКЕ (`mdEditorInternals.notifyMdInput`) — той функции,
 * которую вызывает `EditorView.updateListener` в `md-editor.ts`. Поэтому снятие
 * гейта (вызова `inputMirrorText`/раннего `return`) краснит тест, а не остаётся
 * зелёным при целом хелпере. Настоящий `EditorView` в проекте недоступен (нет
 * jsdom), поэтому состояние правки блока строится реальным `EditorState`, а
 * «событие обновления» — минимальным объектом `{ docChanged, state }`, которому
 * структурно удовлетворяет `ViewUpdate`. Headless — без DOM и сети.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EditorState } from '@codemirror/state';

import { parseTransclusions } from '@etn/markdown';

import { mdEditorInternals, type MdInputUpdate } from '../src/renderer/editor/md-editor.js';
import {
  isBlockEditing,
  setBlockEdit,
  transclusionInternals,
  transclusionState,
} from '../src/renderer/editor/transclusion.js';

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const SOURCE_BODY = 'ТЕЛО ИСТОЧНИКА';

interface BlockEditFixture {
  /** Состояние поля после входа в правку — ссылка подменена телом источника. */
  state: EditorState;
  /** Исходный markdown контейнера (со ссылкой-трансклюзией). */
  container: string;
  from: number;
  to: number;
  raw: string;
}

/** Вход в правку блока как в проде: ссылка заменена телом источника. */
function enterBlockEdit(): BlockEditFixture {
  const raw = `![[#${ID_A}]]`;
  const container = `вступление ${raw} окончание`;
  const ref = parseTransclusions(container)[0]!;
  const from = ref.start;
  const to = ref.start + SOURCE_BODY.length;
  const base = EditorState.create({ doc: container, extensions: [transclusionState] });
  const state = base.update({
    changes: { from: ref.start, to: ref.end, insert: SOURCE_BODY },
    effects: [
      setBlockEdit.of(ID_A),
      transclusionInternals.setBlockEditRange.of({
        sourceId: ID_A,
        section: null,
        refRaw: raw,
        from,
        to,
      }),
    ],
  }).state;
  return { state, container, from, to, raw };
}

/** Собирает значения, переданные владельцу через обвязку `onInput`. */
function collectMirror(state: EditorState, docChanged = true): string[] {
  const seen: string[] = [];
  mdEditorInternals.notifyMdInput({ docChanged, state } satisfies MdInputUpdate, (md) => {
    seen.push(md);
  });
  return seen;
}

test('правка блока: обвязка onInput НЕ уведомляет владельца — подменённый текст не уходит в черновик', () => {
  const { state, container } = enterBlockEdit();

  assert.equal(isBlockEditing(state), true, 'режим правки блока активен');
  const substituted = state.doc.toString();
  assert.ok(substituted.includes(SOURCE_BODY), 'в документе поля лежит текст источника');
  assert.ok(!substituted.includes(`![[#${ID_A}]]`), 'ссылка-трансклюзия подменена — черновик испортился бы');
  assert.notEqual(substituted, container);

  // Реальный путь листенера: update.docChanged=true в состоянии правки блока.
  // Владелец (saveDraft) не должен получить ничего.
  assert.deepEqual(
    collectMirror(state),
    [],
    'пока идёт правка блока onInput подавлен обвязкой',
  );
});

test('выход из правки блока: обвязка снова отдаёт исходный текст со ссылкой', () => {
  const { state, container, from, to, raw } = enterBlockEdit();

  const restored = state.update({
    changes: { from, to, insert: raw },
    effects: [setBlockEdit.of(null), transclusionInternals.setBlockEditRange.of(null)],
  }).state;

  assert.equal(isBlockEditing(restored), false, 'правка блока завершена');
  const seen = collectMirror(restored);
  assert.deepEqual(seen, [container], 'владельцу ушёл исходный markdown контейнера');
  assert.ok(seen[0]!.includes(`![[#${ID_A}]]`), 'ссылка-трансклюзия на месте — черновик корректен');
});

test('вне правки блока обвязка onInput продолжает уведомлять владельца', () => {
  const state = EditorState.create({ doc: 'обычный текст', extensions: [transclusionState] });
  assert.deepEqual(collectMirror(state), ['обычный текст']);
});

test('обвязка не дёргает onInput без изменения документа', () => {
  const state = EditorState.create({ doc: 'без правок', extensions: [transclusionState] });
  assert.deepEqual(collectMirror(state, false), [], 'selectionSet без docChanged onInput не шлёт');
});
