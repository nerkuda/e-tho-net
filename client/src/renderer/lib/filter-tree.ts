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
  filterProfileOperands,
  filterProfileOperators,
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
import { VALUE_TYPE_LABELS } from './property-list.js';
// Фасады дизайн-системы — из файлов каталога, как в соседнем `lib/filter-form.ts`:
// barrel `lib/ui/index.ts` тянет за собой регистрацию вендора (webawesome/vaadin)
// и не грузится в юнит-тестах и на клиентском DOM-шиме. Правила `lib/ui`
// (без голого вендора, единый вид) соблюдены — используются только фасады.
import { uiButton, iconButton } from './ui/button.js';
import { fieldInput } from './ui/field.js';
import { svgIcon } from './ui/icon.js';
import { openPopover, type PopoverHandle } from './ui/popover.js';
import { segmentedControl } from './ui/segmented.js';
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
}

/** Раздел списка «Что» — человекочитаемая подпись. */
export const FILTER_TREE_OPERAND_GROUPS: Readonly<Record<FilterTreeOperandEntry['group'], string>> = {
  context: 'В этом месте',
  operands: 'Характеристики',
  properties: 'Свойства',
};

/** Человекочитаемые имена видов операндов (требование fc65b647). */
const OPERAND_KIND_LABELS: Readonly<Record<string, string>> = {
  id: 'Ссылка на мысль по id',
  type: 'Тип',
  link_type: 'Тип связи',
  parents: 'Родители',
  children: 'Потомки',
  attachments: 'Есть вложения',
  chronology: 'Есть дневниковые записи',
  comment: 'Есть комментарий',
  active: 'Актуальность',
  trashed: 'Помечено на удаление',
  keywords: 'Есть слова',
  author: 'Автор',
  editor: 'Редактор',
  created_at: 'Дата создания',
  updated_at: 'Дата изменения',
  properties: 'Есть любое свойство',
  targets: 'Цели записи',
  record_time: 'Время записи',
  record_title: 'Заголовок записи',
  record_body: 'Тело записи',
  record_author: 'Автор записи',
  record_editor: 'Редактор записи',
  occurred_at: 'Время события',
  action: 'Тип действия',
  entity_type: 'Вид сущности',
  entity_id: 'Сущность',
  user: 'Автор события',
  name: 'Имя вложения',
  kind: 'Вид вложения',
  mime_type: 'MIME-подтип',
  owner: 'Владельцы',
  size: 'Размер',
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
      group: contextual.has(kind) ? 'context' : 'operands',
      entity,
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
  const entity = leaf.entity;
  if (entity.kind === 'property') {
    const ref = entity.property_id ?? entity.property ?? '';
    const entry = data.registry.get(ref);
    if (entry !== undefined) return entry.name;
    return leaf.labels?.entity ?? ref;
  }
  return OPERAND_KIND_LABELS[entity.kind] ?? leaf.labels?.entity ?? entity.kind;
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

/** Подпись коннектора группы: «все условия (И)» / «любое условие (ИЛИ)». */
export function filterTreeConnectorLabel(op: 'and' | 'or'): string {
  return op === 'and' ? 'все условия' : 'любое условие';
}

/** Подпись связатора-индикатора перед строкой (менять коннекцию нельзя — это индикатор). */
export function filterTreeConnectorIndicator(op: 'and' | 'or'): string {
  return op === 'and' ? 'И' : 'ИЛИ';
}

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
}

/** Дескриптор построенного дерева. */
export interface FilterTreeHandle {
  root: HTMLElement;
  /** Перерисовать дерево из модели (после правок хоста). */
  rerender: () => void;
}

/** Классы вида — единственная точка их имён (адресуются тестами и CSS). */
export const FILTER_TREE_CLASS = 'ft';
export const FILTER_TREE_GROUP_CLASS = 'ft-group';
export const FILTER_TREE_ROW_CLASS = 'ft-row';
export const FILTER_TREE_CONNECTOR_CLASS = 'ft-connector';
/** Строка диагностики узла: причина + кнопка «исправить» (элемент 4e634c9a). */
export const FILTER_TREE_ISSUE_CLASS = 'ft-issue';

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
   * Строка диагностики узла (элемент 4e634c9a): точная причина (снапшот имени и
   * дата — из записи ядра) и кнопка «исправить», переводящая фокус в строку.
   */
  const buildIssueLine = (issue: FilterIssue, focus: () => void): HTMLElement => {
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

  const render = (): void => {
    clear(root);
    issueMap = [...(ctx.issues?.() ?? [])];
    const title = ctx.title ?? filterTreeTitle(ctx.profile);
    root.append(el('div', 'ft-title', title));
    root.append(renderGroup([], 0));
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

    head.append(span(filterTreeConnectorLabel(group.op), 'ft-group__connector-label'));
    const segments = segmentedControl({
      items: [
        { id: 'and', label: 'И', title: 'Все условия группы' },
        { id: 'or', label: 'ИЛИ', title: 'Любое условие группы' },
      ],
      activeId: group.op,
      ariaLabel: 'Коннекция группы',
      extraClass: 'ft-group__connector',
      role: 'ghost',
      size: 's',
      onChange: (id) => {
        if (id !== 'and' && id !== 'or') return;
        // Коннекцию меняет СЕЛЕКТОР ГРУППЫ; связаторы перед строками — только
        // индикаторы (элемент интерфейса fc65b647). У корневой группы путь пуст
        // — замена идёт не в `children` родителя, а в само поле дерева модели
        // (иначе клик по коннектору корня был бы no-op).
        const next = filterTreeUpdateAt(model(), group.opPath, (current) =>
          current.kind === 'group' ? { ...current, op: id } : current,
        );
        if (next !== null && next.kind === 'group' && group.opPath.length === 0) {
          ctx.getState().tree = next;
        }
        touch();
      },
    });
    head.append(segments.root);

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

    // --- Тело: связаторы-индикаторы, дети, пустое состояние, кнопки --------
    const body = div('ft-group__body');
    if (group.children.length === 0) {
      body.append(el('div', 'ft-group__empty', 'группа пуста — добавьте условие или группу'));
    } else {
      group.children.forEach((child, index) => {
        if (index > 0) {
          const indicator = span(filterTreeConnectorIndicator(group.op), FILTER_TREE_CONNECTOR_CLASS);
          indicator.setAttribute('aria-hidden', 'true');
          setTooltip(indicator, 'Коннекция задаётся селектором группы');
          body.append(indicator);
        }
        const childPath = [...group.bodyPath, index];
        body.append(
          child.kind === 'group' ? renderGroup(childPath, depth + 1) : renderRow(child, childPath),
        );
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
        label: '+ группа',
        role: 'ghost',
        size: 's',
        class: 'ft-add-group',
        onClick: () => {
          filterTreeAppendChildAt(model(), group.bodyPath, defaultFilterTreeGroup('and'));
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
    row.append(
      buildPickerButton({
        cls: 'ft-row__what',
        label: 'Что',
        value: filterTreeOperandLabel(leaf, ctx.data),
        title: 'Что отбираем',
        onOpen: (anchor) => {
          const entries = filterTreeOperandCatalogue(ctx.profile, ctx.data);
          openChoiceMenu(anchor, {
            title: 'Что',
            search: true,
            placeholder: 'Поиск свойства…',
            groups: groupEntries(entries),
            activeKey: entryKeyOf(leaf),
            onPick: (key) => {
              const entry = entries.find((item) => item.key === key);
              if (entry === undefined) return;
              leaf.entity = entry.entity;
              // Смена операнда сбрасывает значение: прежнее к новому операнду
              // не относится (то же правило, что у плоской панели).
              leaf.value = { kind: 'none' };
              const ops = filterProfileOperators(ctx.profile, entry.entity.kind, entry.valueType);
              if (ops.length > 0 && !ops.includes(leaf.operator)) leaf.operator = ops[0]!;
              touch();
            },
          });
        },
      }),
    );

    row.append(
      buildPickerButton({
        cls: 'ft-row__op',
        label: 'Оператор',
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
            onPick: (key) => {
              leaf.operator = key as FilterAstOperator;
              touch();
            },
          });
        },
      }),
    );

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
  return { root, rerender: render };
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

/** Разложить строки «Что» по разделам списка (контекстные — первыми). */
function groupEntries(
  entries: readonly FilterTreeOperandEntry[],
): Array<{ label: string; items: Array<{ key: string; label: string; side?: 'yes' | 'no' }> }> {
  const order: FilterTreeOperandEntry['group'][] = ['context', 'operands', 'properties'];
  const out: Array<{ label: string; items: Array<{ key: string; label: string }> }> = [];
  for (const group of order) {
    const items = entries
      .filter((entry) => entry.group === group)
      .map((entry) => ({ key: entry.key, label: entry.detail === undefined ? entry.label : `${entry.label} — ${entry.detail}` }));
    if (items.length > 0) out.push({ label: FILTER_TREE_OPERAND_GROUPS[group], items });
  }
  return out;
}

/** Кнопка-ячейка «Что»/«Оператор»: подпись + текущее значение + выпадающий список. */
function buildPickerButton(opts: {
  cls: string;
  label: string;
  value: string;
  title: string;
  onOpen: (anchor: HTMLElement) => void;
}): HTMLElement {
  const button = uiButton({
    prefix: span(opts.label, 'ft-picker__label'),
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
}

/** Раздел выпадающего списка. */
export interface FilterTreeChoiceGroup {
  label: string;
  items: FilterTreeChoiceItem[];
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
} {
  const root = div(FILTER_TREE_CHOICE_CLASS);
  if (opts.grid === true) root.classList.add(`${FILTER_TREE_CHOICE_CLASS}--grid`);
  let query = '';

  const list = div('ft-choice__list');
  const paint = (): void => {
    clear(list);
    const needle = query.trim().toLowerCase();
    let rendered = 0;
    for (const group of opts.groups) {
      const items =
        needle === ''
          ? group.items
          : group.items.filter((item) => item.label.toLowerCase().includes(needle));
      if (items.length === 0) continue;
      list.append(el('div', 'ft-choice__group', group.label));
      const rows = div('ft-choice__rows');
      for (const item of items) {
        const button = uiButton({
          label: item.label,
          role: item.key === opts.activeKey ? 'secondary' : 'ghost',
          size: 's',
          class: `ft-choice__item${item.side === 'no' ? ' ft-choice__item--no' : ''}`,
          onClick: () => opts.onPick(item.key),
        });
        button.dataset['key'] = item.key;
        if (item.side !== undefined) button.dataset['side'] = item.side;
        rows.append(button);
        rendered += 1;
      }
      list.append(rows);
    }
    if (rendered === 0) list.append(el('div', 'ft-choice__empty', 'ничего не найдено'));
  };

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
    root.append(field);
  }
  paint();
  root.append(list);
  return {
    root,
    setQuery: (value) => {
      query = value;
      paint();
    },
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
}
