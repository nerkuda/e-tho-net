/**
 * Фасад иконок дизайн-системы (задача 6d8db38b, ADR bd224643, требование
 * e52d249e, компонент lib/ui f3979068).
 *
 * Единственная точка доступа клиента к иконочной библиотеке **Lucide** (ISC):
 * рендер значка, каталог имён библиотеки и поиск по каталогу, применение
 * размера/цвета/толщины. Значки обвязки — tree-shake-абельные именованные
 * импорты `lucide` (см. `CHROME_ICONS`); полный каталог для вкладки выбора
 * иконки достаётся лениво (`loadIconCatalog`), в bundle, без CDN.
 *
 * Правила (ADR bd224643): прямой импорт `lucide` вне этого фасада запрещён;
 * собственные inline-SVG-значки обвязки вне фасада не заводят; эмодзи-иконки
 * пользовательского контента (мысли/типы) и картинки-иконки не сюда.
 *
 * Цвет значка — `currentColor` (наследует цвет хоста), толщина — атрибут.
 */

import type { IconNode, Icons } from 'lucide';
import {
  Activity,
  ArrowLeft,
  AtSign,
  BookOpen,
  Calendar,
  CalendarDays,
  CheckCheck,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  Copy,
  Download,
  Eraser,
  ExternalLink,
  Filter,
  Hash,
  Layers,
  Link,
  ListTree,
  Loader,
  Menu,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings,
  ToggleLeft,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  User,
  Waypoints,
  X,
} from 'lucide';

/** Класс значка обвязки: раскладка/цвет наследуются от хоста (`styles/layout.css`). */
export const ICON_CLASS = 'icon';

/** Имена значков обвязки клиента (kebab-case). */
export type IconName =
  | 'network'
  | 'settings'
  | 'user'
  | 'menu'
  | 'chevron-down'
  // Группы дат ленты «Дневника»: «Развернуть все» — двойной шеврон вниз,
  // «Свернуть все» — двойной шеврон вверх.
  | 'chevrons-down'
  | 'chevrons-up'
  | 'arrow-left'
  | 'search'
  | 'alert'
  | 'x'
  // Переключатель видов (lucide): карта мыслей, дерево структур, хроника.
  | 'mindmap'
  | 'tree'
  | 'calendar-month'
  | 'activity'
  | 'plus'
  | 'trash'
  // Возврат из корзины (ошибка 009784ad): lucide «undo-2».
  | 'undo'
  | 'layers'
  | 'loader'
  | 'filter'
  // Команды модального чек-листа пикера (ошибка bd8b78a0): «Очистить»,
  // «Пометить все», «Вернуть умолчания».
  | 'eraser'
  | 'check-check'
  | 'rotate-ccw'
  // Строка сохранённых отборов (задача 2ebe4206): дискета и копия.
  | 'save'
  | 'copy'
  // Виды значения свойства (задача 6ebde54e): строка, число, дата, да/нет, URL,
  // ссылка на мысль.
  | 'value-text'
  | 'value-number'
  | 'value-date'
  | 'value-bool'
  | 'value-url'
  | 'value-ref'
  // Кросс-сетевая ссылка (задача 7849008a) и ссылка на публикацию
  // (задача 3275fd8d).
  | 'value-cross-network-ref'
  | 'value-publication'
  // Шапка рабочей области публикации (задача b51dbca4): экспорт и
  // разворот/сворачивание панели оглавления.
  | 'download'
  | 'panel-left-open'
  | 'panel-left-close';

/**
 * Значки обвязки: kebab-имя проекта → узел Lucide (`IconNode`). Именованные
 * импорты tree-shake-аются — в bundle попадают только использованные значки.
 */
const CHROME_ICONS: Record<IconName, IconNode> = {
  network: Network,
  settings: Settings,
  user: User,
  menu: Menu,
  'chevron-down': ChevronDown,
  'chevrons-down': ChevronsDown,
  'chevrons-up': ChevronsUp,
  'arrow-left': ArrowLeft,
  search: Search,
  alert: TriangleAlert,
  x: X,
  mindmap: Waypoints,
  tree: ListTree,
  'calendar-month': CalendarDays,
  activity: Activity,
  plus: Plus,
  trash: Trash2,
  undo: Undo2,
  layers: Layers,
  loader: Loader,
  filter: Filter,
  eraser: Eraser,
  'check-check': CheckCheck,
  'rotate-ccw': RotateCcw,
  save: Save,
  copy: Copy,
  'value-text': Type,
  'value-number': Hash,
  'value-date': Calendar,
  'value-bool': ToggleLeft,
  'value-url': Link,
  'value-ref': AtSign,
  'value-cross-network-ref': ExternalLink,
  'value-publication': BookOpen,
  download: Download,
  'panel-left-open': PanelLeftOpen,
  'panel-left-close': PanelLeftClose,
};

/** Имена значков обвязки — каталог в порядке объявления. */
export const ICON_NAMES: readonly IconName[] = Object.keys(CHROME_ICONS) as IconName[];

/** Параметры рендера значка (значения по умолчанию — для значков обвязки). */
export interface IconOptions {
  /** Сторона значка в px (по умолчанию 16). */
  size?: number;
  /** Цвет штриха (по умолчанию `currentColor` — наследует цвет хоста). */
  color?: string;
  /** Толщина штриха (по умолчанию 2). */
  strokeWidth?: number;
  /** Дополнительные классы к `ICON_CLASS`. */
  className?: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Экранирование значения атрибута при сборке статической SVG-разметки. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Сериализует узел Lucide во внутреннюю SVG-разметку. Данные библиотеки
 * доверенные (статические), значения атрибутов всё равно экранируются.
 */
function serializeIconNode(node: IconNode): string {
  let markup = '';
  for (const [tag, attrs] of node) {
    let attrText = '';
    for (const [name, value] of Object.entries(attrs)) {
      attrText += ` ${name}="${escapeAttr(String(value))}"`;
    }
    markup += `<${tag}${attrText}/>`;
  }
  return markup;
}

/**
 * Собирает `<svg>` из узла Lucide с применением параметров оформления.
 * Разметка строится из доверенных данных библиотеки, пользовательский ввод
 * сюда не попадает.
 */
export function renderIconNode(node: IconNode, options: IconOptions = {}): SVGSVGElement {
  const size = options.size ?? 16;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add(ICON_CLASS);
  if (options.className !== undefined && options.className !== '') {
    svg.classList.add(options.className);
  }
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', options.color ?? 'currentColor');
  svg.setAttribute('stroke-width', String(options.strokeWidth ?? 2));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = serializeIconNode(node);
  return svg;
}

/** Рисует значок обвязки по имени с параметрами оформления. */
export function renderIcon(name: IconName, options: IconOptions = {}): SVGSVGElement {
  return renderIconNode(CHROME_ICONS[name], options);
}

/**
 * Совместимый API значков обвязки: `<svg>` со стороной `size` px и классом
 * `icon`. Цвет наследуется через `currentColor`.
 */
export function svgIcon(name: IconName, size = 16): SVGSVGElement {
  return renderIcon(name, { size });
}

/** Проверка, что строка — имя значка обвязки. */
export function isIconName(value: string): value is IconName {
  return Object.prototype.hasOwnProperty.call(CHROME_ICONS, value);
}

export interface IconCatalog {
  /** Отсортированные kebab-имена всех значков библиотеки. */
  readonly names: readonly string[];
  /** Узел значка по kebab-имени; `null` — имени нет в каталоге. */
  node(name: string): IconNode | null;
}

/** PascalCase-экспорт Lucide → kebab-имя каталога (`CalendarDays` → `calendar-days`). */
export function iconNameFromExport(exportName: string): string {
  return exportName
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])([0-9])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Строит каталог из набора экспортов Lucide: kebab-имена, дедупликация
 * алиасов (одна и та же геометрия под разными именами — один значок),
 * сортировка по имени.
 */
export function buildIconCatalog(icons: Icons): IconCatalog {
  const byNode = new Map<IconNode, string>();
  for (const [exportName, node] of Object.entries(icons)) {
    if (!byNode.has(node)) byNode.set(node, iconNameFromExport(exportName));
  }
  const names = [...byNode.values()].sort((a, b) => a.localeCompare(b));
  const byName = new Map<string, IconNode>();
  for (const [node, name] of byNode) {
    if (!byName.has(name)) byName.set(name, node);
  }
  return {
    names,
    node: (name: string): IconNode | null => byName.get(name) ?? null,
  };
}

let catalogPromise: Promise<IconCatalog> | null = null;

/**
 * Лениво загружает полный каталог значков библиотеки (для вкладки выбора
 * иконки). Результат кешируется; значки в поставке, сетевых запросов нет.
 */
export function loadIconCatalog(): Promise<IconCatalog> {
  catalogPromise ??= import('lucide').then((mod) => buildIconCatalog(mod.icons as Icons));
  return catalogPromise;
}

/**
 * Поиск по каталогу: регистронезависимо, все слова запроса должны входить в
 * имя значка. Пустой запрос — весь каталог.
 */
export function searchIconCatalog(names: readonly string[], query: string): string[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter((t) => t !== '');
  if (tokens.length === 0) return [...names];
  return names.filter((name) => {
    const lower = name.toLowerCase();
    return tokens.every((token) => lower.includes(token));
  });
}
