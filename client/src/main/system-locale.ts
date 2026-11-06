/**
 * Язык системного окружения → код каталога клиента (задача e6374cd1).
 *
 * Electron отдаёт упорядоченный список предпочтений ОС
 * (`app.getPreferredSystemLanguages()`, BCP-47). Первое значение сводится к
 * каталогу, который клиент точно знает: `en-*` → `en`, `zh-*` → `zh`, остальное
 * (в том числе `de-DE`, пустая строка, `null`) → исходный `ru`.
 *
 * Почему так: на первом запуске без `client_meta.lang` язык интерфейса —
 * стартовое отображение (ADR daab6ac4). Точное совпадение не требуется —
 * `en-US`, `en-GB`, `zh-Hans`, `zh-CN` должны попасть в свой каталог, а редкая
 * локаль без каталога деградирует на `ru` (сценарий b259ab45), а не оставляет
 * клиент без текстов.
 *
 * Функция чистая (без Electron) — проверяется юнит-тестами; вызов Electron
 * живёт в обработчике IPC (`system.preferredLanguage`).
 */

import type { ClientLanguage } from './ipc/contract.js';

/** Основные подтеги каталогов, поддерживаемые автодетектом. */
const SUPPORTED: readonly ClientLanguage[] = ['ru', 'en', 'zh'];

/**
 * Сводит предпочтение ОС к коду каталога: `en-US` → `en`, `zh-CN` → `zh`,
 * `de-DE`/`null` → `ru`. Регистр и разделитель `_` нормализуются.
 */
export function mapSystemLanguage(preferred: string | null | undefined): ClientLanguage {
  const tag = typeof preferred === 'string' ? preferred.trim().toLowerCase().replace(/_/g, '-') : '';
  if (tag === '') return 'ru';
  const primary = tag.split('-')[0] ?? '';
  return SUPPORTED.find((code) => code === primary) ?? 'ru';
}
