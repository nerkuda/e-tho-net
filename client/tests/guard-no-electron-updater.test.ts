/**
 * Сторож удаления `electron-updater` из клиента (задача 61cec451, ADR 9c49a5c7,
 * требование f663f875; требование d654473a — обновление только вручную через
 * страницу релиза).
 *
 * Правило: клиент не обновляет себя сам и не знает «последнюю версию».
 * Проверяются формы появления пакета и его автозагрузки:
 *
 * | Приём | Ловится |
 * |---|---|
 * | `import … from 'electron-updater'` | правило импорта |
 * | `import('electron-updater')` (динамический) | правило импорта |
 * | `require('electron-updater')` | правило импорта |
 * | `'electron-updater/dist/…'` (подпуть) | правило импорта |
 * | запись в `dependencies`/`devDependencies` `client/package.json` | проверка манифеста |
 * | `autoDownload` / `autoInstallOnAppQuit` в исходниках | правило автозагрузки |
 * | секция `publish:` в `client/electron-builder.yml` (фид автообновления) | проверка конфигурации |
 *
 * Лицензионный каталог `lib/third-party.ts` здесь НЕ проверяется: список
 * сторонних компонентов может упоминать пакет в пояснении, а запрет — про код
 * и конфигурацию обновления. Сторож входит в обычный прогон
 * `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Статический/динамический импорт и `require` пакета (включая подпути). */
const UPDATER_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]electron-updater(?:\/[^'"]*)?['"]/;

/** Флаги автообновления, которые запрещены ADR 9c49a5c7. */
const UPDATER_AUTOFLAGS = /\b(?:autoDownload|autoInstallOnAppQuit)\b/;

describe('guard: electron-updater удалён из клиента (61cec451)', () => {
  it('исходники клиента не импортируют electron-updater', () => {
    assertGuardClean(
      CLIENT_ROOT,
      [
        {
          name: 'no-electron-updater-import',
          description:
            'Импорт `electron-updater` (статический, динамический или require) ' +
            'запрещён: автообновление клиента удалено, обновление — только ' +
            'вручную через страницу релиза (ADR 9c49a5c7).',
          pattern: UPDATER_IMPORT,
          filePattern: UPDATER_IMPORT,
        },
        {
          name: 'no-auto-update-flags',
          description:
            '`autoDownload`/`autoInstallOnAppQuit` запрещены ADR 9c49a5c7: ' +
            'клиент не скачивает и не устанавливает обновления сам.',
          pattern: UPDATER_AUTOFLAGS,
        },
      ],
      // Тесты содержат сами шаблоны поиска — сканируем код и скрипты.
      { exclude: ['tests'] },
    );
  });

  it('в зависимостях клиента нет electron-updater', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    for (const section of ['dependencies', 'devDependencies'] as const) {
      const found = Object.keys(pkg[section] ?? {}).filter(
        (name) => name === 'electron-updater' || name.startsWith('electron-updater/'),
      );
      assert.deepEqual(
        found,
        [],
        `electron-updater не должен быть в ${section} client/package.json (61cec451).`,
      );
    }
  });

  it('electron-builder.yml не публикует фид автообновления', () => {
    const builder = fs.readFileSync(path.join(CLIENT_ROOT, 'electron-builder.yml'), 'utf8');
    assert.ok(
      !/^\s*publish\s*:/m.test(builder),
      'секция `publish` в client/electron-builder.yml — фид автообновления; ' +
        'после удаления electron-updater она не нужна (задача 61cec451).',
    );
    assert.ok(
      !/electron-updater/.test(builder),
      'client/electron-builder.yml не должен упоминать electron-updater.',
    );
  });
});
