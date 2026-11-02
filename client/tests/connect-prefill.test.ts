/**
 * Аргументы предзаполнения подключения от установщика (ошибка 0f8dd0f3,
 * п.6 карточки 860def0d).
 *
 * Установщик при «Запустить клиент» передаёт имя и адрес локального сервера
 * (`ETN.exe --connect-url=http://localhost:<порт> --connect-name="Локальный
 * сервер"`); клиент на первом запуске показывает новое подключение с
 * заполненными именем и адресом, API-ключ вводит пользователь.
 *
 * Тест держит контракт разбора argv:
 *  - без флагов (обычный запуск из меню) — предзаполнения нет;
 *  - оба флага — имя и адрес (хвостовой «/» снимается, как в
 *    `server.addProfile`);
 *  - неполный набор или некорректный адрес — предзаполнения нет (лучше пустая
 *    форма, чем мусор в полях);
 *  - чужие флаги с похожим префиксом не подходят.
 *
 * Мутации, которые краснят: вернуть предзаполнение при одном флаге; принять
 * `ftp://`; не обрезать хвостовой «/».
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseConnectArgs } from '../src/main/connect-prefill.js';

describe('parseConnectArgs: предзаполнение подключения из argv установщика', () => {
  it('без connect-флагов (обычный запуск) — null', () => {
    assert.equal(parseConnectArgs(['ETN.exe']), null);
    assert.equal(parseConnectArgs([]), null);
    assert.equal(parseConnectArgs(['ETN.exe', '--user-data-dir=C:\\tmp\\profile']), null);
  });

  it('имя и адрес от установщика — предзаполнение собрано', () => {
    assert.deepEqual(
      parseConnectArgs([
        'ETN.exe',
        '--connect-url=http://localhost:4321',
        '--connect-name=Локальный сервер',
      ]),
      { name: 'Локальный сервер', url: 'http://localhost:4321' },
    );
  });

  it('хвостовой «/» адреса снимается, лишние пробелы обрезаются', () => {
    assert.deepEqual(
      parseConnectArgs([
        'ETN.exe',
        '--connect-url= http://localhost:4321/ ',
        '--connect-name= Локальный сервер ',
      ]),
      { name: 'Локальный сервер', url: 'http://localhost:4321' },
    );
  });

  it('кавычки вокруг значения (argv доехал как есть) снимаются', () => {
    assert.deepEqual(
      parseConnectArgs([
        'ETN.exe',
        '--connect-url="http://localhost:4321"',
        '--connect-name="Локальный сервер"',
      ]),
      { name: 'Локальный сервер', url: 'http://localhost:4321' },
    );
  });

  it('неполный набор — null', () => {
    assert.equal(parseConnectArgs(['ETN.exe', '--connect-url=http://localhost:4321']), null);
    assert.equal(parseConnectArgs(['ETN.exe', '--connect-name=Локальный сервер']), null);
    assert.equal(parseConnectArgs(['ETN.exe', '--connect-url=', '--connect-name=Сервер']), null);
  });

  it('некорректный адрес — null', () => {
    assert.equal(
      parseConnectArgs(['ETN.exe', '--connect-url=localhost:4321', '--connect-name=Сервер']),
      null,
    );
    assert.equal(
      parseConnectArgs(['ETN.exe', '--connect-url=ftp://localhost:4321', '--connect-name=Сервер']),
      null,
    );
  });

  it('чужие флаги с похожим префиксом не подходят', () => {
    assert.equal(
      parseConnectArgs([
        'ETN.exe',
        '--connect-urlx=http://localhost:4321',
        '--connect-namex=Сервер',
      ]),
      null,
    );
  });
});
