/**
 * Thought-type views (отборы типов мыслей) DTOs.
 *
 * Хранятся в ветвимой таблице `thought_type_views` (миграция 037; тех.проект
 * 918833e3 «Отборы для типов мыслей», задача 5361aa33 «Хранение отборов
 * типов», задача 17eb741e «Домен отборов типа»). Поле `definition` хранится
 * как JSON-строка того же формата, что и `saved_filters.definition`
 * (`SavedFilterDefinition` + `sort`/`order`, structure.ts).
 *
 * Доменные правила:
 *   * требование 141c2576 — имя уникально в пределах одного типа мысли
 *     (`name_key`, регистронезависимо); совпадение с именем отбора предка —
 *     переопределение, а не дубль;
 *   * требование 7263e565 — у одного типа не более одного `is_default = true`;
 *     перенос пометки идёт транзакционно (домен 17eb741e);
 *   * требование eaca1253 — эффективный набор собирается по цепочке типов от
 *     корня, одноимённый (по `name_key`, регистронезависимо) отбор потомка
 *     перекрывает предка целиком (`defined_on` остаётся у потомка, но визуально
 *     и функционально это новая сущность);
 *   * требование 23e0f78e — у мысли без типа действуют отборы корневого типа;
 *     добавлять новый отбор с холста для неё нельзя (UI-правило).
 */

import type { SavedFilterDefinition } from './structure.js';

/** Имя отбора уникально в пределах одного типа мысли (требование 141c2576). */
export const THOUGHT_TYPE_VIEW_NAME_MAX = 200;

/** Описание отбора — необязательный комментарий, до 1000 символов. */
export const THOUGHT_TYPE_VIEW_DESCRIPTION_MAX = 1000;

/**
 * Один отбор типа мысли (table `thought_type_views`).
 *
 * Зеркало контракта миграции 037 за вычетом ветвимых служебных колонок
 * (`layer_id`/`deleted`/`base_version`/`pk`). `definition` приходит как
 * JSON-строка; на клиенте распарсивается в {@link ThoughtTypeViewDefinition}.
 */
export interface ThoughtTypeView {
  id: string;
  /** Логический id типа мысли-владельца (`thought_type_id` в таблице). */
  thought_type_id: string;
  /** Видимое имя (1..200 символов). */
  name: string;
  /** Нормализованное имя (trim + lowercase) — по нему сравниваются дубль и перекрытие. */
  name_key: string;
  /** Описание (подсказка и контекст для агентов). `null` — нет описания. */
  description: string | null;
  /** JSON-строка определения отбора. */
  definition: string;
  /** Порядок отображения кнопки внутри типа (требование eaca1253). */
  position: number;
  /** `true` — отбор открывается сам при переводе мысли в фокус (требование 7263e565). */
  is_default: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
}

/** Тело запроса создания отбора (REST: `POST /thought-types/{id}/views`). */
export interface ThoughtTypeViewInput {
  name: string;
  description?: string | null;
  /**
   * JSON-строка определения отбора (`SavedFilterDefinition`). Валидация
   * синтаксиса JSON — на домене (17eb741e); токены и полная валидация —
   * отдельный этап 20b2fca0.
   */
  definition: string;
  position?: number;
  is_default?: boolean;
}

/** Тело запроса правки отбора (`PATCH /thought-types/{id}/views/{view_id}`). */
export interface ThoughtTypeViewUpdateInput {
  name?: string;
  description?: string | null;
  definition?: string;
  position?: number;
  is_default?: boolean;
}

/**
 * Распарсенное определение отбора (`definition` после `JSON.parse`).
 *
 * Синоним {@link SavedFilterDefinition} — формат таблицы унаследован от
 * `saved_filters.definition` (`StructureFilter` + `sort`/`order`).
 */
export type ThoughtTypeViewDefinition = SavedFilterDefinition;

/**
 * Один отбор в эффективном наборе (требование eaca1253). Содержит пометку
 * `defined_on` (id типа, на котором этот отбор определён) — нужно клиенту,
 * чтобы показать, откуда отбор взят, и серверу — чтобы в MCP-ответе
 * `etn.views.run` сообщить источник.
 */
export interface EffectiveThoughtTypeView extends ThoughtTypeView {
  /**
   * Id типа мысли, на котором отбор определён. Может совпадать с
   * `thought_type_id` самой мысли (если отбор свой) либо быть id
   * типа-предка (если отбор унаследован и не перекрыт).
   */
  defined_on: string;
  /**
   * `false` — отбор определён на типе самой мысли; `true` — унаследован
   * от типа-предка. Симметрия с {@link EffectiveTypeProperty.inherited}.
   */
  inherited: boolean;
}
