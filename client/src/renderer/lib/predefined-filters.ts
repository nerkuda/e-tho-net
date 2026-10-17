/**
 * Посев предопределённых наборов отборов (задача 347b307e «Предопределённые
 * наборы отборов (панели «Структур» и «Дневника»)», арбитраж оркестратора
 * 2026-10-14).
 *
 * Панель при ОТКРЫТИИ списка сохранённых отборов вызывает {@link seedPredefinedFilters}:
 * отсутствующие предопределённые наборы создаются, уже существующие (в том числе
 * переименованные пользователем) НЕ дублируются — сопоставление идёт ПО
 * КАНОНИЧНЫМ УСЛОВИЯМ ({@link canonicalFilterTree}), а не по имени. Канонизацию
 * даёт ридер панели: определение приводится к дереву редактора
 * (`readFilterDefinition` экрана), поэтому легаси-плоское определение
 * сравнивается наравне с AST.
 *
 * Модуль держится ЧИСТЫМ (никакого DOM/сети): решения о создании и о пометке
 * «предопределённый» вычисляются по уже прочитанному списку строк, а исполнение
 * (REST-вызовы) остаётся панели. Так посев проверяем поведенческим тестом без
 * стенда.
 *
 * Поведение при удалении пользователем: набор пропадёт из списка до следующего
 * ОТКРЫТИЯ списка — посев восстанавливает его по букве постановки («добавлять
 * отсутствующие»). Это задокументировано в спеке панелей.
 */

import { duplicateFilterName } from './pure.js';

/** Предопределённый набор: имя заказчика и определение в форме ЗАПИСИ вида. */
export interface PredefinedFilter {
  /** Имя набора (формулировка заказчика, без правок). */
  name: string;
  /** Определение в форме записи вида (`FilterAst` либо `{ ast, order }`). */
  definition: unknown;
}

/** Строка сохранённого отбора вида (минимально нужное посеву). */
export interface PredefinedExistingRow {
  id: string;
  name: string;
  definition: unknown;
}

/** Функция канонизации определения в строку условий (ридер панели). */
export type DefinitionCanonicalizer = (definition: unknown) => string;

/** Канонизация с защитой: нечитаемое определение не роняет посев. */
function safeCanonical(canonicalOf: DefinitionCanonicalizer, definition: unknown): string {
  try {
    return canonicalOf(definition);
  } catch {
    return '';
  }
}

/**
 * Наборы, которых ещё нет среди строк: определяет отсутствие по каноничным
 * условиям и подбирает СВОБОДНОЕ имя (конфликт имени с чужим отбором —
 * `duplicateFilterName`, не падение: UNIQUE `(user, view, name)`).
 *
 * Набор с ПУСТЫМИ условиями (канон — пустая строка) сопоставлению не подлежит.
 */
export function predefinedFiltersToCreate(
  presets: readonly PredefinedFilter[],
  existing: readonly PredefinedExistingRow[],
  canonicalOf: DefinitionCanonicalizer,
): PredefinedFilter[] {
  const existingCanon = new Set<string>();
  for (const row of existing) {
    const canonical = safeCanonical(canonicalOf, row.definition);
    if (canonical !== '') existingCanon.add(canonical);
  }
  const names = existing.map((row) => row.name);
  const out: PredefinedFilter[] = [];
  for (const preset of presets) {
    const canonical = safeCanonical(canonicalOf, preset.definition);
    if (canonical !== '' && existingCanon.has(canonical)) continue;
    const taken = names.some((name) => name.toLowerCase() === preset.name.toLowerCase());
    const name = taken ? duplicateFilterName(preset.name, names) : preset.name;
    names.push(name);
    out.push({ name, definition: preset.definition });
  }
  return out;
}

/**
 * Идентификаторы строк, условия которых совпадают с предопределённым набором —
 * метка «предопределённый» в списке (минимальная пометка без новых паттернов
 * дизайн-системы). Помета по УСЛОВИЯМ: строка, чьи условия совпали с каноном
 * набора, показывается предопределённой независимо от имени.
 */
export function predefinedFilterIds(
  presets: readonly PredefinedFilter[],
  rows: readonly PredefinedExistingRow[],
  canonicalOf: DefinitionCanonicalizer,
): Set<string> {
  const presetCanon = new Set<string>();
  for (const preset of presets) {
    const canonical = safeCanonical(canonicalOf, preset.definition);
    if (canonical !== '') presetCanon.add(canonical);
  }
  const ids = new Set<string>();
  if (presetCanon.size === 0) return ids;
  for (const row of rows) {
    const canonical = safeCanonical(canonicalOf, row.definition);
    if (canonical !== '' && presetCanon.has(canonical)) ids.add(row.id);
  }
  return ids;
}
