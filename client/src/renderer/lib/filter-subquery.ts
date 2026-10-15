/**
 * Модальный слой под-выборки редактора отбора (задача 3644342c ТП 11b2509a
 * «Редактор: базовый компонент»; элемент интерфейса f5005daa «Модальный слой
 * под-выборки»; ADR 4396ca00 «под-выборка в редакторе — модальный слой того же
 * компонента», ADR b0cf5433 «подзапросы — значения операторов, ввод модальный»;
 * требования af7859c9 «подпись чипа ≤ 2 строк», c088f9e1 «релевантные левые
 * операнды»).
 *
 * Ячейка значения релевантного операнда даёт переключение «список ↔ выборка»:
 * «выборка» открывает модальный слой с ТЕМ ЖЕ компонентом редактора
 * (`buildFilterTree`) — условия внутри под-выборки собираются тем же деревом,
 * профиль редактора — «мысли» (под-дерево всегда отбирает мысли: сервер
 * материализует набор id/типов по `thoughts_v`, `astSubqueryIdSet`). После
 * «Готово» ячейка показывает чип с подписью условий (обрезка до двух строк — в
 * CSS), полный текст — в тултипе. Повторное открытие — редактирование уже
 * собранного под-дерева; вложенность модалов не ограничена (выборка в выборке).
 *
 * **Релевантность операнда — зеркало серверных правил** (`query-service.ts`
 * `astSubqueryLeafClause`): значение-под-выборка доступно на `property` со
 * ссылочным видом значения, `parents`/`children`, `type` и — как ИСТОЧНИК
 * КОРНЕЙ иерархического обхода — на «Мысли» (`id`, только операторы
 * «в иерархии»/«не в иерархии», ошибка f4e99090 п.4); релевантные, но ещё
 * не исполняемые операнды (`attachments`, `chronology`, `targets`, `link_type`)
 * переключения не получают — иначе UI обещал бы то, что исполнитель отвергает
 * честным `unsupported`. Оператор-лист — `in`/`not_in`/`all_of`/
 * `in_hierarchy`/`not_in_hierarchy` (`SUBQUERY_LEAF_OPERATOR`:
 * `all_of` ↔ `value.operator = "all_in"`).
 *
 * **Модель — одна**: значение живёт в единственном слоте листа
 * (`FilterTreeValue.subquery`), режим ячейки ВЫЧИСЛЯЕТСЯ из вида значения, а
 * черновик модала — копия той же модели `FilterCriteriaState` (правка идёт по
 * копии, «Отмена» ничего не меняет). Отдельного типа модели под-выборки нет —
 * это запрещено ADR 4396ca00. Вид — фасады дизайн-системы (`segmentedControl`,
 * `uiButton`/`iconButton`) и каркас диалогов `lib/dialog.ts`; свой CSS — только
 * роли ячейки, чипа и тела модала (`styles/filter-subquery.css`).
 */

import {
  type FilterAstEntityKind,
  type FilterAstOperator,
  type FilterProfileId,
} from '@etn/shared';

import { confirmDialog, showDialog } from './dialog.js';
import { div, setTooltip } from './dom.js';
import {
  defaultFilterCriteriaState,
  defaultFilterTreeGroup,
  filterProfileOperators,
  withReverseLinkPropertySides,
  type FilterTreeGroup,
  type FilterTreeLeaf,
  type FilterTreeNode,
} from './filter-builder.js';
import {
  buildFilterTree,
  filterTreeOperandLabel,
  filterTreeOperatorLabel,
  filterTreeValueKindLabel,
  type FilterTreeData,
  type FilterTreeValueSlotApi,
} from './filter-tree.js';
import { renderFilterValue, type FilterValueContext } from './filter-value.js';
import { iconButton, uiButton } from './ui/button.js';
import { svgIcon } from './ui/icon.js';
import { segmentedControl } from './ui/segmented.js';

// ---------------------------------------------------------------------------
// Вид и имена классов
// ---------------------------------------------------------------------------

export const FILTER_SUBQUERY_CELL_CLASS = 'fq-cell';
export const FILTER_SUBQUERY_MODE_CLASS = 'fq-mode';
export const FILTER_SUBQUERY_CHIP_CLASS = 'fq-chip';
export const FILTER_SUBQUERY_MODAL_CLASS = 'fq-modal';

/**
 * Число строк подписи чипа (требование af7859c9: «не более 2 строк с обрезкой»).
 * Значение объявлено правилом CSS `.fq-chip__open` (`line-clamp`), тест сверяет
 * их друг с другом — хардкод числа в разметке не нужен.
 */
export const FILTER_SUBQUERY_CHIP_LINES = 2;

/** Профиль редактора под-выборки: под-дерево всегда отбирает МЫСЛИ. */
export const FILTER_SUBQUERY_PROFILE: FilterProfileId = 'thoughts';

// ---------------------------------------------------------------------------
// Релевантность операнда (требование c088f9e1)
// ---------------------------------------------------------------------------

/** Операнды, на которых значение-под-выборка исполняется (паритет с сервером). */
const SUBQUERY_SUPPORTED_KINDS: ReadonlySet<FilterAstEntityKind> = new Set([
  'property',
  'parents',
  'children',
  'type',
  // «Мысль» (`id`, задача a577875b): под-выборка — набор мыслей и ИСТОЧНИК
  // КОРНЕЙ иерархического обхода («в иерархии» от мыслей выборки). Переключатель
  // доступен и наборным «в списке»/«не в списке» — вхождение мысли в выборку
  // (ошибка 696b3c3b п.8; сервер исполняет оба вида, см.
  // {@link filterSubqueryRelevantLeaf}).
  'id',
  // «Цели записи» (`targets`, ошибка 609deba0 п.1): под-выборка мыслей-целей —
  // тот же вид значения, что у «Мысли»; сервер исполняет `in`/`not_in`/`all_of`
  // и «в иерархии» (`chronicle-service.targetsLeafClause`).
  'targets',
]);

/**
 * Релевантные, но ещё не исполняемые операнды (сервер отвечает `unsupported` до
 * под-проекта сущностей): переключение «выборка» им не предлагается.
 */
const SUBQUERY_DEFERRED_KINDS: ReadonlySet<FilterAstEntityKind> = new Set([
  'attachments',
  'chronology',
  'link_type',
]);

/**
 * ТИПОВЫЕ операнды, которым переключатель «Список ↔ Выборка» в этой версии НЕ
 * предлагается (ошибка 609deba0 п.1): выборку по типам мыслей/связей и
 * публикациям в 0.13.1 не строим — значение таких операндов перечисляется
 * списком. Сервер под-выборку по «Типу» исполняет (`filterSubquerySupported`
 * остаётся true — зеркало `AST_SUBQUERY_SUPPORTED`), ограничение — только
 * редактор: иначе он предлагал бы собрать отбор по МЫСЛЯМ там, где значение —
 * тип. Публикации (свойство вида `publication`) сюда не входят: у них нет
 * ссылочного вида значения, и переключатель им не даётся вовсе
 * ({@link filterSubqueryRelevantLeaf} пропускает только `link`).
 */
const SUBQUERY_HIDDEN_KINDS: ReadonlySet<FilterAstEntityKind> = new Set(['type', 'link_type']);

/** Операторы-листья, совместимые со значением-под-выборкой. */
const SUBQUERY_LEAF_OPERATORS: ReadonlySet<FilterAstOperator> = new Set([
  'in',
  'not_in',
  'all_of',
  // «В иерархии»/«не в иерархии»: под-выборка — источник КОРНЕЙ обхода
  // (ошибка f4e99090 п.4; серверная поддержка — `SUBQUERY_LEAF_OPERATOR`
  // `filter-ast.ts` и `AST_SUBQUERY_LEAF_OPS` `query-service.ts`).
  'in_hierarchy',
  'not_in_hierarchy',
]);

/** Квантификатор значения по оператору-листу (`all_of` ↔ `all_in`). */
export function filterSubqueryValueOperator(operator: FilterAstOperator): 'in' | 'not_in' | 'all_in' {
  if (operator === 'not_in' || operator === 'not_in_hierarchy') return 'not_in';
  if (operator === 'all_of') return 'all_in';
  return 'in';
}

/** Операнд поддержан исполнителем (паритет с `AST_SUBQUERY_SUPPORTED`). */
export function filterSubquerySupported(kind: FilterAstEntityKind): boolean {
  return SUBQUERY_SUPPORTED_KINDS.has(kind);
}

/** Операнд релевантен, но ждёт под-проекта сущностей (`AST_SUBQUERY_DEFERRED`). */
export function filterSubqueryDeferred(kind: FilterAstEntityKind): boolean {
  return SUBQUERY_DEFERRED_KINDS.has(kind);
}

/**
 * ТИПОВОЙ операнд: выборка в этой версии не предлагается, хотя исполнитель её
 * принимает (ошибка 609deba0 п.1). Точка правды для проверок и тестов.
 */
export function filterSubqueryHidden(kind: FilterAstEntityKind): boolean {
  return SUBQUERY_HIDDEN_KINDS.has(kind);
}

/**
 * Предлагать ли переключение «список ↔ выборка» на этом листе: оператор
 * совместим со значением-под-выборкой, операнд поддержан исполнителем, а
 * свойство-ссылка — ссылочного вида значения (под-выборка сравнивает набор
 * мыслей; на текстовом свойстве это бессмыслица, сервер отвечает отказом).
 */
export function filterSubqueryRelevantLeaf(leaf: FilterTreeLeaf, data: FilterTreeData): boolean {
  if (!SUBQUERY_LEAF_OPERATORS.has(leaf.operator)) return false;
  const kind = leaf.entity.kind;
  if (!filterSubquerySupported(kind)) return false;
  // Типовые операнды («Тип мысли»/«Тип связи») — в 0.13.1 без выборки
  // (ошибка 609deba0 п.1): редактор предлагал собрать отбор по МЫСЛЯМ там, где
  // значение — тип. Сервер их исполняет, но UI выборку по типам не строит.
  if (SUBQUERY_HIDDEN_KINDS.has(kind)) return false;
  // «Мысль» (`id`): под-выборка — набор мыслей. Наборные «в списке»/«не в
  // списке» дают вхождение мысли в выборку, иерархические «в иерархии»/«не в
  // иерархии» — обход поддерева выборки. Сервер исполняет ОБА вида (ошибка
  // 696b3c3b п.8; `AST_SUBQUERY_SUPPORTED`/`case 'id'` в `query-service.ts`).
  // «Все в выборке» неприменимо — «Мысль» одиночный операнд (сервер отвергает
  // `all_in`), поэтому `all_of` исключён, как у «Типа».
  if (kind === 'id') return leaf.operator !== 'all_of';
  if (kind !== 'property') return true;
  const ref = leaf.entity.property_id ?? leaf.entity.property ?? '';
  const direct = data.registry.get(ref);
  const valueType =
    direct?.value_type ?? withReverseLinkPropertySides(data.registry, data.linkTypes ?? []).get(ref)?.value_type;
  return valueType === 'link';
}

/** Пустое под-дерево новой выборки — та же модель (`FilterTreeGroup`). */
export function filterSubqueryDefaultNode(): FilterTreeGroup {
  return defaultFilterTreeGroup('and');
}

/** Операнд листа доступен профилю редактора под-выборки (защита от мусора). */
export function filterSubqueryLeafInProfile(leaf: FilterTreeLeaf): boolean {
  return filterProfileOperators(FILTER_SUBQUERY_PROFILE, leaf.entity.kind).includes(leaf.operator);
}

// ---------------------------------------------------------------------------
// Подпись под-выборки (требование af7859c9)
// ---------------------------------------------------------------------------

/** Текст значения листа для подписи (человекочитаемый вид модели). */
function leafValueText(leaf: FilterTreeLeaf): string {
  return leaf.value.kind === 'none' ? '' : filterTreeValueKindLabel(leaf.value);
}

/**
 * Подпись условий под-выборки одной строкой: листья — «операнд оператор
 * значение», группы — коннектором, вложенные группы — в скобках. Полный текст
 * уходит в тултип чипа; обрезка до двух строк — визуальная (CSS).
 */
export function filterSubquerySummary(node: FilterTreeNode, data: FilterTreeData): string {
  if (node.kind === 'group') {
    if (node.children.length === 0) return 'без условий';
    const parts = node.children.map((child) =>
      child.kind === 'group' ? `(${filterSubquerySummary(child, data)})` : filterSubquerySummary(child, data),
    );
    if (node.op === 'not') return `НЕ (${filterSubquerySummary(node.children[0]!, data)})`;
    return parts.join(node.op === 'or' ? ' ИЛИ ' : ' И ');
  }
  const value = leafValueText(node);
  const head = `${filterTreeOperandLabel(node, data)} ${filterTreeOperatorLabel(node.operator)}`;
  return value === '' ? head : `${head} ${value}`;
}

/** Тултип чипа: полный текст подписи и подсказка о повторном открытии. */
export function filterSubqueryChipTooltip(summary: string): string {
  return `${summary}\n\nнажмите, чтобы открыть выборку в модальном слое`;
}

// ---------------------------------------------------------------------------
// Чип собранной выборки
// ---------------------------------------------------------------------------

/** Параметры чипа под-выборки. */
export interface FilterSubqueryChipOptions {
  /** Условия под-выборки (то, что описывает подпись). */
  node: FilterTreeNode;
  /** Данные сети — для подписи операндов. */
  data: FilterTreeData;
  /** Открыть модальный слой (повторное открытие — редактирование). */
  onEdit: () => void;
  /** Убрать выборку из значения (ячейка вернётся к списку). */
  onClear: () => void;
}

/** Собрать чип под-выборки: подпись ≤ двух строк и тултип с полным текстом. */
export function buildSubqueryChip(opts: FilterSubqueryChipOptions): HTMLElement {
  const summary = filterSubquerySummary(opts.node, opts.data);
  const chip = div(FILTER_SUBQUERY_CHIP_CLASS);
  chip.dataset['summary'] = summary;
  const open = uiButton({
    label: summary,
    role: 'secondary',
    size: 's',
    class: 'fq-chip__open',
    title: filterSubqueryChipTooltip(summary),
    onClick: () => opts.onEdit(),
  });
  chip.append(
    open,
    iconButton({
      icon: svgIcon('x'),
      title: 'Убрать выборку из значения',
      role: 'ghost',
      size: 's',
      class: 'fq-chip__clear',
      onClick: () => opts.onClear(),
    }),
  );
  setTooltip(chip, filterSubqueryChipTooltip(summary));
  return chip;
}

// ---------------------------------------------------------------------------
// Модальный слой
// ---------------------------------------------------------------------------

/** Подтверждение: да/нет (`confirmDialog` каркаса либо подмена хоста/теста). */
export type FilterSubqueryConfirm = (title: string, message: string) => Promise<boolean>;

/** Параметры модального слоя под-выборки. */
export interface FilterSubqueryOptions {
  /** Данные сети редактора (реестр, типы, типы связей) — те же, что у дерева. */
  data: FilterTreeData;
  /** Контекст виджетов значений внутри под-выборки (сеть, пикер, облачка). */
  value: FilterValueContext;
  /** Заголовок модала; по умолчанию «Выборка». */
  title?: string;
  /** Подтверждение сброса собранной под-выборки (по умолчанию `confirmDialog`). */
  confirm?: FilterSubqueryConfirm;
}

/**
 * Открыть модальный слой под-выборки. Возвращает отредактированное под-дерево
 * («Готово») либо `null` («Отмена», Esc, крестик) — значение в модели не
 * меняется. Черновик — копия модели: правки в модале не трогают лист до
 * подтверждения.
 */
export function openFilterSubqueryModal(
  current: FilterTreeNode | null,
  opts: FilterSubqueryOptions,
): Promise<FilterTreeNode | null> {
  // Черновик — копия ТОЙ ЖЕ модели (`FilterCriteriaState`): правки модала не
  // трогают лист до «Готово», «Отмена» не меняет ничего.
  const draft = defaultFilterCriteriaState();
  draft.tree = current === null ? filterSubqueryDefaultNode() : copyTreeNode(current);
  let settle: (value: FilterTreeNode | null) => void = () => undefined;
  let settled = false;
  const done = (value: FilterTreeNode | null): void => {
    if (settled) return;
    settled = true;
    settle(value);
  };

  const body = div(FILTER_SUBQUERY_MODAL_CLASS);
  body.append(
    buildFilterTree({
      profile: FILTER_SUBQUERY_PROFILE,
      getState: () => draft,
      data: opts.data,
      renderValue: createFilterSubqueryValueRenderer(opts.value, opts),
    }).root,
  );

  const promise = new Promise<FilterTreeNode | null>((resolve) => {
    settle = resolve;
  });
  showDialog({
    title: opts.title ?? 'Выборка',
    body,
    size: 'l',
    fixedHeight: true,
    buttons: [
      { label: 'Отмена' },
      {
        label: 'Готово',
        primary: true,
        keepOpen: true,
        onClick: (close) => {
          const tree = draft.tree;
          done(tree === null || tree === undefined ? filterSubqueryDefaultNode() : copyTreeNode(tree));
          close();
        },
      },
    ],
    onClose: () => done(null),
  });
  return promise;
}

/** Глубокая копия под-дерева: черновик модала не делит узлы с моделью листа. */
export function copyTreeNode(node: FilterTreeNode): FilterTreeNode {
  if (node.kind === 'leaf') {
    return {
      ...node,
      entity: { ...node.entity },
      value: copyTreeValue(node.value),
      ...(node.labels === undefined ? {} : { labels: { ...node.labels } }),
    };
  }
  return { ...node, children: node.children.map((child) => copyTreeNode(child)) };
}

/** Копия значения листа (под-выборка копируется рекурсивно). */
function copyTreeValue(value: FilterTreeLeaf['value']): FilterTreeLeaf['value'] {
  if (value.kind === 'subquery') {
    return { ...value, node: copyTreeNode(value.node) };
  }
  if (value.kind === 'list') return { ...value, items: [...value.items] };
  return value;
}

// ---------------------------------------------------------------------------
// Сброс собранной выборки при смене свойства (элемент f5005daa, ADR 4396ca00)
// ---------------------------------------------------------------------------

/** Подтверждение по умолчанию — единый каркас диалогов клиента. */
export const defaultFilterSubqueryConfirm: FilterSubqueryConfirm = (title, message) =>
  confirmDialog(title, message);

/**
 * Подтвердить сброс СОБРАННОЙ под-выборки и затем выполнить `apply` (смена
 * свойства строки обнуляет значение — собранные условия выборки при этом
 * теряются). Отказ оставляет строку как есть.
 */
export function confirmFilterSubqueryReset(
  apply: () => void,
  confirm: FilterSubqueryConfirm = defaultFilterSubqueryConfirm,
): void {
  void confirm(
    'Сменить свойство строки?',
    'В строке собрана под-выборка — при смене свойства она будет сброшена.',
  ).then((ok) => {
    if (ok) apply();
  });
}

// ---------------------------------------------------------------------------
// Ячейка значения: «список ↔ выборка»
// ---------------------------------------------------------------------------

/** Слот значения с под-выборкой: хук хоста для `FilterTreeContext.renderValue`. */
export function createFilterSubqueryValueRenderer(
  ctx: FilterValueContext,
  opts: FilterSubqueryOptions,
): (leaf: FilterTreeLeaf, api: FilterTreeValueSlotApi) => HTMLElement {
  return (leaf, api) => {
    if (!filterSubqueryRelevantLeaf(leaf, ctx.data)) return renderFilterValue(leaf, api, ctx);
    return buildSubqueryValueCell(leaf, api, ctx, opts);
  };
}

/** Собрать ячейку значения релевантного листа: переключатель режима и вид значения. */
export function buildSubqueryValueCell(
  leaf: FilterTreeLeaf,
  api: FilterTreeValueSlotApi,
  ctx: FilterValueContext,
  opts: FilterSubqueryOptions,
): HTMLElement {
  const value = leaf.value;
  const isSubquery = value.kind === 'subquery';
  const cell = div(FILTER_SUBQUERY_CELL_CLASS);
  cell.dataset['mode'] = isSubquery ? 'subquery' : 'list';
  /**
   * Правка значения ВИДА ячейки (список ↔ под-выборка) — структурная: обычная
   * правка значения ячейку не пересобирает (ошибка 7d36f439), а здесь меняется
   * её представление, поэтому строка перерисовывается целиком.
   */
  const writeModeValue = api.setStructuralValue ?? api.setValue;

  /**
   * Переключатель «Список ↔ Выборка». Храним рукоятку: при выборе «Выборка»
   * список СКРЫВАЕТСЯ представлением выборки (после «Готово» значение модели
   * становится под-выборкой и строка перерисовывается), а при «Отмене» создания
   * выборки (вложенная выборка пуста) переключатель возвращаем на «Список» —
   * список снова виден (ошибка 609deba0 п.2).
   */
  const modeControl = segmentedControl({
    items: [
      { id: 'list', label: 'Список', title: 'Перечислить значения в строке' },
      { id: 'subquery', label: 'Выборка', title: 'Собрать под-выборку в модальном слое' },
    ],
    activeId: isSubquery ? 'subquery' : 'list',
    ariaLabel: 'Вид значения условия',
    extraClass: FILTER_SUBQUERY_MODE_CLASS,
    role: 'ghost',
    size: 's',
    onChange: (id) => {
      if (id === 'subquery') openModal();
      // «Список» при собранной выборке — сброс значения-выборки: переключатель
      // выглядит как смена ВИДА, но собранные условия при этом теряются, поэтому
      // подтверждаем (ошибка 68023851 п.4) — как при смене свойства строки.
      else if (isSubquery) clearSubquery();
    },
  });

  /**
   * Подтвердить сброс собранной под-выборки при переключении режима на «Список»
   * (ошибка 68023851 п.4). Крестик чипа (`fq-chip__clear`) — ЯВНОЕ «убрать
   * выборку», он сбрасывает без подтверждения (элемент f5005daa).
   */
  const clearSubquery = (): void => {
    const confirm = opts.confirm ?? defaultFilterSubqueryConfirm;
    void confirm(
      'Сменить вид значения?',
      'В строке собрана под-выборка — при переходе к списку она будет сброшена.',
    ).then((ok) => {
      if (ok) writeModeValue({ kind: 'none' });
      // Отказ — переключатель возвращаем на «Выборка»: сегмент уже переключился
      // визуально до вызова `onChange`.
      else modeControl.setActive('subquery');
    });
  };

  /** Открыть модал под-выборки; подтверждение — значение-выборка, отмена — откат. */
  const openModal = (): void => {
    void openFilterSubqueryModal(isSubquery ? value.node : null, opts).then((edited) => {
      if (edited === null) {
        // «Отмена»: значение в модели не меняется. Выборки не было — выборка
        // пуста, значит переключатель возвращаем на «Список» (список снова
        // виден и активен, ошибка 609deba0 п.2). Собранную выборку при отмене
        // редактирования сохраняем как есть.
        if (!isSubquery) modeControl.setActive('list');
        return;
      }
      writeModeValue({
        kind: 'subquery',
        operator: filterSubqueryValueOperator(leaf.operator),
        node: edited,
      });
    });
  };

  cell.append(modeControl.root);

  const body = div('fq-cell__body');
  if (isSubquery) {
    body.append(
      buildSubqueryChip({
        node: value.node,
        data: ctx.data,
        onEdit: openModal,
        onClear: () => writeModeValue({ kind: 'none' }),
      }),
    );
  } else {
    body.append(renderFilterValue(leaf, api, ctx));
  }
  cell.append(body);
  return cell;
}
