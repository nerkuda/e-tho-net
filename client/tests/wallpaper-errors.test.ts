/**
 * Тексты ошибок фоновой картинки в футере настроек (0.16.1, задача 80324150;
 * сценарий 88a8879d).
 *
 * Пользователь должен видеть причину, а не сырой конверт сервера: 422 с
 * `details.field=file_size` — «файл больше лимита 5 МБ», прочие отказы
 * валидации — общая подсказка «проверьте формат и размер», сетевой сбой —
 * «сервер недоступен, повторите позже». Отказы подготовки (крупный исходник,
 * крупный результат, не-картинка) приходят ключами словаря из чистого пайплайна.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError, NOT_CONNECTED_ERROR_TEXT } from '@etn/shared';

import { en } from '../src/renderer/lib/locales/en.js';
import { ru } from '../src/renderer/lib/locales/ru.js';
import { zh } from '../src/renderer/lib/locales/zh.js';
import {
  imagePickErrorText,
  wallpaperPrepareError,
  wallpaperUploadError,
} from '../src/renderer/lib/wallpaper-errors.js';

describe('wallpaperPrepareError: ключи отказа подготовки', () => {
  it('ключ с параметром переводится с подстановкой', () => {
    assert.equal(
      wallpaperPrepareError('wallpaperErrorTooLargeResult:5'),
      ru['settings.wallpaperErrorTooLargeResult'].replace('%1', '5'),
    );
  });

  it('ключ без параметра переводится как есть', () => {
    assert.equal(
      wallpaperPrepareError('wallpaperErrorNotImage'),
      ru['settings.wallpaperErrorNotImage'],
    );
    assert.equal(
      wallpaperPrepareError('wallpaperErrorTooLargeSource:40'),
      ru['settings.wallpaperErrorTooLargeSource'].replace('%1', '40'),
    );
  });

  it('чужая строка не переводится и не искажается', () => {
    assert.equal(wallpaperPrepareError('файл не выбран'), 'файл не выбран');
    assert.equal(wallpaperPrepareError('fatal: oops'), 'fatal: oops');
  });
});

describe('wallpaperUploadError: отказы сервера и сети', () => {
  it('422 с field=file_size — про лимит файла', () => {
    const err = new EtnError('VALIDATION_ERROR', 'wallpaper file too large', {
      field: 'file_size',
    });
    assert.equal(wallpaperUploadError(err), ru['settings.wallpaperErrorFileSize']);
  });

  it('422 по другим полям — общая подсказка про формат и размер', () => {
    const meta = new EtnError('VALIDATION_ERROR', 'bad meta', { field: 'meta' });
    assert.equal(wallpaperUploadError(meta), ru['settings.wallpaperErrorServer']);
    const noDetails = new EtnError('VALIDATION_ERROR', 'bad request');
    assert.equal(wallpaperUploadError(noDetails), ru['settings.wallpaperErrorServer']);
  });

  it('сетевой сбой — «сервер недоступен», а не текст конверта', () => {
    const err = new EtnError('INTERNAL', 'internal error');
    const text = wallpaperUploadError(err);
    assert.equal(text, ru['errors.serverUnavailable']);
  });

  it('офлайн «not connected» — текст обрыва связи, а не сырая строка', () => {
    const text = wallpaperUploadError(new Error(NOT_CONNECTED_ERROR_TEXT));
    assert.equal(text, ru['errors.connectionLost']);
  });
});

describe('imagePickErrorText: коды системного выбора картинки', () => {
  it('image_too_large — лимит с подстановкой мегабайт', () => {
    // Потолок приходит из main числом: у вложения — 10 МиБ, у фоновой
    // картинки — 40 МиБ; текст один, меняется только параметр.
    assert.equal(
      imagePickErrorText({ status: 'error', code: 'image_too_large', max_bytes: 40 * 1024 * 1024 }),
      ru['settings.wallpaperErrorSourceLimit'].replace('%1', '40'),
    );
    assert.equal(
      imagePickErrorText({ status: 'error', code: 'image_too_large', max_bytes: 10 * 1024 * 1024 }),
      ru['settings.wallpaperErrorSourceLimit'].replace('%1', '10'),
    );
  });

  it('image_unreadable — «не читается как изображение»', () => {
    assert.equal(
      imagePickErrorText({ status: 'error', code: 'image_unreadable' }),
      ru['settings.wallpaperErrorNotImage'],
    );
  });
});

describe('словарь: лимит исходника картинки', () => {
  it('ключ лимита исходника есть во всех языках и с подстановкой %1', () => {
    const catalogs = [
      ['ru', ru],
      ['en', en],
      ['zh', zh],
    ] as const;
    for (const [lang, catalog] of catalogs) {
      const value = catalog['settings.wallpaperErrorSourceLimit'];
      assert.equal(typeof value, 'string', `${lang}: ключ отсутствует`);
      assert.ok(value.includes('%1'), `${lang}: нет подстановки %1`);
      if (lang !== 'ru') {
        assert.equal(
          /[А-Яа-яЁё]/.test(value),
          false,
          `${lang}: русская строка из main не должна доходить до интерфейса — ${value}`,
        );
      }
    }
  });
});
