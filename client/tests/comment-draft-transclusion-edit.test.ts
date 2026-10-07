/**
 * Черновик постоянного комментария не должен впитывать текст правки блока
 * трансклюзии (ошибка 59d9b5f3, 0.12.1).
 *
 * Симптом: пока блок трансклюзии в правке, в поле вместо ссылки `![[#id]]`
 * лежит текст источника. Поле уведомляет владельца о каждом изменении
 * (`onInput` → `scheduleDraft`, `comments.ts`), поэтому подменённый текст уходил
 * в черновик, и после аварийного закрытия предложенный черновик содержал
 * «растворённую» трансклюзию — сохранение портило контейнер.
 *
 * Решение (вариант а): пока идёт правка блока, `onInput` наружу не сообщается
 * вовсе (`md-editor.ts`, гейт `inputMirrorText`). Здесь проверяется сам гейт на
 * реальном `EditorState` в состоянии правки блока: подменённый текст не
 * отдаётся (значение `null` — вызова `saveDraft` не будет), после выхода из
 * правки возвращается исходный текст со ссылкой (обычная запись черновика
 * работает). Headless — без DOM и сети.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EditorState } from '@codemirror/state';

import { parseTransclusions } from '@etn/markdown';

import { mdEditorInternals } from '../src/renderer/editor/md-editor.js';
import {
  isBlockEditing,
  setBlockEdit,
  transclusionInternals,
  transclusionState,
} from '../src/renderer/editor/transclusion.js';

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const SOURCE_BODY = 'ТЕЛО ИСТОЧНИКА';

interface BlockEditFixture {
  /** Документ поля после входа в правку — ссылка подменена телом источника. */
  state: EditorState;
  /** Исходный markdown контейнера (со ссылкой `![[#id]]`). */
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

test('правка блока: подменённый текст источника не отдаётся в onInput (черновик не пишется)', () => {
  const { state, container } = enterBlockEdit();

  assert.equal(isBlockEditing(state), true, 'режим правки блока активен');
  const substituted = state.doc.toString();
  assert.ok(substituted.includes(SOURCE_BODY), 'в документе поля лежит текст источника');
  assert.ok(!substituted.includes(`![[#${ID_A}]]`), 'ссылка-трансклюзия подменена — черновик испортился бы');
  assert.notEqual(substituted, container);

  // Гейт редактора: владельцу (saveDraft) не сообщается ничего — подменённый
  // текст не может попасть в черновик.
  assert.equal(
    mdEditorInternals.inputMirrorText(state),
    null,
    'пока идёт правка блока — onInput подавлен',
  );
});

test('выход из правки блока: onInput снова отдаёт исходный текст со ссылкой', () => {
  const { state, container, from, to, raw } = enterBlockEdit();

  const restored = state.update({
    changes: { from, to, insert: raw },
    effects: [setBlockEdit.of(null), transclusionInternals.setBlockEditRange.of(null)],
  }).state;

  assert.equal(isBlockEditing(restored), false, 'правка блока завершена');
  const md = mdEditorInternals.inputMirrorText(restored);
  assert.equal(md, container, 'отдаётся исходный markdown контейнера');
  assert.ok(md!.includes(`![[#${ID_A}]]`), 'ссылка-трансклюзия на месте — черновик корректен');
});

test('вне правки блока onInput продолжает отдавать текст (обычная запись черновика работает)', () => {
  const state = EditorState.create({ doc: 'обычный текст', extensions: [transclusionState] });
  assert.equal(mdEditorInternals.inputMirrorText(state), 'обычный текст');
});
