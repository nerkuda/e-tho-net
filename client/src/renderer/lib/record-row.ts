/**
 * Строка дневниковой записи — общая компонента результатов (0.15.4,
 * тех.проект 43329662, задача 33ed043c, элемент 554e3129, ADR 8f0e9412).
 *
 * **Роль.** Одна форма строки для результатов поиска («Найдено в хронологии») и
 * вкладки «Упоминания»: период записи, чипы привязок (`comment_targets`), сниппет
 * с подсветкой. Компонента живёт в `lib/` и НЕ импортирует экранные модули:
 * транспортные DTO (`SearchChronoHit`, `RecordHit`) приводятся к единой
 * view-модели {@link RecordRowModel} адаптерами, поэтому условная логика двух
 * форматов не расползается по разметке.
 *
 * **Состав и правила (элемент 554e3129):**
 *  * период — единое отображение `formatRecordPeriod(from, to, use_time)`, как в
 *    таблице вкладки «Дневник» и ленте экрана «Дневник»;
 *  * чипы — ВСЕ видимые привязки (фильтр — общий предикат
 *    `lib/record-targets.ts`: HOME скрыт, настройки видимости учтены, сужение
 *    K4 — `show_trash` только для чипов-мыслей); чип мысли — фабрика облачка
 *    (профиль `chip`), чип связи — вид «источник — тип — цель» (КОПИЯ ПО
 *    ОБРАЗЦУ `chronicle.ts::linkChip`: `thoughtChip`/`linkChip` живут в
 *    `screens/`, импорт lib→screens запрещён — осознанное временное дублирование,
 *    как у обвязки переполнения); не поместившиеся чипы — кнопка «+N» с меню
 *    (`lib/chip-overflow.ts`, паттерн нижней строки истории посещений);
 *  * сниппет — тот же конвейер автоссылок `[[#id]]` → имя мысли
 *    (`paintWikiIdsInSnippet`/`resolveWikiIdsInSnippet`), что у прочих строк
 *    результатов (ошибка 2a8181f4) — регресс недопустим;
 *  * Ctrl+hover-предпросмотр в строке результата НЕ включается: строка —
 *    навигационный элемент, предпросмотр — фича ленты «Дневника» (уточнение N5).
 *
 * **Клики (требование ce121e09, сценарии 55c7f9c7/eeffbc16/b87fb958):**
 *  * строка в любом месте (период — часть строки, отдельной цели не образует):
 *    одна видимая привязка → прямой переход; несколько → список выбора
 *    (клавиатурный профиль `lib/menu.ts`); видимых нет → владелец записи
 *    (`owner_*` модели; владелец-связь → редактор связи без записи);
 *  * чип → конкретная привязка;
 *  * перетаскивание с чипа не начинается: чип — цель клика (ADR, паттерн
 *    history-bar), жест гасится на `pointerdown`.
 *
 * Компонента НЕ решает, как открывать цель: доменное действие передаёт
 * потребитель ({@link RecordRowOptions.onOpen}) — поиск добавляет фокус холста,
 * вкладка «Упоминания» действует по своему правилу.
 */

import type {
  ChronicleTarget,
  ChronicleTargetLink,
  RecordHit,
  SearchChronoHit,
  ThoughtRef,
} from '@etn/shared';

import { mountChipOverflow, type ChipOverflowStrip } from './chip-overflow.js';
import { formatRecordPeriod } from './date-period-dialog.js';
import { div, el, renderHtml, span } from './dom.js';
import { isInsideMenu, menuAction, showMenuAt, type MenuItem } from './menu.js';
import { paintWikiIdsInSnippet, resolveWikiIdsInSnippet } from '../editor/wiki-link-resolver.js';
import { createThoughtCloud } from './thought-cloud.js';
import { uiButton } from './ui/button.js';
import {
  recordTargetRef,
  visibleRecordTargets,
  type RecordTargetsVisibility,
  type RecordTargetRef,
} from './record-targets.js';

/**
 * Единая view-модель строки-записи: адаптер снимает различие транспортных DTO
 * (у поиска владелец — `owner`/`owner_id` хита, у backlinks/mentions —
 * `RecordHit.owner_type`/`owner_id`; всё остальное совпадает).
 */
export interface RecordRowModel {
  /** id записи: он же ключ строки (`comment_id`), устойчивый к смене представителя. */
  commentId: string;
  validFrom: string;
  validTo: string | null;
  /** Флаг «учитывать время» — от него зависит отображение периода. */
  useTime: boolean;
  /** Серверный сниппет с подсветкой (`<mark>`), сырой `[[#id]]` внутри. */
  snippet: string;
  /** Привязки записи (первичная первой) — чипы строки и цели навигации. */
  targets: readonly ChronicleTarget[];
  /** Владелец записи (первичная привязка): клик без видимых привязок ведёт к нему. */
  ownerType: 'thought' | 'link';
  ownerId: string;
}

/** Строка-запись из хита группы «Найдено в хронологии» (`SearchChronoHit`). */
export function recordRowFromChronoHit(hit: SearchChronoHit): RecordRowModel {
  return {
    commentId: hit.comment_id,
    validFrom: hit.valid_from,
    validTo: hit.valid_to,
    useTime: hit.use_time,
    snippet: hit.snippet,
    targets: hit.targets,
    ownerType: hit.owner,
    ownerId: hit.owner_id,
  };
}

/** Строка-запись из ответа backlinks/mentions (`RecordHit`). */
export function recordRowFromRecordHit(hit: RecordHit): RecordRowModel {
  return {
    commentId: hit.comment_id,
    validFrom: hit.valid_from,
    validTo: hit.valid_to,
    useTime: hit.use_time,
    snippet: hit.snippet,
    targets: hit.targets,
    ownerType: hit.owner_type,
    ownerId: hit.owner_id,
  };
}

/** Параметры сборки строки-записи. */
export interface RecordRowOptions {
  /** Сеть хита: сниппет-конвейер `[[#id]]`→имя разрешает id в ней. */
  networkId: string;
  /** Настройки видимости чипов (паритет с чипами истории посещений). */
  visibility: RecordTargetsVisibility;
  /** Открыть цель: привязку из чипа/списка или владельца записи. */
  onOpen: (target: RecordTargetRef, model: RecordRowModel) => void;
}

/** Рукоятка строки-записи. */
export interface RecordRowHandle {
  /** Корень строки (класс `record-row`); классы ряда добавляет потребитель. */
  el: HTMLElement;
  /** Действие строки — то же, что клик по ней (Enter в списке результатов). */
  activate(): void;
  /** Применить новые настройки видимости и перерисовать чипы (без перезапроса). */
  refreshVisibility(visibility: RecordTargetsVisibility): void;
  /** Снять обвязку переполнения (размонтирование результатов). */
  destroy(): void;
}

/** Чип привязки-мысли: фабрика облачка (профиль `chip`) в оформлении чипа записи. */
function recordThoughtChip(ref: ThoughtRef, inMenu = false): HTMLElement {
  const chip = createThoughtCloud(ref, {
    profile: 'chip',
    ...(inMenu ? { width: 'container' as const } : {}),
  });
  chip.classList.add('chron-chip', 'thought');
  return chip;
}

/**
 * Чип привязки-связи «источник — тип — цель» — копия ПО ОБРАЗЦУ
 * `screens/chronicle/chronicle.ts::linkChip` (см. шапку модуля). Неактуальная
 * связь показывается бледной (`.chron-chip.muted`, паритет с чипами истории:
 * настройка показа неактуальных не прячет её в бледность сама).
 */
function recordLinkChip(link: ChronicleTargetLink): HTMLElement {
  const chip = el('span', 'chron-chip link');
  const sourceTitle = link.source.title;
  const targetTitle = link.target.title;
  chip.append(
    span('🔗', 'chip-icon'),
    span(sourceTitle, 'chip-title'),
    span(
      link.type_name_forward === null ? ' — ' : ` — ${link.type_name_forward} — `,
      'chip-type muted',
    ),
    span(targetTitle, 'chip-title'),
  );
  chip.title =
    link.type_name_forward === null
      ? `${sourceTitle} — ${targetTitle}`
      : `${sourceTitle} — ${link.type_name_forward} — ${targetTitle}`;
  if (!link.active) chip.classList.add('muted');
  return chip;
}

/** Чип привязки: мысль — облачко, связь — «источник — тип — цель». */
function buildChip(target: ChronicleTarget, inMenu = false): HTMLElement {
  return target.kind === 'thought'
    ? recordThoughtChip(target.thought, inMenu)
    : recordLinkChip(target.link);
}

/** Подпись пункта списка выбора (доступность: у чипа-облачка её нет). */
function targetLabel(target: ChronicleTarget): string {
  if (target.kind === 'thought') return target.thought.title;
  const link = target.link;
  return link.type_name_forward === null
    ? `${link.source.title} — ${link.target.title}`
    : `${link.source.title} — ${link.type_name_forward} — ${link.target.title}`;
}

/**
 * Кнопка «+N» полосы чипов строки записи (паттерн «▾ N» истории посещений).
 * Кнопка — из словаря `lib/ui/button.ts`; класс `chron-chip` даёт ей вид чипа.
 */
function buildMoreButton(count: number, onOpen: () => void): HTMLElement {
  return uiButton({
    label: `+${count}`,
    role: 'ghost',
    size: 's',
    class: 'record-row-more chron-chip',
    onClick: (event) => {
      // Кнопка — отдельная цель клика, а не «строка целиком».
      event.stopPropagation();
      onOpen();
    },
  });
}

/**
 * Собирает строку дневниковой записи. Возвращает рукоятку: корень для вставки в
 * список, активацию для Enter и перерисовку чипов по смене настроек видимости.
 */
export function createRecordRow(model: RecordRowModel, options: RecordRowOptions): RecordRowHandle {
  let visibility = options.visibility;

  const row = div('record-row');
  const head = div('record-row-head');
  const period = span(
    formatRecordPeriod(model.validFrom, model.validTo, model.useTime),
    'record-row-period',
  );
  const chipsHost = div('record-row-chips');
  head.append(period, chipsHost);

  const snippet = div('record-row-snippet');
  // Сниппет несёт сырой `[[#<id>]]` — тот же конвейер, что у прочих результатов
  // поиска: синхронно из кеша (id не мелькает), затем дорезолв батчем
  // (ошибка 2a8181f4).
  renderHtml(snippet, paintWikiIdsInSnippet(model.snippet, options.networkId));
  void resolveWikiIdsInSnippet(model.snippet, options.networkId).then((resolved) => {
    if (snippet.isConnected) renderHtml(snippet, resolved);
  });

  row.append(head, snippet);

  /** Открыть цель (привязку или владельца) — доменное действие потребителя. */
  const open = (target: RecordTargetRef): void => options.onOpen(target, model);

  /** Владелец записи: клик без видимых привязок. */
  const openOwner = (): void => open({ kind: model.ownerType, id: model.ownerId });

  /** Список выбора привязки: пункты-облачка, клавиатурный профиль меню. */
  const openSelectionList = (visible: readonly ChronicleTarget[], anchor: HTMLElement): void => {
    const items: MenuItem[] = visible.map((target) =>
      menuAction(targetLabel(target), () => open(recordTargetRef(target)), {
        content: buildChip(target, true),
      }),
    );
    const rect = anchor.getBoundingClientRect();
    showMenuAt(rect.left, rect.bottom + 2, items, { keyboard: true });
  };

  /** Клик по строке (включая период): одна привязка → переход, несколько → список. */
  const activate = (): void => {
    const visible = visibleRecordTargets(model.targets, visibility);
    if (visible.length === 0) {
      openOwner();
      return;
    }
    if (visible.length === 1) {
      const only = visible[0];
      if (only !== undefined) open(recordTargetRef(only));
      return;
    }
    openSelectionList(visible, row);
  };

  row.addEventListener('click', (event) => {
    // Клик по строке меню списка выбора — не клик по строке результата.
    if (isInsideMenu(event.target)) return;
    activate();
  });

  /**
   * Чип привязки — своя цель клика. Перетаскивание с чипа не начинается: у чипа
   * нет канала перетаскивания вовсе (фабрика облачка без `actions` не монтирует
   * жесты, общий канал строк не подключается) — чип в строке результата только
   * навигация (ADR 8f0e9412, уточнение P3).
   */
  const wireChip = (chip: HTMLElement, target: ChronicleTarget): void => {
    chip.addEventListener('click', (event) => {
      event.stopPropagation();
      open(recordTargetRef(target));
    });
  };

  /**
   * Привязка каждого построенного чипа: кнопка «+N» отдаёт обвязке сами
   * ЭЛЕМЕНТЫ полосы, а меню остатка должно знать, куда ведёт пункт.
   */
  const chipTargets = new Map<HTMLElement, ChronicleTarget>();

  const strip: ChipOverflowStrip = mountChipOverflow({
    host: chipsHost,
    buildMore: buildMoreButton,
    openRest: (rest, anchor) => {
      // Пункты меню — те же чипы, что ушли в «+N»: цель клика — привязка из
      // снимка `targets` (снимок не перечитывается; удалённая привязка —
      // тихий пропуск/тост по действующему правилу stale-хита, сценарий
      // 20d5a3cf).
      const items: MenuItem[] = rest.flatMap((chip) => {
        const target = chipTargets.get(chip);
        if (target === undefined) return [];
        const content = buildChip(target, true);
        return [menuAction(targetLabel(target), () => open(recordTargetRef(target)), { content })];
      });
      const rect = anchor.getBoundingClientRect();
      showMenuAt(rect.left, rect.bottom + 2, items, { keyboard: true });
    },
  });

  /** Перерисовать полосу чипов из текущих привязок и настроек видимости. */
  const paintChips = (): void => {
    const visible = visibleRecordTargets(model.targets, visibility);
    chipTargets.clear();
    const chips = visible.map((target) => {
      const chip = buildChip(target);
      chipTargets.set(chip, target);
      wireChip(chip, target);
      return chip;
    });
    strip.paint(chips);
  };
  paintChips();

  return {
    el: row,
    activate: () => activate(),
    refreshVisibility: (next) => {
      visibility = next;
      paintChips();
    },
    destroy: () => strip.destroy(),
  };
}
