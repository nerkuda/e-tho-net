/**
 * DTO подсистемы «Публикации» (0.11.1; задачи 8178e007 модель данных и
 * 34119c67 сборка; тех.проект c5261d02, каталог «Публикации»; сущности
 * bc147b40, 18f3bebf, e6aeb7ba, f0a51091, 8b849dfc).
 *
 * Публикация — живой документ из мыслесети: заголовки разделов и тексты
 * собираются из мыслей по рецептам; контент не дублируется, правка текста в
 * публикации — правка самой мысли. Здесь описаны и МОДЕЛЬ публикации
 * (карточка, порядок, исключения, полки — задача 8178e007), и DTO сборки
 * документа с членством (кандидаты, использование — задача 34119c67).
 */

import type { SavedFilterDefinition } from './structure.js';
import type { HoldingLayerRef } from './trash.js';

/** Источник обложки публикации (GET-карточка отдаёт вычисленный `cover_kind`). */
export const PUBLICATION_COVER_KINDS = ['attachment', 'url', 'none'] as const;
export type PublicationCoverKind = (typeof PUBLICATION_COVER_KINDS)[number];

/** Сортировка списка публикаций (03-server-api.md, карточка CRUD). */
export const PUBLICATION_SORTS = ['manual', 'title', 'date', 'author'] as const;
export type PublicationSort = (typeof PUBLICATION_SORTS)[number];

/** Фильтр актуальности списка: `true` — только актуальные (по умолчанию),
 * `false` — только неактуальные, `any` — все. */
export const PUBLICATION_ACTIVE_FILTERS = ['true', 'false', 'any'] as const;
export type PublicationActiveFilter = (typeof PUBLICATION_ACTIVE_FILTERS)[number];

/** Публикация — живой документ сети (сущность `publications`). */
export interface Publication {
  id: string;
  /** Название — заголовок титула (H1). */
  title: string;
  subtitle: string | null;
  /** Резюме, markdown без заголовков (заголовки запрещены валидацией). */
  summary_md: string | null;
  /** Авторство текстом; `null` — показывается создатель (`created_by`). */
  authorship: string | null;
  /** Строка-вложение-обложка (owner_type='publication', этот же id). */
  cover_attachment_id: string | null;
  /** Обложка внешним URL; взаимоисключимо с `cover_attachment_id`. */
  cover_url: string | null;
  /** Вычисленный источник обложки. */
  cover_kind: PublicationCoverKind;
  /** Хранимая ISO-дата сборки; `null` — не собрана; меняет только rebuild. */
  assembly_date: string | null;
  /** Рецепт заголовков: условия отбора в формате «Структур мыслей». */
  title_recipe: SavedFilterDefinition | null;
  /** Рецепт текстов: упорядоченный список id свойств-связей; `[]` — пустой. */
  text_sources: string[];
  /** Id свойств блока «дополнительные материалы» (∩ text_sources = ∅). */
  extra_properties: string[];
  numbering_from: number | null;
  numbering_to: number | null;
  active: boolean;
  marked_for_deletion: boolean;
  marked_for_deletion_at: string | null;
  marked_for_deletion_by: string | null;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

/** Вход создания публикации. Валидация — в домене и zod-схеме контракта. */
export interface PublicationCreateInput {
  title: string;
  subtitle?: string | null;
  summary_md?: string | null;
  authorship?: string | null;
  cover_attachment_id?: string | null;
  cover_url?: string | null;
  title_recipe?: SavedFilterDefinition | null;
  text_sources?: string[];
  extra_properties?: string[];
  numbering_from?: number | null;
  numbering_to?: number | null;
}

/** Вход правки настроек публикации (last-write-wins по полям). */
export interface PublicationUpdateInput {
  title?: string;
  subtitle?: string | null;
  summary_md?: string | null;
  authorship?: string | null;
  cover_attachment_id?: string | null;
  cover_url?: string | null;
  title_recipe?: SavedFilterDefinition | null;
  text_sources?: string[];
  extra_properties?: string[];
  numbering_from?: number | null;
  numbering_to?: number | null;
  active?: boolean;
}

/** Результат списка публикаций: страница `items` + полное число `total`
 * (клиентский мост читает `meta.total` ответа `GET /publications`). */
export interface PublicationListResult {
  items: Publication[];
  total: number;
}

/** Параметры списка публикаций (пагинация по прецеденту списков сети). */
export interface PublicationListQuery {
  q?: string;
  shelf?: string;
  active?: PublicationActiveFilter;
  sort?: PublicationSort;
  include_trashed?: boolean;
  limit?: number;
  offset?: number;
}

/** Один элемент локального порядка: ключ узла и позиция. */
export interface PublicationOrderItem {
  /** id ребра вхождения (для текста — ребро свойства-источника, для
   * подраздела — родительское ребро) либо id мысли корневого раздела. */
  node_key: string;
  position: number;
}

/** Исключённая из публикации мысль (действует на все вхождения). */
export interface PublicationExclusion {
  publication_id: string;
  thought_id: string;
  created_at: string;
  created_by: string;
}

/** Что блокирует физическое удаление публикации (по образцу мыслей). */
export interface PublicationDeletionBlocking {
  /** Живых значений свойств типа «Публикация», ссылающихся на неё. */
  properties: number;
  /** Живые теневые строки публикации в иных слоях; в рабочем слое — и основа. */
  layers: HoldingLayerRef[];
}

/** Результат проверки удаления публикации (аналог `deletion-check` мысли). */
export interface PublicationDeletionCheckResult {
  blocked: boolean;
  blocking: PublicationDeletionBlocking;
}

/** Элемент состава полки. */
export interface ShelfItem {
  shelf_id: string;
  publication_id: string;
  position: number;
}

/** Полка библиотеки публикаций (общая для участников сети). */
export interface Shelf {
  id: string;
  title: string;
  position: number;
  version: number;
  /** Пометка на удаление (корзина); purge — только в основе, состав сносится каскадом. */
  marked_for_deletion: boolean;
  marked_for_deletion_at: string | null;
  marked_for_deletion_by: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  items: ShelfItem[];
}

/** Вход создания/правки полки. */
export interface ShelfInput {
  title?: string;
  position?: number;
}

/** Что блокирует физическое удаление полки (0.11.1, задача c59ce742). */
export interface ShelfDeletionBlocking {
  /**
   * Число строк состава полки, которые снесёт каскад. Информационно: непустая
   * полка физически удаляется (полка — как плейлист, публикации не трогаются);
   * `blocked` отражает только контекст слоя.
   */
  items: number;
}

/** Результат проверки удаления полки. */
export interface ShelfDeletionCheckResult {
  blocked: boolean;
  blocking: ShelfDeletionBlocking;
}

// ---------------------------------------------------------------------------
// Сборка документа (0.11.1, задача 34119c67; сущность 8b849dfc; операция
// 19d80dd2; требования дерева 599414b6, текстов 620aa285, титула 745fdc48,
// нумерации a33f7b0e; ADR членства 7adf7778)
// ---------------------------------------------------------------------------

/** Источник обложки в собранном документе: вложение, URL или заглушка. */
export const PUBLICATION_ASSEMBLY_COVER_KINDS = ['attachment', 'url', 'placeholder'] as const;
export type PublicationAssemblyCoverKind = (typeof PUBLICATION_ASSEMBLY_COVER_KINDS)[number];

/** Обложка титульного блока сборки. `ref` — id вложения / URL; у заглушки `null`. */
export interface PublicationAssemblyCover {
  kind: PublicationAssemblyCoverKind;
  ref: string | null;
}

/** Титульный блок документа (H1), собираемый из полей публикации. */
export interface PublicationAssemblyTitle {
  title: string;
  subtitle: string | null;
  /** Авторство текстом; пусто — клиент показывает создателя публикации. */
  authorship: string | null;
  /** Хранимая дата сборки; меняет только rebuild. */
  assembly_date: string | null;
  /** Резюме, отрендеренное в HTML (без заголовков). */
  summary_html: string;
  cover: PublicationAssemblyCover;
  /**
   * Число новых кандидатов — мыслей, вошедших в отбор позже принятого
   * состояния публикации (временная семантика, задача e754527d; спека f9a20c3f).
   */
  new_candidates: number;
}

/** Один текст раздела: мысль-текст, её якорь, ребро-источник и HTML. */
export interface PublicationAssemblyText {
  thought_id: string;
  anchor: string;
  /** Ребро свойства-источника (ключ локального порядка текста). */
  edge_id: string;
  body_html: string;
}

/** Блок «дополнительные материалы»: свойство рецепта и названия его целей. */
export interface PublicationAssemblyExtraGroup {
  property: string;
  targets: Array<{ id: string; title: string }>;
}

/** Пометки раздела: повторное вхождение и обрыв кольца. */
export interface PublicationSectionFlags {
  /** Якорь первого вхождения раздела; `null` — первое (содержательное). */
  repeat_of: string | null;
  /** Повторный заход пришёлся на текущую ветку обхода (кольцо). */
  cycle_cut: boolean;
}

/** Узел дерева разделов сборки. */
export interface PublicationAssemblySection {
  thought_id: string;
  /**
   * Ключ локального порядка узла (`node_key` операции f6b242fe). Корневой
   * раздел адресуется id своей мысли, вложенный — id родительского ребра
   * вхождения. Совпадает с ключом, который принимает `PUT …/order`, поэтому
   * клиент переставляет разделы любого уровня, не зная рёбер графа.
   */
  node_key: string;
  /** Детерминированный якорь блока `pub-<shortid>`. */
  anchor: string;
  /** Уровень дерева, корень = 1. */
  level: number;
  /** Заголовок с номером (нумерация по настройке) или без. */
  heading: string;
  /** Предисловие — комментарий раздела, отрендеренный в HTML. */
  preamble_html: string;
  texts: PublicationAssemblyText[];
  extra: PublicationAssemblyExtraGroup[];
  flags: PublicationSectionFlags;
  children: PublicationAssemblySection[];
}

/** Исключённая мысль (для пометки в редакторе). */
export interface PublicationAssemblyExcluded {
  thought_id: string;
  title: string;
}

/** Мета пагинации по разделам верхнего уровня. */
export interface PublicationAssemblyMeta {
  page: number;
  per_page: number;
  total_roots: number;
  has_more: boolean;
}

/** Ответ сборки документа (`GET /publications/{id}/assembly`). */
export interface PublicationAssembly {
  publication: PublicationAssemblyTitle;
  sections: PublicationAssemblySection[];
  excluded: PublicationAssemblyExcluded[];
  warnings: string[];
  meta: PublicationAssemblyMeta;
}

/**
 * Маркер предупреждения сборки: отбор заголовков публикации пуст (ни одного
 * условия), поэтому сборка пустая, а не «вся сеть» (задача 7cfaba7c, п.2,
 * решение пользователя 2026-10-03). Общий маркер сервера (кладёт в `warnings`)
 * и клиента (по нему показывает пустое состояние документа): строка не должна
 * разъезжаться между сторонами.
 */
export const PUBLICATION_EMPTY_RECIPE_WARNING = 'отбор заголовков не задан';

/** Параметры сборки. */
export interface PublicationAssemblyQuery {
  /** Страница по разделам верхнего уровня (1-based). */
  page?: number;
  /** Для редактора — включить исключённые разделы (с пометками). */
  include_excluded?: boolean;
}

/**
 * Кандидат — мысль, вошедшая в отбор заголовков позже принятого состояния
 * публикации (временная семантика, задача e754527d; спека f9a20c3f).
 */
export interface PublicationCandidate {
  thought_id: string;
  title: string;
  type_id: string | null;
  /**
   * Путь в дереве сборки (заголовки разделов от корня до самого кандидата) —
   * «путь в дереве после вставки» элемента интерфейса 43ec961f. Пусто, если
   * кандидат в дерево не попадает (недостижимый раздел).
   */
  breadcrumbs: string[];
}

/** Ответ `GET /publications/{id}/candidates` (лимит + усечение, не ошибка). */
export interface PublicationCandidatesResult {
  items: PublicationCandidate[];
  /** Полное число кандидатов до пагинации. */
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

/** Роль мысли в публикации: раздел, текст или прямая ссылка свойством. */
export type PublicationUsageRole = 'section' | 'text' | 'direct';

/** Одно использование мысли в публикации (группа «Публикации»). */
export interface PublicationUsageItem {
  publication_id: string;
  title: string;
  role: PublicationUsageRole;
  /** Для роли `section` — хлебные крошки имён разделов (от корня). */
  breadcrumbs?: string[];
  /** Для роли `text` — название и id раздела, в котором мысль текст. */
  section_title?: string;
  section_thought_id?: string;
  /** Для роли `direct` — имя свойства типа «Публикация». */
  property?: string;
  /**
   * Якорь первого вхождения мысли в документе (`pub-<shortid>`) — цель
   * перехода с роли `section`/`text` (0.11.1, задача 3275fd8d). Совпадает с
   * `domId` блока; у повторных вхождений `domId` получает суффикс, поэтому
   * ведём к первому.
   */
  anchor?: string;
  /**
   * Номер страницы сборки (1-based; на сервере постранично —
   * `PUBLICATION_ASSEMBLY_PAGE_SIZE` = 20 корневых разделов), на которой
   * находится первое вхождение, — рабочая область открывается сразу на ней
   * (0.11.1, задача 3275fd8d). У роли `direct` раздела нет — поле отсутствует.
   */
  page?: number;
}

/** Ответ `GET /thoughts/{id}/publications` (лимит публикаций + усечение). */
export interface PublicationUsageResult {
  items: PublicationUsageItem[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

// ---------------------------------------------------------------------------
// Экспорт документа публикации (0.11.1, задача 6d87f1f2; операции 1f161c74 и
// 074d7a97; детерминизм a26135ad/06874c5d). Оба формата — zip-артефакт джобы.
// ---------------------------------------------------------------------------

/** Формат экспорта документа публикации: Markdown или самодостаточный HTML. */
export const PUBLICATION_EXPORT_FORMATS = ['md', 'html'] as const;
export type PublicationExportFormat = (typeof PUBLICATION_EXPORT_FORMATS)[number];

/** Тело `POST /networks/:networkId/publications/:id/export` (операция 1f161c74). */
export interface PublicationExportRequest {
  format: PublicationExportFormat;
  /** Копировать доступные серверу картинки-вложения в `assets/` (по умолчанию да). */
  with_assets?: boolean;
}

/** Тело `POST /networks/:networkId/publications/export-batch` (операция 074d7a97). */
export interface PublicationExportBatchRequest {
  /** Явный список публикаций; взаимоисключим с `active_only`. */
  ids?: string[];
  /** Все актуальные публикации сети. */
  active_only?: boolean;
  format: PublicationExportFormat;
  /** Копировать доступные серверу картинки-вложения в `assets/` (по умолчанию да). */
  with_assets?: boolean;
}

/** Итог обработки одной публикации в отчёте экспортной джобы. */
export const PUBLICATION_EXPORT_STATUSES = ['ok', 'skipped', 'error'] as const;
export type PublicationExportStatus = (typeof PUBLICATION_EXPORT_STATUSES)[number];

/** Одна запись отчёта джобы: публикация, её slug, статус и предупреждения. */
export interface PublicationExportEntry {
  publication_id: string;
  title: string;
  slug: string;
  status: PublicationExportStatus;
  /** Недоступные вложения и прочие нефатальные замечания сборки. */
  warnings: string[];
  /** Сообщение об ошибке при `status = 'error'`. */
  error?: string;
  /** Относительные пути файлов публикации внутри архива. */
  files?: string[];
}

/** Отчёт экспортной джобы публикаций (`ExportJob.report`). */
export interface PublicationExportReport {
  publications: PublicationExportEntry[];
  /** Сводные предупреждения, не привязанные к одной публикации. */
  warnings: string[];
}
