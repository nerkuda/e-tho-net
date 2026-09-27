/**
 * Тело записи ленты «Дневник» в режиме ПРОСМОТРА (0.10.1, приёмка №3,
 * задача 9bef6a27; элемент 2f14de06-лента e01f383a).
 *
 * Запись показывается ЦЕЛИКОМ: в оболочку комментария (`lib/ui/comment.ts`)
 * кладётся полный `row.body_html` (прендеренный HTML из `comments.body_html`)
 * и отображается общим `renderHtml` — заголовки, списки, выделения и прочее
 * форматирование видны без обрезаний. Однострочная выжимка `row.snippet`
 * здесь НЕ используется: она остаётся в ответе API ради совместимости
 * MCP-инструмента `etn.chronicle.query`. Ограничение объёма ленты — только
 * пагинация «+50», а не урезание текста записи.
 *
 * Пустая запись (нет текста) даёт прежнее приглашение; двойной клик по телу
 * по-прежнему входит в правку — это поведение хозяина экрана
 * (`screens/chronicle/chronicle.ts`).
 *
 * Модуль выделен ради тестируемости: `chronicle.ts` тянет Electron-каркас и
 * под Node не импортируется, а правило «просмотр = полный `body_html`»
 * обязательно должно проверяться поведенческим тестом
 * (`tests/chronicle-acceptance-iter3.test.ts`).
 */

import { div, el, renderHtml } from '../../lib/dom.js';
import { t } from '../../lib/i18n.js';
import { commentShell } from '../../lib/ui/comment.js';

/** Класс контейнера отрендеренного тела записи. */
export const RECORD_VIEW_CLASS = 'diary-body';

/** Минимум строки, нужный для отрисовки тела (полный HTML записи). */
export interface RecordBodySource {
  body_html: string;
}

/**
 * Показать запись в оболочке комментария: полный `body_html` через общий
 * рендер; пустой текст — приглашение (двойной клик входит в правку).
 */
export function renderRecordView(
  shell: ReturnType<typeof commentShell>,
  row: RecordBodySource,
): void {
  const view = div(RECORD_VIEW_CLASS);
  if (row.body_html.trim() !== '') {
    renderHtml(view, row.body_html);
  } else {
    view.append(el('span', 'diary-snippet-empty muted', t('diary.emptyRecordHint')));
  }
  shell.setField(view);
  shell.setState({ kind: 'ready' });
}
