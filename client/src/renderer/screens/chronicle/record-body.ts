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
import { wireCommentLinksInDom } from '../../lib/hover-preview.js';
import { t } from '../../lib/i18n.js';
import { commentShell } from '../../lib/ui/comment.js';
import { store } from '../../state.js';
import { wireMdZoomWheel } from '../../editor/md-zoom.js';

/** Класс контейнера отрендеренного тела записи. */
export const RECORD_VIEW_CLASS = 'diary-body';

/** Минимум строки, нужный для отрисовки тела (полный HTML записи). */
export interface RecordBodySource {
  body_html: string;
}

/**
 * Показать запись в оболочке комментария: полный `body_html` через общий
 * рендер; пустой текст — приглашение (двойной клик входит в правку).
 *
 * Возвращает контейнер тела (`.diary-body`), чтобы вызывающий декорировал его
 * так же, как `markdown-field.ts` декорирует СВОЙ просмотр (авто-подсветка
 * упоминаний `annotateMentions`, резолв ID-ссылок). Просмотр комментария обязан
 * нести одни и те же декорации в любом месте, включая статичный `body_html`
 * ленты «Дневника» (ошибка `616207a9`).
 */
export function renderRecordView(
  shell: ReturnType<typeof commentShell>,
  row: RecordBodySource,
): HTMLElement {
  const view = div(RECORD_VIEW_CLASS);
  if (row.body_html.trim() !== '') {
    renderHtml(view, row.body_html);
    // Ссылки внутри записи — сами по себе триггеры Ctrl+наведения (ошибка
    // a42c1896): тем же единственным проходом разметки, что и просмотр поля
    // markdown / попап постоянного комментария (`wireCommentLinksInDom`).
    // Проход идемпотентен и идёт ПОСЛЕ вставки HTML — до неё ссылок в `view`
    // ещё нет. Резолв ID-форм (`resolveWikiLinksInDom`) — забота экрана
    // (`chronicle.ts`), атрибуты разметки он не снимает.
    wireCommentLinksInDom(view);
    // Ctrl+колесо над текстом записи масштабирует комментарий так же, как поля
    // markdown (ошибка 157b7c14): тот же жест `--md-font-size`. Масштабируется
    // ТОЛЬКО текст записи (`.diary-body`), прочие поля слота — нет.
    wireMdZoomWheel(view, store.state.networkId);
  } else {
    view.append(el('span', 'diary-snippet-empty muted', t('diary.emptyRecordHint')));
  }
  shell.setField(view);
  shell.setState({ kind: 'ready' });
  return view;
}
