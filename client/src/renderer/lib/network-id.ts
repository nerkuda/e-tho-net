/**
 * Текущая сеть сессии (`requireNetworkId`) — низкоуровневый источник без
 * зависимостей от сборки экранов (0.16.1, задача `7446eb25`).
 *
 * **Зачем отдельный модуль.** Функция жила в `app.ts`, а `app.ts` тянет за собой
 * весь граф экранов (`screens/screens.ts` → «Дневник» → панель задач). Единая
 * компонента списка задач (`lib/ui/task-list.ts`) нуждается в идентификаторе
 * сети, но импорт `app.ts` из неё замыкал цикл «экран → компонента → app →
 * экран» и ронял модульную инициализацию (`Cannot access ... before
 * initialization`). Здесь — только чтение `store.state.networkId`; `app.ts`
 * реэкспортирует функцию, поэтому прежние точки импорта не меняются.
 */

import { t } from './i18n.js';
import { store } from '../state.js';

/** Идентификатор текущей сети; сети нет — исключение (вызывающий требует сеть). */
export function requireNetworkId(): string {
  const id = store.state.networkId;
  if (id === null) throw new Error(t('app.networkNotOpen'));
  return id;
}
