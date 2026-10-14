/**
 * Дерево условий отбора — рендер-слой редактора (задача ТП 11b2509a «Редактор:
 * базовый компонент», требование-элемент fc65b647; требования 5ef1bce1
 * «тонированная вложенность и маркер НЕ», 502f1922 «сгруппированные списки
 * операторов»; ADR 30ff83bb «дерево — развитие одного конструктора», ADR
 * 4154811f «два библиотечных модуля: filter-tree и filter-value»).
 *
 * Слой рисует и ведёт ТОЛЬКО представление: группы-блоки (рамка с селектором
 * коннекции и НЕ-переключателем в заголовке), строки-условия
 * `[Что][Оператор][Значение]`, бледные связаторы «И»/«ИЛИ»-индикаторы,
 * тонированную вложенность, сворачивание групп и крестики удаления, кнопки
 * «+ условие» / «+ группа».
 *
 * **Данные и состояние — единая модель `lib/filter-builder.ts`**
 * (`FilterCriteriaState.tree`, типы `FilterTreeGroup`/`FilterTreeLeaf`).
 * Второй модели состояния, второго конвертера в wire и второго словаря
 * операторов здесь нет (ADR 23fab347/30ff83bb, сторож `guard-filter-builder`):
 * состав операторов спрашивается у реестра профилей `@etn/shared`
 * (`filterProfileOperators`), подписи кодов — из словаря конструктора
 * (`astOperatorLabel`), тона — из токенов темы (`styles/tokens.css`).
 *
 * **Значение листа** редактирует виджет ячейки значения следующей задачи
 * (`lib/filter-value.ts`); до него слот рисует заглушку с видом значения.
 * Точка расширения — `ctx.renderValue`.
 *
 * **Диагностика строк** (элемент интерфейса 4e634c9a) приходит готовым списком
 * (`ctx.issues` из `lib/filter-diagnostics.ts`): красная запись подсвечивает
 * строку и запрещает применение, жёлтая — только подсвечивает; у каждой строки
 * видна точная причина и кнопка «исправить», переводящая фокус в строку. Записи
 * без адреса строки дерево не показывает — их место в тултипе превью футера.
 *
 * **Вид** — из дизайн-системы (фасады `lib/ui` — файловыми импортами, как в
 * `lib/filter-form.ts`: barrel тянет регистрацию вендора и не грузится в
 * DOM-шиме юнит-тестов): кнопки `uiButton`/`iconButton`, сегменты
 * `segmentedControl`, тумблер `toggleButton`, поле `fieldInput`, всплывающая
 * панель `openPopover`. Свой CSS-модуль (`styles/filter-tree.css`) несёт только
 * роли, которых в дизайн-системе нет: рамка группы, связатор, тон вложенности,
 * строка диагностики. Класс строки диагностики — `FILTER_TREE_ISSUE_CLASS`
 * (`ft-issue`).
 *
 * **Профиль контекста — параметр** (`ctx.profile`): он задаёт состав операндов
 * списка «Что», набор операторов и подпись целевой сущности в заголовке. Сам
 * каркас от профиля не зависит.
 */

import {
  getFilterProfile,
  type FilterAstEntity,
  type FilterAstEntityKind,
  type FilterAstGroupOp,
  type FilterAstOperator,
  type FilterProfileId,
  type LinkType,
  type NetworkProperty,
  type PropertyValueType,
  type ThoughtType,
} from '@etn/shared';

import { clear, div, el, setTooltip, span } from './dom.js';
import {
  astOperatorLabel,
  defaultFilterTreeGroup,
  defaultFilterTreeLeaf,
  filterOperandLabel,
  filterProfileOperands,
  filterProfileOperators,
  OPERAND_KIND_LABELS,
  withReverseLinkPropertySides,
  type FilterCriteriaState,
  type FilterTreeGroup,
  type FilterTreeLeaf,
  type FilterTreeNode,
  type FilterTreeValue,
} from './filter-builder.js';
// Диагностика строк (элемент 4e634c9a): записи ядра и проверки конструктора
// сведены одним модулем — дерево только раскладывает их по адресам строк.
import {
  filterIssueForNode,
  filterIssueNodePath,
  filterIssueReason,
  type FilterIssue,
} from './filter-diagnostics.js';
import { VALUE_TYPE_LABELS, valueTypeIconName } from './property-list.js';
// Подтверждение сброса собранной под-выборки при смене свойства строки: правило
// живёт в модуле модального слоя (`lib/filter-subquery.ts`, элемент f5005daa).
import { confirmFilterSubqueryReset } from './filter-subquery.js';
// Фасады дизайн-системы — из файлов каталога, как в соседнем `lib/filter-form.ts`:
// barrel `lib/ui/index.ts` тянет за собой регистрацию вендора (webawesome/vaadin)
// и не грузится в юнит-тестах и на клиентском DOM-шиме. Правила `lib/ui`
// (без голого вендора, единый вид) соблюдены — используются только фасады.
import { uiButton, iconButton } from './ui/button.js';
import { fieldInput, wrapClearable } from './ui/field.js';
import { svgIcon, type IconName } from './ui/icon.js';
import { openPopover, type PopoverHandle } from './ui/popover.js';
import { toggleButton } from './ui/toggle.js';

// ---------------------------------------------------------------------------
// Тона вложенности (требование 5ef1bce1)
// ---------------------------------------------------------------------------

/**
 * Точек палитры в цикле тонированной вложенности. Четыре — минимум требования
 * «цикл не менее 4 тонов»: соседние уровни не совпадают по тону, пятый уровень
 * снова первый тон. Значения тонов — токены темы `--ft-tone-N`
 * (`styles/tokens.css`, обе темы), хардкода hex в модуле и его CSS нет.
 */
export const FILTER_TREE_TONE_COUNT = 4;

/** Классы тонов — порядок совпадает с циклом глубины. */
const TONE_CLASSES: readonly string[] = ['ft-tone-1', 'ft-tone-2', 'ft-tone-3', 'ft-tone-4'];

/** Индекс тона для глубины: цикл палитры (0 — корневая группа). */
export function filterTreeToneIndex(depth: number): number {
  const d = Number.isFinite(depth) ? Math.max(0, Math.trunc(depth)) : 0;
  return d % FILTER_TREE_TONE_COUNT;
}

/** Класс тона для глубины группы. */
export function filterTreeToneClass(depth: number): string {
  return TONE_CLASSES[filterTreeToneIndex(depth)]!;
}

// ---------------------------------------------------------------------------
// Адресация узлов модели путём (индексы детей от корня)
// ---------------------------------------------------------------------------

/**
 * Путь узла: индексы детей от корня (`[]` — сама корневая группа). Та же
 * адресация, что в `FilterTreeIssue.path` модели, — второй схемы нет.
 */
export type FilterTreePath = readonly number[];

/** Ключ пути для карт представления (свёрнутые группы и т. п.). */
export function filterTreePathKey(path: FilterTreePath): string {
  return path.join('.');
}

/** Узел по пути; `null` — путь не ведёт к узлу. */
export function filterTreeNodeAt(root: FilterTreeNode, path: FilterTreePath): FilterTreeNode | null {
  let node: FilterTreeNode = root;
  for (const index of path) {
    if (node.kind !== 'group') return null;
    const child: FilterTreeNode | undefined = node.children[index];
    if (child === undefined) return null;
    node = child;
  }
  return node;
}

/** Путь ведёт к группе? */
export function filterTreeGroupAt(root: FilterTreeNode, path: FilterTreePath): FilterTreeGroup | null {
  const node = filterTreeNodeAt(root, path);
  return node !== null && node.kind === 'group' ? node : null;
}

/**
 * Заменить узел по пути результатом `update` (мутация модели на месте, как у
 * плоских панелей: состояние живёт в `FilterCriteriaState`). `false` — путь не
 * ведёт к узлу. Корень заменяется по месту вызова (root возвращается отдельно).
 */
export function filterTreeUpdateAt(
  root: FilterTreeNode,
  path: FilterTreePath,
  update: (node: FilterTreeNode) => FilterTreeNode,
): FilterTreeNode | null {
  if (path.length === 0) return update(root);
  const parent = filterTreeNodeAt(root, path.slice(0, -1));
  if (parent === null || parent.kind !== 'group') return null;
  const index = path[path.length - 1]!;
  const child = parent.children[index];
  if (child === undefined) return null;
  parent.children[index] = update(child);
  return root;
}

/** Дописать ребёнка в группу по пути (в конец). `false` — путь не группа. */
export function filterTreeAppendChildAt(
  root: FilterTreeNode,
  path: FilterTreePath,
  child: FilterTreeNode,
): boolean {
  const group = filterTreeGroupAt(root, path);
  if (group === null) return false;
  group.children.push(child);
  return true;
}

/**
 * Удалить узел по пути. Корневая группа НЕ удаляется (элемент интерфейса
 * fc65b647: «корневая группа не удаляется») — для `[]` возвращается `false`.
 */
export function filterTreeRemoveAt(root: FilterTreeNode, path: FilterTreePath): boolean {
  if (path.length === 0) return false;
  const parent = filterTreeNodeAt(root, path.slice(0, -1));
  if (parent === null || parent.kind !== 'group') return false;
  const index = path[path.length - 1]!;
  if (parent.children[index] === undefined) return false;
  parent.children.splice(index, 1);
  return true;
}

// ---------------------------------------------------------------------------
// Группа глазами вида: коннектор, отрицание, тело
// ---------------------------------------------------------------------------

/**
 * Группа в представлении. Модель знает три вида группы (`and`/`or`/`not`), а
 * интерфейс — рамку с селектором коннекции И/ИЛИ и НЕ-переключателем, поэтому
 * «отрицающая» группа — это узел `not` вокруг группы-коннектора:
 *
 * ```
 * { kind: 'group', op: 'not', children: [ { kind: 'group', op: 'or', … } ] }
 * ```
 *
 * Вид показывает её ОДНОЙ рамкой: коннектор берётся у внутренней группы,
 * НЕ-переключатель — у обёртки. Так «НЕ» не теряет выбранный И/ИЛИ (и наоборот)
 * и не заводит поля модели, которого в AST нет.
 */
export interface FilterTreeGroupView {
  /** Путь ВИДИМОЙ группы в модели (по нему — удаление всей группы). */
  modelPath: FilterTreePath;
  /** Путь узла, чей `op` меняет селектор коннекции (И ↔ ИЛИ). */
  opPath: FilterTreePath;
  /** Путь группы, в `children` которой дописываются условия и вложенные группы. */
  bodyPath: FilterTreePath;
  /** Путь узла, к которому применяется НЕ-переключение. */
  notPath: FilterTreePath;
  /** Коннектор — `and` или `or` (у `not` коннектора нет). */
  op: 'and' | 'or';
  /** Включено ли отрицание (узел `not` в модели). */
  negated: boolean;
  children: readonly FilterTreeNode[];
}

function isConnectorOp(op: FilterAstGroupOp): op is 'and' | 'or' {
  return op === 'and' || op === 'or';
}

/** Разбор группы модели в представление (см. {@link FilterTreeGroupView}). */
export function filterTreeGroupView(
  root: FilterTreeNode,
  path: FilterTreePath,
): FilterTreeGroupView | null {
  const node = filterTreeGroupAt(root, path);
  if (node === null) return null;
  if (node.op === 'not') {
    const inner = node.children[0];
    const innerPath = [...path, 0];
    if (inner !== undefined && inner.kind === 'group' && isConnectorOp(inner.op)) {
      return {
        modelPath: path,
        opPath: innerPath,
        bodyPath: innerPath,
        notPath: path,
        op: inner.op,
        negated: true,
        children: inner.children,
      };
    }
    return {
      modelPath: path,
      opPath: path,
      bodyPath: path,
      notPath: path,
      op: 'and',
      negated: true,
      children: node.children,
    };
  }
  return {
    modelPath: path,
    opPath: path,
    bodyPath: path,
    notPath: path,
    op: node.op,
    negated: false,
    children: node.children,
  };
}

/**
 * НЕ-переключатель группы. Включение отрицания оборачивает группу в `not`
 * (коннектор сохраняется внутри), выключение — снимает обёртку. Результат —
 * всегда ГРУППА: у `not` с одиночным листом обёртка снимается в группу `И` с
 * этим листом (лист на месте группы в модели недопустим).
 */
export function filterTreeToggleNotAt(root: FilterTreeNode, path: FilterTreePath): FilterTreeGroup | null {
  const view = filterTreeGroupView(root, path);
  if (view === null) return null;
  const node = filterTreeNodeAt(root, path)!;
  if (node.kind !== 'group') return null;
  if (view.negated) {
    const inner = node.children[0];
    const unwrapped: FilterTreeGroup =
      inner !== undefined && inner.kind === 'group'
        ? inner
        : { kind: 'group', op: 'and', children: inner === undefined ? [] : [inner] };
    return filterTreeUpdateAt(root, path, () => unwrapped) as FilterTreeGroup | null;
  }
  return filterTreeUpdateAt(root, path, () => ({
    kind: 'group',
    op: 'not',
    children: [node],
  })) as FilterTreeGroup | null;
}

// ---------------------------------------------------------------------------
// Сгруппированные списки операторов (требование 502f1922)
// ---------------------------------------------------------------------------

/** Ячейка сетки операторов: код, подпись и колонка «утверждение/отрицание». */
export interface FilterTreeOperatorMenuCell {
  op: FilterAstOperator;
  label: string;
  side: 'yes' | 'no';
}

/** Одна строка сетки — до двух колонок (утверждение | отрицание). */
export interface FilterTreeOperatorMenuRow {
  cells: FilterTreeOperatorMenuCell[];
}

/** Секция списка — «способ задания множества» (требование 502f1922). */
export interface FilterTreeOperatorMenuSection {
  key: string;
  title: string;
  rows: FilterTreeOperatorMenuRow[];
}

/**
 * Секции списка операторов: «способ задания множества» × колонки
 * «утверждение/отрицание» (требование 502f1922). Пары подобраны так, что правая
 * колонка — ОТРИЦАНИЕ левой (`равно|не равно`, `больше|меньше или равно`…), а
 * «между»/«заполнено»/«в иерархии» стоят в своих секциях. Состав — подмножество
 * этого словаря, отобранное реестром профиля.
 */
const OPERATOR_MENU_SECTIONS: ReadonlyArray<{
  key: string;
  title: string;
  /** Заголовок для числовых и датовых операндов (там секция — «Сравнение»). */
  numericTitle?: string;
  rows: ReadonlyArray<{ yes: readonly FilterAstOperator[]; no: readonly FilterAstOperator[] }>;
}> = [
  {
    key: 'value',
    title: 'Значение',
    numericTitle: 'Сравнение',
    rows: [
      { yes: ['eq'], no: ['ne'] },
      { yes: ['contains'], no: ['not_contains'] },
      { yes: ['gt'], no: ['lte'] },
      { yes: ['gte'], no: ['lt'] },
      { yes: ['between'], no: ['not_between'] },
    ],
  },
  { key: 'multiple', title: 'Несколько', rows: [{ yes: ['in'], no: ['not_in'] }] },
  { key: 'hierarchy', title: 'Иерархия', rows: [{ yes: ['in_hierarchy'], no: ['not_in_hierarchy'] }] },
  {
    key: 'sets',
    title: 'Выборка',
    rows: [
      { yes: ['any_of'], no: ['none_of'] },
      { yes: ['all_of'], no: [] },
    ],
  },
  { key: 'state', title: 'Состояние', rows: [{ yes: ['not_empty'], no: ['is_empty'] }] },
  { key: 'words', title: 'Слова', rows: [{ yes: ['matches'], no: [] }] },
  { key: 'property', title: 'Свойство', rows: [{ yes: ['has'], no: ['not_has'] }] },
];

/** Подпись оператора в дереве (словарь спецификации из конструктора). */
export function filterTreeOperatorLabel(op: FilterAstOperator): string {
  return astOperatorLabel(op);
}

// ---------------------------------------------------------------------------
// Быстрые периоды подменю «между» (элемент интерфейса 69ac9ff8, требование
// 17dcd2fb: матрица [текущий/прошлый/следующий] × [день/неделя/месяц/год])
// ---------------------------------------------------------------------------

/** Ячейка матрицы быстрых периодов: подпись и канонические границы-токены. */
export interface FilterTreeQuickPeriod {
  /** Ключ ячейки меню (устойчив для тестов и данных кнопки). */
  key: string;
  /** Подпись ячейки («прошлый месяц»). */
  label: string;
  /** Раздел матрицы (строка «текущий/прошлый/следующий»). */
  row: 'current' | 'previous' | 'next';
  /** Токен нижней границы («С»). */
  from: string;
  /** Токен верхней границы («По»). */
  to: string;
}

/** Единицы матрицы быстрых периодов (столбцы). */
interface QuickPeriodUnit {
  key: string;
  /**
   * Подписи ячейки по строкам матрицы, в порядке [текущий, прошлый, следующий]:
   * род прилагательного у каждой гранулярности свой («текущая неделя», но
   * «текущий месяц»), поэтому подписи заданы явно, а не склейкой.
   */
  forms: readonly [string, string, string];
  /** Опора «С» и «По» без сдвига. */
  from: string;
  to: string;
  /** Сдвиг строки (текущий — '', прошлый — '-1<unit>', следующий — '+1<unit>'). */
  shiftUnit: string;
}

const QUICK_PERIOD_UNITS: readonly QuickPeriodUnit[] = [
  {
    key: 'day',
    forms: ['текущий день', 'прошлый день', 'следующий день'],
    from: '$today',
    to: '$today',
    shiftUnit: 'd',
  },
  {
    key: 'week',
    forms: ['текущая неделя', 'прошлая неделя', 'следующая неделя'],
    from: '$weekStart',
    to: '$weekEnd',
    shiftUnit: 'w',
  },
  {
    key: 'month',
    forms: ['текущий месяц', 'прошлый месяц', 'следующий месяц'],
    from: '$monthStart',
    to: '$monthEnd',
    shiftUnit: 'mo',
  },
  {
    key: 'year',
    forms: ['текущий год', 'прошлый год', 'следующий год'],
    from: '$yearStart',
    to: '$yearEnd',
    shiftUnit: 'y',
  },
];

/** Строки матрицы: текущий / прошлый / следующий период (индекс — выбор подписи). */
const QUICK_PERIOD_ROWS: readonly { key: FilterTreeQuickPeriod['row']; sign: string }[] = [
  { key: 'current', sign: '' },
  { key: 'previous', sign: '-' },
  { key: 'next', sign: '+' },
];

/** Токен опоры со сдвигом на `sign` 1 единицу (пустой знак — без сдвига). */
function shiftedToken(token: string, sign: string, unit: string): string {
  return sign === '' ? token : `${token}${sign}1${unit}`;
}

/**
 * Матрица быстрых периодов подменю «между» (элемент 69ac9ff8): три строки
 * [текущий/прошлый/следующий] × четыре столбца [день/неделя/месяц/год]. Выбор
 * ячейки создаёт обычное условие «между» с ВИДИМЫМИ границами-токенами —
 * период не держится скрытым состоянием условия (требование 69ac9ff8).
 */
export function filterTreeQuickPeriods(): readonly FilterTreeQuickPeriod[] {
  const out: FilterTreeQuickPeriod[] = [];
  for (const [rowIndex, row] of QUICK_PERIOD_ROWS.entries()) {
    for (const unit of QUICK_PERIOD_UNITS) {
      out.push({
        key: `period:${row.key}:${unit.key}`,
        label: unit.forms[rowIndex] ?? unit.forms[0],
        row: row.key,
        from: shiftedToken(unit.from, row.sign, unit.shiftUnit),
        to: shiftedToken(unit.to, row.sign, unit.shiftUnit),
      });
    }
  }
  return out;
}

/** Значение-границы выбранной ячейки быстрого периода (пара токенов). */
export function filterTreeQuickPeriodValue(period: FilterTreeQuickPeriod): FilterTreeValue {
  return { kind: 'list', items: [{ token: period.from }, { token: period.to }] };
}

/**
 * Датовая ли природа листа: датовые операторы (дата создания/изменения, время
 * записи/события) либо свойство вида «дата» — только у них «между» получает
 * подменю быстрых периодов.
 */
export function filterTreeIsDateLeaf(leaf: FilterTreeLeaf, valueType?: PropertyValueType): boolean {
  if (valueType === 'date') return true;
  const kind = leaf.entity.kind;
  return kind === 'created_at' || kind === 'updated_at' || kind === 'record_time' || kind === 'occurred_at';
}

/** Ключ пункта «Задать вручную…» подменю периодов (обычный выбор оператора). */
export const FILTER_TREE_PERIOD_MANUAL_KEY = 'between:manual';

/**
 * Подменю «между» для датового операнда (элемент 69ac9ff8): пункт «Задать
 * вручную…» плюс матрица «период × гранулярность» — 3 строки
 * [текущий/прошлый/следующий] × 4 столбца [день/неделя/месяц/год]. Матрица
 * задана раскладкой в четыре колонки (`columns`).
 */
export function filterTreePeriodMenu(): {
  title: string;
  groups: FilterTreeChoiceGroup[];
} {
  return {
    title: 'Период',
    groups: [
      {
        label: 'Период',
        items: [
          { key: FILTER_TREE_PERIOD_MANUAL_KEY, label: 'Задать вручную…' },
          ...filterTreeQuickPeriods().map((period) => ({ key: period.key, label: period.label })),
        ],
        columns: 4,
      },
    ],
  };
}

/** Ключ ячейки матрицы, которой соответствуют ТЕКУЩИЕ границы листа (или null). */
export function filterTreePeriodKeyOf(leaf: FilterTreeLeaf): string | null {
  if (leaf.value.kind !== 'list' || leaf.value.items.length !== 2) return null;
  const [from, to] = leaf.value.items;
  if (typeof from !== 'object' || typeof to !== 'object') return null;
  const period = filterTreeQuickPeriods().find((p) => p.from === from.token && p.to === to.token);
  return period?.key ?? null;
}

/**
 * Применить выбор подменю периодов к листу: оператор — «между», значение —
 * ВИДИМЫЕ границы-токены выбранной ячейки (период не хранится скрытым
 * состоянием — 69ac9ff8). «Задать вручную…» оставляет границы как есть
 * (пользователь правит их в ячейке значения). Неизвестный ключ не меняет лист.
 */
export function filterTreeApplyPeriod(leaf: FilterTreeLeaf, periodKey: string): FilterTreeQuickPeriod | null {
  if (periodKey === FILTER_TREE_PERIOD_MANUAL_KEY) {
    leaf.operator = 'between';
    return null;
  }
  const period = filterTreeQuickPeriods().find((p) => p.key === periodKey);
  if (period === undefined) return null;
  leaf.operator = 'between';
  leaf.value = filterTreeQuickPeriodValue(period);
  return period;
}

/**
 * Выбор в списке операторов (элемент 69ac9ff8): «между» у ДАТОВОГО операнда
 * раскрывает подменю периодов (в него передаётся {@link filterTreePeriodMenu}),
 * прочие выборы сразу ставят оператор листу. Возвращает `true`, если открыто
 * подменю, — вызывающему не нужно перерисовывать строку (это закрыло бы панель).
 * «Не между» остаётся обычным пунктом — подменю раскрывает только «между».
 */
export function filterTreeOperatorChoice(
  leaf: FilterTreeLeaf,
  key: string,
  valueType: PropertyValueType | undefined,
  openPeriod: (menu: ReturnType<typeof filterTreePeriodMenu>) => void,
): boolean {
  if (key === 'between' && filterTreeIsDateLeaf(leaf, valueType)) {
    openPeriod(filterTreePeriodMenu());
    return true;
  }
  leaf.operator = key as FilterAstOperator;
  return false;
}

/**
 * Список операторов операнда в профиле контекста, сгруппированный по способу
 * задания множества (требование 502f1922). Состав берётся у реестра профилей
 * `@etn/shared` — редактор не имеет своего мнения о допустимых операторах
 * (ADR 23fab347: «исполнитель принимает всё, что конструктор позволил»).
 *
 * `valueType` — природа свойства: у числовых/датовых операндов секция
 * называется «Сравнение» (требование 502f1922, «Масштабирование по типам»).
 */
export function filterTreeOperatorMenu(
  profile: FilterProfileId,
  kind: FilterAstEntityKind,
  valueType?: PropertyValueType,
): FilterTreeOperatorMenuSection[] {
  const allowed = new Set<FilterAstOperator>(filterProfileOperators(profile, kind, valueType));
  const out: FilterTreeOperatorMenuSection[] = [];
  for (const section of OPERATOR_MENU_SECTIONS) {
    const rows: FilterTreeOperatorMenuRow[] = [];
    for (const row of section.rows) {
      const cells: FilterTreeOperatorMenuCell[] = [];
      for (const op of row.yes) {
        if (allowed.has(op)) cells.push({ op, label: astOperatorLabel(op), side: 'yes' });
      }
      for (const op of row.no) {
        if (allowed.has(op)) cells.push({ op, label: astOperatorLabel(op), side: 'no' });
      }
      if (cells.length > 0) rows.push({ cells });
    }
    if (rows.length === 0) continue;
    const numeric = valueType === 'number' || valueType === 'date';
    out.push({
      key: section.key,
      title: numeric && section.numericTitle !== undefined ? section.numericTitle : section.title,
      rows,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Список «Что»: операнды сети (профиль — параметр)
// ---------------------------------------------------------------------------

/** Строка списка «Что»: готовый операнд модели и его место в списке. */
export interface FilterTreeOperandEntry {
  /** Ключ строки (id свойства, вид операнда, имя обратной стороны). */
  key: string;
  label: string;
  /** Раздел списка: контекстные — первыми, ниже реестр (требование fc65b647). */
  group: 'context' | 'operands' | 'properties';
  entity: FilterAstEntity;
  /** Вторая строка: тип значения свойства, сторона связи, вид операнда. */
  detail?: string;
  /** Природа свойства — для списка операторов строки. */
  valueType?: PropertyValueType;
  /** Значок строки: вид значения (свойства) либо смысловой (реквизиты/сущности). */
  icon?: IconName;
}

/** Раздел списка «Что» — человекочитаемая подпись (пусто — без заголовка). */
export const FILTER_TREE_OPERAND_GROUPS: Readonly<Record<FilterTreeOperandEntry['group'], string>> = {
  // Первая группа (контекстные операнды места) идёт БЕЗ заголовка — заголовок
  // «В этом месте» убран по требованию заказчика (2026-10-13).
  context: '',
  operands: 'Характеристики',
  properties: 'Свойства',
};

/**
 * Смысловые значки реквизитов и сущностей верхней группы (требование заказчика
 * 2026-10-13): у свойства — значок вида значения (как в списке «Свойства мыслей»),
 * у служебных операндов — смысловой (дата, строка, мысль, связь…).
 */
const OPERAND_ICONS: Readonly<Record<string, IconName>> = {
  // «Мысль» — значок «ссылка на мысль» (не `hash`: ID пользователь не видит,
  // задача a577875b).
  id: 'value-ref',
  type: 'layers',
  link_type: 'link-edit',
  parents: 'arrow-up',
  children: 'arrow-down',
  attachments: 'copy-text',
  chronology: 'quote',
  comment: 'html-comment',
  active: 'check-check',
  trashed: 'trash',
  keywords: 'search',
  author: 'user',
  editor: 'user',
  created_at: 'value-date',
  updated_at: 'value-date',
  properties: 'list-ordered',
  targets: 'focus',
  record_time: 'calendar-month',
  record_title: 'value-text',
  record_body: 'value-text',
  record_author: 'user',
  record_editor: 'user',
  occurred_at: 'calendar-month',
  action: 'activity',
  entity_type: 'layers',
  entity_id: 'hash',
  user: 'user',
  name: 'value-text',
  kind: 'filter',
  mime_type: 'value-text',
  owner: 'user',
  size: 'value-number',
};

/** Данные сети для списка «Что» и подписей строк. */
export interface FilterTreeData {
  /** Реестр свойств сети: id → строка реестра (как у каркаса формы отбора). */
  registry: ReadonlyMap<string, NetworkProperty>;
  /** Типы связей сети — нужны для обратных сторон свойств-связей. */
  linkTypes?: readonly LinkType[];
  /** Типы мыслей сети (профили мыслей) — для подписи операнда «Тип». */
  thoughtTypes?: readonly ThoughtType[];
  /**
   * Контекстные операнды места применения — идут первыми строками списка:
   * ключи строк (`property:<id>`, `type`, `keywords`…). Пусто — только реестр.
   */
  contextual?: readonly string[];
}

/** Собрать список «Что» для профиля: характеристики + реестр свойств сети. */
export function filterTreeOperandCatalogue(
  profile: FilterProfileId,
  data: FilterTreeData,
): FilterTreeOperandEntry[] {
  const operands = filterProfileOperands(profile);
  const contextual = new Set(data.contextual ?? []);
  const out: FilterTreeOperandEntry[] = [];

  // 1. Характеристики целевой сущности (кроме «Свойство» — его строки даёт реестр).
  for (const kind of operands) {
    if (kind === 'property') continue;
    const label = OPERAND_KIND_LABELS[kind];
    if (label === undefined) continue;
    const entity = defaultEntityForKind(kind);
    out.push({
      key: kind,
      label,
      // «Мысль» (id) — всегда в ВЕРХНЕЙ группе без заголовка: это базовая
      // характеристика места, а не рядовая «Характеристика» (решение заказчика
      // 2026-10-14, задача a577875b); прочие операнды — контекстные по месту.
      group: kind === 'id' || contextual.has(kind) ? 'context' : 'operands',
      entity,
      ...(OPERAND_ICONS[kind] !== undefined ? { icon: OPERAND_ICONS[kind] } : {}),
    });
  }

  // 2. Свойства сети: скаляры и обе стороны свойств-связей (требование fc65b647:
  // «структурные и обратные стороны — в общем списке»). Обратные стороны даёт
  // единый помощник конструктора — второго словаря сторон нет.
  if (operands.includes('property')) {
    const registry = withReverseLinkPropertySides(data.registry, data.linkTypes ?? []);
    for (const [id, entry] of registry) {
      // Прямая запись реестра адресуется `property_id`; обратная сторона живёт
      // под своим ИМЕНЕМ (её в исходном реестре нет) — адрес `property` + сторона.
      const direct = data.registry.has(id);
      const entity: FilterAstEntity = direct
        ? { kind: 'property', property_id: id }
        : { kind: 'property', property: id, direction: 'in' };
      const detail = direct
        ? VALUE_TYPE_LABELS[entry.value_type]
        : `${VALUE_TYPE_LABELS[entry.value_type]} · обратная сторона`;
      out.push({
        key: `property:${id}`,
        label: entry.name,
        group: contextual.has(`property:${id}`) ? 'context' : 'properties',
        entity,
        valueType: entry.value_type,
        detail,
        ...(valueTypeIconName(entry.value_type) !== null
          ? { icon: valueTypeIconName(entry.value_type)! }
          : {}),
      });
    }
  }

  return out;
}

/** Операнд-вид без адреса свойства: тип/связь/структурные/служебные виды. */
function defaultEntityForKind(kind: FilterAstEntityKind): FilterAstEntity {
  switch (kind) {
    case 'keywords': {
      const scope: ('title' | 'synonyms' | 'comment')[] = ['title', 'synonyms', 'comment'];
      return { kind, scope } as FilterAstEntity;
    }
    default:
      return { kind } as FilterAstEntity;
  }
}

/** Поиск в списке «Что»: подстрока по подписи/подробности, без регистра. */
export function filterTreeFilterOperands(
  entries: readonly FilterTreeOperandEntry[],
  query: string,
): FilterTreeOperandEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...entries];
  return entries.filter(
    (entry) =>
      entry.label.toLowerCase().includes(needle) ||
      (entry.detail ?? '').toLowerCase().includes(needle),
  );
}

/** Подпись операнда листа (что показывать в ячейке «Что»). */
export function filterTreeOperandLabel(leaf: FilterTreeLeaf, data: FilterTreeData): string {
  // Словарь подписей — в едином конструкторе (`filter-builder.filterOperandLabel`):
  // его же использует композер фразы-превью (`lib/filter-phrase.ts`).
  return filterOperandLabel(leaf, data);
}

/** Природа свойства листа (для списка операторов строки). */
export function filterTreeLeafValueType(leaf: FilterTreeLeaf, data: FilterTreeData): PropertyValueType | undefined {
  if (leaf.entity.kind !== 'property') return undefined;
  const ref = leaf.entity.property_id ?? leaf.entity.property ?? '';
  const direct = data.registry.get(ref);
  if (direct !== undefined) return direct.value_type;
  // Обратная сторона свойства-связи адресована ИМЕНЕМ — ищем её в том же
  // расширенном реестре, что и список «Что» (второго словаря сторон нет).
  return withReverseLinkPropertySides(data.registry, data.linkTypes ?? []).get(ref)?.value_type;
}

// ---------------------------------------------------------------------------
// Подписи служебных элементов
// ---------------------------------------------------------------------------

/** Подпись коннектора группы: «все условия (И)» / «любое из условий (ИЛИ)». */
export function filterTreeConnectorLabel(op: 'and' | 'or'): string {
  return op === 'and' ? 'все условия (И)' : 'любое из условий (ИЛИ)';
}

/** Подпись связатора-индикатора перед строкой (менять коннекцию нельзя — это индикатор). */
export function filterTreeConnectorIndicator(op: 'and' | 'or'): string {
  return op === 'and' ? 'И' : 'ИЛИ';
}

/**
 * Пункты списка коннекции группы (требование заказчика 2026-10-13): заголовок
 * группы — ВЫПАДАЮЩИЙ СПИСОК «все условия (И)» / «любое из условий (ИЛИ)», а не
 * сегмент-переключатель. Ключ пункта — код коннектора модели (`and`/`or`).
 */
export const FILTER_TREE_CONNECTOR_CHOICES: ReadonlyArray<{ key: 'and' | 'or'; label: string }> = [
  { key: 'and', label: filterTreeConnectorLabel('and') },
  { key: 'or', label: filterTreeConnectorLabel('or') },
];

/** Тип целевой сущности профиля — для заголовка «Показать <сущность> по условиям:». */
const PROFILE_TARGET_LABELS: Readonly<Record<string, string>> = {
  thought: 'мысли',
  chronicle_record: 'записи дневника',
  activity: 'события',
  attachment: 'вложения',
  link: 'связи',
  publication: 'публикации',
};

/** Заголовок редактора: «Показать <сущность> по условиям:» (элемент fc65b647). */
export function filterTreeTitle(profile: FilterProfileId): string {
  const target = getFilterProfile(profile).target;
  return `Показать ${PROFILE_TARGET_LABELS[target] ?? target} по условиям:`;
}

// ---------------------------------------------------------------------------
// Вид значения-заглушки (слот следующей задачи — lib/filter-value.ts)
// ---------------------------------------------------------------------------

/** Вид значения листа — подпись заглушки слота. */
export function filterTreeValueKindLabel(value: FilterTreeValue): string {
  switch (value.kind) {
    case 'none':
      return 'значение не требуется';
    case 'scalar':
      return String(value.value);
    case 'token':
      return value.token;
    case 'list':
      return value.items
        .map((item) => (typeof item === 'object' ? item.token : String(item)))
        .join(', ');
    case 'subquery':
      return `под-выборка (${value.operator})`;
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Сборка дерева
// ---------------------------------------------------------------------------

/** API слота значения: виджет значения переписывает значение листа (модель). */
export interface FilterTreeValueSlotApi {
  /** Переписать значение листа моделью (единственный путь правки значения). */
  setValue: (value: FilterTreeValue) => void;
}

/** Контекст сборки дерева: профиль — параметр, данные и модель — снаружи. */
export interface FilterTreeContext {
  /** Профиль контекста точки применения (состав операндов/операторов, подпись). */
  profile: FilterProfileId;
  /** Живая модель отбора — дерево лежит в `state.tree` (второй модели нет). */
  getState: () => FilterCriteriaState;
  /** Данные сети для списка «Что». */
  data: FilterTreeData;
  /** Сообщить хосту об изменении (персист состояния, маркер «изменён»). */
  touch?: () => void;
  /** Заголовок редактора; по умолчанию — «Показать <сущность> по условиям:». */
  title?: string;
  /** Слот значения (виджет следующей задачи); по умолчанию — заглушка. */
  renderValue?: (leaf: FilterTreeLeaf, api: FilterTreeValueSlotApi) => HTMLElement;
  /**
   * Диагностика строк (элемент интерфейса 4e634c9a): записи приходят из
   * `lib/filter-diagnostics.ts` — красные (сущность удалена, применение
   * запрещено) и жёлтые (свойство отвязано, отбор исполняется) плюс проверки
   * конструктора. Адрес записи — `filter.children[0]…` ({@link filterIssueNodePath});
   * записи без адреса дерево не показывает (их место — тултип превью футера).
   * Список перечитывается при каждой отрисовке: получив диагностику, хост зовёт
   * `rerender()`.
   */
  issues?: () => readonly FilterIssue[];
  /** Хост узнаёт, что пользователь нажал «исправить» у узла с этим адресом. */
  onFixPath?: (path: string) => void;
  /**
   * Подтверждение сброса СОБРАННОЙ под-выборки при смене свойства строки
   * (элемент интерфейса f5005daa): получает действие «сменить операнд и
   * сбросить значение» и решает, выполнять ли его. Не задан — спрашивает
   * `confirmFilterSubqueryReset` (`lib/filter-subquery.ts`).
   */
  confirmSubqueryReset?: (apply: () => void) => void;
}

/** Дескриптор построенного дерева. */
export interface FilterTreeHandle {
  root: HTMLElement;
  /** Перерисовать дерево из модели (после правок хоста). */
  rerender: () => void;
  /**
   * Перевести фокус в строку с диагностикой по её адресу (тот же переход, что у
   * кнопки «исправить» в строке) — общая точка для сообщения о запрете в футере
   * (требования 0fd1dc5d, 44d61c8a). Адрес не отрисован (нет записи/строка
   * внутри свёрнутой группы) — ничего не делается.
   */
  focusIssue: (path: string) => void;
}

/** Классы вида — единственная точка их имён (адресуются тестами и CSS). */
export const FILTER_TREE_CLASS = 'ft';
export const FILTER_TREE_GROUP_CLASS = 'ft-group';
export const FILTER_TREE_ROW_CLASS = 'ft-row';
export const FILTER_TREE_CONNECTOR_CLASS = 'ft-connector';
/** Строка диагностики узла: причина + кнопка «исправить» (элемент 4e634c9a). */
export const FILTER_TREE_ISSUE_CLASS = 'ft-issue';

/**
 * Операнды, у которых ячейка ОПЕРАТОРА в редакторе скрыта (требование заказчика
 * 2026-10-13): «Найти слова» и наличие коллекций/свойств — вид значения сам
 * задаёт семантику, а оператор AST перезаписывается из ячейки значения.
 */
export const FILTER_TREE_OPERATOR_HIDDEN_KINDS: ReadonlySet<string> = new Set([
  'keywords',
  'attachments',
  'chronology',
  'comment',
  'properties',
]);

/**
 * Собрать дерево условий над единой моделью. Возвращает корневой узел и
 * `rerender` — повторную отрисовку из модели (дерево перерисовывается целиком:
 * редактору нужна целостная картина ветки, а не инкрементальная лента).
 */
export function buildFilterTree(ctx: FilterTreeContext): FilterTreeHandle {
  const root = div(FILTER_TREE_CLASS);
  /** Свёрнутые группы — ключи путей (представление, не модель). */
  const collapsed = new Set<string>();

  const ensureTree = (): FilterTreeGroup => {
    const state = ctx.getState();
    if (state.tree === undefined || state.tree === null || state.tree.kind !== 'group') {
      state.tree = defaultFilterTreeGroup('and');
    }
    return state.tree;
  };

  const touch = (): void => {
    ctx.touch?.();
    render();
  };

  const model = (): FilterTreeGroup => ensureTree();

  /** Записи диагностики — перечитываются на каждой отрисовке дерева. */
  let issueMap: FilterIssue[] = [];
  /**
   * Адрес записи → переход к её строке. Собирается при отрисовке вместе со
   * строками диагностики; кнопка «исправить» в футере зовёт тот же переход
   * (`focusIssue`), поэтому логика перехода живёт в ОДНОМ месте — каркасе
   * дерева, а не в экране (требования 0fd1dc5d, 44d61c8a).
   */
  const fixers = new Map<string, () => void>();

  /**
   * Строка диагностики узла (элемент 4e634c9a): точная причина (снапшот имени и
   * дата — из записи ядра) и кнопка «исправить», переводящая фокус в строку.
   */
  const buildIssueLine = (issue: FilterIssue, focus: () => void): HTMLElement => {
    // Тот же переход доступен футеру по адресу записи (сообщение о запрете).
    fixers.set(issue.path, focus);
    const line = div(FILTER_TREE_ISSUE_CLASS);
    line.dataset['severity'] = issue.severity;
    line.dataset['code'] = issue.code;
    line.dataset['path'] = issue.path;
    line.append(span(filterIssueReason(issue), 'ft-issue__text'));
    line.append(
      uiButton({
        label: 'исправить',
        role: 'ghost',
        size: 's',
        class: 'ft-issue__fix',
        title: 'Перевести фокус в строку с ошибкой',
        onClick: () => {
          focus();
          ctx.onFixPath?.(issue.path);
        },
      }),
    );
    return line;
  };

  /** Пометить узел по диагностике (класс + `data-severity`); `null` — чисто. */
  const applyIssue = (node: HTMLElement, path: FilterTreePath): FilterIssue | null => {
    const issue = filterIssueForNode(issueMap, filterIssueNodePath(path));
    if (issue === null) return null;
    node.classList.add(`ft-node--${issue.severity}`);
    node.dataset['severity'] = issue.severity;
    return issue;
  };

  /**
   * Сохранить/восстановить фокус в поле ввода чип-значения при перерисовке:
   * хост пересобирает редактор после записи чипа, и без этого фокус теряется
   * (замечание п.6г — второй чип не набрать сразу).
   */
  const chipsInputPathBeforeRender = (): string | null => {
    const active = (globalThis as { document?: { activeElement?: unknown } }).document?.activeElement as
      | (Element & { classList?: { contains(c: string): boolean } })
      | null
      | undefined;
    if (active == null || !root.contains(active as Node)) return null;
    if (active.classList?.contains('value-chips-input') !== true) return null;
    const row = active.closest?.('.ft-row') as HTMLElement | null;
    return row?.dataset['path'] ?? null;
  };

  const restoreChipsInputFocus = (path: string | null): void => {
    if (path === null) return;
    const rows = Array.from(root.querySelectorAll(`.${FILTER_TREE_ROW_CLASS}`)) as HTMLElement[];
    const target = rows.find((node) => node.dataset['path'] === path);
    const input = target?.querySelector('.value-chips-input') as HTMLElement | null;
    input?.focus();
  };

  const render = (): void => {
    const focusPath = chipsInputPathBeforeRender();
    clear(root);
    fixers.clear();
    issueMap = [...(ctx.issues?.() ?? [])];
    const title = ctx.title ?? filterTreeTitle(ctx.profile);
    root.append(el('div', 'ft-title', title));
    root.append(renderGroup([], 0));
    restoreChipsInputFocus(focusPath);
  };

  /** Группа-блок с заголовком-рамкой и телом (адресация — путём в модели). */
  const renderGroup = (path: FilterTreePath, depth: number): HTMLElement => {
    const treeRoot = model();
    const atPath = filterTreeNodeAt(treeRoot, path);
    const view = filterTreeGroupView(treeRoot, path);
    const group = view ?? {
      modelPath: path,
      opPath: path,
      bodyPath: path,
      notPath: path,
      op: 'and' as const,
      negated: false,
      children: atPath !== null && atPath.kind === 'group' ? atPath.children : [],
    };
    const isRoot = path.length === 0;
    const key = filterTreePathKey(group.modelPath);
    const isCollapsed = collapsed.has(key);

    const section = el('section', `${FILTER_TREE_GROUP_CLASS} ${filterTreeToneClass(depth)}`);
    section.dataset['path'] = key;
    section.dataset['op'] = group.op;
    if (group.negated) section.dataset['negated'] = '1';
    if (isCollapsed) section.dataset['collapsed'] = '1';

    // --- Заголовок-рамка: свёртка, коннектор, НЕ, удаление ----------------
    const head = div('ft-group__head');
    // Корневая группа НЕ сворачивается (требование заказчика 2026-10-13):
    // стрелка-каретка есть только у вложенных групп.
    if (!isRoot) {
      const caret = uiButton({
        label: isCollapsed ? '▸' : '▾',
        role: 'ghost',
        size: 's',
        title: isCollapsed ? 'Развернуть группу' : 'Свернуть группу',
        class: 'ft-group__caret',
        onClick: () => {
          if (isCollapsed) collapsed.delete(key);
          else collapsed.add(key);
          render();
        },
      });
      caret.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      head.append(caret);
    }

    // Коннектор группы — ВЫПАДАЮЩИЙ СПИСОК «все условия (И)» / «любое из
    // условий (ИЛИ)» (требование заказчика 2026-10-13), а не сегмент-тогглер.
    const connector = uiButton({
      prefix: span(filterTreeConnectorLabel(group.op), 'ft-group__connector-label'),
      role: 'ghost',
      size: 's',
      title: 'Коннекция группы',
      class: 'ft-group__connector',
    });
    connector.append(span('▾', 'ft-picker__caret'));
    connector.addEventListener('click', () => {
      openChoiceMenu(connector, {
        title: 'Коннекция группы',
        groups: [{ label: '', items: FILTER_TREE_CONNECTOR_CHOICES.map((c) => ({ ...c })) }],
        activeKey: group.op,
        onPick: (id) => {
          if (id !== 'and' && id !== 'or') return;
          // Коннекцию меняет СЕЛЕКТОР ГРУППЫ; связаторы перед строками — только
          // индикаторы. У корневой группы путь пуст — замена идёт в само поле
          // дерева модели (иначе клик по коннектору корня был бы no-op).
          const next = filterTreeUpdateAt(model(), group.opPath, (current) =>
            current.kind === 'group' ? { ...current, op: id } : current,
          );
          if (next !== null && next.kind === 'group' && group.opPath.length === 0) {
            ctx.getState().tree = next;
          }
          touch();
        },
      });
    });
    head.append(connector);

    if (!isRoot) {
      const not = toggleButton({
        label: 'НЕ',
        title: group.negated ? 'Снять отрицание группы' : 'Отрицать группу',
        pressed: group.negated,
        extraClass: 'ft-group__not',
        onChange: () => {
          const next = filterTreeToggleNotAt(model(), group.notPath);
          if (next !== null && group.notPath.length === 0) ctx.getState().tree = next;
          touch();
        },
      });
      head.append(not.root);
    } else if (group.negated) {
      // «НЕ» на корне не предлагается (элемент fc65b647): показываем маркер,
      // но переключение заблокировано.
      const marker = toggleButton({
        label: 'НЕ',
        title: 'Отрицание корневой группы не предлагается',
        pressed: true,
        extraClass: 'ft-group__not',
        disabled: true,
        onChange: () => undefined,
      });
      head.append(marker.root);
    }

    if (!isRoot) {
      head.append(
        iconButton({
          icon: svgIcon('x'),
          title: 'Удалить группу',
          role: 'ghost',
          size: 's',
          class: 'ft-group__remove',
          onClick: () => {
            if (filterTreeRemoveAt(model(), group.modelPath)) {
              collapsed.delete(key);
              touch();
            }
          },
        }),
      );
    }

    section.append(head);
    // Диагностика группы (пустая группа) видна и в свёрнутом виде — строка идёт
    // сразу под заголовком-рамкой.
    const groupIssue = applyIssue(section, path);
    if (groupIssue !== null) {
      section.tabIndex = -1;
      section.append(
        buildIssueLine(groupIssue, () => {
          section.scrollIntoView();
          section.focus();
        }),
      );
    }
    if (isCollapsed) return section;

    // --- Тело: связаторы-индикаторы слева ПЕРЕД каждым условием, дети, кнопки --
    const body = div('ft-group__body');
    if (group.children.length === 0) {
      body.append(el('div', 'ft-group__empty', 'группа пуста — добавьте условие или группу'));
    } else {
      group.children.forEach((child, index) => {
        const childPath = [...group.bodyPath, index];
        // Индикатор И/ИЛИ — левый столбец ПЕРЕД строкой (требование заказчика
        // 2026-10-13), а не между строками: связатор меняет селектор группы.
        const item = div('ft-item');
        const indicator = span(filterTreeConnectorIndicator(group.op), FILTER_TREE_CONNECTOR_CLASS);
        indicator.setAttribute('aria-hidden', 'true');
        setTooltip(indicator, 'Коннекция задаётся селектором группы');
        item.append(indicator);
        item.append(
          child.kind === 'group' ? renderGroup(childPath, depth + 1) : renderRow(child, childPath),
        );
        body.append(item);
      });
    }
    const actions = div('ft-group__actions');
    actions.append(
      uiButton({
        label: '+ условие',
        role: 'ghost',
        size: 's',
        class: 'ft-add-condition',
        onClick: () => {
          const first = filterTreeOperandCatalogue(ctx.profile, ctx.data)[0];
          if (first === undefined) return;
          filterTreeAppendChildAt(model(), group.bodyPath, defaultFilterTreeLeaf(first.entity));
          touch();
        },
      }),
      uiButton({
        label: '+ группу',
        role: 'ghost',
        size: 's',
        class: 'ft-add-group',
        onClick: () => {
          // Группу добавляют ради условия: сразу кладём внутрь слот пустого
          // условия (требование заказчика 2026-10-13).
          const first = filterTreeOperandCatalogue(ctx.profile, ctx.data)[0];
          const children =
            first === undefined ? [] : [defaultFilterTreeLeaf(first.entity)];
          filterTreeAppendChildAt(model(), group.bodyPath, {
            kind: 'group',
            op: 'and',
            children,
          });
          touch();
        },
      }),
    );
    body.append(actions);
    section.append(body);
    return section;
  };

  /** Строка-условие: [Что][Оператор][Значение][×] (+ строка диагностики снизу). */
  const renderRow = (leaf: FilterTreeLeaf, path: FilterTreePath): HTMLElement => {
    const row = div(FILTER_TREE_ROW_CLASS);
    row.dataset['path'] = filterTreePathKey(path);
    const rowIssue = applyIssue(row, path);

    const valueType = filterTreeLeafValueType(leaf, ctx.data);
    const entries = filterTreeOperandCatalogue(ctx.profile, ctx.data);
    const activeEntryKey = entryKeyOf(leaf);
    const activeEntry = entries.find((entry) => entry.key === activeEntryKey);
    row.append(
      buildPickerButton({
        cls: 'ft-row__what',
        value: filterTreeOperandLabel(leaf, ctx.data),
        title: 'Что отбираем',
        ...(activeEntry?.icon !== undefined ? { icon: activeEntry.icon } : {}),
        onOpen: (anchor) => {
          openChoiceMenu(anchor, {
            title: 'Что',
            search: true,
            placeholder: 'Поиск свойства…',
            groups: groupEntries(entries),
            activeKey: activeEntryKey,
            onPick: (key) => {
              const entry = entries.find((item) => item.key === key);
              if (entry === undefined) return;
              const apply = (): void => {
                leaf.entity = entry.entity;
                // Смена операнда сбрасывает значение: прежнее к новому операнду
                // не относится (то же правило, что у плоской панели).
                leaf.value = { kind: 'none' };
                const ops = filterProfileOperators(ctx.profile, entry.entity.kind, entry.valueType);
                if (ops.length > 0 && !ops.includes(leaf.operator)) leaf.operator = ops[0]!;
                touch();
              };
              // Собранную под-выборку молча терять нельзя: сброс подтверждаем
              // (элемент f5005daa, ADR 4396ca00). Хост может подменить
              // подтверждение (`ctx.confirmSubqueryReset`) — тесты и экраны.
              if (leaf.value.kind === 'subquery') {
                (ctx.confirmSubqueryReset ?? ((run) => confirmFilterSubqueryReset(run)))(apply);
                return;
              }
              apply();
            },
          });
        },
      }),
    );

    // Оператор в редакторе НЕ показывается у операндов со «связанным» видом
    // значения (требование заказчика 2026-10-13): «Найти слова» (в AST остаётся
    // `matches`) и наличие коллекций/свойств («Есть вложения», «Есть дневниковые
    // записи», «Есть комментарий», «Есть свойства») — вид «(да)(нет)» либо чип-поле
    // сами перезаписывают оператор AST (`not_empty`/`is_empty`/`has`).
    if (!FILTER_TREE_OPERATOR_HIDDEN_KINDS.has(leaf.entity.kind)) {
      row.append(
        buildPickerButton({
          cls: 'ft-row__op',
          value: filterTreeOperatorLabel(leaf.operator),
          title: 'Оператор условия',
          onOpen: (anchor) => {
            const sections = filterTreeOperatorMenu(ctx.profile, leaf.entity.kind, valueType);
            openChoiceMenu(anchor, {
              title: 'Оператор',
              grid: true,
              groups: sections.map((section) => ({
                label: section.title,
                items: section.rows.flatMap((menuRow) =>
                  menuRow.cells.map((cell) => ({
                    key: cell.op,
                    label: cell.label,
                    side: cell.side,
                  })),
                ),
              })),
              activeKey: leaf.operator,
              onPick: (key, close) => {
                // «Между» у датового операнда раскрывается в подменю быстрых
                // периодов (элемент 69ac9ff8): матрица [текущий/прошлый/следующий] ×
                // [день/неделя/месяц/год] + «Задать вручную…». Выбор периода
                // создаёт обычное условие с ВИДИМЫМИ границами-токенами.
                const opened = filterTreeOperatorChoice(leaf, key, valueType, (menu) => {
                  close();
                  openChoiceMenu(anchor, {
                    title: menu.title,
                    groups: menu.groups,
                    activeKey: filterTreePeriodKeyOf(leaf) ?? undefined,
                    onPick: (periodKey) => {
                      filterTreeApplyPeriod(leaf, periodKey);
                      touch();
                    },
                  });
                });
                if (!opened) touch();
              },
            });
          },
        }),
      );
    }

    const valueBox = div('ft-row__value');
    const api: FilterTreeValueSlotApi = {
      setValue: (value) => {
        leaf.value = value;
        touch();
      },
    };
    valueBox.append(
      ctx.renderValue !== undefined
        ? ctx.renderValue(leaf, api)
        : buildValuePlaceholder(leaf),
    );
    row.append(valueBox);

    row.append(
      iconButton({
        icon: svgIcon('x'),
        title: 'Удалить условие',
        role: 'ghost',
        size: 's',
        class: 'ft-row__remove',
        onClick: () => {
          if (filterTreeRemoveAt(model(), path)) touch();
        },
      }),
    );
    if (rowIssue !== null) {
      row.tabIndex = -1;
      row.append(
        buildIssueLine(rowIssue, () => {
          row.scrollIntoView();
          row.focus();
        }),
      );
    }
    return row;
  };

  render();
  return {
    root,
    rerender: render,
    focusIssue: (path: string): void => fixers.get(path)?.(),
  };
}

/** Ключ строки «Что», соответствующей листу (для подсветки текущего операнда). */
function entryKeyOf(leaf: FilterTreeLeaf): string {
  const entity = leaf.entity;
  if (entity.kind === 'property') {
    const ref = entity.property_id ?? entity.property ?? '';
    return `property:${ref}`;
  }
  return entity.kind;
}

/** Разложить строки «Что» по разделам списка (контекстные — первыми, без заголовка). */
function groupEntries(
  entries: readonly FilterTreeOperandEntry[],
): Array<{ label: string; items: Array<FilterTreeChoiceItem>; columns?: number }> {
  const order: FilterTreeOperandEntry['group'][] = ['context', 'operands', 'properties'];
  const out: Array<{ label: string; items: FilterTreeChoiceItem[]; columns?: number }> = [];
  for (const group of order) {
    const items = entries
      .filter((entry) => entry.group === group)
      .map((entry) => ({
        key: entry.key,
        label: truncateOperandLabel(entry.detail === undefined ? entry.label : `${entry.label} — ${entry.detail}`),
        ...(entry.icon !== undefined ? { icon: entry.icon } : {}),
      }));
    if (items.length > 0) out.push({ label: FILTER_TREE_OPERAND_GROUPS[group], items, columns: 2 });
  }
  return out;
}

/** Предел длины пункта списка операндов: длиннее — обрезается многоточием. */
export const FILTER_TREE_OPERAND_LABEL_MAX = 60;

/** Обрезка длинной подписи пункта списка (требование заказчика 2026-10-13). */
export function truncateOperandLabel(label: string, max = FILTER_TREE_OPERAND_LABEL_MAX): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/** Кнопка-ячейка «Что»/«Оператор»: значок (необязательно) + значение + список. */
function buildPickerButton(opts: {
  cls: string;
  value: string;
  title: string;
  icon?: IconName;
  onOpen: (anchor: HTMLElement) => void;
}): HTMLElement {
  const button = uiButton({
    ...(opts.icon !== undefined ? { prefix: operandIconNode(opts.icon) } : {}),
    label: opts.value,
    role: 'secondary',
    size: 's',
    title: opts.title,
    class: `ft-picker ${opts.cls}`,
  });
  button.append(span('▾', 'ft-picker__caret'));
  button.addEventListener('click', () => opts.onOpen(button));
  return button;
}

/** Значок строки списка (svg-иконка малого размера, класс роли списка). */
function operandIconNode(name: IconName): SVGSVGElement {
  const icon = svgIcon(name, 14);
  icon.classList.add('ft-picker__icon');
  return icon;
}

/** Заглушка значения: виджет значения — следующая задача (`lib/filter-value.ts`). */
function buildValuePlaceholder(leaf: FilterTreeLeaf): HTMLElement {
  const box = div('ft-value');
  box.dataset['kind'] = leaf.value.kind;
  const needsValue = leaf.operator !== 'is_empty' && leaf.operator !== 'not_empty';
  box.append(
    span(
      leaf.value.kind === 'none' ? (needsValue ? 'задайте значение' : filterTreeValueKindLabel(leaf.value)) : filterTreeValueKindLabel(leaf.value),
      'ft-value__text',
    ),
  );
  setTooltip(
    box,
    needsValue ? 'Виджет значения — следующая задача редактора' : 'Значение не требуется этим оператором',
  );
  return box;
}

/** Элемент списка выпадающей панели. */
export interface FilterTreeChoiceItem {
  key: string;
  label: string;
  side?: 'yes' | 'no';
  /** Значок строки (иконка свойства либо смысловая иконка операнда). */
  icon?: IconName;
}

/** Раздел выпадающего списка. */
export interface FilterTreeChoiceGroup {
  label: string;
  items: FilterTreeChoiceItem[];
  /**
   * Число колонок раздела: задано — раздел раскладывается матрицей по N кнопок
   * в ряд (матрица быстрых периодов 4×3 у подменю «между», элемент 69ac9ff8).
   */
  columns?: number;
}

/** Опции выпадающего списка выбора (общее для «Что» и «Оператор»). */
export interface FilterTreeChoiceOptions {
  title: string;
  groups: readonly FilterTreeChoiceGroup[];
  /** Поле поиска над списком (список «Что», требование fc65b647). */
  search?: boolean;
  placeholder?: string;
  /** Двухколоночная сетка «утверждение | отрицание» (список операторов). */
  grid?: boolean;
  activeKey?: string;
  /** Выбор строки; `close` закрывает панель списка. */
  onPick: (key: string, close: () => void) => void;
}

export const FILTER_TREE_CHOICE_CLASS = 'ft-choice';

/**
 * Тело выпадающего списка — чистая сборка (без панели): поиск, разделы, строки.
 * Вынесено отдельно, чтобы список проверялся DOM-пробой без открытия поповера.
 */
export function buildChoiceMenuBody(
  opts: Omit<FilterTreeChoiceOptions, 'onPick'> & { onPick: (key: string) => void },
): {
  root: HTMLElement;
  setQuery: (query: string) => void;
  /** Перевести курсор в поле живого поиска (зовётся ПОСЛЕ монтирования панели). */
  focusSearch: () => void;
} {
  const root = div(FILTER_TREE_CHOICE_CLASS);
  if (opts.grid === true) root.classList.add(`${FILTER_TREE_CHOICE_CLASS}--grid`);
  let query = '';

  const list = div('ft-choice__list');
  /** Выделенная клавиатурой строка (индекс среди отрисованных кнопок). */
  let cursor = -1;
  /** Кнопки текущей отрисовки — порядок совпадает с видимым списком. */
  let renderedButtons: HTMLElement[] = [];

  const setCursor = (index: number): void => {
    const buttons = renderedButtons;
    if (buttons.length === 0) {
      cursor = -1;
      return;
    }
    cursor = (index + buttons.length) % buttons.length;
    buttons.forEach((button, i) => button.classList.toggle('ft-choice__item--cursor', i === cursor));
    buttons[cursor]?.scrollIntoView?.({ block: 'nearest' });
  };

  const paint = (): void => {
    clear(list);
    cursor = -1;
    renderedButtons = [];
    const needle = query.trim().toLowerCase();
    let rendered = 0;
    for (const group of opts.groups) {
      const items =
        needle === ''
          ? group.items
          : group.items.filter((item) => item.label.toLowerCase().includes(needle));
      if (items.length === 0) continue;
      // Первый раздел без подписи идёт без заголовка (заголовок «В этом месте» убран).
      if (group.label !== '') list.append(el('div', 'ft-choice__group', group.label));
      const rows = div('ft-choice__rows');
      if (group.columns !== undefined) {
        // Раздел-матрица (быстрые периоды «между», элемент 69ac9ff8): число
        // колонок — параметр раздела, раскладка задаётся в разметке. Ширина не
        // меньше 320px, чтобы колонки не сжимались в переносы строк.
        rows.dataset['columns'] = String(group.columns);
        rows.style.setProperty('display', 'grid');
        rows.style.setProperty('grid-template-columns', `repeat(${group.columns}, minmax(0, 1fr))`);
        rows.style.setProperty('gap', 'var(--space-1)');
        rows.style.setProperty('min-width', '320px');
      }
      for (const item of items) {
        const button = uiButton({
          ...(item.icon !== undefined ? { prefix: operandIconNode(item.icon) } : {}),
          label: item.label,
          role: item.key === opts.activeKey ? 'secondary' : 'ghost',
          size: 's',
          class: `ft-choice__item${item.side === 'no' ? ' ft-choice__item--no' : ''}`,
          onClick: () => opts.onPick(item.key),
        });
        button.dataset['key'] = item.key;
        if (item.side !== undefined) button.dataset['side'] = item.side;
        rows.append(button);
        renderedButtons.push(button);
        rendered += 1;
      }
      list.append(rows);
    }
    if (rendered === 0) list.append(el('div', 'ft-choice__empty', 'ничего не найдено'));
  };

  // Живой поиск: поле закреплено СВЕРХУ (sticky, CSS) и не прокручивается со
  // списком, есть крестик быстрой очистки и автофокус при открытии (требование
  // заказчика 2026-10-13); навигация ←/→ ↑/↓ и Enter — по списку.
  let searchInput: HTMLInputElement | null = null;
  if (opts.search === true) {
    const field = fieldInput({
      type: 'search',
      placeholder: opts.placeholder ?? 'Поиск…',
      ariaLabel: 'Поиск в списке',
      extraClass: 'ft-choice__search',
      onInput: (value) => {
        query = value;
        paint();
      },
    });
    searchInput = field;
    const clearSearch = (): void => {
      query = '';
      field.value = '';
      paint();
      field.focus();
    };
    const wrap = div('ft-choice__search-wrap');
    wrap.append(wrapClearable(field, clearSearch));
    root.append(wrap);
  }

  // Клавиатура списка: ↑/↓ перебор (в т.ч. из поля поиска), Enter — выбор.
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault?.();
      setCursor(cursor + (event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey) {
      const index = cursor >= 0 ? cursor : 0;
      const target = renderedButtons[index];
      if (target !== undefined) {
        event.preventDefault?.();
        target.click?.();
      }
    }
  };
  root.addEventListener('keydown', onKeydown as EventListener);

  paint();
  root.append(list);
  return {
    root,
    setQuery: (value) => {
      query = value;
      paint();
    },
    // Автофокус поля поиска делается вызывающим ПОСЛЕ монтирования панели:
    // focus() на ещё не подключённом узле не срабатывает (блокер п.14).
    focusSearch: () => searchInput?.focus?.(),
  };
}

/**
 * Открыть выпадающий список у якоря. Панель — общий фасад `lib/ui/popover`;
 * содержимое — {@link buildChoiceMenuBody}. Выбор строки закрывает панель.
 * Экспортируется: тем же списком набирает ключ сортировки секция сортировки
 * (`lib/filter-sort.ts`) — второй реализации выпадающего списка нет.
 */
export function openChoiceMenu(anchor: HTMLElement, opts: FilterTreeChoiceOptions): void {
  let popover: PopoverHandle | null = null;
  const built = buildChoiceMenuBody({
    ...opts,
    onPick: (key) => {
      popover?.close();
      opts.onPick(key, () => popover?.close());
    },
  });
  popover = openPopover({
    anchor: { element: anchor },
    content: { title: opts.title, body: built.root, maxHeightPx: 360 },
    extraClass: 'ft-choice-popover',
  });
  popover.element.dataset['ft'] = opts.title;
  // Автофокус поля живого поиска — ПОСЛЕ монтирования панели (блокер п.14):
  // на не подключённом к DOM узле focus() игнорируется браузером.
  built.focusSearch();
}
