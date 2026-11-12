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

import { ru } from '../src/renderer/lib/locales/ru.js';
import {
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
