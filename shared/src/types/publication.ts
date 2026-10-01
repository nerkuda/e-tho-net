/**
 * DTO подсистемы «Публикации» (0.11.1, задача 8178e007; тех.проект c5261d02,
 * каталог «Публикации»; сущности bc147b40, 18f3bebf, e6aeb7ba, f0a51091).
 *
 * Публикация — живой документ из мыслесети: заголовки разделов и тексты
 * собираются из мыслей по рецептам; контент не дублируется, правка текста в
 * публикации — правка самой мысли. Здесь описана только МОДЕЛЬ публикации
 * (карточка, порядок, исключения, полки) без сборки документа (задача
 * 34119c67).
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
