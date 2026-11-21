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
 *
 * **Трансклюзии** (0.16.1, пачка 6, пункт 3). Чекбокс внутри развёрнутой
 * трансклюзии принадлежит не владельцу просмотра, а ИСТОЧНИКУ трансклюзии:
 * клик правит строку его постоянного комментария. Адрес берётся у блока
 * (`data-transclusion-source` — id мысли-источника, `data-transclusion-section`
 * — имя раздела, если ссылка адресовала раздел), а индекс считается по
 * чекбоксам ЭТОГО блока (контролы вложенных трансклюзий не в счёт). Тело
 * правится в пределах показанного фрагмента — всего `body_md` или извлечённого
 * раздела (`extractSection`), — поэтому строки за пределами раздела целы. Если
 * адрес построить нельзя (нет источника/раздела, числа разошлись), клик —
 * безопасный no-op с откатом контрола.
 *
 * В режиме ПРАВКИ статический блок трансклюзии чекбоксов этим модулем не
 * обслуживается: клик по нему — вход в правку блока (вложенный редактор правит
 * свой буфер), см. `mdWidgetMouseDown`.
 */

import {
  extractSection,
  parseTaskLines,
  TRANSCLUSION_SECTION_ATTR,
  TRANSCLUSION_SOURCE_ATTR,
} from '@etn/markdown';
import type { Comment } from '@etn/shared';

import { requireNetworkId } from '../lib/network-id.js';
import { errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { notice } from '../lib/notice.js';
import {
  LIVE_TASK_CHECKBOX_CLASS,
  replaceTaskLine,
  setChecklistLineDone,
} from '../lib/ui/task-panel-model.js';

/** Класс живого чекбокса просмотра (адрес CSS: курсор-указатель). */
export { LIVE_TASK_CHECKBOX_CLASS };

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
 * Блок трансклюзии, внутри которого лежит узел (`null` — вне трансклюзий).
 * Возвращается БЛИЖАЙШАЯ обёртка: у вложенной трансклюзии контрол принадлежит
 * её источнику, а не внешнему.
 */
function transclusionBlockOf(node: EventTarget | null): HTMLElement | null {
  let current = node as HTMLElement | null;
  while (current !== null) {
    if (current.hasAttribute?.(TRANSCLUSION_SOURCE_ATTR) === true) return current;
    current = current.parentElement ?? null;
  }
  return null;
}

/**
 * Чекбоксы САМОГО блока трансклюзии — без контролов вложенных блоков: у них
 * свои источники, и в адресации внешнего они не участвуют.
 */
function blockCheckboxes(block: HTMLElement): HTMLInputElement[] {
  return Array.from(block.querySelectorAll<HTMLInputElement>(CHECKBOX_SELECTOR)).filter(
    (box) => box.type === 'checkbox' && transclusionBlockOf(box) === block,
  );
}

/**
 * Фрагмент источника, который показывает блок трансклюзии, и его смещение в
 * теле: весь `body_md` либо извлечённый раздел ВМЕСТЕ с заголовком — ровно так
 * его разворачивает `expandTransclusions`. `null` — раздела в теле нет.
 */
function transclusionFragment(
  body: string,
  section: string | null,
): { text: string; start: number } | null {
  if (section === null) return { text: body, start: 0 };
  const text = extractSection(body, section);
  if (text === null) return null;
  const start = body.indexOf(text);
  return start < 0 ? null : { text, start };
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
  /** Чекбоксы просмотра в порядке документа (включая контролы трансклюзий). */
  const allCheckboxes = (): HTMLInputElement[] =>
    Array.from(host.querySelectorAll<HTMLInputElement>(CHECKBOX_SELECTOR)).filter(
      (box) => box.type === 'checkbox',
    );

  /**
   * Чекбоксы САМОГО комментария владельца: контролы блоков трансклюзий из
   * адресации исключены (они правят свои источники — пачка 6, пункт 3), иначе
   * N-й контрол DOM не совпал бы с N-й строкой `body_md` владельца.
   */
  const ownerCheckboxes = (): HTMLInputElement[] =>
    allCheckboxes().filter((box) => transclusionBlockOf(box) === null);

  // Отключённый вендорский контрол не шлёт `click`, поэтому просмотр делает
  // чекбоксы живыми: снимаем `disabled` и помечаем классом (CSS — курсор).
  const activate = (box: HTMLInputElement): void => {
    if (box.disabled) box.disabled = false;
    box.removeAttribute('disabled');
    box.classList.add(LIVE_TASK_CHECKBOX_CLASS);
  };
  for (const box of allCheckboxes()) activate(box);

  const onClick = (event: Event): void => {
    const box = taskCheckboxOf(event.target);
    if (box === null || !host.contains(box)) return;
    event.preventDefault();
    event.stopPropagation();
    const want = box.checked;
    // Чекбокс внутри трансклюзии правит ИСТОЧНИК, а не комментарий владельца
    // просмотра (0.16.1, пачка 6, пункт 3).
    const block = transclusionBlockOf(box);
    if (block !== null) {
      void applyTransclusionToggle(block, box, want);
      return;
    }
    const sourceRef = source();
    const commentId = sourceRef?.commentId ?? null;
    if (sourceRef === null || commentId === null) return;
    const boxes = ownerCheckboxes();
    const index = boxes.indexOf(box);
    if (index < 0) return;
    void applyToggle(commentId, index, want, sourceRef);
  };

  /**
   * Переключить строку внутри блока трансклюзии: адресация — по атрибутам блока
   * (комментарий-источник + раздел) и по номеру чекбокса внутри него. Вид
   * контрола ставится сразу, при отказе построения адреса или записи —
   * откатывается (лучше no-op, чем правка чужой строки).
   */
  async function applyTransclusionToggle(
    block: HTMLElement,
    box: HTMLInputElement,
    want: boolean,
  ): Promise<void> {
    const sourceId = block.getAttribute(TRANSCLUSION_SOURCE_ATTR);
    const section = block.getAttribute(TRANSCLUSION_SECTION_ATTR);
    const boxes = blockCheckboxes(block);
    const index = boxes.indexOf(box);
    if (sourceId === null || index < 0) {
      box.checked = !want;
      return;
    }
    const networkId = requireNetworkId();
    try {
      // Источник трансклюзии — ПОСТОЯННЫЙ комментарий мысли-источника.
      const comments = await etn.comments.list(networkId, 'thought', sourceId);
      const permanent = comments.find((comment) => comment.kind === 'permanent');
      if (permanent === undefined) {
        box.checked = !want;
        return;
      }
      const fragment = transclusionFragment(permanent.body_md, section);
      const checkLines =
        fragment === null ? [] : parseTaskLines(fragment.text).filter((line) => line.hasCheckbox);
      const target = checkLines[index];
      // Число чекбоксов раздела и блока обязано совпасть: разошлось — адрес
      // неоднозначен, клик молчит.
      if (fragment === null || target === undefined || checkLines.length !== boxes.length) {
        box.checked = !want;
        return;
      }
      const lines = fragment.text.split('\n');
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
      lines[target.lineNo - 1] = next;
      // Заменяется ровно показанный фрагмент: строки источника за пределами
      // раздела (когда ссылка адресовала раздел) остаются нетронутыми.
      const bodyMd =
        permanent.body_md.slice(0, fragment.start) +
        lines.join('\n') +
        permanent.body_md.slice(fragment.start + fragment.text.length);
      await etn.comments.update(networkId, permanent.id, { body_md: bodyMd }, permanent.version);
      box.checked = want;
    } catch (err) {
      box.checked = !want;
      notice(t('tasks.errorEdit', [errText(err)]), 'error');
    }
  }

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
    const boxes = ownerCheckboxes();
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
