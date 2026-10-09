/**
 * Команды «Вставить ссылку на мысль» и «Вставить трансклюзию мысли» (ТЗ5
 * «Дневник без псевдослота», версия 0.12.1).
 *
 * Обе команды живут в контекстном меню поля комментария рядом с «Вставить
 * ссылку на публикацию…» и открывают общий диалог поиска/создания мысли
 * (`pickThoughtsDialog`, `allowCreate`). После выбора в позицию каретки
 * вставляется ссылка `[[#<id>|<имя>]]` либо трансклюзия мысли; несколько
 * выбранных мыслей вставляются последовательно.
 *
 * Создание НОВОЙ мысли в диалоге: её родителями становятся ВСЕ мысли-владельцы
 * редактируемого комментария — цели-чипсы дневниковой записи либо владелец
 * обычного комментария (расширение модели `wiki-link-create`, карточка
 * 34ffbd75). Список владельцев приходит универсально через контекст команды
 * ({@link CommentCommandContext.getCommentParents}); без контекста комментария
 * команды недоступны.
 *
 * Конструкция трансклюзии — только {@link formatTransclusionRef} из
 * `@etn/markdown` (единый дом конструкции, сторож
 * `own-transclusion-outside-package`). Сеть и диалог спрятаны за портом
 * {@link CommentThoughtInsertPort}: юнит-тесты подменяют его и проверяют
 * вставку/родителей/отмену без сервера и DOM-диалога.
 */

import { formatTransclusionRef } from '@etn/markdown';

import { requireNetworkId } from '../app.js';
import { errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { menuAction, type MenuItem } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import {
  registerCommentCommand,
  runCommentCommand,
  type CommentCommandContext,
  type CommentCommandHost,
  type CommentOwnerRef,
} from './comment-commands.js';

/** Идентификатор команды «Вставить ссылку на мысль». */
export const INSERT_THOUGHT_LINK_COMMAND = 'comment.insertThoughtLink';

/** Идентификатор команды «Вставить трансклюзию мысли». */
export const INSERT_THOUGHT_TRANSCLUSION_COMMAND = 'comment.insertThoughtTransclusion';

/** Форма вставляемой конструкции: ссылка или трансклюзия. */
export type ThoughtInsertKind = 'link' | 'transclusion';

/* ------------------------------------------------------------------ *
 * Чистые преобразования (основа юнит-тестов).
 * ------------------------------------------------------------------ */

/** Ссылка на мысль по id: `[[#<id>|<имя>]]` (имя пустое — без алиаса). */
export function thoughtLinkRef(id: string, title: string): string {
  const name = title.trim();
  return name === '' ? `[[#${id}]]` : `[[#${id}|${name}]]`;
}

/** Трансклюзия мысли (единый дом — `@etn/markdown`). */
export function thoughtTransclusionRef(id: string): string {
  return formatTransclusionRef(id);
}

/**
 * Собирает итоговую вставку из ссылок на выбранные мысли: ссылки — через
 * запятую (как вставка мыслей из буфера, `buildCommentPasteLinks`),
 * трансклюзии — блоки, разделённые переводом строки.
 */
export function joinThoughtRefs(refs: readonly string[], kind: ThoughtInsertKind): string {
  return refs.join(kind === 'transclusion' ? '\n' : ', ');
}

/** Доступны ли команды для поля: есть владелец-мысль или список владельцев. */
export function commentThoughtInsertDisabled(host: CommentCommandHost): boolean {
  const owner = host.getCommentOwner?.() ?? null;
  const parents = host.getCommentParents?.() ?? null;
  return owner === null && (parents === null || parents.length === 0);
}

/* ------------------------------------------------------------------ *
 * Порт вставки (тестовый шов).
 * ------------------------------------------------------------------ */

/** Разрешённые родители новой мысли и заголовок для якоря диалога. */
export interface ThoughtInsertParents {
  /** Идентификаторы мыслей-родителей (в порядке приоритета). */
  ids: string[];
  /** Первичный родитель — якорь диалога. */
  primaryId: string;
  primaryTitle: string;
}

/** Сеть и диалог для команд вставки. Разделено по шагам сценария. */
export interface CommentThoughtInsertPort {
  /**
   * Родители новой мысли: явный список из контекста (цели-чипсы записи) либо
   * вывод из владельца комментария (мысль; для связи — её источник).
   * `null` — родителя нет.
   */
  resolveParents(
    hint: readonly string[] | null,
    owner: CommentOwnerRef | null,
  ): Promise<ThoughtInsertParents | null>;
  /** Открывает диалог выбора/создания мысли; `null` — отменено. */
  pick(input: { anchorId: string; anchorTitle: string }): Promise<PickResultLike | null>;
  /** Канонический заголовок существующей мысли (для алиаса ссылки). */
  thoughtTitle(id: string): Promise<string>;
  /** Создаёт мысль (без комментария). */
  create(input: {
    title: string;
    synonyms: readonly string[];
    typeId: string | null;
  }): Promise<{ id: string; title: string }>;
  /** Делает перечисленные мысли родителями новой (структурные рёбра). */
  linkParents(newId: string, parentIds: readonly string[]): Promise<void>;
}

/**
 * Минимальный срез результата диалога, нужный вставке (совпадает с
 * `ThoughtPickResult` из `canvas/add-dialog.ts`). Собственный тип разрывает
 * статическую зависимость на модуль диалога (`add-dialog` → canvas → editor →
 * comments → markdown-field — цикл); сам диалог грузится динамически.
 */
export interface PickResultLike {
  items: Array<
    | { kind: 'existing'; id: string }
    | { kind: 'new'; title: string; synonyms: string[] }
  >;
  thoughtTypeId: string | null;
}

let insertPort: CommentThoughtInsertPort | null = null;

/** Подменяет порт вставки (тестовый шов); `null` — системный порт. */
export function setCommentThoughtInsertPort(port: CommentThoughtInsertPort | null): void {
  insertPort = port;
}

/** Действующий порт вставки. */
export function commentThoughtInsertPort(): CommentThoughtInsertPort {
  return insertPort ?? restInsertPort();
}

/** Мысль-родитель для владельца-связи: её источник (как в `wiki-link-create`). */
async function ownerThoughtId(networkId: string, owner: CommentOwnerRef): Promise<string> {
  if (owner.ownerType === 'thought') return owner.ownerId;
  const link = await etn.links.get(networkId, owner.ownerId);
  return link.source_id;
}

/** Системный порт: сеть через `etn`, диалог — динамический импорт. */
function restInsertPort(): CommentThoughtInsertPort {
  return {
    async resolveParents(hint, owner) {
      const networkId = requireNetworkId();
      const ids: string[] = [];
      for (const id of hint ?? []) {
        if (id !== '' && !ids.includes(id)) ids.push(id);
      }
      if (ids.length === 0 && owner !== null) {
        const id = await ownerThoughtId(networkId, owner);
        if (id !== '' && !ids.includes(id)) ids.push(id);
      }
      if (ids.length === 0) return null;
      const primaryId = ids[0]!;
      const thought = await etn.thoughts.get(networkId, primaryId);
      return { ids, primaryId, primaryTitle: thought.title };
    },
    async pick({ anchorId, anchorTitle }) {
      // Динамический импорт: `add-dialog` тянет canvas→editor→comments→
      // markdown-field, статическая связь замкнула бы цикл модулей.
      const { pickThoughtsDialog } = await import('../canvas/add-dialog.js');
      return pickThoughtsDialog({
        networkId: requireNetworkId(),
        anchor: { id: anchorId, direction: 'child' },
        anchorTitle,
        allowCreate: true,
        allowLinkType: false,
      });
    },
    async thoughtTitle(id) {
      return (await etn.thoughts.get(requireNetworkId(), id)).title;
    },
    async create({ title, synonyms, typeId }) {
      const created = await etn.thoughts.create(requireNetworkId(), {
        title,
        synonyms: [...synonyms],
        type_id: typeId,
      });
      return { id: created.id, title: created.title };
    },
    async linkParents(newId, parentIds) {
      if (parentIds.length === 0) return;
      await etn.thoughts.batch(requireNetworkId(), {
        ids: [newId],
        op: 'link_parents',
        args: { parent_ids: [...parentIds], link_type_id: null },
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * Тела команд.
 * ------------------------------------------------------------------ */

/**
 * Открывает диалог и вставляет ссылки/трансклюзии в позицию каретки. Экспорт —
 * тело команды и тестовый шов (await-проверка без DOM-диалога).
 */
export async function runCommentThoughtInsert(
  ctx: CommentCommandContext,
  kind: ThoughtInsertKind,
): Promise<void> {
  const owner = ctx.getCommentOwner();
  const hint = ctx.getCommentParents();
  if (owner === null && (hint === null || hint.length === 0)) return;
  const port = commentThoughtInsertPort();
  try {
    const parents = await port.resolveParents(hint, owner);
    if (parents === null) {
      notice(`${t('comment.create.error')}: ${t('comment.create.noParent')}`, 'error');
      return;
    }
    const result = await port.pick({ anchorId: parents.primaryId, anchorTitle: parents.primaryTitle });
    if (result === null) return; // отмена — ничего не меняется
    const refs: string[] = [];
    let failed = 0;
    for (const item of result.items) {
      try {
        if (item.kind === 'existing') {
          const title = await port.thoughtTitle(item.id);
          refs.push(kind === 'transclusion' ? thoughtTransclusionRef(item.id) : thoughtLinkRef(item.id, title));
        } else {
          const created = await port.create({
            title: item.title,
            synonyms: item.synonyms,
            typeId: result.thoughtTypeId,
          });
          // Родители новой мысли — ВСЕ мысли-владельцы комментария (ТЗ5).
          await port.linkParents(created.id, parents.ids);
          refs.push(
            kind === 'transclusion' ? thoughtTransclusionRef(created.id) : thoughtLinkRef(created.id, created.title),
          );
        }
      } catch {
        failed++;
      }
    }
    if (failed > 0) {
      notice(`${t('comment.create.error')}: ${failed}`, 'error');
    }
    if (refs.length === 0) return;
    const insert = joinThoughtRefs(refs, kind);
    const snap = ctx.editor.snapshot();
    ctx.editor.applyEdit({
      changes: { from: snap.to, to: snap.to, insert },
      selection: { anchor: snap.to + insert.length },
    });
  } catch (err) {
    notice(`${t('comment.create.error')}: ${errText(err)}`, 'error');
  }
}

/**
 * Пункты контекстного меню рядом с «Вставить ссылку на публикацию…»: обе
 * команды ТЗ5. Без контекста комментария (нечего дать в родители) — недоступны.
 */
export function commentThoughtInsertMenuItems(host: CommentCommandHost): MenuItem[] {
  const disabled = commentThoughtInsertDisabled(host);
  return [
    menuAction(t('comment.cmd.insertThoughtLink'), () => {
      runCommentCommand(INSERT_THOUGHT_LINK_COMMAND, host);
    }, { disabled }),
    menuAction(t('comment.cmd.insertThoughtTransclusion'), () => {
      runCommentCommand(INSERT_THOUGHT_TRANSCLUSION_COMMAND, host);
    }, { disabled }),
  ];
}

/** Регистрирует тела команд (идемпотентно). */
export function installCommentThoughtInsertCommands(): void {
  registerCommentCommand(INSERT_THOUGHT_LINK_COMMAND, {
    run: (ctx) => {
      void runCommentThoughtInsert(ctx, 'link');
      return true;
    },
  });
  registerCommentCommand(INSERT_THOUGHT_TRANSCLUSION_COMMAND, {
    run: (ctx) => {
      void runCommentThoughtInsert(ctx, 'transclusion');
      return true;
    },
  });
}

// Самоустановка при загрузке модуля: команды доступны полю без явного вызова
// (модуль подключается боковым импортом из `markdown-field.ts`).
installCommentThoughtInsertCommands();
