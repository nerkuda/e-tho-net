/**
 * Сторож ошибки d60f61b5: сохранения псевдо-записи дневника сериализуются
 * очередью (`enqueueSlotSave`, diary.ts) и НЕ подменяются промисом уже идущего
 * сохранения.
 *
 * Что запрещает: в `ensureSlot` снова появится «вернуть чужой промис»,
 * (`if (slotBusy !== null) return slotBusy;`) — тогда раннее пустое сохранение
 * ухода фокуса (`ensureSlot({})`, план `none`) съест настоящее сохранение тела,
 * POST /comments не уйдёт, запись не создастся (живое воспроизведение: стенд
 * .tmp/ver-focus, сценарий d1). Также запрещает молчаливый выход в просмотр при
 * сбое сохранения слота: `onSave` обязан бросить, а не подменить html сырым md.
 *
 * Сторож краснеет при откате этих инвариантов; защиту от дубля записи (ошибка
 * 0757cd08) проверяет рядом.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');
const CHRONICLE = readFileSync(resolve(RENDERER, 'screens', 'chronicle', 'chronicle.ts'), 'utf8');
const DIARY = readFileSync(resolve(RENDERER, 'screens', 'chronicle', 'diary.ts'), 'utf8');

describe('сторож: сохранения слота сериализуются, содержимое не теряется (d60f61b5)', () => {
  it('ensureSlot ставит сохранение в очередь enqueueSlotSave', () => {
    assert.match(
      CHRONICLE,
      /const run = enqueueSlotSave\(slotBusy, \(\) => runEnsureSlot\(opts\)\);/,
      'очередь сохранений вместо подмены промиса',
    );
    assert.doesNotMatch(
      CHRONICLE,
      /if \(slotBusy !== null\)\s*return slotBusy;/,
      'запрещено возвращать промис чужого сохранения (теряет содержимое)',
    );
  });

  it('очередь enqueueSlotSave объявлена как чистая и экспортируемая', () => {
    assert.match(
      DIARY,
      /export function enqueueSlotSave<T>\(/,
      'очередь — чистый экспортируемый помощник (unit-тестируемый)',
    );
    assert.match(
      DIARY,
      /\(pending \?\? Promise\.resolve\(null\)\)\.catch\(\(\) => null\)\.then\(run\)/,
      'следующее сохранение ждёт предыдущее и стартует после него',
    );
  });

  it('слот не конвертируется, пока живой редактор поля открыт (иначе теряется текст)', () => {
    assert.match(
      CHRONICLE,
      /if \(opts\.convert === true \|\| \(!slotFocusInside && !slotFieldEditing\(state\)\)\) \{/,
      'конвертация только при закрытом редакторе поля либо явном convert',
    );
    assert.match(
      CHRONICLE,
      /function slotFieldEditing\(state: SlotState\): boolean \{\s*return state\.root\.querySelector\('\.md-field--editing'\) !== null;/,
      'состояние правки поля — по классу каркаса правки',
    );
    assert.match(
      CHRONICLE,
      /const created = await ensureSlot\(\{ body: md, convert: true \}\);/,
      'жест записи поля конвертирует слот сразу (Ctrl+Enter/клик вне)',
    );
  });

  it('сбой сохранения слота сообщается (notice), а не уходит молча в просмотр', () => {
    assert.match(
      CHRONICLE,
      /if \(created === null && md\.trim\(\) !== ''\) \{\s*throw new Error\(t\('diary\.slotNotSaved'\)\);/,
      'onSave слота бросает при неудаче вместо подмены html сырым markdown',
    );
  });

  it('защита от дубля записи сохранена (ошибка 0757cd08)', () => {
    assert.match(CHRONICLE, /state\.commentId = comment\.id;/, 'создание запоминает id');
    assert.match(
      CHRONICLE,
      /comment = await updateSlotComment\(networkId, state\.commentId!, plan, extra, home\);/,
      'существующая запись обновляется, а не создаётся второй раз',
    );
  });
});
