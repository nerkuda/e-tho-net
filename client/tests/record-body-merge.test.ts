/**
 * Построчное слияние черновика открытой правки записи с внешней правкой
 * источника (0.16.1, задача `b36a3d49`, блокер репроверки `90c35105`).
 *
 * **Что проверяется.** Пока правка записи открыта, источник меняется под ней
 * (панель «Отменить задачу» снимает маркер строки, чекбокс правит соседнюю).
 * Сохранение черновика не должно ни возвращать отменённую строку, ни терять
 * набранный пользователем текст: строки, которых он не касался, берутся из
 * источника, набранные — остаются. Одновременная правка ОДНОЙ строки —
 * приоритет пользователя (осознанный размен); разошлось число строк — слияние
 * невозможно, документ не трогаем.
 *
 * Модуль чистый (без DOM и сети), поэтому проверяется напрямую.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeRecordBody } from '../src/renderer/screens/chronicle/record-body-merge.js';

const TASK = '- [ ] Задача записи [[#11111111-1111-4111-8111-111111111111]] [[2026-11-19]]';
const CANCELLED = '- Задача записи [[#11111111-1111-4111-8111-111111111111]] [[2026-11-19]]';

describe('слияние черновика с внешней правкой записи', () => {
  it('пользователь ничего не набрал — берётся тело источника', () => {
    const known = `Заметка дня\n${TASK}`;
    const server = `Заметка дня\n${CANCELLED}`;
    assert.equal(mergeRecordBody(known, known, server), server);
  });

  it('источник не менялся — остаётся черновик со всем набранным', () => {
    const known = `Заметка дня\n${TASK}`;
    const user = `Заметка дня, дописал\n${TASK}`;
    assert.equal(mergeRecordBody(known, user, known), user);
  });

  it('набранная строка сохраняется, правка источника в другой строке применяется', () => {
    const known = `Заметка дня\n${TASK}`;
    const user = `Заметка дня, дописал\n${TASK}`;
    const server = `Заметка дня\n${CANCELLED}`;
    assert.equal(mergeRecordBody(known, user, server), `Заметка дня, дописал\n${CANCELLED}`);
  });

  it('правки обеих сторон в разных строках сливаются независимо', () => {
    const known = 'первая\nвторая\nтретья';
    const user = 'первая pravka\nвторая\nтретья';
    const server = 'первая\nвторая\nтретья pravka';
    assert.equal(mergeRecordBody(known, user, server), 'первая pravka\nвторая\nтретья pravka');
  });

  it('одну строку правили обе стороны — остаётся текст пользователя', () => {
    const known = `Заметка дня\n${TASK}`;
    const user = `Моя заметка\n${TASK}`;
    const server = `Заметка дня\n${CANCELLED}`;
    assert.equal(mergeRecordBody(known, user, server), `Моя заметка\n${CANCELLED}`);
  });

  it('источник добавил строку — слияние невозможно, документ не трогаем', () => {
    const known = `Заметка дня\n${TASK}`;
    const user = `Заметка дня, дописал\n${TASK}`;
    const server = `Заметка дня\nновая строка\n${CANCELLED}`;
    assert.equal(mergeRecordBody(known, user, server), null);
  });

  it('пользователь добавил строку — слияние невозможно, документ не трогаем', () => {
    const known = `Заметка дня\n${TASK}`;
    const user = `Заметка дня\nновая строка\n${TASK}`;
    const server = `Заметка дня\n${CANCELLED}`;
    assert.equal(mergeRecordBody(known, user, server), null);
  });

  it('обе стороны написали в пустую строку — слияние невозможно, документ не трогаем', () => {
    assert.equal(mergeRecordBody('', 'набрал', `- Задача`), null);
  });
});
