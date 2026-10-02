/**
 * Создание полки и видимость пустой полки (0.11.1, ошибка 87ad669a).
 *
 * Контракт проводки проверяется по исходникам модулей (как сторож `guard-*`):
 *  * диалог СОЗДАНИЯ полки берёт заголовок/подпись из ключей создания
 *    (`publications.shelf.create` / `publications.shelf.name`), а не из ключа
 *    переименования;
 *  * переименование полки — inline по двойному клику (задача 00160da1), а не
 *    пункт контекстного меню;
 *  * только что созданная пустая полка видна в обоих видах: секция полки с
 *    пустым состоянием (`publications.shelf.empty`) в виде «полки» и группа в
 *    виде «список» (пустые полки не пропускаются).
 *
 * Тест входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLICATIONS = path.join(
  CLIENT_ROOT,
  'src',
  'renderer',
  'screens',
  'publications',
  'publications.ts',
);
const LOCALES = path.join(CLIENT_ROOT, 'src', 'renderer', 'lib', 'locales', 'ru.ts');

const source = fs.readFileSync(PUBLICATIONS, 'utf8');

describe('публикации: создание полки и пустая полка (87ad669a)', () => {
  it('диалог создания использует ключи создания, а не переименования', () => {
    const start = source.indexOf('async function createShelf(');
    assert.ok(start >= 0, 'не найдена функция createShelf');
    const block = source.slice(start, source.indexOf('\n}', start));
    assert.ok(
      block.includes("t('publications.shelf.create')"),
      'заголовок диалога создания — из ключа publications.shelf.create («Новая полка»)',
    );
    assert.ok(
      block.includes("t('publications.shelf.name')"),
      'подпись поля — из ключа publications.shelf.name («Название полки»)',
    );
    assert.ok(
      !block.includes("t('publications.shelf.rename')"),
      'путь создания не должен использовать ключ переименования',
    );
  });

  it('переименование полки — inline по двойному клику, а не пункт меню', () => {
    assert.ok(source.includes('startShelfRename'), 'переименование реализовано inline');
    assert.ok(source.includes('dblclick'), 'двойной клик по имени открывает inline-правку');
    assert.ok(
      source.includes("t('publications.shelf.rename')"),
      'ключ переименования остаётся (подпись поля ввода)',
    );
    const menuStart = source.indexOf('function openShelfMenu');
    assert.ok(menuStart >= 0, 'не найдена функция openShelfMenu');
    const menu = source.slice(menuStart, source.indexOf('function publicationBlockedLines'));
    assert.ok(
      !menu.includes("menuAction(t('publications.shelf.rename')"),
      'из контекстного меню пункт переименования убран (задача 00160da1)',
    );
  });

  it('пустая полка видна в виде «полки» — секция с пустым состоянием', () => {
    assert.ok(
      source.includes("t('publications.shelf.empty')"),
      'пустое состояние полки берётся из словаря publications.shelf.empty',
    );
    assert.ok(
      source.includes('toggleShelfEmpty('),
      'секция полки переключает своё пустое состояние по числу публикаций',
    );
    assert.ok(
      source.includes('shelfEmptyHosts'),
      'пустое состояние живёт в отдельном хосте секции полки',
    );
  });

  it('в виде «список» пустые полки не пропускаются — группа с пустым состоянием', () => {
    assert.ok(
      !/if \(items\.length === 0\) continue;/.test(source),
      'renderList не должен пропускать пустые полки (ошибка 87ad669a)',
    );
    assert.ok(
      source.includes("t('publications.shelf.empty')"),
      'у пустой группы списка — пустое состояние полки',
    );
    assert.ok(
      source.includes('group.empty'),
      'группа списка несёт признак пустоты (раскрыта, чтобы состояние было видно)',
    );
  });

  it('словарь содержит ключи создания и пустого состояния', () => {
    const ru = fs.readFileSync(LOCALES, 'utf8');
    assert.ok(ru.includes("'publications.shelf.create': 'Новая полка'"));
    assert.ok(ru.includes("'publications.shelf.name': 'Название полки'"));
    assert.ok(ru.includes("'publications.shelf.empty': 'На полке пока нет публикаций'"));
  });
});
