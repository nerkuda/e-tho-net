/**
 * Editor tab «Метаданные» (задача 04cd9794 «Вкладка Метаданные и колонки
 * автора в Хронике», 08-ui-spec.md §6.4).
 *
 * Read-only block listing the entity's authorship data:
 *  - id сущности (с копированием по клику);
 *  - имя автора создания (по `created_by` → кэш пользователей);
 *  - дата создания (по `created_at_ms`, секунды);
 *  - имя последнего редактора;
 *  - дата изменения (по `updated_at_ms`, секунды).
 *
 * For a not-yet-persisted entity (`ownerId` is null on the stub card) the id
 * field shows «будет присвоен при сохранении». For links the same shape is
 * used — link DTO also carries `created_by/updated_by/created_at_ms/
 * updated_at_ms` since the same authorship migration (033) covered it.
 */

import type { Link, Thought } from '@etn/shared';

import { buildMetadataBlock } from '../lib/metadata.js';
import { registerTabContent, type EditorContext } from './editor.js';

interface AuthorshipFields {
  id: string | null;
  createdAtMs: number | string | null;
  createdBy: string | null;
  updatedAtMs: number | string | null;
  updatedBy: string | null;
}

/**
 * Extracts authorship fields from a thought DTO. The DTO marks `created_by`
 * / `updated_by` / `created_at_ms` / `updated_at_ms` optional to keep the
 * 0.7.0 fixture clients compiling — values are always present after the
 * 033 migration, but treat absence as «unknown» rather than crashing.
 */
function thoughtFields(thought: Thought): AuthorshipFields {
  return {
    id: thought.id,
    createdAtMs: thought.created_at_ms ?? thought.created_at ?? null,
    createdBy: thought.created_by ?? null,
    updatedAtMs: thought.updated_at_ms ?? thought.updated_at ?? null,
    updatedBy: thought.updated_by ?? null,
  };
}

/** Same extraction for a link DTO. */
function linkFields(link: Link): AuthorshipFields {
  return {
    id: link.id,
    createdAtMs: link.created_at_ms ?? link.created_at ?? null,
    createdBy: link.created_by ?? null,
    updatedAtMs: link.updated_at_ms ?? link.updated_at ?? null,
    updatedBy: link.updated_by ?? null,
  };
}

/** Registers the «Метаданные» tab content builder. */
export function registerMetadataTab(): void {
  registerTabContent('metadata', buildMetadataTab);
}

/** Builds the tab pane for the current editor context. */
function buildMetadataTab(ctx: EditorContext): HTMLElement {
  const root = document.createElement('div');
  root.className = 'metadata-tab';
  // The not-yet-fetched target has no entity to describe — show the placeholder
  // so the user knows the tab is functional but there is nothing to display
  // until the entity arrives.
  if (ctx.ownerType === 'thought') {
    if (ctx.thought === null) {
      root.append(emptyState('Дождитесь загрузки мысли.'));
      return root;
    }
    root.append(buildMetadataBlock(thoughtFields(ctx.thought)));
    return root;
  }
  if (ctx.link === null) {
    root.append(emptyState('Дождитесь загрузки связи.'));
    return root;
  }
  root.append(buildMetadataBlock(linkFields(ctx.link)));
  return root;
}

function emptyState(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = text;
  return p;
}
