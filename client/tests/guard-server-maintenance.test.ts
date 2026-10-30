/**
 * Сторож режима обслуживания сервера (задача 479e37ed, требование 9636b1cc).
 *
 * Правила, которые легко нарушить незаметно для типов:
 *  1. Центральный IPC-гейт изменений обязан спросить состояние обслуживания
 *     РАНЬШЕ, чем объявить обрыв связи: сокет закрыт именно из-за обновления,
 *     и пользователь должен увидеть `SERVER_UPDATING`, а не «нет соединения».
 *  2. Предупреждение о потерянной связи показывает текст обслуживания раньше
 *     таблицы статусов — иначе «сервер обновляется» превращается в «аварию».
 *  3. Закрытие `1012` распознаётся только через общий справочник
 *     `REALTIME_CLOSE_CODES` (литерал `1012` разъезжается с сервером).
 *  4. Тексты обслуживания из словаря не называют сервер «недоступным».
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ru } from '../src/renderer/lib/locales/ru.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_ROOT = path.join(CLIENT_ROOT, 'src', 'main');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('guard: обслуживание сервера (479e37ed)', () => {
  it('IPC-гейт изменений отвечает SERVER_UPDATING раньше «обрыва связи»', () => {
    const source = read(path.join(MAIN_ROOT, 'ipc', 'register.ts'));
    const maintenance = source.indexOf('mutation blocked: server maintenance');
    const linkDown = source.indexOf('mutation blocked: network link down');
    assert.notEqual(maintenance, -1, 'нет ветки обслуживания в центральном IPC-гейте');
    assert.notEqual(linkDown, -1, 'пропала ветка обрыва связи');
    assert.ok(
      maintenance < linkDown,
      'ветка обслуживания обязана стоять ДО ветки connection-lost',
    );
    assert.match(source, /serverUpdatingError\(\{/, 'отказ отдаётся каноническим SERVER_UPDATING');
  });

  it('потеря связи показывает текст обслуживания раньше таблицы статусов', () => {
    const source = read(path.join(RENDERER_ROOT, 'drafts.ts'));
    const maintenance = source.indexOf('store.state.serverMaintenance');
    const linkTable = source.indexOf("t('realtime.link.lostReconnecting')");
    assert.notEqual(maintenance, -1, 'drafts.ts не учитывает обслуживание');
    assert.ok(
      maintenance < linkTable,
      'проверка обслуживания обязана стоять до выбора текста по статусу связи',
    );
  });

  it('close 1012 — только через REALTIME_CLOSE_CODES.SERVICE_RESTART', () => {
    const source = read(path.join(MAIN_ROOT, 'net', 'ws-client.ts'));
    assert.match(source, /code === REALTIME_CLOSE_CODES\.SERVICE_RESTART/);
    assert.doesNotMatch(source, /code === 1012/, 'литерал 1012 в ws-client.ts');
  });

  it('словарные тексты обслуживания не путают его с недоступностью', () => {
    const keys = ['realtime.maintenance.waiting', 'realtime.maintenance.noRetry'] as const;
    for (const key of keys) {
      const text = ru[key];
      assert.ok(text.trim().length > 0, `${key}: пустой текст`);
      assert.doesNotMatch(text, /недоступен|нет соединения|ошибк/i, `${key}: «${text}»`);
      assert.match(text, /обновляется/i, `${key}: текст не про обновление`);
    }
    assert.match(ru['realtime.status.serverMaintenance'], /обновление/);
  });
});
