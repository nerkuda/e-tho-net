/**
 * Сторож стандарта «Клиент: ввод значения свойства — только через общий
 * редактор значения» (S2, задача 77e7cafd вехи 4 версии 0.8.2; ADR «значение
 * свойства вводит один компонент, свитч по виду значения — в одном
 * экземпляре»).
 *
 * Правило: `switch` по `value_type` (в любом написании — `value_type`,
 * `valueType`) для построения поля ввода встречается ТОЛЬКО в
 * `editor/value-editor.ts` — единственном месте клиента, где поле значения
 * строится свитчем по виду. Новый вид значения добавляется в одном месте и
 * появляется во всех диалогах сразу; четыре свитча-пересказа (таблица
 * свойств, диалог «Свойство / связь», редактор типа, панель выбранных)
 * больше не расходятся по возможностям.
 *
 * Сторож вводится зелёным — в том же изменении, которое переводит все поля
 * ввода на общий редактор (мета-стандарт «Правило без теста-сторожа
 * не считается введённым»).
 */

import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

describe('guard: ввод значения свойства строится только общим редактором', () => {
  it('switch по value_type/valueType вне editor/value-editor.ts запрещён', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-value-type-switch',
        description:
          '`switch` по виду значения (value_type/valueType) для построения поля ' +
          'ввода разрешён только в editor/value-editor.ts (стандарт S2, ADR ' +
          '«значение свойства вводит один компонент…»).',
        filePattern: /\bswitch\s*\(\s*[^)]*\bvalue_?[tT]ype\s*\)/g,
        allow: (rel) => rel === 'editor/value-editor.ts',
      },
    ]);
  });
});
