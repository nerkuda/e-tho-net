/**
 * Пользовательский текст неразрешённого токена AST по machine-readable
 * `reason` (ADR daab6ac4, п. 4): серверный `message` английский и не
 * показывается, причина определяется только по коду.
 *
 * Один помощник на все поверхности, которые показывают `unresolved`:
 * редактор отбора (`lib/filter-diagnostics.ts`) и строка поиска
 * (`search/search.ts`). Своя копия switch'а разъехалась бы с серверными
 * причинами.
 */

import { t } from './i18n.js';

/** Текст причины неразрешённого токена; неизвестная причина — общий текст. */
export function tokenIssueMessage(token: string, reason: string): string {
  switch (reason) {
    case 'unknown_token':
      return t('filterDiagnostics.server.tokenUnknown', token);
    case 'time_context_required':
      return t('filterDiagnostics.server.tokenTimeContext', token);
    case 'incompatible_operation':
      return t('filterDiagnostics.server.tokenIncompatible');
    case 'unknown_property':
      return t('filterDiagnostics.server.tokenUnknownProperty');
    case 'empty_value':
      return t('filterDiagnostics.server.tokenEmptyValue');
    default:
      return t('filterDiagnostics.server.tokenUnresolved', token);
  }
}
