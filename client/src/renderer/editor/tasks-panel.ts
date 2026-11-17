/**
 * Зона «Задачи» вкладки «Основное» редактора МЫСЛИ (0.16.1, задачи
 * `710b68aa`/`7446eb25`; элемент `f3893859`, элементы строки `498f23e0`,
 * требования `e6d65f51`/`e6af8b9e`/`0e85b66e`).
 *
 * **Тонкая обвязка.** Любые строки задач (`- [ ]` / `- [X]`) в записях и
 * комментариях, содержащие ID-ссылку на эту мысль, читает и ведёт единая
 * компонента `lib/ui/task-list.ts` (источник `thought`): выборка
 * `GET /tasks?thought_id=`, вложенные строки (`include_nested`), «сегодня» для
 * красной просрочки, операции строк и mass-команды по мысли, realtime-маркер
 * «Обновить». Здесь — только шапка группы (`main.tasks`), переход к источнику
 * строки и скрытие пустой зоны.
 *
 * **Шапка.** Панель монтируется БЕЗ своей шапки (`headless`): заголовок
 * «Задачи», счётчики и кнопки «Обновить»/«⋮» отдаёт компонента, а зона кладёт
 * их в свою шапку.
 *
 * **Пустая зона.** Комментарий занимает вкладку целиком: пустая панель скрывает
 * группу (`hidden`), раскладку зон пересчитывает редактор по событию
 * `etn:zone-visibility`.
 */

import { div, errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { notice } from '../lib/notice.js';
import type { TaskPanelRow } from '../lib/ui/task-panel.js';
import { taskZoneVisible } from '../lib/ui/task-panel-model.js';
import { mountTaskList } from '../lib/ui/task-list.js';
import { requireNetworkId } from '../app.js';
import {
  openLinkInEditor,
  openRecordInEditor,
  openThoughtInEditor,
  registerMainSection,
  showEditorMainTab,
  type EditorContext,
  type TabPaneLifecycle,
} from './editor.js';
import type { GroupSpec } from './group.js';
import { renderMarkdownWithWikiLinks } from './wiki-link-resolver.js';

/**
 * Регистрирует секцию `main.tasks` вкладки «Основное» (только мысль, только
 * после группы `permanent`). Порядок регистрации задаёт порядок зон вкладки.
 */
export function registerEditorTasksSection(): void {
  registerMainSection(createEditorTasksSection);
}

/**
 * Секция `main.tasks` как `GroupSpec` (`null` — у связи зоны задач нет).
 * Отдельная фабрика: шапку зоны (бейдж счётчиков, «Обновить», «⋮») проверяет
 * DOM-тест без монтирования всего редактора.
 */
export function createEditorTasksSection(
  ctx: EditorContext,
  lifecycle: TabPaneLifecycle,
): GroupSpec | null {
  if (ctx.ownerType !== 'thought') return null;
  const host = div('main-tasks-body');
  const list = mountTaskList(host, {
    source: { kind: 'thought', ownerId: ctx.ownerId },
    view: {
      headless: true,
      doneSection: 'collapsed',
      inactiveRows: 'filter',
      renderText: (node, row) => renderEditorTaskRowText(node, row.text, requireNetworkId()),
    },
    actions: {
      openRowSource: (row) => void openSource(row),
      onViewState: (state) => syncZone(host, taskZoneVisible(state)),
    },
  });
  lifecycle.onDispose(() => list.destroy());
  return {
    id: 'main.tasks',
    title: t('editor.title.tasks'),
    // Панель раскрыта по умолчанию: свёрнутость `main.tasks` — пользовательский
    // персист (`editor_collapsed_groups`), дефолт — раскрытая зона.
    defaultCollapsed: false,
    // Бейдж шапки: счётчики публикует тело панели событием `etn:set-count`.
    lazyCount: true,
    actions: list.headActions(),
    buildBody: () => host,
  };
}

/**
 * Открыть запись/комментарий-источник строки. Постоянный комментарий открывает
 * карточку владельца, запись — её саму (вкладка «Дневник» владельца-мысли).
 */
async function openSource(row: TaskPanelRow): Promise<void> {
  const networkId = requireNetworkId();
  try {
    // Постоянный комментарий записи «Дневника» не имеет: его источник
    // открывается карточкой владельца на вкладке «Основное», без
    // pending-записи. Запись выбирает только хроно-строка (замечание 710b68aa).
    const permanent = row.kind === 'permanent';
    if (row.ownerType === 'thought') {
      if (permanent) {
        openThoughtInEditor(row.ownerId);
        showEditorMainTab();
      } else {
        openRecordInEditor(row.ownerId, row.commentId);
      }
      return;
    }
    if (row.ownerType === 'link') {
      openLinkInEditor(await etn.links.get(networkId, row.ownerId));
      if (permanent) showEditorMainTab();
      return;
    }
    // Публикация: ленивый импорт — статический замкнул бы цикл экранов.
    const { openPublicationInWorkspace } = await import('../screens/active-view.js');
    await openPublicationInWorkspace(row.ownerId);
  } catch (err) {
    notice(t('tasks.errorOpenSource', [errText(err)]), 'error');
  }
}

/**
 * Синхронизировать видимость зоны `main.tasks`: пустая панель не показывается
 * (комментарий занимает вкладку), раскладку пересчитывает редактор по событию.
 */
function syncZone(host: HTMLElement, visible: boolean): void {
  const group = host.closest<HTMLElement>('.group');
  if (group === null || group.hidden === !visible) return;
  group.hidden = !visible;
  group.dispatchEvent(new CustomEvent('etn:zone-visibility', { bubbles: true }));
}

/**
 * Нарисовать снапшот текста строки зоны «Задачи» редактора мысли: markdown +
 * кликабельные ID-ссылки. Резолв — по ГОТОВОМУ DOM (общий вход
 * `renderMarkdownWithWikiLinks`): отрендеренный markdown несёт
 * `<span class="wiki-link" data-wiki-id>`, которого резолвер строки сниппета не
 * видит (блокер 399c25d5).
 */
export function renderEditorTaskRowText(node: HTMLElement, text: string, networkId: string): void {
  renderMarkdownWithWikiLinks(node, text, networkId);
}
