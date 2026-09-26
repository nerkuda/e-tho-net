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
 * `packages` перечисляет npm-имена, которые запись покрывает: сторож
 * `guard-ui-facades.test.ts` и сам генератор падают, если у клиента появилась
 * прямая зависимость, не описанная здесь, — список не протухает.
 *
 * Собственные пакеты (`@etn/*`) сторонними не считаются и сюда не входят.
 */

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
  /** npm-имена пакетов, которые покрывает эта запись. */
  packages: readonly string[];
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
  {
    title: 'electron-updater',
    license: 'MIT',
    copyright: 'Vladimir Krivosheev',
    url: 'https://github.com/electron-userland/electron-builder',
    packages: ['electron-updater'],
  },
];

/** Все npm-имена, покрытые каталогом (для проверок и генератора). */
export function coveredPackageNames(): string[] {
  return THIRD_PARTY_COMPONENTS.flatMap((c) => [...c.packages]);
}
