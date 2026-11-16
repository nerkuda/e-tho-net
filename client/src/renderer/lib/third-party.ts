/**
 * Каталог сторонних компонентов клиента (задача 35b9cc05, ADR 03eb2c61).
 *
 * ЕДИНЫЙ источник данных о сторонних библиотеках, попадающих в дистрибутив:
 *  • раздел «Сторонние компоненты» диалога «О программе» показывает его
 *    напрямую (кратко: имя, лицензия, ссылка);
 *  • скрипт `client/scripts/generate-notices.ts` читает этот же каталог и
 *    строит по нему `THIRD-PARTY-NOTICES.txt` (перечень всех пакетов — прямых
 *    и транзитивных — с версиями и полными текстами ключевых лицензий).
 *
 * Запись описывает либо библиотеку из npm (`packages` перечисляет имена,
 * которые она покрывает), либо вендоренный ассет поставки (`asset: true` +
 * `licenseFile` — путь к тексту лицензии в `src/renderer/public/`). Сторож
 * `guard-third-party-notices.test.ts` и генератор падают, если у клиента
 * появилась прямая зависимость, не описанная здесь, или в
 * `public/licenses/` лежит файл, на который не ссылается ни одна запись, —
 * списки не протухают.
 *
 * Собственные пакеты (`@etn/*`) сторонними не считаются и сюда не входят.
 */

import type { UiTheme } from '../state.js';

/**
 * Фраза автора Blue Topaz — дословно, как просит лицензия темы (задача
 * 3cac16cc): звучит в шапке `lib/ui/themes/blue-topaz.css` и в
 * `THIRD-PARTY-NOTICES.txt`. Менять текст нельзя, только по требованию автора.
 */
export const BLUE_TOPAZ_ATTRIBUTION =
  'Partial style(s) is(are) sourced or adapted from Blue Topaz ' +
  '(https://github.com/PKM-er/Blue-Topaz_Obsidian-css), and I would like to express ' +
  'my appreciation to WhyI (https://github.com/whyt-byte) and pkmer.cn (https://pkmer.cn).';

/** Одна запись каталога — библиотека (семейство пакетов). */
export interface ThirdPartyComponent {
  /** Отображаемое имя библиотеки в диалоге «О программе». */
  title: string;
  /** Идентификатор лицензии (SPDX). */
  license: string;
  /** Правообладатель. */
  copyright: string;
  /** Домашняя страница или репозиторий. */
  url: string;
  /** npm-имена пакетов, которые покрывает эта запись (у ассета — пусто). */
  packages?: readonly string[];
  /**
   * Вендоренный ассет поставки (шрифты и т. п.) — не npm-пакет. У такой записи
   * `packages` пусто, а `licenseFile` указывает на текст лицензии.
   */
  asset?: boolean;
  /**
   * Путь к файлу лицензии относительно `src/renderer/public/` (например
   * `licenses/inter-OFL-1.1.txt`). Файл едет в поставку вместе с ассетом.
   */
  licenseFile?: string;
  /**
   * Тема оформления интерфейса, значения которой взяты из этого ассета
   * (задача 3cac16cc): идентификатор из `UI_THEME_NAMES`. Сторож требует
   * запись для каждой темы, кроме собственной `current`.
   */
  theme?: UiTheme;
  /**
   * Тема собрана по опубликованной палитре и не связана с её авторами
   * (решение задачи 3cac16cc по Catppuccin): в диалоге «О программе» подпись
   * дополняется пометкой «неофициальная тема».
   */
  unofficial?: boolean;
}

/** Сторонние библиотеки, попадающие в дистрибутив клиента. */
export const THIRD_PARTY_COMPONENTS: readonly ThirdPartyComponent[] = [
  {
    title: 'Web Awesome Core',
    license: 'MIT',
    copyright: 'Web Awesome',
    url: 'https://webawesome.com/',
    packages: ['@awesome.me/webawesome'],
  },
  {
    title: 'Vaadin Web Components',
    license: 'Apache-2.0',
    copyright: 'Vaadin Ltd.',
    url: 'https://vaadin.com/components',
    packages: ['@vaadin/grid'],
  },
  {
    title: 'CodeMirror 6',
    license: 'MIT',
    copyright: 'Marijn Haverbeke',
    url: 'https://codemirror.net/',
    packages: [
      '@codemirror/autocomplete',
      '@codemirror/commands',
      '@codemirror/lang-cpp',
      '@codemirror/lang-css',
      '@codemirror/lang-go',
      '@codemirror/lang-html',
      '@codemirror/lang-java',
      '@codemirror/lang-javascript',
      '@codemirror/lang-json',
      '@codemirror/lang-markdown',
      '@codemirror/lang-php',
      '@codemirror/lang-python',
      '@codemirror/lang-rust',
      '@codemirror/lang-sql',
      '@codemirror/lang-xml',
      '@codemirror/lang-yaml',
      '@codemirror/language',
      '@codemirror/language-data',
      '@codemirror/state',
      '@codemirror/view',
      '@lezer/highlight',
      '@lezer/markdown',
    ],
  },
  {
    title: 'Lucide',
    license: 'ISC',
    copyright: 'Lucide Contributors',
    url: 'https://lucide.dev/',
    packages: ['lucide'],
  },
  {
    title: 'Mermaid',
    license: 'MIT',
    copyright: 'Knut Sveidqvist',
    url: 'https://mermaid.js.org/',
    packages: ['mermaid'],
  },
  {
    title: 'D3',
    license: 'ISC',
    copyright: 'Mike Bostock',
    url: 'https://d3js.org/',
    packages: ['d3-drag', 'd3-force', 'd3-selection', 'd3-zoom'],
  },
  {
    title: 'ws',
    license: 'MIT',
    copyright: 'Einar Otto Stangvik',
    url: 'https://github.com/websockets/ws',
    packages: ['ws'],
  },
  {
    title: 'better-sqlite3',
    license: 'MIT',
    copyright: 'Joshua Wise',
    url: 'https://github.com/WiseLibs/better-sqlite3',
    packages: ['better-sqlite3'],
  },
  // Вендоренные шрифты (задача e622824e): не npm-пакеты, а файлы поставки.
  // Текст OFL 1.1 лежит в public/licenses и попадает в THIRD-PARTY-NOTICES.
  {
    title: 'Inter',
    license: 'OFL-1.1',
    copyright: 'The Inter Project Authors',
    url: 'https://github.com/rsms/inter',
    asset: true,
    licenseFile: 'licenses/inter-OFL-1.1.txt',
  },
  {
    title: 'JetBrains Mono',
    license: 'OFL-1.1',
    copyright: 'The JetBrains Mono Project Authors',
    url: 'https://github.com/JetBrains/JetBrainsMono',
    asset: true,
    licenseFile: 'licenses/jetbrains-mono-OFL-1.1.txt',
  },
  // Темы оформления (задача 3cac16cc): значения токенов ETN выведены из палитр
  // этих тем, поэтому лицензия и правообладатель едут в поставку вместе с
  // текстом MIT. У каждой темы из `UI_THEME_NAMES` (кроме собственной
  // `current`) запись обязательна — это держит `guard-third-party-notices`.
  {
    title: 'Blue Topaz',
    license: 'MIT',
    copyright: '© 2020 whyt-byte, PKM-er',
    url: 'https://github.com/PKM-er/Blue-Topaz_Obsidian-css',
    asset: true,
    licenseFile: 'licenses/themes/blue-topaz.txt',
    theme: 'blue-topaz',
  },
  {
    // «Неофициальная тема» (решение задачи 3cac16cc): ETN не связан с
    // Catppuccin Org, тема собрана по опубликованной палитре.
    title: 'Catppuccin',
    license: 'MIT',
    copyright: '© 2021 Catppuccin Org',
    url: 'https://github.com/catppuccin/catppuccin',
    asset: true,
    licenseFile: 'licenses/themes/catppuccin.txt',
    theme: 'catppuccin',
    unofficial: true,
  },
  {
    title: 'RetroNotes',
    license: 'MIT',
    copyright: '© 2024 sr-campelo',
    url: 'https://github.com/sr-campelo/retronotes',
    asset: true,
    licenseFile: 'licenses/themes/retronotes.txt',
    theme: 'retronotes',
  },
  {
    // Гарнитура Source Code Pro из референса НЕ переносится: в поставке её нет,
    // лицензия OFL 1.1 к теме ETN не применяется (задача 3cac16cc).
    title: 'Wasp',
    license: 'MIT',
    copyright: '© 2020-2026 Santi Younger',
    url: 'https://github.com/santiyounger/Wasp-Obsidian-Theme',
    asset: true,
    licenseFile: 'licenses/themes/wasp.txt',
    theme: 'wasp',
  },
  {
    // Тема «Nordic» пересобрана напрямую из палитры Nord (задача 135ae1b4):
    // сторонний CSS темы не используется, лицензия — палитры.
    title: 'Nordic',
    license: 'MIT',
    copyright: '© Sven Greb (Nord palette)',
    url: 'https://github.com/nordtheme/nord',
    asset: true,
    licenseFile: 'licenses/themes/nordic.txt',
    theme: 'nordic',
  },
];

/** Все npm-имена, покрытые каталогом (для проверок и генератора). */
export function coveredPackageNames(): string[] {
  return THIRD_PARTY_COMPONENTS.flatMap((c) => [...(c.packages ?? [])]);
}

/** Записи-ассеты каталога: вендоренные файлы поставки, а не npm-пакеты. */
export function assetComponents(): readonly ThirdPartyComponent[] {
  return THIRD_PARTY_COMPONENTS.filter((c) => c.asset === true);
}

/** Записи тем оформления: ассеты, у которых указан `theme`. */
export function themeComponents(): readonly ThirdPartyComponent[] {
  return THIRD_PARTY_COMPONENTS.filter((c) => c.theme !== undefined);
}
