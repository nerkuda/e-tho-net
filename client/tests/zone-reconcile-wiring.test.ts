/**
 * Проводка сценария «своя запись → обновление счётчика, порции и списка
 * значений» (ошибка ec5ba58c).
 *
 * Логика сверки счётчиков чистая и проверяется в `zone-paging.test.ts`; здесь
 * закреплены концы, которые иначе молча отваливаются: холст обязан сверять
 * количества на свежем ответе ТОГО ЖЕ фокуса, дотягивать порцию по признаку
 * роста и звать общий канал перечитывания значений, а таблица свойств —
 * слушать тот канал в обеих группах (свойства типа и свойства вне типа).
 *
 * Модули холста и редактора завязаны на DOM/IPC и в юнит-раннере не
 * поднимаются (см. `editor-tabs-structure.test.ts`), поэтому проверяются
 * структурные якоря исходников — приём, принятый в этом наборе тестов.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { PROPERTY_VALUES_REFRESHED_EVENT } from '../src/renderer/lib/property-values-refresh.js';

const SRC = {
  canvas: resolve(import.meta.dirname, '..', 'src', 'renderer', 'canvas', 'canvas.ts'),
  addDialog: resolve(import.meta.dirname, '..', 'src', 'renderer', 'canvas', 'add-dialog.ts'),
  properties: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'properties.ts'),
  valueEditor: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'value-editor.ts'),
};

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('холст: сверка секторов на свежем ответе того же фокуса (ec5ba58c)', () => {
  const src = readText(SRC.canvas);

  it('сверка запускается на свежем ответе фокуса, а не только при его смене', () => {
    assert.ok(
      src.includes('function syncZoneTotalsWithFreshFocus()'),
      'есть точка сверки на свежем ответе фокуса',
    );
    assert.ok(
      src.includes('if (focus.focused.id !== lastFocusId) return;'),
      'смену фокуса сверка не трогает — её отрабатывает render()',
    );
    // Сверка стоит ДО fast-path подписчика: ответ без видимых изменений
    // (новая мысль за загруженной порцией) иначе не дошёл бы до render().
    const subscriber = src.slice(src.indexOf('store.subscribe(() => {'));
    const syncAt = subscriber.indexOf('syncZoneTotalsWithFreshFocus();');
    const keyAt = subscriber.indexOf('const key = canvasRenderKey();');
    assert.ok(syncAt >= 0 && keyAt > syncAt, 'сверка идёт до вычисления подписи отрисовки');
  });

  it('счётчики сверяются чистой функцией и не теряют показанный префикс', () => {
    assert.ok(src.includes('planZoneReconcile('), 'пересчёт идёт через planZoneReconcile');
    assert.ok(
      src.includes('next.loaded = plan.counters.loaded;'),
      'префикс переносится из плана, а не сбрасывается к первой порции',
    );
  });

  it('рост количества дотягивает порцию — новая мысль появляется без смены фокуса', () => {
    assert.ok(
      src.includes('if (plan.grew) toTopUp.push(dir);'),
      'по признаку роста сектор попадает в список догрузки',
    );
    assert.ok(
      src.includes('for (const dir of toTopUp) await appendNextZonePage(dir);'),
      'догрузка выполняется по признаку роста, без ожидания скролла',
    );
    // Порция — общая с подгрузкой по скроллу: одна реализация на оба триггера.
    const calls = src.split('await appendNextZonePage(dir);').length - 1;
    assert.ok(calls >= 2, `appendNextZonePage зовётся из скролла и из сверки, найдено ${calls}`);
  });

  it('изменение окрестности уведомляет карточку о перечитывании значений свойств', () => {
    const reconcile = src.slice(src.indexOf('async function reconcileZoneTotals'));
    assert.ok(
      reconcile.slice(0, reconcile.indexOf('\n}\n')).includes('notifyPropertyValuesRefreshed()'),
      'сверка шлёт общий канал перечитывания значений',
    );
  });
});

describe('таблица свойств: слушает общий канал (ec5ba58c)', () => {
  it('обе группы (типа и вне типа) перечитывают значения по каналу', () => {
    const src = readText(SRC.properties);
    // Импорт + по одному слушателю на группу («Свойства типа» и «Свойства вне
    // типа») — не меньше трёх упоминаний константы.
    const listeners = src.split('PROPERTY_VALUES_REFRESHED_EVENT').length - 1;
    assert.ok(listeners >= 3, `упоминаний константы канала: ${listeners}, ожидалось не меньше трёх`);
    assert.ok(
      !src.includes(PROPERTY_VALUES_REFRESHED_EVENT),
      'имя события берётся из общего модуля, а не литералом',
    );
  });

  it('редактор значения шлёт канал через общий хелпер', () => {
    const src = readText(SRC.valueEditor);
    assert.ok(
      src.includes('notifyPropertyValuesRefreshed(key);'),
      'crossResolve уведомляет о перечитывании значений',
    );
    assert.ok(
      !src.includes('new CustomEvent('),
      'имя события и диспатч живут в lib/property-values-refresh.ts',
    );
  });
});

describe('место записи уведомляет таблицу, независимо от сверки карты (da032ee3)', () => {
  it('диалог добавления связи с карты шлёт канал после записи рёбер', () => {
    const src = readText(SRC.addDialog);
    assert.ok(
      src.includes("from '../lib/property-values-refresh.js'"),
      'канал берётся из общего модуля',
    );
    const insert = src.slice(src.indexOf('async function insertIntoCanvas'));
    assert.ok(
      insert.slice(0, insert.indexOf('\n}\n')).includes('notifyPropertyValuesRefreshed()'),
      'после создания/связывания мыслей карта уведомляет таблицу значений свойств',
    );
  });

  it('сохранение значения свойства-связи уведомляет ключом своего свойства', () => {
    const src = readText(SRC.valueEditor);
    const persist = src.slice(src.indexOf('const persist = async'));
    assert.ok(
      persist
        .slice(0, persist.indexOf('\n  };'))
        .includes("notifyPropertyValuesRefreshed(definition.key ?? '')"),
      'persist редактора связи уведомляет таблицу ключом записанного свойства',
    );
  });
});
