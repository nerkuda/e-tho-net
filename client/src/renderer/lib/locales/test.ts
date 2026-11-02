/**
 * Тестовая локаль GUI-стенда (задача e6374cd1).
 *
 * Живая смена языка проверяется на стенде (`client/scripts/ui-probe-stand.mjs`)
 * тем же путём, что у пользователя: «Все настройки» → язык → «Применить». До
 * появления каталогов en/zh (задачи 6c1b56f3/d08c422d) второго языка в
 * production-сборке нет, поэтому стенд собирается в режиме `test`
 * (`--mode test`) и получает эту маленькую локаль. Регистрация — в `app.ts`,
 * только при `import.meta.env.MODE === 'test'`; в обычную сборку файл не
 * попадает (ветка статически ложна и вырезается).
 *
 * Это ФИКСТУРА, а не пользовательский язык: тексты намеренно короткие и
 * узнаваемые («TestNet»), чтобы сценарий доказывал перерисовку по DOM-пробам,
 * а не по картинке. Имя языка в списке — код `zz` (`lang.zz` в словаре `ru`
 * не заводится).
 */

import { registerLocale, type MessageCatalog } from '../i18n.js';
import type { PluralCatalog } from '../plural.js';

/** Код тестовой локали. */
export const TEST_LOCALE_CODE = 'zz';

/** Несколько ключей рабочего стола и диалога настроек — маркеры перерисовки. */
export const testLocale: MessageCatalog = {
  'actions.apply': 'TestApply',
  'actions.applyClose': 'TestApplyClose',
  'actions.cancel': 'TestCancel',
  'settings.title': 'TestSettings',
  'settings.language': 'TestLanguage',
  'workspace.networkLabel': 'TestNet',
  'workspace.view.map': 'TestMap',
  'realtime.status.idle': 'TestIdle',
  // Подписи из мест, которые до ошибки ebed42d3 вычислялись на уровне модуля
  // (карты/константы при импорте): при живой смене языка они обязаны
  // перерисоваться вместе с экраном.
  'canvas.vliyayuschihThoughtsNoDvoynoyKlikAdd': 'TestParentsEmpty',
  'canvas.siblings.rodstvennyhThoughtsNo': 'TestSiblingsEmpty',
  'canvas.podchinennyhThoughtsNoDvoynoyKlikAdd': 'TestChildrenEmpty',
  'comment.title.kommentariy': 'TestComment',
  'editor.title.properties': 'TestProps',
  'editor.title.attachments': 'TestAttach',
  'editor.title.mentions': 'TestMentions',
  'editor.title.dnevnik': 'TestChrono',
  'editor.title.graph': 'TestGraph',
  'editor.title.metadata': 'TestMeta',
};

/** Формы плюрализации тестовой локали (en-подобные). */
export const testPlurals: PluralCatalog = {
  'plurals.child': { one: 'child', few: 'children', many: 'children', other: 'children' },
};

/** Регистрирует тестовую локаль (идемпотентно — `registerLocale` заменяет). */
export function registerTestLocale(): void {
  registerLocale(TEST_LOCALE_CODE, testLocale, testPlurals);
}
