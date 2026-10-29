/**
 * Сторож баннера рекомендованной версии клиента (элемент ed068706, компонент
 * 06d88619, задача b57910b5).
 *
 * Правило: напоминание о рекомендованной версии клиента — РОВНО один модуль
 * `lib/update-banner.ts`. Рядом с ним второй баннер легко заводится «по месту»
 * (экран, статус-бар, тост), и тогда состояние `recommended-update` начнёт
 * показываться дважды и разными словами. Проверяются четыре инварианта:
 *
 * 1. **Разметка баннера — только в модуле.** Классы `.update-banner*` в
 *    исходниках рендерера объявляет/использует только `lib/update-banner.ts`
 *    (вид — `styles/layout.css`); импорт модуля разрешён.
 * 2. **Состояние `banner` читает только модуль.** Поле `banner` вердикта
 *    совместимости (сущность 89aad200) — проекция ровно для баннера; другие
 *    модули обязаны смотреть на `status`/`blocking`, иначе появятся самодельные
 *    напоминания.
 * 3. **Без тоста.** Баннер не использует `notice()`/тост: тот автозакрывается
 *    и не содержит действий (границы компонента 06d88619).
 * 4. **Страница релиза — только у баннера и блокирующего диалога.** Поле
 *    `downloadUrl` в рендерере читают только эти две точки: остальные ветки
 *    обновления клиента переехали в ТП обновления сервера 2d9f5cc7 (ТП
 *    52b33158 п. К6).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Модуль — единственный владелец баннера. */
const BANNER_MODULE = 'lib/update-banner.ts';

/** Комментарий (строчный, блочный или JSDoc) — не разметка. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Импорт самого модуля баннера — разрешённый способ им пользоваться. */
function isBannerImport(line: string): boolean {
  return /from\s+['"][^'"]*lib\/update-banner\.js['"]/.test(line);
}

/** Класс семьи `.update-banner*` (разметка или имя в строке). */
const UPDATE_BANNER_CLASS = /\bupdate-banner(-[a-z0-9-]+)?\b/;

describe('guard: единственная точка баннера рекомендованной версии (b57910b5)', () => {
  it('классы баннера объявлены только в lib/update-banner.ts', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'update-banner-single-point',
        description:
          'Баннер рекомендованной версии — единственная точка показа ' +
          '(элемент ed068706): классы `.update-banner*` вне ' +
          '`lib/update-banner.ts` запрещены, иначе рядом появится второй баннер.',
        pattern: UPDATE_BANNER_CLASS,
        allow: (rel, line) =>
          rel === BANNER_MODULE || isCommentLine(line) || isBannerImport(line),
      },
    ]);
  });

  it('поле banner вердикта читает только модуль баннера', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'banner-projection-single-reader',
        description:
          'Поле `banner` вердикта совместимости (89aad200) — проекция для ' +
          'баннера: читает его только `lib/update-banner.ts`; остальным нужны ' +
          '`status`/`blocking`.',
        pattern: /\.banner\b/,
        allow: (rel, line) => rel === BANNER_MODULE || isCommentLine(line),
      },
    ]);
  });

  it('баннер не использует тосты', () => {
    assertGuardClean(
      RENDERER_ROOT,
      [
        {
          name: 'no-toast-in-update-banner',
          description:
            'Баннер не использует `notice()`/тост: тот автозакрывается и не ' +
            'содержит действий (границы компонента 06d88619).',
          pattern: /\b(?:notice|toast)\s*\(/,
          include: (rel) => rel === BANNER_MODULE,
          allow: (_rel, line) => isCommentLine(line),
        },
      ],
      { extensions: ['.ts'] },
    );
  });

  it('страницу релиза клиента открывают только баннер и блокирующий диалог', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'release-page-single-point',
        description:
          'Поле `downloadUrl` в рендерере читают только `lib/update-banner.ts` ' +
          '(«Обновить клиент» в баннере) и `lib/compatibility-dialog.ts` ' +
          '(блокирующий диалог 8623b9ff): остальное обновление клиента — ТП ' +
          '2d9f5cc7 (ТП 52b33158 п. К6).',
        pattern: /\bdownloadUrl\b/,
        allow: (rel, line) =>
          rel === BANNER_MODULE ||
          rel === 'lib/compatibility-dialog.ts' ||
          isCommentLine(line),
      },
    ]);
  });
});
