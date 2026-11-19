/**
 * Кликабельные чекбоксы задач в режиме ПРОСМОТРА комментария (0.16.1, задача
 * `cfb8cb72`, пункт 8; спека `0e85b66e`).
 *
 * **Что было.** Единый рендерер `@etn/markdown` отдаёт чекбокс задачи тем же
 * markup, что и сервер (чекбокс с атрибутом `disabled`), поэтому в просмотре
 * `body_html` чекбокс был ИНДИКАТОРОМ состояния: клик по нему ничего не делал
 * (отключённый контрол не шлёт `click`).
 *
 * **Что стало.** Просмотр записи/постоянного комментария делает чекбоксы
 * живыми: клик переключает `- [ ]` ↔ `- [x]` В ТЕКСТЕ источника
 * (`body_md` → `etn.comments.update`), а не только вид индикатора. Панели
 * («Задачи»/«Напоминания») на это отвечают штатным маркером «Обновить»: запись
 * публикует `comment.updated`, и чужое для панели событие поднимает маркер —
 * отдельной проводки из просмотра не нужно.
 *
 * **Адресация.** N-й чекбокс DOM соответствует N-й строке с чек-боксом по
 * `parseTaskLines` (`hasCheckbox`, номера строк 1-based). Разбор — та же
 * грамматика, что и просмотр (`@etn/markdown`), поэтому code fence и `- [ ]` в
 * середине строки чекбоксом не считаются и адресация не съезжает. Число
 * чекбоксов в DOM и в разборе обязано совпасть: не совпало — клик ничего не
 * делает (лучше no-op, чем правка чужой строки).
 */

import { parseTaskLines } from '@etn/markdown';
import type { Comment } from '@etn/shared';

import { requireNetworkId } from '../lib/network-id.js';
import { errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { notice } from '../lib/notice.js';
import { replaceTaskLine, setChecklistLineDone } from '../lib/ui/task-panel-model.js';

/** Класс живого чекбокса просмотра (адрес CSS: курсор-указатель). */
export const LIVE_TASK_CHECKBOX_CLASS = 'ui-task-checkbox-live';

/**
 * Селектор контрола чекбокса. В `body_html` комментария единственные `input` —
 * чекбоксы задач единого рендерера (произвольный HTML очищен сервером),
 * поэтому фильтр по типу точен и не дублирует разметку пакета.
 */
const CHECKBOX_SELECTOR = 'input';

/** Источник правки для живых чекбоксов просмотра. */
export interface TaskCheckboxSource {
  /** Комментарий, чей `body_md` правится; `null` — править нечего. */
  commentId: string | null;
  /**
   * Сохранено: новый `body_md`, HTML, который отдал сервер, и сам обновлённый
   * комментарий. Владелец просмотра обновляет свой снапшот точечно —
   * перерисовывать весь просмотр не нужно (чекбокс уже показывает новое
   * состояние), а лента «Дневника» обязана сохранить прокрутку (0.16.1,
   * уточнение 2026-11-19, пункт 9).
   */
  onSaved?(md: string, html: string, comment: Comment): void;
  /**
   * Начало СВОЕЙ записи в источник: владелец просмотра помечает правку
   * «в полёте» и гасит её realtime-эхо. Сервер публикует `comment.updated`
   * ДО ответа PATCH, поэтому без метки эхо могло прийти раньше ответа и
   * перерисовать просмотр (сброс прокрутки — пункт 2 пачки 3).
   * Возвращает освобождение метки; вызывается и при ошибке записи.
   */
  beginSave?(commentId: string): () => void;
}

/** Узел — чекбокс задачи (обход предков вручную: `closest` шима с родителя). */
function taskCheckboxOf(node: EventTarget | null): HTMLInputElement | null {
  let current = node as HTMLElement | null;
  while (current !== null) {
    if (current.tagName?.toLowerCase() === 'input') {
      const box = current as unknown as HTMLInputElement;
      if (box.type === 'checkbox') return box;
    }
    current = current.parentElement ?? null;
  }
  return null;
}

/**
 * Подключить живые чекбоксы внутри просмотра `host`. `source` — геттер
 * источника: он вызывается в момент КЛИКА (id комментария появляется позже
 * сборки просмотра, например у записи до дочитывания). Возвращает функцию
 * отключения (снимает слушатель).
 */
export function wireTaskCheckboxes(
  host: HTMLElement,
  source: () => TaskCheckboxSource | null,
): () => void {
  /** Чекбоксы просмотра в порядке документа. */
  const checkboxes = (): HTMLInputElement[] =>
    Array.from(host.querySelectorAll<HTMLInputElement>(CHECKBOX_SELECTOR)).filter(
      (box) => box.type === 'checkbox',
    );

  // Отключённый вендорский контрол не шлёт `click`, поэтому просмотр делает
  // чекбоксы живыми: снимаем `disabled` и помечаем классом (CSS — курсор).
  const activate = (box: HTMLInputElement): void => {
    if (box.disabled) box.disabled = false;
    box.removeAttribute('disabled');
    box.classList.add(LIVE_TASK_CHECKBOX_CLASS);
  };
  for (const box of checkboxes()) activate(box);

  const onClick = (event: Event): void => {
    const box = taskCheckboxOf(event.target);
    if (box === null || !host.contains(box)) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceRef = source();
    const commentId = sourceRef?.commentId ?? null;
    if (sourceRef === null || commentId === null) return;
    const boxes = checkboxes();
    const index = boxes.indexOf(box);
    if (index < 0) return;
    const want = box.checked;
    void applyToggle(commentId, index, want, sourceRef);
  };

  /**
   * Переключить N-ю строку с чек-боксом источника. Вид чекбокса ставится сразу
   * (отклик), при отказе — откатывается.
   */
  async function applyToggle(
    commentId: string,
    index: number,
    want: boolean,
    sourceRef: TaskCheckboxSource,
  ): Promise<void> {
    const networkId = requireNetworkId();
    const boxes = checkboxes();
    const box = boxes[index];
    if (box === undefined) return;
    // Метка СВОЕЙ записи — ДО сетевого вызова: эхо `comment.updated` может
    // прийти раньше ответа PATCH и не должно считаться внешним изменением.
    const releaseSave = sourceRef.beginSave?.(commentId);
    try {
      const comment = await etn.comments.get(networkId, commentId);
      const checkLines = parseTaskLines(comment.body_md).filter((line) => line.hasCheckbox);
      const target = checkLines[index];
      if (target === undefined || checkLines.length !== boxes.length) {
        // Просмотр и источник разошлись (html от другой ревизии): не правим
        // наугад — состояние контрола возвращается к снапшоту.
        if (box !== undefined) box.checked = !want;
        return;
      }
      const lines = comment.body_md.split('\n');
      const rawLine = lines[target.lineNo - 1];
      if (rawLine === undefined) {
        box.checked = !want;
        return;
      }
      const next = setChecklistLineDone(rawLine, want);
      if (next === null) {
        box.checked = !want;
        return;
      }
      if (next === rawLine) return;
      const bodyMd = replaceTaskLine(comment.body_md, target.lineNo - 1, next);
      if (bodyMd === null) {
        box.checked = !want;
        return;
      }
      const updated = await etn.comments.update(
        networkId,
        commentId,
        { body_md: bodyMd },
        comment.version,
      );
      // Нативный клик отменён (`preventDefault` в `onClick`), поэтому браузер
      // вернул контрол в прежнее состояние — успешную отметку фиксируем на узле
      // сами. Это ТОЧЕЧНОЕ обновление: DOM просмотра (и прокрутка длинного
      // комментария) не пересобирается — пункт 2 пачки 3.
      box.checked = want;
      sourceRef.onSaved?.(bodyMd, updated.body_html, updated);
    } catch (err) {
      box.checked = !want;
      notice(t('tasks.errorEdit', [errText(err)]), 'error');
    } finally {
      releaseSave?.();
    }
  }

  host.addEventListener('click', onClick);
  return () => host.removeEventListener('click', onClick);
}
