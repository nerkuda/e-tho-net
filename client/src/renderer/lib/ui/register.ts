/**
 * Регистрация вендорских Web Components дизайн-системы (задача 95dd50b9).
 *
 * Импорт этого модуля — единственная точка подключения вендора в рендерере:
 *  1) базовые стили и тема Web Awesome Core (MIT, `@awesome.me/webawesome`);
 *  2) карта маппинга токенов ETN → `--wa-*` (`./tokens.css`);
 *  3) сами компоненты (custom elements) — набор этапа 1.
 *
 * Порядок важен: `tokens.css` идёт после стилей вендора и объявлен вне его
 * cascade-слоёв, поэтому переопределения `--wa-*` выигрывают (unlayered >
 * layered). См. шапку `./tokens.css`.
 *
 * Только Core-пакеты: Pro-компоненты Web Awesome и `@vaadin/bundles`
 * запрещены ADR «Основа lib/ui: готовые Web Components за фасадами»
 * (сторож `guard-ui-licenses.test.ts`). Отдельные пакеты `@vaadin/*`
 * подключаются задачами этапа 2 по потребности.
 *
 * Vaadin (Apache-2.0) подключается отдельными пакетами `@vaadin/*`, не через
 * `@vaadin/bundles` (её и Pro Web Awesome запрещает ADR). Ниже — базовый Grid
 * и его колонки (задача cf4f8f70); фасад таблицы поверх него появится
 * отдельной задачей этапа 2.
 */

// Базовые стили и тема по умолчанию: `webawesome.css` подтягивает
// `styles/themes/default.css` и цветовые палитры.
import '@awesome.me/webawesome/dist/styles/webawesome.css';

// Карта маппинга токенов ETN → `--wa-*` (светлая и тёмная темы).
import './tokens.css';

// Стили словаря кнопок (`.ui-btn*`) — роли, плотности и состояния
// (задача 56f1dcb2). Подключаются здесь, а не из `./button.ts`, чтобы
// модуль словаря оставался импортируемым тестами без CSS-загрузчика.
import './button.css';

// Единый вид полосы вкладок (`.ui-tab*`, задача a57e7998) — заменяет
// частные стили admin/icon/diff/type-editor/settings-md вкладок.
import './tabs.css';

// Добавки к виду строк ошибок (кликабельная строка панели кнопок,
// дублирование у поля; задача e20761c2).
import './messages.css';

// Поля ввода, строки-переключатели, сегменты, тумблеры и бейджи — словарь
// фасадов этапа полей (задача f351b894): базовые классы полей
// (`ui-input`/`ui-field`/`ui-clearable`), строк (`ui-choice-row`),
// сегментов, тумблеров и бейджей. Старые `text-input`/`checkbox-row`/
// `radio-row`/`font-toggle`/`role-badge`/`group-count`/`st-count` удалены
// из `styles.css`.
import './field.css';
import './choice-row.css';
import './segmented.css';
import './toggle.css';
import './badge.css';

// Всплывающая панель — единое оформление общего компонента поповера
// (`.ui-popover*`, задача dd1f47d4): база панели, хвостик, заголовок и тело.
// Вид перенесён сюда из `styles.css` (бывший `.hover-preview-popup`).
import './popover.css';

// Оболочка комментария — единый каркас просмотра/правки (`.ui-comment*`,
// задача 9cb87c42): рамка, панели действий и состояния. Раскладка растянутого
// комментария (`--fill`/`--scroll`) перенесена из `styles.css`.
import './comment.css';

// Сплиттер — гриф и его вид (`.ui-splitter*`, задача 50f57b82). Раскладку шва
// (размер, положение, курсор) задаёт владелец своим классом в `styles.css`;
// здесь только общее — глиф и его состояния. Вид перенесён из `.row-splitter`.
import './splitter.css';

// Единая таблица списков — обёртка, растяжение сетки и пустое состояние
// (`.ui-table*`, задача dad2b029).
import './table.css';


// Компоненты этапа 1: кнопки, поля, переключатели, вкладки, тосты,
// тултипы, деревья, аккордеоны, сплиттеры. Каждый модуль регистрирует
// свой custom element; повторный импорт безопасен (ESM-кеш).
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import '@awesome.me/webawesome/dist/components/radio/radio.js';
import '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
import '@awesome.me/webawesome/dist/components/tab/tab.js';
import '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';
import '@awesome.me/webawesome/dist/components/toast/toast.js';
import '@awesome.me/webawesome/dist/components/toast-item/toast-item.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/tree/tree.js';
import '@awesome.me/webawesome/dist/components/tree-item/tree-item.js';
import '@awesome.me/webawesome/dist/components/accordion/accordion.js';
import '@awesome.me/webawesome/dist/components/accordion-item/accordion-item.js';
import '@awesome.me/webawesome/dist/components/split-panel/split-panel.js';

// --- Vaadin (Apache-2.0) — отдельные пакеты `@vaadin/*` ---
// Базовый Grid и колонки (задача cf4f8f70). Пакет `@vaadin/bundles` не
// используется: только точечные компоненты. Компоненты Vaadin регистрируют
// свои custom elements сами; повторный импорт безопасен (ESM-кеш).
import '@vaadin/grid/vaadin-grid.js';
import '@vaadin/grid/vaadin-grid-column.js';
import '@vaadin/grid/vaadin-grid-sort-column.js';

// Карта маппинга токенов ETN → `--vaadin-*` (светлая и тёмная темы).
// В Vaadin 25 `--lumo-*` заменены токенами `--vaadin-*` — см. шапку файла.
import './vaadin-tokens.css';

// --- Телеметрия Vaadin (vaadin-usage-statistics) отключена ---
// Vaadin в режиме разработки собирает статистику использования компонентов.
// Документированный opt-out — флаг проекта "vaadin": {"disableUsageStatistics": true}
// в корневом package.json: postinstall `@vaadin/vaadin-usage-statistics`
// подменяет `vaadin-usage-statistics.js` пустым (`check.cjs`). Дополнительно
// глушим колбэк в рантайме сразу после импорта элементов (element-mixin
// заводит его синхронно при импорте и вызывает на idle через debounce —
// перезапись до срабатывания делает вызов пустым). См. карточку компонента
// 88111458.
{
  const host = window as unknown as {
    Vaadin?: { developmentModeCallback?: Record<string, () => void> };
  };
  if (host.Vaadin?.developmentModeCallback !== undefined) {
    host.Vaadin.developmentModeCallback['vaadin-usage-statistics'] = () => undefined;
  }
}

