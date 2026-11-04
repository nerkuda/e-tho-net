/**
 * Каталог английского языка клиента (задача d08c422d, тех.проект 3690fc8f
 * «Локализация ETN: английский и китайский языки»).
 *
 * Полный перевод ключей исходного каталога `ru.ts`: набор ключей совпадает
 * с `ru`, формы плюрализации — категории `one`/`other` по CLDR
 * (`Intl.PluralRules('en')`). Терминология — строго по таблицам требования
 * fc00129d «Единая терминология надписей интерфейса»; орфография
 * американская, регистр — sentence case. Непереводимые имена (ETN, MCP, API,
 * URL, ID, Markdown, PDF, имена типов и свойств данных) остаются как есть;
 * данные мыслесетей не переводятся. Подстановки `%1`, `%2`, … — тот же набор
 * и номера, что в `ru.ts`; порядок слов перевода может отличаться.
 */

import type { PluralCatalog } from '../plural.js';

/** Словарь английского языка: ключ → текст. */
export const en = {
  // -- Общие действия ------------------------------------------------------
  /** Закрытие без изменений; также заголовок кнопки Esc. */
  'actions.cancel': 'Cancel',
  /** «Отмена» с подсказкой горячей клавиши: `t('actions.cancelShortcut', 'Esc')`. */
  'actions.cancelShortcut': 'Cancel (%1)',
  /** Главное подтверждающее действие; унифицирует прежние OK/ОК/Сохранить/Записать. */
  'actions.apply': 'Apply',
  'actions.applyShortcut': 'Apply (%1)',
  /** Применить без закрытия диалога (особая семантика, не синоним «Применить»). */
  'actions.applyClose': 'Apply and close',
  'actions.applyCloseShortcut': 'Apply and close (%1)',
  /** Ответ на вопрос-подтверждение (диалог `confirmDialog`). */
  'actions.confirm': 'Confirm',
  /** Закрытие информационного диалога и заголовок крестика. */
  'actions.close': 'Close',
  'actions.closeShortcut': 'Close (%1)',
  /** Сброс значений контрола/формы. */
  'actions.reset': 'Clear',
  /** Выбор файла на диске (единая подпись). */
  'actions.browse': 'Browse…',
  /** Единый плейсхолдер строки поиска. */
  'actions.search': 'Search…',
  /** Плейсхолдер поиска с подсказкой горячей клавиши: `t('actions.searchShortcut', 'Ctrl+Shift+F')`. */
  'actions.searchShortcut': 'Search… (%1)',
  /** Пометить сущность на удаление (в корзину). */
  'actions.delete': 'Delete',
  /** Окончательное удаление (минуя корзину). */
  'actions.deleteForever': 'Delete permanently',
  'actions.toTrash': 'Move to basket',
  'actions.restore': 'Restore from basket',
  /** Решение диалога-списка в режиме выбора: применить текущую строку и закрыть. */
  'actions.select': 'Select',
  /** Запись изменений и закрытие редактора (кнопка подтверждения «грязного» закрытия). */
  'actions.save': 'Save',

  // -- Подтверждение закрытия редактора с изменениями (требование b58f6aad) -
  /** Заголовок подтверждения при закрытии редактора с несохранёнными изменениями. */
  'dialog.unsaved.title': 'Unsaved changes',
  /** Вопрос подтверждения закрытия редактора (Esc/крестик при изменениях). */
  'dialog.unsaved.message': 'Data has been changed. Save changes?',
  /** Кнопка «Сохранить»: записать изменения и закрыть редактор. */
  'dialog.unsaved.save': 'Save',
  /** Кнопка «Не сохранять»: закрыть без записи, изменения отбрасываются. */
  'dialog.unsaved.discard': 'Don\'t save',
  /** Кнопка «Отменить закрытие»: ничего не делать, редактор остаётся открытым. */
  'dialog.unsaved.stay': 'Cancel closing',

  // -- Строка управления диалогов-списков (требование 11ddd910) ------------
  /** Кнопка «Изменить» строки управления: редактор ТЕКУЩЕЙ строки списка. */
  'listActions.edit': 'Edit',
  /** Подсказка кнопки «Изменить». */
  'listActions.editHint': 'Open the current row in the editor',
  /** Подсказка кнопки «Удалить» (подпись — `actions.delete`). */
  'listActions.deleteHint': 'Delete the current row',
  /** Кнопка «Копировать» строки управления: текущая строка в буфер обмена. */
  'listActions.copy': 'Copy',
  /** Подсказка кнопки «Копировать». */
  'listActions.copyHint': 'Copy the current row to clipboard',
  /** Пометить все строки (чек-режим множественного выбора). */
  'listActions.checkAll': 'Check all',
  /** Снять все пометки (чек-режим множественного выбора). */
  'listActions.uncheckAll': 'Uncheck all',
  /** Пункт контекстного меню строки-ветви: раскрыть ветвь (правило 8). */
  'listActions.expand': 'Expand',
  /** Пункт контекстного меню строки-ветви: свернуть ветвь (правило 8). */
  'listActions.collapse': 'Collapse',
  /** Пустое состояние списка, когда поиск не нашёл совпадений (правило 1). */
  'list.emptySearch': 'Nothing found',
  /** Подсказка пустого состояния списка по поиску. */
  'list.emptySearchHint': 'Change the query or clear the search.',

  // -- Общие тексты --------------------------------------------------------
  'common.loading': 'Loading…',

  // -- Пустые состояния и загрузка (lib/ui/empty-state.ts) -----------------
  /** Заголовок пустого состояния по умолчанию: данных нет. */
  'state.emptyTitle': 'Nothing here yet',
  /** Подсказка пустого состояния по умолчанию — что сделать. */
  'state.emptyHint': 'Data will appear here once it is added.',

  // -- Таблица списков -----------------------------------------------------
  /** Пустое состояние таблицы, когда строк нет (фасад `lib/ui/table.ts`). */
  'table.empty': 'No rows yet',
  /** Подсказка пустого состояния таблицы по умолчанию. */
  'table.emptyHint': 'Data will appear as soon as it is added.',

  // -- Общий список свойств (lib/property-list.ts) -------------------------
  /** Заголовок колонки «Имя» общего списка свойств. */
  'propertyList.col.name': 'Name',
  /** Заголовок колонки «Тип значения». */
  'propertyList.col.valueType': 'Value type',
  /** Заголовок колонки «Кол-во типов». */
  'propertyList.col.typesCount': 'Type count',
  /** ARIA-подпись таблицы свойств. */
  'propertyList.aria': 'Network property list',
  /** Кнопка добавления свойства (режим менеджера). */
  'propertyList.add': 'Add',
  /** Подсказка кнопки добавления. */
  'propertyList.addHint': 'Create property',
  /** Пункт меню строки — открыть редактор свойства. */
  'propertyList.menu.edit': 'Edit',
  /** Пустое состояние списка без строк. */
  'propertyList.empty': 'No properties yet',
  /** Подсказка пустого состояния списка без строк. */
  'propertyList.emptyHint': 'Add the first property with the Add button.',
  /** Пустое состояние при поиске без совпадений. */
  'propertyList.emptySearch': 'Nothing found',
  /** Подсказка пустого состояния при поиске без совпадений. */
  'propertyList.emptySearchHint': 'Change the query or clear the search.',
  /** Пометка системной структурной строки «Родители»/«Потомки». */
  'propertyList.structuralMark': '🔒 (structural)',
  /** Подсказка системной структурной строки. */
  'propertyList.structuralHint': 'System link property for untyped “Родители/Потомки” edges. It cannot be edited or deleted from this dialog.',

  // -- Поле выбора свойства-связи (lib/entity-picker.ts) -------------------
  /** Пустое значение поля свойства-связи: подпись поля и пункт снятия выбора
   *  (по аналогии с «без типа»; требование fc00129d, ошибка a7abe50e). */
  'linkProperty.empty': 'no property',
  /** Заголовок диалога выбора свойства-связи (кнопка «…»). */
  'linkProperty.pickerTitle': 'Select link property',

  // -- Перетаскивание мыслей (задача d144ef71, lib/thought-drop.ts) --------
  /** Подпись поля выбора свойства-связи при дропе мысли на облачко. */
  'thoughtDrop.linkPropertyLabel': 'Link property',
  /** Заголовок диалога выбора свойства-связи при дропе мысли на облачко. */
  'thoughtDrop.linkPropertyTitle': 'Select a link property for this link',
  /** Подсказка: в диалоге дропа свойство-связь не выбрано. */
  'thoughtDrop.pickProperty': 'Select a link property.',
  /** Неудача записи связи при дропе на облачко. */
  'thoughtDrop.linkFailed': 'Failed to create link',

  // -- Панель отбора (lib/filter-form.ts) ---------------------------------
  /** Пустое состояние панели условий отбора. */
  'filterForm.empty': 'No conditions',
  /** Подсказка пустого состояния панели условий отбора. */
  'filterForm.emptyHint': 'Add a view condition.',

  // -- Единый редактор отбора (lib/filter-tree.ts, filter-diagnostics.ts,
  //    screens/structures/filter-panel.ts, screens/thought-type/filter-dialog.ts)
  /** Заголовок редактора условий панели отбора мыслей (экран «Структуры»). */
  'filterEditor.titleThoughts': 'Thought view:',
  /** Заголовок редактора условий зоны настроек строки поиска карты (задача 4b1cc3d4). */
  'filterEditor.titleSearch': 'Thought view for search:',
  /** Заголовок секции условий в диалоге отбора типа мысли. */
  'filterEditor.conditionsTitle': 'View conditions:',
  /** Заголовок диалога правки существующего отбора типа (подстановка — имя типа). */
  'filterEditor.dialogTitleEdit': 'View of type “%1”',
  /** Заголовок диалога создания нового отбора типа (подстановка — имя типа). */
  'filterEditor.dialogTitleCreate': 'Create a view of type “%1”',
  /** Заголовок диалога правки внетипового отбора мысли (0.14.1; имя мысли). */
  'filterEditor.dialogTitleEditThought': 'View of thought “%1”',
  /** Заголовок диалога создания внетипового отбора мысли (имя мысли). */
  'filterEditor.dialogTitleCreateThought': 'Create a view of thought “%1”',
  /** Предупреждение в диалоге типового отбора: эффект на все мысли типа. */
  'filterEditor.typeViewWarning': 'The view is shared across the network: all members will see it in all thoughts of this type.',
  /** Предупреждение в диалоге внетипового отбора: виден всем, действует у мысли. */
  'filterEditor.thoughtViewWarning': 'The view is visible to all network members (not personal) but applies only to this thought.',
  /** Подпись поля описания отбора. */
  'filterEditor.descriptionLabel': 'Description',
  /** Подсказка поля описания отбора. */
  'filterEditor.descriptionPlaceholder': 'Description (read by both humans and agents)',
  /** Флажок «отбор открывается сам при переводе мысли в фокус». */
  'filterEditor.openByDefault': 'Open by default',
  /** Сообщение валидации: имя отбора не заполнено. */
  'filterEditor.nameRequired': 'Enter a view name.',
  /** Ошибка длины имени (параметры — предел и текущая длина). */
  'filterEditor.nameTooLong': 'Name must not exceed %1 characters (currently %2).',
  /** Ошибка длины описания (параметры — предел и текущая длина). */
  'filterEditor.descriptionTooLong': 'Description must not exceed %1 characters (currently %2).',
  /** Сообщение валидации: пустой отбор без единого условия. */
  'filterEditor.noCriteria': 'Specify at least one view condition.',
  /** Сообщение валидации: в отборе есть красная диагностика. */
  'filterEditor.blockingIssues': 'The view contains errors — fix them before saving.',
  /** Гейт сохранения: правка отборов доступна только в Основе (0.14.1). */
  'filterEditor.baseLayerGuard': 'Views can only be edited in Base. Switch to Base and try again.',
  /** Не удалось открыть диалог отбора (параметр — причина). */
  'filterEditor.openFailed': 'Failed to open the view dialog: %1',
  /** Диагностика: реестр свойств не прочитан, условия по свойствам могут ждать повтора. */
  'filterEditor.registryPending': 'The network property registry has not been read — property conditions may not be displayed. Retrying the read.',
  /** Запрет сохранения: реестр не прочитан и перезапись потеряет условия по свойствам. */
  'filterEditor.registryPendingSave': 'The network property registry has not been read: saving will overwrite the view without property conditions. Wait for the connection to recover or reopen the dialog.',
  /**
   * Запрет сохранения: реестр прочитан, но правка шла без него — условия по
   * свойствам из сохранённого определения в форму не восстановлены (071acfc2).
   */
  'filterEditor.conditionsLostSave': 'Property conditions were not restored after the registry read: an edit made before it will replace the view without those conditions. Close the dialog without saving and reopen the view.',
  /** Строка диагностики условия, которому оператор требует значение, а его нет. */
  'filterEditor.conditionWithoutValue': 'condition value is not set',

  // -- Полоса отборов под фокусом (canvas/focus-filter-strip.ts, спека
  //    df84de22, 0.14.1) -----------------------------------------------------
  /** Подпись тулбара полосы отборов. */
  'strip.ariaLabel': 'View strip',
  /** Первая кнопка полосы — обычное содержимое нижней зоны. */
  'strip.children': 'Children',
  /** Тултип кнопки «⋯» — отборы, не поместившиеся в полосу. */
  'strip.overflowTitle': 'Views that did not fit',
  /** Пустой список в меню «⋯». */
  'strip.noViews': 'No views',
  /** Пометка внетипового отбора в меню «⋯». */
  'strip.outOfTypeMark': '(out of type)',
  /** Пометка унаследованного типового отбора в меню «⋯». */
  'strip.inheritedMark': '(inherited)',
  /** Тултип кнопки «+» — добавить отбор. */
  'strip.addView': 'Add view',
  /** Гейт «+»: добавление отборов только в Основе. */
  'strip.addBaseLayerOnly': 'Switch to Base to add views.',
  /** Пункт меню «+»: новый отбор типа мысли. */
  'strip.addTypeView': 'New thought type view',
  /** Пункт меню «+»: новый внетиповой отбор мысли. */
  'strip.addThoughtView': 'New out-of-type view',
  /** Тултип кнопки-воронки: фильтр типов связей на карте. */
  'strip.linkFilter': 'Link type filter on the map',
  /** Контекстное меню чипа: правка отбора. */
  'strip.menuEdit': 'Edit view',
  /** Контекстное меню чипа: снять пометку «по умолчанию». */
  'strip.menuClearDefault': 'Clear default',
  /** Контекстное меню чипа: пометить отбор «по умолчанию». */
  'strip.menuMakeDefault': 'Make default view',
  /** Контекстное меню внетипового чипа: перенос владельца в отборы типа. */
  'strip.menuMoveToType': 'Move view to type views',
  /** Контекстное меню типового чипа: перенос владельца на мысль. */
  'strip.menuMoveToThought': 'Remove view from type views',
  /** Контекстное меню чипа: удалить отбор. */
  'strip.menuDelete': 'Delete view',
  /** Гейт правки/удаления отбора: только Основа. */
  'strip.editBaseLayerOnly': 'Switch to Base to edit the view.',
  /** Гейт удаления отбора: только Основа. */
  'strip.deleteBaseLayerOnly': 'Switch to Base to delete the view.',
  /** Тост: отбор помечен «по умолчанию». */
  'strip.defaultSet': 'The view is marked as default.',
  /** Тост: пометка «по умолчанию» снята. */
  'strip.defaultCleared': 'The default mark has been cleared.',
  /** Ошибка изменения пометки «по умолчанию». */
  'strip.defaultFailed': 'Failed to change the mark.',
  /** Заголовок подтверждения переноса «вне типа → тип». */
  'strip.transferToTypeTitle': 'Move view to type views',
  /** Текст подтверждения переноса в тип (параметры — имя отбора, имя типа). */
  'strip.transferToTypeConfirm': 'View “%1” will be shared by type “%2”: all thoughts of this type will see it.',
  /** Заголовок подтверждения переноса «тип → вне». */
  'strip.transferToThoughtTitle': 'Remove view from type views',
  /** Текст подтверждения переноса на мысль (отбор, тип, мысль). */
  'strip.transferToThoughtConfirm': 'View “%1” will disappear from all thoughts of type “%2” and become an out-of-type view of thought “%3”.',
  /** Дополнение для унаследованного отбора (параметр — тип-владелец). */
  'strip.transferInheritedNote': 'The view is inherited from type “%1” — it will also disappear from all descendant types of “%1”.',
  /** Дополнение при занятом собственном дефолте получателя. */
  'strip.transferDefaultNote': 'The recipient already has a default view — the moved view will keep no default mark.',
  /** Тост: перенос выполнен. */
  'strip.transferDone': 'View moved.',
  /** Ошибка переноса отбора. */
  'strip.transferFailed': 'Failed to move the view.',
  /** Заголовок подтверждения удаления отбора. */
  'strip.deleteTitle': 'Delete view',
  /** Удаление типового отбора (имя отбора, имя типа-владельца). */
  'strip.deleteTypeConfirm': 'Delete view “%1” of type “%2”? It will disappear from all thoughts of this type. This action cannot be undone.',
  /** Удаление внетипового отбора (имя отбора, имя мысли-владельца). */
  'strip.deleteThoughtConfirm': 'Delete view “%1” of thought “%2”? This action cannot be undone.',
  /** Тост: отбор удалён. */
  'strip.deleted': 'View deleted.',
  /** Ошибка удаления отбора. */
  'strip.deleteFailed': 'Failed to delete the view.',
  /** Ошибка исполнения отбора. */
  'strip.runFailed': 'Failed to run the view.',

  // -- Диалог добавления/выбора мыслей (canvas/add-dialog.ts) --------------
  /** Заголовок списка найденных кандидатов-дублей. */
  'addDialog.candidatesHeader': 'Matching thoughts:',
  /** Точность совпадения кандидата: точное имя. */
  'addDialog.matchExact': 'exact name',
  /** Точность совпадения кандидата: синоним (текст синонима — параметр). */
  'addDialog.matchSynonym': 'synonym “%1”',
  /** Точность совпадения кандидата: частичное. */
  'addDialog.matchPartial': 'partial match',

  // -- Контекстное меню мысли (canvas/context-menu.ts) ---------------------
  /**
   * Переход к ленте «События» с отбором по выбранной мысли (ошибка 56ab2902).
   * Формулировка заказчика — «Смотреть события» (было «Что происходило с этой
   * сущностью»).
   */
  'thoughtMenu.activityForEntity': 'View events',

  // -- Чип-лист мультивыбора (lib/ui/chip-list.ts, users.ts) ---------------
  /** Пустое состояние чип-листа — ничего не выбрано. */
  'chipList.empty': 'Nothing selected',
  /** Подсказка пустого состояния чип-листа. */
  'chipList.emptyHint': 'Add a value using the field below.',
  /** Первый (пустой) пункт поля добавления чип-листа. */
  'chipList.addPlaceholder': '+ add…',
  /** Подсказка кнопки снятия чипа. */
  'chipList.remove': 'Remove',
  /** Первый пункт поля добавления участника (мультивыбор пользователей). */
  'userMulti.addPlaceholder': '+ add user…',

  // -- Экран «События» (activity.ts) --------------------------------------
  /** ARIA-подпись ленты активности. */
  'activity.aria': 'Event feed',
  'activity.col.time': 'Time',
  'activity.col.author': 'Author',
  'activity.col.action': 'Action',
  'activity.col.entity': 'Entity',
  'activity.col.layer': 'Layer',
  /** Пустое состояние ленты. */
  'activity.empty': 'No events yet',
  /** Подсказка пустого состояния ленты. */
  'activity.emptyHint': 'Entries will appear once members start changing network data.',
  /** Метки действий журнала (код действия — английский). */
  'activity.action.created': 'created',
  'activity.action.updated': 'updated',
  'activity.action.deleted': 'deleted',
  'activity.action.trashed': 'marked for deletion',
  'activity.action.restored': 'restored',
  /** Метки типов сущностей (код — английский). */
  'activity.entity.thought': 'thought',
  'activity.entity.link': 'link',
  'activity.entity.thought_type': 'thought type',
  'activity.entity.link_type': 'link type',
  'activity.entity.property': 'property',
  'activity.entity.comment': 'comment',
  'activity.entity.attachment': 'attachment',
  'activity.entity.layer': 'layer',

  // -- Корзина и групповое удаление (trash.ts) ----------------------------
  /** ARIA-подпись таблицы корзины. */
  'trash.aria': 'Basket',
  'trash.col.item': 'In basket',
  'trash.col.count': 'References',
  'trash.col.actions': 'Actions',
  /** Пустое состояние корзины. */
  'trash.empty': 'The basket is empty',
  /** Подсказка пустого состояния корзины. */
  'trash.emptyHint': 'Thoughts and links marked for deletion end up here.',
  /** Пустое состояние корзины, когда поиск не нашёл совпадений. */
  'trash.emptySearch': 'Nothing found',
  /** Подсказка пустого состояния корзины по поиску. */
  'trash.emptySearchHint': 'Change the query or clear the search.',
  /** ARIA-подпись таблицы группового удаления. */
  'trash.group.aria': 'Bulk deletion',
  'trash.group.col.thought': 'Thought',
  'trash.group.col.action': 'Action',

  // -- Сохранённые отборы (saved-filter-bar.ts) ---------------------------
  /** ARIA-подпись диалога сохранённых отборов. */
  'savedFilters.aria': 'Saved views',
  /** Заголовок диалога выбора сохранённого отбора. */
  'savedFilters.title': 'Saved views',
  'savedFilters.col.name': 'Name',
  /** Пустое состояние: сохранённых отборов нет. */
  'savedFilters.empty': 'No saved views yet',
  /** Подсказка пустого состояния: сохранённых отборов нет. */
  'savedFilters.emptyHint': 'Configure a view and save it — it will appear in this list.',
  /** Пустое состояние при поиске без совпадений. */
  'savedFilters.emptySearch': 'Nothing found',
  /** Подсказка пустого состояния при поиске без совпадений. */
  'savedFilters.emptySearchHint': 'Change the query or clear the search.',
  'savedFilters.menu.rename': 'Rename',
  'savedFilters.menu.copy': 'Copy',
  /** Метка предопределённого набора в списке сохранённых отборов. */
  'savedFilters.predefined': 'predefined',
  /** Подсказка метки предопределённого набора. */
  'savedFilters.predefinedHint': 'The set ships with the panel and is restored when the list is opened if deleted.',
  /** Пункт выбора «текущий пользователь» (значение-токен $user) в поле автора. */
  'userSelect.currentUser': 'current user ($user)',

  // -- Админ-панель (admin.ts) --------------------------------------------
  'admin.users.aria': 'Members (users)',
  'admin.networks.aria': 'Networks',
  'admin.audit.aria': 'Audit log',
  'admin.col.user': 'User',
  'admin.col.role': 'Role',
  'admin.col.status': 'Status',
  'admin.col.created': 'Created',
  'admin.col.createdF': 'Created',
  'admin.col.actions': 'Actions',
  'admin.col.network': 'Network',
  'admin.col.owner': 'Owner',
  'admin.col.time': 'Time',
  'admin.col.who': 'Who',
  'admin.col.category': 'Category',
  'admin.col.action': 'Action',
  'admin.col.target': 'Target',
  'admin.role.admin': 'admin',
  'admin.role.user': 'user',
  'admin.status.active': 'active',
  'admin.status.disabled': 'disabled',
  // Строка управления над таблицами админ-панели (требование 11ddd910,
  // правило 2): действия над ТЕКУЩЕЙ строкой.
  /** Сгенерировать/перевыпустить API-ключ текущего пользователя. */
  'admin.user.key': 'Key',
  /** Включить текущую учётную запись. */
  'admin.user.enable': 'Enable',
  /** Отключить текущую учётную запись. */
  'admin.user.disable': 'Disable',
  /** Удалить текущую сеть. */
  'admin.network.delete': 'Delete network',
  /** Пустое состояние списка участников. */
  'admin.users.empty': 'No users yet',
  /** Подсказка пустого состояния списка участников. */
  'admin.users.emptyHint': 'Create the first user with the Add user button.',
  /** Пустое состояние списка сетей. */
  'admin.networks.empty': 'No networks yet',
  /** Подсказка пустого состояния списка сетей. */
  'admin.networks.emptyHint': 'Create the first network — it will appear in this list.',
  /** Пустое состояние журнала аудита. */
  'admin.audit.empty': 'No entries',
  /** Подсказка пустого состояния журнала аудита. */
  'admin.audit.emptyHint': 'Change the filter or extend the date range.',

  // -- Комментарий ---------------------------------------------------------
  /** Тело оболочки комментария, когда комментарий пуст. */
  'comment.empty': 'The comment is empty.',
  /** Хроника: комментарий не выбран. */
  'comment.emptySelection': 'Select a comment from the list or click Add.',
  /** Ошибка загрузки комментария (оболочка `lib/ui/comment.ts`); к ней
   *  добавляется дружелюбная причина: «Невозможно загрузить: нет соединения
   *  с сервером». */
  'comment.loadError': 'Unable to load',

  // -- Команды поля комментария (0.12.1, задача 3d6f98cb, ТП1) --------------
  /** Доступное имя тулбара команд поля комментария. */
  'comment.toolbar.label': 'Comment formatting commands',
  /** Подменю тулбара «прочие внутристрочные» команды. */
  'comment.tb.inlineMore': 'More inline',
  /** Подменю тулбара «прочие блочные» команды. */
  'comment.tb.blockMore': 'More block',
  /** Подменю настроек поля на правом краю тулбара. */
  'comment.tb.settings': 'Field settings',
  /** Команда «жирный». */
  'comment.cmd.bold': 'Bold',
  /** Команда «курсив». */
  'comment.cmd.italic': 'Italic',
  /** Команда «подчёркнутый». */
  'comment.cmd.underline': 'Underline',
  /** Команда «зачёркнутый». */
  'comment.cmd.strike': 'Strikethrough',
  /** Команда «выделение». */
  'comment.cmd.highlight': 'Highlight',
  /** Команда «инлайн-код». */
  'comment.cmd.inlineCode': 'Inline code',
  /** Команда «маркированный список». */
  'comment.cmd.bulletList': 'Bulleted list',
  /** Команда «нумерованный список». */
  'comment.cmd.orderedList': 'Numbered list',
  /** Команда «список задач». */
  'comment.cmd.taskList': 'Task list',
  /** Команда «сдвиг списка вправо». */
  'comment.cmd.indentList': 'Indent',
  /** Команда «сдвиг списка влево». */
  'comment.cmd.outdentList': 'Outdent',
  /** Команда «заголовок 1». */
  'comment.cmd.h1': 'Heading 1',
  /** Команда «заголовок 2». */
  'comment.cmd.h2': 'Heading 2',
  /** Команда «заголовок 3». */
  'comment.cmd.h3': 'Heading 3',
  /** Команда «цитата». */
  'comment.cmd.blockquote': 'Quote',
  /** Команда «блок кода». */
  'comment.cmd.codeBlock': 'Code block',
  /** Команда «таблица». */
  'comment.cmd.table': 'Table',
  /** Команда «разделитель». */
  'comment.cmd.hr': 'Divider',
  /** Команда «HTML-комментарий». */
  'comment.cmd.htmlComment': 'HTML comment',
  /** Команда «копировать». */
  'comment.cmd.copy': 'Copy',
  /** Команда «копировать как текст». */
  'comment.cmd.copyAsText': 'Copy as text',
  /** Команда «вырезать». */
  'comment.cmd.cut': 'Cut',
  /** Команда «вырезать как текст». */
  'comment.cmd.cutAsText': 'Cut as text',
  /** Команда «вставить». */
  'comment.cmd.paste': 'Paste',
  /** Команда «вставить как текст». */
  'comment.cmd.pasteAsText': 'Paste as text',
  /** Команда «поиск в поле». */
  'comment.cmd.find': 'Search',
  /** Команда «разделение выделения» (ТП3, задача 578c8525). */
  'comment.cmd.split': 'Split selection into thoughts',
  /** Команда «создать мысль из раздела» (ТП3, задача 5f854e7a). */
  'comment.cmd.createFromSection': 'Create thought from section',
  /** Команда «создать мысль из выделенного» (ТП3, задача 5f854e7a). */
  'comment.cmd.createFromSelection': 'Create thought from selection',
  /** Команда «вставить ссылку на мысль» (ТЗ5, «Дневник без псевдослота»). */
  'comment.cmd.insertThoughtLink': 'Insert thought link…',
  /** Команда «вставить трансклюзию мысли» (ТЗ5, «Дневник без псевдослота»). */
  'comment.cmd.insertThoughtTransclusion': 'Insert thought transclusion…',
  /**
   * Команда контекстного меню «вставить картинку» (0.12.1, задача 87c455db):
   * открывает диалог выбора ресурса для вставки эмодзи/картинки-вложения/URL
   * в позицию курсора.
   */
  'comment.cmd.insertImage': 'Insert image…',
  /** Ошибка создания мысли из выделения (ТП3, задача 5f854e7a). */
  'comment.create.error': 'Failed to create thought',
  /** Не найден родитель для новой мысли (ТП3, задача 5f854e7a). */
  'comment.create.noParent': 'parent is not defined',
  /** Команда «отмена правки». */
  'comment.cmd.cancel': 'Cancel',
  /** Команда «сохранить правку». */
  'comment.cmd.save': 'Save',
  /** Команда подменю настроек «Сочетания клавиш». */
  'comment.cmd.hotkeys': 'Keyboard shortcuts',
  /** Команда «замена в поле». */
  'comment.cmd.replace': 'Replace',
  /** Команда «следующее вхождение». */
  'comment.cmd.findNext': 'Next match',
  /** Команда «предыдущее вхождение». */
  'comment.cmd.findPrevious': 'Previous match',
  /** Команда «глобальный поиск». */
  'comment.cmd.globalSearch': 'Global search',
  /** Команда «переместить строку выше» (сочетание подставляет `commandTitle`). */
  'comment.cmd.moveLineUp': 'Move line up',
  /** Команда «переместить строку ниже» (сочетание подставляет `commandTitle`). */
  'comment.cmd.moveLineDown': 'Move line down',
  /** Команда «свернуть раздел под кареткой» (задача 558cac34). */
  'comment.cmd.fold': 'Collapse section under cursor',
  /** Команда «развернуть раздел под кареткой» (задача 558cac34). */
  'comment.cmd.unfold': 'Expand section under cursor',
  /** Подсказка иконочной кнопки входа в правку в углу поля (элемент a0e5bc2e). */
  'comment.action.editTooltip': 'Edit text',

  // -- Сворачивание разделов комментария (634f1412) ------------------------
  /** Подсказка индикатора свёрнутого раздела. */
  'comment.collapse.expand': 'Expand section',
  /** Подсказка индикатора развёрнутого раздела. */
  'comment.collapse.collapse': 'Collapse section',

  // -- Трансклюзии комментариев (ТП2, задача f72a9134) ---------------------
  /** Подсказка чипа-шапки блока «имя · раздел» (68591b8a). */
  'comment.transclusion.chip.tooltip': 'Transclusion link',
  /** Заголовок поповера правки ссылки (68591b8a). */
  'comment.transclusion.popover.title': 'Transclusion link',
  /** Первая команда центра: применить ссылку без раздела (aa309fb7). */
  'comment.transclusion.popover.allSections': 'All comment sections',
  /** Подсказка команды «Все разделы комментария» (aa309fb7). */
  'comment.transclusion.popover.allSectionsTooltip': 'Show all sections of the thought comment',
  /** Плейсхолдер живого поиска по разделам источника (aa309fb7). */
  'comment.transclusion.popover.sectionSearch': 'Search section…',
  /** Плашка блока: мысль-источник недоступна или удалена. */
  'comment.transclusion.noSource': 'No transclusion source',
  /** Плашка блока: раздел не найден в источнике. */
  'comment.transclusion.noSection': 'No section in the transclusion source',
  /** Плашка блока: ссылка не раскрыта (цикл или предел глубины 5). */
  'comment.transclusion.skipped': 'Link not expanded',
  /** Имя ссылки, когда мысль ещё не разрешена. */
  'comment.transclusion.untitled': 'Untitled',
  /** Частичный сбой записи блоков-источников: %1 — список «имя · раздел» (7399c9ec). */
  'comment.transclusion.savePartial': 'Some edits were not saved: %1. Fix the marked blocks and retry saving',
  /** Сбой записи комментария (окружения): %1 — причина (7399c9ec). */
  'comment.save.failed': 'Failed to save the comment: %1',
  /** Сбой записи комментария без внятной причины (7399c9ec). */
  'comment.save.failedUnknown': 'Failed to save the comment — retry saving.',
  /** «Замочек» блока: источник захвачен другим участником (f59d24e1). */
  'comment.transclusion.locked': '%1 is editing the source',

  // -- Контекстное меню блока трансклюзии (ТП2, задача 955478e8) -----------
  /** Пункт: открыть мысль-источник в редакторе. */
  'comment.transclusion.menu.open': 'Open link',
  /** Пункт: перейти на карту мыслей с фокусом на источнике. */
  'comment.transclusion.menu.focus': 'Focus',
  /** Пункт: скопировать ссылку трансклюзии. */
  'comment.transclusion.menu.copy': 'Copy',
  /** Пункт: скопировать id мысли-источника. */
  'comment.transclusion.menu.copyId': 'Copy ID',
  /** Поповер чипа: удалить блок трансклюзии одной транзакцией (c11b82ee). */
  'comment.transclusion.menu.delete': 'Delete block',
  /** Уведомление: ссылка трансклюзии скопирована. */
  'comment.transclusion.menu.copied': 'Transclusion link copied.',
  /** Уведомление: id источника скопирован. */
  'comment.transclusion.menu.copiedId': 'Source ID copied.',
  /** Ошибка копирования в буфер обмена. */
  'comment.transclusion.menu.copyError': 'Failed to copy.',

  // -- Панель поиска и замены поля комментария (045f98db) ------------------
  /** Плейсхолдер поля «Найти». */
  'comment.search.findPlaceholder': 'Find',
  /** Плейсхолдер поля «Заменить». */
  'comment.search.replacePlaceholder': 'Replace',
  /** Доступное имя поля «Найти». */
  'comment.search.findLabel': 'Find in comment',
  /** Доступное имя поля «Заменить». */
  'comment.search.replaceLabel': 'Replace in comment',
  /** Кнопка «следующее вхождение». */
  'comment.search.next': 'Next match',
  /** Кнопка «предыдущее вхождение». */
  'comment.search.previous': 'Previous match',
  /** Кнопка закрытия панели поиска. */
  'comment.search.close': 'Close search',
  /** Кнопка «заменить текущее вхождение». */
  'comment.search.replace': 'Replace',
  /** Кнопка «заменить все вхождения». */
  'comment.search.replaceAll': 'Replace all',
  /** Счётчик вхождений: «%1 из %2». */
  'comment.search.count': '%1 of %2',
  /** Счётчик при отсутствии вхождений. */
  'comment.search.none': 'No matches',

  // -- Диалог настройки сочетаний клавиш (d534eb35) ------------------------
  /** Заголовок диалога настройки сочетаний клавиш комментария. */
  'comment.hotkeys.title': 'Comment keyboard shortcuts',
  /** Подсказка в верхней части диалога настройки сочетаний. */
  'comment.hotkeys.hint': 'Click a shortcut to assign a new one. Shortcuts are saved on the server and apply across all thought networks.',
  /** Состояние перехвата: ждём нажатия сочетания. */
  'comment.hotkeys.capture': 'Press a shortcut…',
  /** Подсказка кнопки сброса сочетания команды. */
  'comment.hotkeys.reset': 'Reset to default',
  /** Кнопка «сбросить все сочетания». */
  'comment.hotkeys.resetAll': 'Reset all',
  /** Сообщение о конфликте: сочетание занято другой командой. */
  'comment.hotkeys.conflict': 'Shortcut %1 is already assigned to “%2”. Choose another.',
  /** Уведомление об успешном сохранении сочетаний. */
  'comment.hotkeys.saved': 'Shortcuts saved.',
  /** Заглушка отсутствующего сочетания. */
  'comment.hotkeys.none': 'Not assigned',

  // -- Сплиттер ------------------------------------------------------------
  /** Подсказка горизонтального разделителя, меняющего высоту области. */
  'splitter.resizeHint': 'Drag to change the height',
  /** Доступное имя горизонтального разделителя (стрелки + перетаскивание). */
  'splitter.resizeAriaVertical': 'Splitter: use arrow keys or dragging to change the height, Enter to apply, Esc to cancel',
  /** Доступное имя вертикального разделителя (стрелки + перетаскивание). */
  'splitter.resizeAriaHorizontal': 'Splitter: use arrow keys or dragging to change the width, Enter to apply, Esc to cancel',

  // -- Ошибки --------------------------------------------------------------
  /** Префикс строки ошибки операции: `<префикс>: <сообщение>`. */
  'errors.prefix': 'Error',
  /** Ошибка с `details.kind === 'connection-lost'` (ошибка de34b35b). */
  'errors.connectionLost': 'no connection to the server',
  /** `INTERNAL` и сырые сетевые ошибки (fetch/ECONN/ETIMEDOUT). */
  'errors.serverUnavailable': 'server is unavailable, try again later',
  /**
   * `503 SERVER_UPDATING` (задача 479e37ed): сервер штатно обновляется — это НЕ
   * «недоступен». `%1` — рекомендованная пауза `retry_after`, целые секунды.
   */
  'errors.serverUpdating': 'server is updating, try again in about %1 s',
  /** `503 SERVER_UPDATING` без пригодного `retry_after`. */
  'errors.serverUpdatingNoRetry': 'server is updating, try again later',
  /** Пользовательская отмена операции (не сетевой сбой). */
  'errors.actionCancelled': 'action canceled',
  /**
   * Свойство-связь: имя адресует обе стороны, обе живые, а сторона не указана
   * (`details.reason === 'side-required'`, ошибка d9bc6012). Серверный текст
   * говорит `side`/`source`/`target` — пользователю это не показываем.
   */
  'errors.propertySideRequired': 'the property has links on both sides — select a side',
  /**
   * Свойство-связь: при удалении/очистке с указанной стороны связей нет, а с
   * противоположной есть (`details.reason === 'side-mismatch'`, ошибка
   * d9bc6012) — данные уже изменились.
   */
  'errors.propertySideMismatch': 'no links on the selected side — the value has already been changed, refresh the card',
  /**
   * Запись свойства по имени: display-имя принадлежит нескольким разным
   * свойствам сети и выбрать одно не удалось даже по стороне
   * (`details.reason === 'property-ambiguous'`, ошибка d9bc6012). Серверный
   * текст для API/агентов не показываем; внутренних терминов здесь нет.
   */
  'errors.propertyNameAmbiguous': 'property name is ambiguous — it is used by several network properties',
  /**
   * Запись свойства-связи: значение не того типа, который допускает привязка
   * целевой стороны (`details.reason === 'target-type-mismatch'`, ошибка
   * d9bc6012, круг 3). Серверный текст уже русский; словарная формулировка
   * короче и не повторяет имя строки.
   */
  'errors.propertyTargetType': 'value type is not allowed by the property',
  /**
   * Server errors — user-facing text by code (ADR daab6ac4, §4):
   * `error.message` is English and never shown. Refining reasons
   * (`details.reason`/`details.issue`) use `errors.code.<code>.<token>` keys;
   * an unknown code or reason falls back to the generic text.
   */
  'errors.code.VALIDATION_ERROR': 'check the entered data',
  'errors.code.BAD_REQUEST': 'the request cannot be completed',
  'errors.code.UNAUTHORIZED': 'sign-in is required',
  'errors.code.FORBIDDEN': 'not enough permissions for this action',
  'errors.code.NOT_FOUND': 'the object was not found — it may have been deleted',
  'errors.code.VERSION_CONFLICT': 'the data has changed — refresh and try again',
  'errors.code.DUPLICATE': 'such a record already exists',
  'errors.code.LOCKED': 'another member is editing the object',
  'errors.code.LOCK_NOT_FOUND': 'the object lock was not found',
  'errors.code.RATE_LIMITED': 'too many requests — try again later',
  'errors.code.PROTECTED_ENTITY': 'the object is protected from changes',
  'errors.code.CLIENT_VERSION_UNSUPPORTED':
    'the client version is not supported — update the client',
  /** Refinements of `426 CLIENT_VERSION_UNSUPPORTED` by `details.reason`. */
  'errors.code.CLIENT_VERSION_UNSUPPORTED.version-missing':
    'the server did not receive the client version — update the client',
  'errors.code.CLIENT_VERSION_UNSUPPORTED.version-invalid':
    'the server could not parse the client version — update the client',
  'errors.code.CLIENT_VERSION_UNSUPPORTED.version-out-of-range':
    'the client version is not supported by the server — update the client',
  'errors.code.UPDATE_INSTALLER_FAILED': 'failed to start the update installer',
  'errors.unknownCode': 'the action could not be completed',

  // -- Подключение к серверу (ошибка 390e9746) -----------------------------
  /** Отказ подключения к сохранённому серверу: «метка» + адрес + причина. */
  'connect.failed.withLabel': 'Failed to connect to server “%1” (%2): %3',
  /** Отказ подключения без отдельной метки (метка совпадает с адресом). */
  'connect.failed.address': 'Failed to connect to server %1: %2',
  /** Причина: соединение отклонено — сервер не запущен или порт закрыт. */
  'connect.reason.refused': 'connection refused — the server is not running or the port is closed',
  /** Причина: ответ не пришёл за отведённое время. */
  'connect.reason.timeout': 'the server did not respond in time',
  /** Причина: адрес сервера не разрешился (DNS). */
  'connect.reason.dns': 'address not found — check the host name',
  /** Причина: сеть или хост недоступны. */
  'connect.reason.unreachable': 'the server is unreachable over the network — check your connection',
  /** Причина: установленное соединение сброшено другой стороной. */
  'connect.reason.reset': 'connection reset by the server',
  /** Причина: сервер отклонил API-key. */
  'connect.reason.unauthorized': 'the server rejected the API key — check the key',
  /** Причина: сервер запретил доступ этому пользователю. */
  'connect.reason.forbidden': 'the server denied access — check user permissions',
  /** Причина: слишком много неудачных попыток входа (HTTP 429). */
  'connect.reason.rateLimited': 'too many failed sign-in attempts — try again later',
  /** Причина не распознана: честно сообщаем об этом, а не выдумываем её. */
  'connect.reason.other': 'could not determine the reason for refusal',
  /**
   * Отказ подключения из-за несовместимых версий (0afec967): `%1` — причина
   * по словарю `CLIENT_VERSION_ERROR_REASON`/статусу, `%2` — строка версий
   * `compatibility.facts`. Раньше здесь показывался технический текст main.
   */
  'connect.reason.compatibility': 'versions are incompatible — %1 %2',

  // -- Несовместимость версий: блокирующий диалог (8623b9ff, 0afec967) -----
  /** Заголовок блокирующего диалога несовместимости. */
  'compatibility.dialog.title': 'Client and server versions are incompatible',
  /** Причина: сервер старше встроенного диапазона клиента. */
  'compatibility.reason.serverOutdated': 'The server is older than the client — this server cannot be used.',
  /** Причина: клиент вне диапазона сервера (причина от сервера не пришла). */
  'compatibility.reason.clientOutdated': 'The client does not match the server — this server cannot be used.',
  /** `426`, `details.reason = version-missing`: сервер не получил версию клиента. */
  'compatibility.reason.versionMissing': 'The server did not receive the client version.',
  /** `426`, `details.reason = version-invalid`: версия клиента не разобрана. */
  'compatibility.reason.versionInvalid': 'The server could not parse the client version sent.',
  /** `426`, `details.reason = version-out-of-range`: клиент вне диапазона сервера. */
  'compatibility.reason.versionOutOfRange': 'The client version is outside the range allowed by the server.',
  /** Строка версий: клиент, сервер, требуемый диапазон. */
  'compatibility.facts': 'Client %1, server %2, required %3',
  /** Неизвестная версия/диапазон в строке версий. */
  'compatibility.value.unknown': 'unknown',
  /** Роль не подтверждена или пользователь не администратор (8623b9ff). */
  'compatibility.contactAdmin': 'Contact your server administrator.',
  /** Кнопка копирования версий для передачи администратору. */
  'compatibility.copyVersions': 'Copy versions',
  /** Подтверждение копирования версий. */
  'compatibility.copied': 'Versions copied',
  /** Копирование версий не удалось (буфер обмена недоступен). */
  'compatibility.copyFailed': 'Failed to copy versions.',
  /** Повтор проверки не удался: `%1` — причина отказа подключения. */
  'compatibility.retryFailed': 'Retry failed: %1',
  /** Страница релиза не открылась: `%1` — причина от системы. */
  'compatibility.openFailed': 'Failed to open the release page: %1',
  /** Нет страницы релиза (`download_url`) — открыть нечего. */
  'compatibility.downloadUnavailable': 'The server did not provide a release page — download the client from the project website.',
  /** Кнопка открытия страницы релиза клиента (без автозагрузки). */
  'compatibility.action.updateClient': 'Update client',
  /** Кнопка диалога обновления сервера — только администратору (ca26c59d). */
  'compatibility.action.updateServer': 'Update server',
  /** Повторная проверка совместимости тем же подключением. */
  'compatibility.action.retry': 'Retry',

  // -- Диалог обновления сервера (c9c96e5c, задача ca26c59d) ---------------
  /** Заголовок диалога обновления сервера. */
  'serverUpdate.title': 'Server update',
  /** Пункт меню пользователя для администратора. */
  'userMenu.serverUpdate': 'Server update',
  /** Текущая версия сервера: `%1` — версия. */
  'serverUpdate.current': 'Current version: %1',
  /** Доступная версия: `%1` — версия. */
  'serverUpdate.available': 'Available version: %1',
  /** Обновлений нет (доступная версия не предложена). */
  'serverUpdate.noUpdate': 'No updates',
  /** Канал проверки: `%1` — подпись канала. */
  'serverUpdate.channel': 'Channel: %1',
  /** Подпись канала `stable`. */
  'serverUpdate.channel.stable': 'stable',
  /** Подпись канала `prerelease`. */
  'serverUpdate.channel.prerelease': 'prerelease',
  /** Время последней проверки: `%1` — дата и время. */
  'serverUpdate.checkedAt': 'Checked: %1',
  /** Проверок ещё не было. */
  'serverUpdate.neverChecked': 'No checks yet',
  /** Ошибка последней проверки фида (данные кеша, не сбой действия). */
  'serverUpdate.checkError': 'The last check failed: %1',
  /** Режим развёртывания сервера: `%1` — подпись режима. */
  'serverUpdate.deployment': 'Server mode: %1',
  /** Подпись режима «служба Windows». */
  'serverUpdate.deployment.windowsService': 'Windows service',
  /** Подпись режима «обычный процесс». */
  'serverUpdate.deployment.standalone': 'standalone process (not a service)',
  /** Подпись режима Docker. */
  'serverUpdate.deployment.docker': 'Docker (container)',
  /** Кнопка принудительной проверки обновлений. */
  'serverUpdate.check': 'Check',
  /** Кнопка запуска обновления сервера. */
  'serverUpdate.apply': 'Update server',
  /** Проверка обновлений идёт (наш запрос). */
  'serverUpdate.checking': 'Checking for updates…',
  /** `429`: проверка уже идёт — состояние, а не ошибка. */
  'serverUpdate.checkAlreadyRunning': 'A check is already running — wait for its result.',
  /** Проверка не удалась: `%1` — причина. */
  'serverUpdate.checkFailed': 'Failed to check for updates: %1',
  /** Этап «подготовка» (сервер записал его сам). */
  'serverUpdate.stage.preparing': 'Preparing the job…',
  /** Этап «резервное копирование БД» (сервер записал его сам). */
  'serverUpdate.stage.backingUp': 'Backing up the database…',
  /**
   * Нетерминальный этап, который сервер записать не может (installing,
   * health-check, rolling-back): общая строка без выдуманного имени.
   */
  'serverUpdate.stage.running': 'Update in progress…',
  /** Итог: задание завершено успешно. */
  'serverUpdate.stage.done': 'Update completed',
  /** Итог: задание провалилось. */
  'serverUpdate.stage.failed': 'Update failed',
  /** Ожидание задания на сервере сразу после запуска (пока /progress пуст). */
  'serverUpdate.progress.waiting': 'Waiting for the update job on the server…',
  /** Идёт вызов apply: скачивание установщика и проверка SHA-256 (до 10 минут). */
  'serverUpdate.progress.downloading': 'The server is downloading the installer and verifying SHA-256 — this may take up to 10 minutes…',
  /** Связь прервана во время обновления — сервер останавливается установщиком. */
  'serverUpdate.progress.disconnected': 'Connection to the server was interrupted — this is expected during an update. Waiting for the server to restart.',
  /** После перезапуска сервер вернётся на новой версии. */
  'serverUpdate.progress.reconnect': 'After the restart, the client will reconnect automatically and continue working on the new version.',
  /** Причина сбоя задания: `%1` — серверный текст. */
  'serverUpdate.failure.reason': 'Reason: %1',
  /** Журнал установщика: `%1` — путь. */
  'serverUpdate.failure.journal': 'Installer log: %1',
  /** Архив базы данных: `%1` — путь (сервер пока присылает `null`). */
  'serverUpdate.backupPath': 'Database backup: %1',
  /** Кнопка копирования пути. */
  'serverUpdate.copyPath': 'Copy path',
  /** Подтверждение копирования пути. */
  'serverUpdate.pathCopied': 'Path copied',
  /** Копирование пути не удалось. */
  'serverUpdate.pathCopyFailed': 'Failed to copy the path.',
  /** Заголовок подтверждения обновления: `%1` — целевая версия. */
  'serverUpdate.confirm.title': 'Update the server to version %1?',
  /**
   * Честное описание последствий (элемент c9c96e5c): остановка сервера,
   * бэкап БД, 503/1012 у клиентов, автопереподключение.
   */
  'serverUpdate.confirm.message': 'The server will be stopped, the database will be backed up, the installer will replace the program and start the new version. During the update, clients receive “server is updating” responses (503/1012) and reconnect automatically. Do not turn off the server computer until the update completes.',
  /** Кнопка подтверждения обновления. */
  'serverUpdate.confirm.action': 'Update server',
  /** Пояснение к отказу установщика (`502`, `retryable: false`) — без автоповтора. */
  'serverUpdate.installerFailedNote': 'The server keeps running on the current version. A retry is not offered — check the installer log.',
  /** Docker: автообновление из клиента недоступно (инструкция — полем `instruction`). */
  'serverUpdate.dockerNote': 'The server is deployed in Docker — client-side auto-update is unavailable.',
  /** Инструкция обновления от сервера (Docker). */
  'serverUpdate.instruction': 'Update instruction: %1',
  /** Кнопка копирования команды из инструкции обновления. */
  'serverUpdate.copyInstruction': 'Copy command',
  /** Подтверждение копирования команды. */
  'serverUpdate.instructionCopied': 'Command copied',
  /** Копирование команды не удалось. */
  'serverUpdate.instructionCopyFailed': 'Failed to copy the command.',
  /** Отказ запуска обновления: `%1` — причина. */
  'serverUpdate.applyFailed': 'Failed to start the update: %1',
  /** Причина отказа не пришла от сервера. */
  'serverUpdate.reasonUnknown': 'reason not reported',
  /** Состояние загрузки кеша проверки. */
  'serverUpdate.loading': 'Reading update state…',
  /** Не удалось прочитать состояние обновлений: `%1` — причина. */
  'serverUpdate.loadFailed': 'Failed to read update state: %1',

  // -- Баннер рекомендованной версии клиента (ed068706, b57910b5) ----------
  /** Основная строка баннера: `%1` — рекомендованная сервером версия. */
  'updateBanner.available': 'Version %1 is available',
  /** Вторая строка баннера: `%1` — установленная версия клиента. */
  'updateBanner.current': 'Client %1 is currently running',
  /**
   * Нейтральное состояние `unknown`: проверка не удалась. Это НЕ «обновлений
   * нет» — отсутствие ответа не равно отсутствию обновлений (DoD b57910b5).
   */
  'updateBanner.unknown': 'Failed to check compatibility with the server — a new client version may be available. Work continues.',
  /** Кнопка «Позже»: скрыть напоминание до следующего подключения/вердикта. */
  'updateBanner.dismiss': 'Later',

  // -- Редактор типа -------------------------------------------------------
  /** Подсказка кнопки записи несохранённого типа: диалог остаётся открытым. */
  'typeEditor.saveHint': 'Save the type without closing the dialog',

  // -- Панель «Свойства» (ошибка d720265c) ---------------------------------
  /** Отказ чтения значений: строки сохраняют прежние значения, отказ виден. */
  'properties.valuesReadFailed': 'Failed to read property values — previous values are shown if they were loaded.',
  /** Значение строки не прочитано: прежних значений ещё нет. */
  'properties.valueUnreadable': 'could not be read',

  // -- Язык и настройки ----------------------------------------------------
  'lang.ru': 'Russian',
  /** Отображаемое имя английского языка (каталог `en.ts`, задача d08c422d). */
  'lang.en': 'English',
  /** Отображаемое имя китайского языка (каталог `zh.ts`, задача f7dba88c). */
  'lang.zh': 'Chinese',
  /** Заголовок объединённого диалога настроек (все разделы). */
  'settings.title': 'All settings',
  'settings.language': 'Language',
  'settings.languageHint': 'Interface language. Applies to this client only.',
  /**
   * Эффективный язык недоступен в сборке (задача e6374cd1): интерфейс уже
   * показан на исходном `ru`, сообщение объясняет почему. Подстановка — код
   * запрошенного языка.
   */
  'settings.langUnavailable': 'The “%1” language catalog is unavailable in this build. The interface is shown in Russian.',

  // -- «О программе» -------------------------------------------------------
  /** Заголовок раздела сторонних компонентов. */
  'about.thirdParty': 'Third-party components',
  /** Подпись ссылки на сайт библиотеки. */
  'about.website': 'Website',
  /** Пояснение, где лежит полный перечень с текстами лицензий. */
  'about.thirdPartyHint': 'The full list with license texts is in the THIRD-PARTY-NOTICES.txt file.',

  // -- Дерево списков (lib/ui/tree.ts) -------------------------------------
  /** Пустое состояние дерева, когда видимых строк нет. */
  'tree.empty': 'Nothing found',
  /** Подсказка пустого состояния дерева. */
  'tree.emptyHint': 'Change the filter query.',
  /** Подсказка каретки раскрытия/сворачивания ветви дерева. */
  'tree.toggle': 'Expand/collapse',

  // -- Объединённый каталог типов и свойств (screens/type-catalogue.ts) ----
  /** Заголовок объединённого диалога каталога (задача 979761cd). */
  'catalogue.title': 'Thought network types and properties',
  /** Подпись вкладки списка типов мыслей. */
  'catalogue.tab.thoughtTypes': 'Thought types',
  /** Подпись вкладки списка свойств мыслей. */
  'catalogue.tab.properties': 'Thought properties',
  /** Подпись вкладки списка типов связей. */
  'catalogue.tab.linkTypes': 'Link types',

  // -- Дерево типов мыслей (screens/type-manager.ts) -----------------------
  /** Заголовок диалога «Типы мыслей». */
  'thoughtTypes.title': 'Thought types',
  /** Заголовок древовидной колонки списка типов мыслей. */
  'thoughtTypes.col.name': 'Type',
  /** Заголовок колонки комментария типа. */
  'thoughtTypes.col.comment': 'Comment',
  /** Заголовок колонки количества мыслей типа. */
  'thoughtTypes.col.count': 'Count',
  /** Кнопка создания типа. */
  'thoughtTypes.add': 'Add',
  /** Подсказка кнопки создания типа. */
  'thoughtTypes.addHint': 'Create type',
  /** Свернуть всю иерархию типов. */
  'thoughtTypes.collapseAll': 'Collapse all',
  /** Развернуть всю иерархию типов. */
  'thoughtTypes.expandAll': 'Expand all',
  /** Пустое состояние списка типов мыслей. */
  'thoughtTypes.empty': 'No types yet',
  /** Подсказка пустого состояния списка типов мыслей. */
  'thoughtTypes.emptyHint': 'Create the first type with the Add button.',
  /** Подсказка кнопки удаления типа. */
  'thoughtTypes.delete': 'Delete type',
  /** Вопрос подтверждения удаления типа (подстановка — имя типа). */
  'thoughtTypes.deleteConfirm': 'Delete type “%1”? Thoughts of this type will remain and become untyped; property values of this type will be deleted.',

  // -- Редактор типа мысли (screens/type-manager.ts) -----------------------
  /** Первая вкладка редактора типа: имя/родитель вынесены в шапку, здесь —
   *  описание, шаблон комментария и метаданные. */
  'typeEditor.tab.basic': 'General',
  /** Вкладка со свойствами типа (собственными и унаследованными). */
  'typeEditor.tab.properties': 'Properties',
  /** Вкладка отборов типа. */
  'typeEditor.tab.views': 'Views',
  /** Сворачиваемая группа шаблона постоянного комментария. */
  'typeEditor.group.template': 'Template',
  /** Сворачиваемая группа метаданных типа. */
  'typeEditor.group.metadata': 'Metadata',
  /** Сворачиваемая группа свойств, унаследованных от родительских типов. */
  'typeEditor.group.inherited': 'Properties inherited from parent types',
  /** Сворачиваемая группа свойств, принадлежащих самому типу. */
  'typeEditor.group.own': 'Properties owned by this type',
  /** Кнопка подключения свойства к типу. */
  'typeEditor.addProperty': 'Add property…',
  /** Подсказка кнопки подключения свойства. */
  'typeEditor.addPropertyHint': 'Attach a property from the network property registry (a new one is created with the Create property button in the picker dialog)',

  // -- Дерево типов связей (screens/property-manager.ts) -------------------
  /** Заголовок диалога «Типы связей». */
  'linkTypes.title': 'Link types',
  /** Заголовок древовидной колонки списка типов связей. */
  'linkTypes.col.name': 'Name (from source to target / reverse)',
  /** Заголовок колонки подключения типа связи к типам. */
  'linkTypes.col.connected': 'Attached to types',
  /** Пустое состояние списка типов связей. */
  'linkTypes.empty': 'No link types yet',
  /** Подсказка пустого состояния списка типов связей. */
  'linkTypes.emptyHint': 'Create the first link type with the Add button.',
  /** Кнопка добавления (создаёт свойство-связь с парой имён сторон). */
  'linkTypes.add': 'Add',
  /** Подсказка кнопки добавления. */
  'linkTypes.addHint': 'Create link property',
  /** Метка строки типа связи без зарегистрированного свойства. */
  'linkTypes.noProperty': 'no property',

  // -- Меню «Мыслесеть» (screens/workspace-menus.ts) -----------------------
  // Терминология (требование fc00129d): «мыслесеть» вместо «сеть» в пунктах
  // меню; счётчики — подстановкой из уже загруженных данных store.
  /** Участники мыслесети — диалог состава. */
  'netMenu.members': 'Thought network members',
  /** Выйти из мыслесети (не владелец). */
  'netMenu.leave': 'Leave thought network',
  /** Дерево типов мыслей с числом типов (подстановка — счётчик). */
  'netMenu.thoughtTypes': 'Thought types (%1)',
  /** Дерево типов связей с числом типов (подстановка — счётчик). */
  'netMenu.linkTypes': 'Link types (%1)',
  /** Общий список свойств мыслей с числом свойств (подстановка — счётчик). */
  'netMenu.properties': 'Thought properties (%1)',
  /** Корзина с числом помеченных сущностей (подстановка — счётчик). */
  'netMenu.trash': 'Basket (%1)',
  /** Раздел «Мыслесеть» объединённого диалога настроек. */
  'netMenu.settings': 'Thought network settings',
  /** Статистика мыслесети — сводка по открытой мыслесети. */
  'netMenu.statistics': 'Thought network statistics',
  /** Показать скрытый редактор мысли. */
  'netMenu.showEditor': 'Show thought editor',
  /** Скрыть показанный редактор мысли. */
  'netMenu.hideEditor': 'Hide thought editor',

  // -- Пользовательское меню (screens/workspace-menus.ts) ------------------
  /** Админ-панель (только для админа). */
  'userMenu.admin': 'Administration',
  /** Вернуться к списку мыслесетей (команда уровня пользователя, a9cb53dd). */
  'userMenu.openNetwork': 'Open thought network (list)',
  /** Создать новую мыслесеть (команда уровня пользователя, a9cb53dd). */
  'userMenu.createNetwork': 'Create thought network',
  /** Объединённый диалог настроек на вкладке «Пользователь». */
  'userMenu.settings': 'Settings',
  /** Информационный диалог «О программе» (восстановлен, ошибка 0e623d4c). */
  'userMenu.about': 'About',
  /** Отключиться от сервера. */
  'userMenu.disconnect': 'Disconnect',

  // -- Меню слоёв (screens/layers.ts) --------------------------------------
  /** Подпись базового слоя в списке выбора. */
  'layers.menu.base': 'Base',
  /** Винительный падеж «Основу» — цель слияния/диффа, когда родитель не найден. */
  'layers.menu.baseTo': 'To Base',
  /** Создать новый слой изменений. */
  'layers.menu.create': 'Create new layer…',
  /** Свойства базового слоя. */
  'layers.menu.propsBase': 'Base properties…',
  /** Свойства текущего (не базового) слоя. */
  'layers.menu.propsLayer': 'Layer properties…',
  /** Дифф слоя (подстановка — имя целевого слоя). */
  'layers.menu.diff': 'Diff from “%1”…',
  /** Слияние слоя (подстановки — имя слоя, имя цели). */
  'layers.menu.merge': 'Merge “%1” into “%2”…',
  /** Удаление слоя (подстановка — имя слоя). */
  'layers.menu.delete': 'Delete “%1”…',

  // -- Меню строки и чипов хроники (screens/chronicle/chronicle.ts) --------
  /** Добавить новую запись хроники. */
  'chrono.menu.add': 'Add',
  /** Скопировать запись хроники. */
  'chrono.menu.copy': 'Copy',
  /** Открыть сущность чипа. */
  'chrono.menu.open': 'Open',
  /** Открыть запись на экране «Дневник» (вкладка редактора). */
  'chrono.menu.openInDiary': 'Open in diary',
  /** Отвязать чип от записи. */
  'chrono.menu.detach': 'Unlink',
  /** Привязать мысль к записи. */
  'chrono.menu.attach': 'Link to…',
  /** Заголовок колонки «действует с». */
  'chrono.col.from': 'From',
  /** Заголовок колонки «действует по». */
  'chrono.col.to': 'To',
  /** Заголовок колонки заголовка записи. */
  'chrono.col.title': 'Title',
  /** Заголовок колонки привязок (мысли и связи). */
  'chrono.col.targets': 'Thoughts/links',
  /** Заголовок колонки автора записи. */
  'chrono.col.author': 'Author',
  /** Заголовок колонки даты создания. */
  'chrono.col.created': 'Created',
  /** Заголовок колонки даты изменения. */
  'chrono.col.updated': 'Updated',
  /** Заголовок колонки краткого текста. */
  'chrono.col.snippet': 'Summary',
  /** Заголовок колонки периода записи (вкладка «Дневник» редактора). */
  'chrono.col.period': 'Period',
  /** Заголовок колонки редактора записи (последний изменивший). */
  'chrono.col.editor': 'Editor',
  /** Пустое состояние нижней области вкладки (ничего не выделено). */
  'chrono.emptyEditor': 'No diary entries. Click Add to create a new entry.',
  /** Пустое состояние таблицы хроники. */
  'chrono.empty': 'No chronological comments',
  /** Подсказка пустого состояния таблицы хроники. */
  'chrono.emptyHint': 'Add the first entry with the Add command.',
  /** ARIA-подпись таблицы хроники. */
  'chrono.aria': 'Chronological comments',
  /** Диапазон видимых записей хроники (подстановки — от, до, всего). */
  'chrono.pager.range': 'Entries %1–%2 of %3',

  // -- Экран «Дневник» (screens/chronicle/chronicle.ts, 0.10.1) -------------
  /** Кнопка «Добавить запись дневника» в sticky-панели. */
  'diary.addRecord': 'Add diary entry',
  /** Пустое состояние ленты дневника. */
  'diary.feedEmpty': 'No diary entries. Add the first one.',
  /** Индикатор остатка ленты (подстановки — показано, всего). */
  'diary.moreLeft': '%1 of %2 shown — scroll to load more.',
  /** Плейсхолдер заголовка записи. */
  'diary.titlePlaceholder': 'Title',
  /** Пустая запись: приглашение войти в правку двойным кликом (0.10.1, приёмка №2). */
  'diary.emptyRecordHint': 'The entry text is empty — double-click to add.',
  /** Заголовок записи без названия и без текста (0.10.2, задача 41ed99ab). */
  'diary.emptyTitle': 'Empty entry',
  /** Подсказка заголовка записи: вход в правку двойным кликом (0.10.2). */
  'diary.titleEditHint': 'Double-click to edit the title',
  /** Кнопки сворачивания групп дат ленты и записей («Развернуть все»/«Свернуть все»). */
  'diary.expandAll': 'Expand all',
  'diary.collapseAll': 'Collapse all',
  /** Команды контекстного меню группы дня: свернуть/развернуть записи дня (0.10.2). */
  'diary.collapseDayRecords': 'Collapse day entries',
  'diary.expandDayRecords': 'Expand day entries',
  /** Не удалось загрузить запись (подстановка — причина). */
  'diary.loadFailed': 'Failed to load the entry: %1',
  /** Не удалось пересчитать счётчики календаря (подстановка — причина). */
  'diary.countsFailed': 'Failed to recalculate calendar marks: %1',
  /** Не удалось сохранить запись (подстановка — причина). */
  'diary.saveFailed': 'Failed to save: %1',
  /** Не удалось создать запись (подстановка — причина). */
  'diary.createFailed': 'Failed to create the entry: %1',
  /** Заголовок подтверждения удаления записи. */
  'diary.deleteTitle': 'Delete entry',
  /** Вопрос подтверждения удаления записи. */
  'diary.deleteQuestion': 'Delete the diary entry?',
  /** Не удалось удалить запись (подстановка — причина). */
  'diary.deleteFailed': 'Failed to delete: %1',
  /** Не удалось дублировать запись (подстановка — причина). */
  'diary.duplicateFailed': 'Failed to duplicate the entry: %1',
  /** Заголовок подтверждения снятия последней привязки. */
  'diary.detachTitle': 'Unlink',
  /** Вопрос подтверждения снятия последней привязки. */
  'diary.detachQuestion': 'The entry will remain in the diary without links to thoughts.',
  /** Не удалось снять привязку (подстановка — причина). */
  'diary.detachFailed': 'Failed to unlink: %1',
  /** Не удалось привязать мысль (подстановка — причина). */
  'diary.attachFailed': 'Failed to link the thought: %1',
  /** Мысль уже привязана к записи. */
  'diary.alreadyAttached': 'The thought is already linked to this entry.',
  // -- Строка поиска дневниковых записей (lib/record-search.ts, 0.10.1) ------
  /** Плейсхолдер строки поиска записей. */
  'recordSearch.placeholder': 'Search entries: report* -draft*',
  /** Доступное имя строки поиска записей. */
  'recordSearch.aria': 'Search diary entries',
  /** Кнопка настроек строки поиска записей. */
  'recordSearch.settings': 'Search settings',
  /** Опция настроек: показывать записи, привязанные к неактуальным мыслям. */
  'recordSearch.includeInactive': 'include inactive thoughts',
  /** Опция настроек: показывать записи, привязанные к мыслям из корзины. */
  'recordSearch.includeTrashed': 'include basket',
  /** Подсказка при коротком запросе (подстановка — минимум символов). */
  'recordSearch.tooShort': 'Enter a query (at least %1 characters).',
  /** Ошибка поиска записей (подстановка — причина). */
  'recordSearch.failed': 'Entry search failed',
  /** Пустой результат поиска записей. */
  'recordSearch.empty': 'Nothing found.',
  /** Заголовок списка найденных записей. */
  'recordSearch.results': 'Matching entries',
  /** Запись без заголовка в результатах. */
  'recordSearch.untitled': 'Entry',

  // -- Общее выделение -----------------------------------------------------
  /** Добавить мысль к выделению (меню чипов хроники). */
  'selection.add': 'Add to selection',
  /** Убрать мысль из выделенного. */
  'selection.remove': 'Remove from selection',
  /** Строка панели выделенных для подтверждённо отсутствующей мысли (b213cf60). */
  'selection.unavailable': 'unavailable',

  // -- Диалоги панели выделения (0.14.1, задача 6ebcd8d6) ------------------
  /** Пикер «без типа» (тип связи/мысли). */
  'selection.picker.noType': 'No type',
  /** Заголовок диалога выбора типа мысли. */
  'selection.thoughtType.title': 'Change thought type',
  /** Общий заголовок пикера строки (кнопка «Выбрать»). */
  'selection.picker.select': 'Select',
  /** Заголовок диалога массового изменения значений свойств. */
  'selection.properties.title': 'Property values of selected thoughts',
  /** Строка загрузки данных диалога. */
  'selection.properties.loading': 'Loading…',
  /** Кнопка «+ свойство» — добавить строку из справочника сети. */
  'selection.properties.add': '+ property',
  /** Подсказка кнопки «+ свойство». */
  'selection.properties.addHint': 'Add a property from the network property registry',
  /** Заголовок пикера свойства. */
  'selection.properties.addTitle': 'Add property',
  /** Пустая таблица: у выделенных нет значений свойств. */
  'selection.properties.empty': 'Selected thoughts have no property values — add one (+)',
  /** Усечение выделения до предела обработки (обработаны первые %1 из %2). */
  'selection.properties.truncated': 'The first %1 of %2 selected thoughts were processed',
  /** Колонка имени свойства. */
  'selection.properties.columnProperty': 'Property',
  /** Колонка значения свойства. */
  'selection.properties.columnValue': 'Value',
  /** Счётчик присутствия свойства у выделенных (K из N). */
  'selection.properties.present': 'present in %1 of %2',
  /** Подпись поля, когда наличные значения различаются. */
  'selection.properties.different': 'different values',
  /** Подпись строки без галочки: введённое не применится. */
  'selection.properties.notApplied': 'will not be applied',
  /** Пометка отмеченной пустой строки: значение будет очищено у K мыслей. */
  'selection.properties.willClear': 'will be cleared in %1',
  /** Заголовок подтверждения очистки. */
  'selection.properties.clearTitle': 'Clear values',
  /** Вопрос подтверждения очистки (K мыслей). */
  'selection.properties.clearMessage': 'Clear values in %1 thoughts?',
  /** Кнопка подтверждения очистки. */
  'selection.properties.clearConfirm': 'Clear',
  /** Итог применения: применено операций. */
  'selection.properties.applied': 'Operations applied: %1',
  /** Итог применения: не удалось. */
  'selection.properties.failed': 'failed: %1',
  /** Заголовок списка причин отказа. */
  'selection.properties.applyFailed': 'Failed to change property values',
  /** Одна причина отказа: мысль, свойство «…», причина. */
  'selection.properties.failureLine': '%1, property “%2”: %3',
  /** Хвост списка причин (ещё N строк). */
  'selection.properties.failureMore': '…and %1 more',
  /** Заголовок подтверждения закрытия формы с неприменёнными правками. */
  'selection.properties.dirtyTitle': 'Unapplied changes',
  /** Вопрос подтверждения закрытия: семантика диалога — «применить», не «сохранить». */
  'selection.properties.dirtyMessage': 'Apply changes?',
  /** Кнопка «Не применять»: закрыть форму, отбросив правки. */
  'selection.properties.dirtyDiscard': 'Don\'t apply',
  /** Пустой план: выделенные мысли не прочитаны — применять не к кому. */
  'selection.properties.nothingToApplyNoThoughts': 'Nothing to apply: selected thoughts were not read. Close and reopen the dialog.',
  /** Пустой план: ни одна строка не отмечена. */
  'selection.properties.nothingToApplyNoRows': 'Nothing to apply: no row is checked. Check the property you need.',
  /** Пустой план: отмеченные строки пусты, очищать нечего (молчаливый no-op). */
  'selection.properties.nothingToApplyEmpty': 'Nothing to apply: checked rows have no values and there is nothing to clear. Enter a value or uncheck the row.',
  /** Отмеченные строки без значения, когда очищать нечего: их не применили. */
  'selection.properties.skippedCount': 'rows skipped: %1',
  /** Заголовок списка отмеченных строк без значения. */
  'selection.properties.skippedTitle': 'Rows without a value',
  /** Строка отчёта: свойство без значения и без данных для очистки. */
  'selection.properties.skippedLine': '“%1”: value is not set and there is nothing to clear',

  // -- Меню команд отбора (screens/structures/commands.ts) -----------------
  'structures.cmd.addSelected': 'Add to selection',
  'structures.cmd.removeSelected': 'Remove from selection',
  'structures.cmd.setActive': 'Make active',
  'structures.cmd.setInactive': 'Make inactive',
  'structures.cmd.changeType': 'Change thought type…',
  'structures.cmd.linkParents': 'Add parent thoughts…',
  'structures.cmd.onlyParents': 'Make only parents…',
  'structures.cmd.unlinkParents': 'Unlink from parents…',
  'structures.cmd.linkChildren': 'Add child thoughts…',
  'structures.cmd.unlinkChildren': 'Unlink from children…',

  // -- Меню вложений (editor/attachments.ts) ------------------------------
  /** Открыть вложение программой по умолчанию. */
  'attachments.menu.openDefault': 'Open in default app',
  /** Назначить вложение иконкой мысли. */
  'attachments.menu.assignIcon': 'Set as thought icon',
  /** Переименовать вложение (общий заголовок, доступно всем владельцам). */
  'attachments.menu.rename': 'Rename…',
  /** Перенести вложение в другую мысль. */
  'attachments.menu.move': 'Move to thought…',
  /** Скопировать вложение в другие мысли. */
  'attachments.menu.copy': 'Copy to thoughts…',
  /** Снять своё владение вложением (не удаление самого вложения). */
  'attachments.menu.delete': 'Delete…',

  // -- Строка списка вложений: действия, владельцы, снятие (0.12.1) ---------
  /** Кнопка-иконка «Переименовать» в строке списка вложений. */
  'attachments.row.rename': 'Rename',
  /** Кнопка-иконка «Снять владение» в строке списка вложений. */
  'attachments.row.remove': 'Remove ownership',
  /** Ошибка переименования вложения. */
  'attachments.rename.failed': 'Failed to rename',
  /** Диалог снятия владения: заголовок. */
  'attachments.remove.title': 'Remove ownership',
  /** Диалог снятия владения: вопрос (подстановка — название вложения). */
  'attachments.remove.message': 'Remove attachment “%1” from this object?',
  /** Дополнение к диалогу, если у вложения есть другие владельцы. */
  'attachments.remove.shared': 'The attachment has other owners — it will remain with them.',
  /** Запрет снятия (409): вложение — своя иконка/обложка объекта. */
  'attachments.remove.iconBlocked': 'The attachment is used as the icon (or cover) of this object. Change or clear the icon first, then retry the removal.',
  /** Ошибка снятия владения вложением. */
  'attachments.remove.failed': 'Failed to remove ownership',
  /** Ошибка добавления владельца вложению при выборе чужой картинки (0.12.1). */
  'attachments.owner.add.failed': 'Failed to add the attachment owner',
  /** Запрет снятия (409) в диалоге обложки: вложение — своя обложка. */
  'publication.cover.removeOwnerBlocked': 'The attachment is the cover of this publication. Change or clear the cover first, then retry the removal.',
  /** Бейдж общего вложения: единственный владелец. */
  'attachments.owners.one': '1 owner',
  /** Бейдж общего вложения: 2–4 владельца. */
  'attachments.owners.few': '%1 owners',
  /** Бейдж общего вложения: 5 и более владельцев. */
  'attachments.owners.many': '%1 owners',
  /** Подсказка бейджа владельцев. */
  'attachments.owners.tooltip': 'The attachment belongs to several objects',
  /** Подсказка просмотрщика вложения, когда ничего не выбрано. */
  'attachments.viewer.hint': 'Select an attachment to preview.',
  /** Ошибка добавления владельца при переносе вложения в другую мысль. */
  'attachments.move.failed': 'Failed to move',
  /** Перенос: добавлено новому владельцу, но снять прежнее владение не удалось. */
  'attachments.move.removeFailed': 'The attachment was added to the new thought, but the previous ownership could not be removed',
  /** Перенос: 409 — вложение является иконкой (обложкой) текущего объекта. */
  'attachments.move.iconBlocked': 'The attachment is the icon (or cover) of this object. It was added to the new thought but not removed from the current object. Change or clear the icon first, then retry the move.',
  /** Ошибка копирования вложения в другие мысли. */
  'attachments.copy.failed': 'Failed to copy',
  /** Итог копирования: ровно одна мысль. */
  'attachments.copy.one': 'Copied to 1 thought',
  /** Итог копирования: 2–4 мысли. */
  'attachments.copy.few': 'Copied to %1 thoughts',
  /** Итог копирования: 5 и более мыслей. */
  'attachments.copy.many': 'Copied to %1 thoughts',
  /** Итог копирования: сколько мыслей уже владели вложением. */
  'attachments.copy.skipped': 'already in %1',

  // -- Общий компонент выбора вложения (editor/attachment-picker.ts) --------
  /** Поле поиска вложений. */
  'attachments.picker.search': 'Search attachments',
  /** Кнопка загрузки вложения из файла. */
  'attachments.picker.upload': 'Upload from file',
  /** Подсказка пустого предпросмотра. */
  'attachments.picker.preview': 'Preview',
  /** Пустой список вложений-картинок. */
  'attachments.picker.empty': 'No image attachments found.',
  /** Кнопка догрузки следующей страницы списка. */
  'attachments.picker.more': 'Show more',
  /** Ошибка чтения файла-вложения при превращении в иконку. */
  'attachments.picker.readError': 'Failed to read the attachment file.',

  // -- Строки списочных экранов этапа 2 (остатки) --------------------------
  /** Кнопка обслуживания журнала: свёртка до даты. */
  'activity.toolbar.rollup': 'Roll up to date…',
  /** Кнопка обслуживания журнала: обрезка до даты. */
  'activity.toolbar.truncate': 'Truncate to date…',
  /** Пустое состояние постраничной навигации ленты. */
  'activity.pager.empty': 'No events',
  /** Диапазон видимых записей ленты (подстановки — от, до, всего). */
  'activity.pager.range': 'Entries %1–%2 of %3',
  /** Подпись тулбара массового переключения в диалоге группового удаления. */
  'trash.group.toggle': 'Switch:',
  /** Массовый переключатель: все строки в корзину. */
  'trash.group.allToTrash': 'all to basket',
  /** Массовый переключатель: удалять возможное, остальное в корзину. */
  'trash.group.deletePossible': 'delete where possible',
  /** Подпись radio-приёмки строки: поместить в корзину. */
  'trash.group.toTrash': 'To basket',
  /** Подпись radio-приёмки заблокированной строки: удалить нельзя. */
  'trash.group.purgeBlocked': 'Delete (unavailable)',
  /** Кнопка строки корзины: вернуть из корзины. */
  'trash.action.restore': 'Restore from basket',
  /** Вкладка админ-панели: участники (пользователи). */
  'admin.tab.users': 'Users',
  /** Вкладка админ-панели: сети. */
  'admin.tab.networks': 'Networks',
  /** Вкладка админ-панели: журнал аудита. */
  'admin.tab.audit': 'Audit',

  // -- Диалог «Статистика мыслесети» (screens/network-stats.ts) -------------
  /** Заголовок диалога и пункта меню «Мыслесеть». */
  'stats.title': 'Thought network statistics',
  /** ARIA-подпись таблицы статистики. */
  'stats.table.aria': 'Thought network metrics',
  /** Колонка «Показатель». */
  'stats.col.indicator': 'Metric',
  /** Колонка «Количество всего». */
  'stats.col.total': 'Total count',
  /** Колонка «Актуальных». */
  'stats.col.active': 'Active',
  /** Колонка «Не актуальных». */
  'stats.col.inactive': 'Inactive',
  /** Колонка «В корзине». */
  'stats.col.trashed': 'In basket',
  /** Строка «Типы мыслей». */
  'stats.row.thoughtTypes': 'Thought types',
  /** Строка «Типы связей». */
  'stats.row.linkTypes': 'Link types',
  /** Строка «Свойства мыслей». */
  'stats.row.properties': 'Thought properties',
  /** Строка «Мысли». */
  'stats.row.thoughts': 'Thoughts',
  /** Строка «Связи». */
  'stats.row.links': 'Links',
  /** Строка «Публикации». */
  'stats.row.publications': 'Publications',
  /** Строка «Полки». */
  'stats.row.shelves': 'Shelves',
  /** Строка «Слои». */
  'stats.row.layers': 'Layers',
  /** Итог по вложениям (подстановки — всего, файлов, размер). */
  'stats.attachments': 'Attachments: %1, files %2, total size %3',

  // -- Публикации: библиотека (0.11.1, задача a3cfc018) ---------------------
  /** Заголовок экрана и вида. */
  'publications.title': 'Publications',
  /** Плейсхолдер поиска по библиотеке. */
  'publications.search': 'Search by title…',
  /** Кнопка создания публикации. */
  'publications.new': 'Publication',
  /** Кнопка создания полки. */
  'publications.newShelf': 'Shelf',
  /** Подсказка кнопки создания полки (задача 55ee3c85). */
  'publications.newShelfHint': 'Create a new shelf',
  /** Подсказка кнопки создания публикации (задача 55ee3c85). */
  'publications.newHint': 'Create a publication with the wizard',
  /** Заголовок диалога создания полки (ошибка 87ad669a). */
  'publications.shelf.create': 'New shelf',
  /** Подпись поля имени новой полки. */
  'publications.shelf.name': 'Shelf name',
  /** Пустое состояние полки без публикаций (ошибка 87ad669a). */
  'publications.shelf.empty': 'No publications on the shelf yet',
  /** Сегмент вида «полки». */
  'publications.view.shelves': 'Shelves',
  /** Сегмент вида «список». */
  'publications.view.list': 'List',
  /** Подпись кнопки сортировки. */
  'publications.sort': 'Sort',
  /** Подсказка сортировки: что именно сортируется (задача 55ee3c85). */
  'publications.sort.hint': 'Sort publications within shelves; the order of shelves themselves is custom',
  'publications.sort.manual': 'Manual',
  'publications.sort.title': 'By title',
  'publications.sort.date': 'By assembly date',
  'publications.sort.author': 'By author',
  /** Кнопка панели фильтров. */
  'publications.filters': 'Filters',
  'publications.active.true': 'Active',
  'publications.active.false': 'Inactive',
  'publications.active.any': 'All',
  /** Пункт «показать все полки». */
  'publications.shelf.all': 'All shelves',
  /** Полка публикаций, не входящих в полки (вид «список»/«полки»). */
  'publications.shelf.none': 'No shelf',
  /** Пустое состояние библиотеки. */
  'publications.empty': 'No publications yet',
  'publications.emptyHint': 'Create the first publication with the wizard.',
  /** Пустое состояние поиска/фильтра. */
  'publications.emptySearch': 'Nothing found',
  /** Ошибка загрузки списка. */
  'publications.error': 'Failed to load publications',
  /** Бейдж «+N новых» (подстановка — число). */
  'publications.newBadge': '+%1 new',
  /** Пагинация списка. */
  'publications.prev': 'Back',
  'publications.next': 'Next',
  'publications.page': '%1–%2 of %3',
  /** Контекстное меню публикации. */
  'publications.menu.export': 'Export',
  'publications.menu.exportMd': 'Export to Markdown',
  'publications.menu.exportHtml': 'Export to HTML',
  'publications.menu.exportPdf': 'Export to PDF',
  // Тост-уведомления экспорта (задача 77cce0ba, п.4): успех с путём и сбой с
  // причиной — по образцу прочих тостов клиента.
  'publications.export.saved': 'Publication saved: %1',
  'publications.export.saveFailed': 'Failed to save the file: %1',
  'publications.export.failed': 'Export failed.',
  'publications.export.failedReason': 'Export failed: %1',
  /** Пункты контекстного меню публикации (задачи 00160da1, b51dbca4):
   *  открыть карточку, удалить, читать, экспортировать. */
  'publications.menu.open': 'Open',
  'publications.menu.read': 'Read',
  'publications.menu.delete': 'Delete',
  /** Контекстное меню полки и inline-переименование. */
  'publications.shelf.rename': 'Rename shelf',
  /** Команда меню полки: создать публикацию с предвыбранной полкой (задача 55ee3c85). */
  'publications.menu.addPublication': 'Add publication',
  /** Диалог удаления публикации/полки (задача 00160da1). */
  'publications.delete.publicationTitle': 'Deleting publication “%1”',
  'publications.delete.shelfTitle': 'Deleting shelf “%1”',
  'publications.delete.reasonProperties': 'Cannot delete permanently — the publication is used in properties (%1).',
  'publications.delete.reasonBase': 'Cannot delete permanently — the publication exists in Base: in a layer it can only be moved to the basket.',
  'publications.delete.reasonLayers': 'Cannot delete permanently — the publication is changed in layers: %1.',
  'publications.delete.reasonShelfBase': 'Cannot delete permanently — the shelf exists in Base: in a layer it can only be moved to the basket.',
  /** Мастер создания публикации. */
  'publications.wizard.title': 'New publication',
  'publications.wizard.meta': 'Title',
  'publications.wizard.recipe': 'Header selection',
  'publications.wizard.texts': 'Text properties',
  'publications.wizard.create': 'Create',
  'publications.wizard.fTitle': 'Title',
  'publications.wizard.fSubtitle': 'Subtitle',
  'publications.wizard.fAuthor': 'Author',
  'publications.wizard.fShelf': 'Shelf',
  'publications.wizard.noShelf': 'No shelf',
  'publications.wizard.fTextsHint': 'Comments of the thoughts in these properties form the section text. This step can be skipped.',
  'publications.wizard.titleRequired': 'Enter a publication title.',

  // -- Публикации: рабочая область открытой публикации (0.11.1, задача 4f03b9d5) --
  /** Кнопка возврата в библиотеку (шапка рабочей области). */
  'publications.ws.back': 'Back',
  'publications.ws.rebuild': 'Rebuild',
  /** Подсветка «Пересобрать»: живой текст устарел (замечание А2 приёмки b02ef1cf). */
  'publications.ws.rebuildStale': 'Live text is outdated — rebuild the document',
  'publications.ws.export': 'Export',
  /** Кликабельный заголовок публикации (задача b51dbca4). */
  'publications.ws.openCard': 'Open publication card',
  /** Кнопки тулбара «Свернуть все»/«Развернуть все» по разделам. */
  'publications.ws.collapseAll': 'Collapse all',
  'publications.ws.expandAll': 'Expand all',
  /** Каретка-экспандер раздела в теле документа. */
  'publications.ws.sectionCollapse': 'Collapse section',
  'publications.ws.sectionExpand': 'Expand section',
  /** Оглавление документа. */
  'publications.ws.toc': 'Table of contents',
  'publications.ws.tocCollapse': 'Collapse table of contents',
  'publications.ws.tocExpand': 'Expand table of contents',
  /** Подпись строки текста раздела в оглавлении (подстановка — номер текста). */
  'publications.ws.text': 'Text %1',
  /** Пометки раздела. */
  'publications.ws.repeat': 'Repeated occurrence',
  'publications.ws.cycle': 'Cycle break',
  /** Ручной порядок: ручка-аффорданс и подсказка про клавиатуру (d13fd645). */
  'publications.ws.dragHandle': 'Drag to reorder',
  'publications.ws.dragKeyboardHint': 'Drag with the mouse or move with Alt+↑/↓',
  /** Контекстное меню раздела/текста. */
  'publications.ws.openThought': 'Open thought',
  'publications.ws.exclude': 'Exclude',
  'publications.ws.restore': 'Restore',
  'publications.ws.createSection': 'Create subsection',
  'publications.ws.createText': 'Create text',
  /** Плашка новых кандидатов (подстановка — число). */
  'publications.ws.candidates': '+%1 new thoughts matching the view',
  'publications.ws.candidatesEmpty': 'No new candidates found',
  /** Действия над кандидатом: расставить в конец / скрыть (исключить). */
  'publications.ws.place': 'Place (at the end)',
  'publications.ws.hide': 'Hide',
  /** Блок «дополнительные материалы». */
  'publications.ws.extra': 'Additional materials',
  /** Пагинация разделов (подстановки — с, по, всего). */
  'publications.ws.prev': 'Previous',
  'publications.ws.next': 'Next',
  'publications.ws.page': 'Sections %1–%2 of %3',
  /** Состояния и предупреждения документа. */
  'publications.ws.loadError': 'Failed to load the document',
  'publications.ws.retry': 'Retry',
  'publications.ws.noTextSources': 'The publication has no text properties configured.',
  // Пустой отбор заголовков (задача 7cfaba7c, п.2): сервер отдаёт пустую сборку
  // с предупреждением — документ показывает это состояние, а не пустую страницу.
  'publications.ws.emptyRecipe': 'The recipe has no conditions — add view conditions to the recipe.',
  'publications.ws.createMiss': 'The thought was created but did not match the publication view.',
  /** Ширина колонки текста документа — подсказка ползунка (ea1b5f14, п. 5). */
  'publications.ws.textWidth': 'Text width',
  /** Контекстное меню блока документа (ea1b5f14, п. 3). */
  'publications.block.menu': 'In publication',
  'publications.block.moveUp': 'Move up',
  'publications.block.moveDown': 'Move down',
  // Пункты меню общего переупорядочивания строк (0.14.1, задача 223f7d50).
  'rowReorder.moveUp': 'Move up',
  'rowReorder.moveDown': 'Move down',
  // Демо-стенд компоненты row-reorder (временный, только по хэшу).
  'rowReorderDemo.title': 'row-reorder — component prototype',
  'rowReorderDemo.hint': 'Drag a row by its name, use Alt+↑/↓ or the name context menu. Esc cancels dragging.',
  'rowReorderDemo.statusInitial': 'Order: initial.',
  'rowReorderDemo.status': 'Order: %1.',
  'rowReorderDemo.foot': 'Demo stand: the order is stored only on the page, the server is not called.',
  'rowReorderDemo.value': 'value %1',
  'rowReorderDemo.name.1': 'Alpha',
  'rowReorderDemo.name.2': 'Beta',
  'rowReorderDemo.name.3': 'Gamma',
  'rowReorderDemo.name.4': 'Delta',
  'rowReorderDemo.name.5': 'Epsilon',
  'rowReorderDemo.name.6': 'Zeta',
  'publications.block.moveToSection': 'Move to section…',
  // Раздельные команды добавления раздела (задача 7cfaba7c, п.4): родитель
  // подставляется по команде — родитель блока либо сам блок.
  'publications.block.addSectionSibling': 'Add section at this level…',
  'publications.block.addSectionChild': 'Add child section…',
  'publications.block.addText': 'Add section text…',
  'publications.block.exclude': 'Exclude from publication',
  'publications.block.include': 'Include',
  'publications.block.open': 'Open thought in editor',
  'publications.block.moveToSectionTitle': 'Move to section',
  'publications.block.moveToSectionEmpty': 'There are no other sections in the publication',
  'publications.block.moveFailed': 'Failed to determine the text property for the move.',
  'publications.block.moveCycle': 'A section cannot be moved into its own subsection.',

  // -- Публикации: карточка в панели редактора (0.11.1, задача a3cfc018) ----
  /** Заголовок панели редактора для цели publication. */
  'publication.card.title': 'Publication',
  'publication.tab.meta': 'Metadata',
  'publication.tab.summary': 'Summary',
  'publication.tab.recipe': 'Recipe',
  'publication.tab.attachments': 'Attachments',
  // Шапка редактора публикации (задача b02ef1cf): настройки, меню «Действия».
  'publication.settings': 'Settings',
  'publication.settings.title': 'Publication settings',
  'publication.settings.shelves': 'Shelves',
  'publication.settings.author': 'Author',
  'publication.actions': 'Actions',
  'publication.action.changeCover': 'Change cover',
  'publication.action.findOnShelf': 'Find on shelf',
  'publication.action.rebuild': 'Rebuild',
  'publication.action.copy': 'Copy',
  'publication.action.copyId': 'Copy ID',
  'publication.copy.linkDone': 'Publication link copied.',
  'publication.copy.idDone': 'Publication ID copied.',
  'publication.copy.failed': 'Failed to copy.',
  'publication.status.active': 'active',
  'publication.field.titlePlaceholder': 'Publication title',
  'publication.field.subtitlePlaceholder': 'Subtitle',
  // Рецепт публикации: крупные группы с подсказками (задача b02ef1cf).
  'publication.recipe.group.select': 'SECTION SELECTION',
  'publication.recipe.group.selectHint': 'Specify parent thoughts — their subtrees provide publication sections; other conditions refine the composition.',
  'publication.recipe.group.texts': 'PROPERTIES WITH SECTION CONTENT',
  'publication.recipe.group.textsHint': 'Specify which properties of the selected sections provide their texts.',
  'publication.recipe.group.extras': 'ADDITIONAL MATERIALS',
  'publication.recipe.group.extrasHint': 'Specify properties whose values should be included in the publication as additional materials.',
  'publication.recipe.group.numbering': 'SECTION NUMBERING',
  // Диалог обложки публикации (задача b02ef1cf).
  'publication.cover.title': 'Cover',
  'publication.cover.tab.attachments': 'Attachments',
  'publication.cover.tab.url': 'Link (URL)',
  'publication.cover.upload': 'Upload from file',
  'publication.cover.apply': 'Apply and close',
  'publication.cover.previewHint': 'Preview',
  'publication.cover.empty': 'No image attachments found.',
  'publication.cover.urlPlaceholder': 'Image URL',
  'publication.cover.ownerThought': 'thought',
  'publication.cover.ownerPublication': 'publication',
  'publication.cover.ownerLink': 'link',
  /** Крестик снятия владельца-публикации с вложения (замечание Б2 b02ef1cf). */
  'publication.cover.ownerRemove': 'Remove owner',
  /** Подтверждение удаления последнего владельца (замечание Б2 b02ef1cf). */
  'publication.cover.removeLastOwner.title': 'Deleting attachment',
  'publication.cover.removeLastOwner.body': 'If the last owner of the attachment is removed, the attachment will be deleted. Delete?',
  /** Ошибка снятия владельца вложения. */
  'publication.cover.removeOwner': 'Remove owner',
  'publication.cover.setDone': 'The publication cover has been updated.',
  'publication.cover.cleared': 'The cover has been cleared.',
  'publication.attachments.makeCover': 'Make publication cover',
  'publication.field.title': 'Title',
  'publication.field.subtitle': 'Subtitle',
  'publication.field.author': 'Author',
  /** Placeholder автора: пустое авторство показывается создателем (c3e44cab). */
  'publication.field.authorPlaceholder': 'creator',
  /** Ошибка настройки рецепта: свойство и в текстах, и в доп. материалах. */
  'publication.recipe.overlap': 'A property cannot be both a text source and an additional material.',
  /** Рецепт ждёт реестр свойств: чтение не удалось, повтор на восстановлении связи. */
  'publication.recipe.registryPending': 'The network property registry has not been read — the recipe will appear once the connection recovers.',
  /** Действие публикации прервано: реестр свойств сети не прочитан. */
  'publications.registryUnreadable': 'The network property registry has not been read — retry when the connection recovers.',
  /** Управление порядком публикации внутри полки (вкладка «Полки и статус»). */
  'publication.orderUp': 'Move up',
  'publication.orderDown': 'Move down',
  /** Рецепт заголовков: ключевые слова. */
  'publication.recipe.keywordsPlaceholder': 'Keywords…',
  'publication.recipe.keywordsTooltip': 'Space-separated words, all required; * matches any characters; -word excludes. Example: report* -draft*',
  'publication.recipe.types': 'Thought types',
  'publication.recipe.typesPlaceholder': 'Type name…',
  'publication.recipe.parentsTooltip': 'Limit the view to thoughts that are children of the specified ones',
  'publication.recipe.parentsTitle': 'Parent thoughts',
  'publication.recipe.pickThoughts': 'Select thoughts…',
  'publication.recipe.pickTypes': 'Select types…',
  'publication.field.summary': 'Summary',
  'publication.summary.placeholder': 'Publication summary… (double-click to edit, Ctrl+Enter to save)',
  'publication.field.cover': 'Cover',
  'publication.field.assembly': 'Assembly date',
  'publication.field.numberingFrom': 'Number from level',
  'publication.field.numberingTo': 'to level',
  'publication.field.texts': 'Text properties',
  'publication.field.extras': 'Additional materials',
  'publication.shelves': 'Shelves',
  'publication.inactive': 'Inactive',
  'publication.toTrash': 'To basket',
  'publication.restore': 'Restore from basket',
  'publication.rebuild': 'Rebuild',
  /** Прелоадер пересборки в карточке (ошибка c2dec45c). */
  'publication.rebuilding': 'Rebuilding…',
  /** Подтверждение успешной пересборки (ошибка c2dec45c). */
  'publication.rebuilt.ready': 'Document rebuilt',
  'publication.save': 'Save',
  'publication.cover.none': 'No cover',
  'publication.cover.url': 'Cover URL',
  'publication.cover.pick': 'Select attachment…',
  'publication.error': 'Failed to save the publication',

  // -- Публикации: поле свойства, упоминания, ссылки (0.11.1, задача 3275fd8d) --
  /** Поле значения свойства вида `publication`: заголовок пикера. */
  'publications.field.pickerTitle': 'Select publication',
  /** Приглашение пустого поля значения-публикации. */
  'publications.field.placeholder': 'Publication title…',
  /** Приглашение непустого поля значения-публикации. */
  'publications.field.addPlaceholder': '+ another publication',
  /** Группа «Публикации» на вкладке «Упоминания» карточки мысли. */
  'publications.mentions.title': 'Publications',
  /** Загрузка списка публикаций-упоминаний. */
  'publications.mentions.loading': 'Searching publications…',
  /** Пустое состояние группы. */
  'publications.mentions.empty': 'This thought is not part of any publication.',
  /** Роль мысли-раздела (подстановка — хлебные крошки раздела). */
  'publications.mentions.roleSection': 'section: %1',
  /** Роль мысли-текста (подстановка — название раздела). */
  'publications.mentions.roleText': 'text of section “%1”',
  /** Роль прямой ссылки свойством (подстановка — имя свойства). */
  'publications.mentions.roleDirect': 'property “%1”',
  /** Строка усечения списка (подстановки — показано, всего). */
  'publications.mentions.more': '%1 of %2 shown',
  /** Пункт меню вставки ссылки в редакторе. */
  'publications.link.insert': 'Insert publication link…',
  /** Пометка ссылки на удалённую публикацию (рендер, как у мыслей). */
  'publications.link.deleted': 'deleted',

  // -- Диалог выбора иконки: вкладка «Библиотека» (0.12.1, задача 4b80a1b3) --
  /** Подпись вкладки библиотеки иконок (следующая за «Эмодзи»). */
  'icons.library.tab': 'Library',
  /** Плейсхолдер живого поиска по каталогу имён значков. */
  'icons.library.search': 'Search icon…',
  /** Подсказка, пока ленивый каталог значков ещё грузится. */
  'icons.library.loading': 'Loading icons…',
  /** Подсказка, когда поиск не нашёл ни одного значка. */
  'icons.library.empty': 'No icons found.',
  /** Подпись тумблера «свой цвет символа» на вкладке «Библиотека». */
  'icons.library.color': 'Custom symbol color',
  /** Заголовок строки последних выбранных иконок над вкладками (0.12.1, задача 0fc95a2b). */
  'icons.recent.title': 'Recent icons',
  /** Подпись ячейки строки последних иконок (клик применяет иконку). */
  'icons.recent.apply': 'Apply icon',
  // -- Диалог выбора иконки: вставка из буфера (0.12.1, задача 78eaf07a) --
  /** Подпись кнопки футера «Вставить из буфера». */
  'icons.clipboard.paste': 'Paste from clipboard',
  // -- Диалог вставки картинки в текст (0.12.1, задача 87c455db) ----------
  /** Заголовок диалога вставки картинки/эмодзи/ссылки в текст комментария. */
  'insertImage.title': 'Insert image',
  /** Подпись нижней кнопки диалога — вставить выбранное в позицию курсора. */
  'insertImage.apply': 'Insert',
  /** Подсказка вкладки «Иконки мыслей», когда у типов нет эмодзи-иконок. */
  'insertImage.iconsEmpty': 'Thought types have no emoji icons.',
  /** Плейсхолдер поля адреса на вкладке «URL» диалога вставки. */
  'insertImage.urlPlaceholder': 'Image URL',
  /** Подпись предпросмотра на вкладке «URL» диалога вставки. */
  'insertImage.preview': 'Preview',

  // -- Зона настроек строки поиска карты (search/search.ts, задача 4b1cc3d4) --
  /** Кнопка подвала зоны: очистить условия основной группы отбора. */
  'search.clearConditions': 'Clear',
  /** Подсказка кнопки «Очистить». */
  'search.clearConditionsTitle': 'Clear view conditions',
  /** Кнопка подвала зоны: подменю быстрых команд отбора. */
  'search.addFilter': 'Add view…',
  /** Подсказка кнопки «Добавить отбор…». */
  'search.addFilterTitle': 'Quick view commands',
  /** Команда: мысль в иерархии мысли-фокуса карты. */
  'search.cmdParentInFocus': 'By parent in focus',
  /** Команда: только актуальные мысли. */
  'search.cmdOnlyActive': 'Only active',
  /** Команда: только не помеченные на удаление. */
  'search.cmdOnlyNotTrashed': 'Only not marked',
  /** Подсказка команды «По родителю в фокусе», когда мысль в фокусе не задана. */
  'search.focusRequired': 'First select a thought in the map focus, then repeat the command.',
  /** Заголовок диагностики неразрешённых токенов в результатах поиска. */
  'search.unresolvedTokens': 'Some view conditions could not be resolved:',
  /**
   * Тост при отказе открытия хита-связи (ошибка 53d21e82): сетевой/серверный
   * отказ не должен выглядеть «зависшим» кликом. Stale-хит (404) — тишина,
   * сюда не попадает.
   */
  'search.hitOpenFailed': 'Failed to open the link: %1',

  // -- Меню «Действия ▾» редактора (editor/editor.ts, ошибка 53d21e82) ------
  /**
   * Тост, когда «В фокус» не смог открыть карту мыслей (сбой загрузки экрана
   * или импорта `active-view.js`); штатный отказ фокуса показывает тостом сам
   * помощник, поэтому второй тост здесь не появляется.
   */
  'editor.focusOnMapFailed': 'Failed to open the thought map: %1',

  // -- Панель использования (спека f7623077, ошибка aca92904) ---------------
  /** Заголовок панели. */
  'usagePanel.title': 'Usage',
  /** Подсказка/aria кнопки закрытия панели. */
  'usagePanel.close': 'Close the usage panel',
  /** Ошибка загрузки, когда сеть не открыта. */
  'usagePanel.noNetwork': 'No network is open.',
  /** Состояние загрузки панели. */
  'usagePanel.loading': 'Loading usage…',
  /** Кнопка повтора после ошибки загрузки. */
  'usagePanel.retry': 'Retry',
  /** Заголовок группы «Используется в свойствах». */
  'usagePanel.properties.title': 'Used in properties',
  /** Пустое состояние группы свойств. */
  'usagePanel.properties.empty': 'No property references this thought.',
  /** Кнопка «Очистить все свойства». */
  'usagePanel.properties.clearAll': 'Clear all properties',
  /** Пункт меню строки: очистить одно свойство. */
  'usagePanel.properties.clearOne': 'Clear property',
  /** Тост после очистки одного свойства. */
  'usagePanel.properties.cleared': 'Property cleared.',
  /** Заголовок подтверждения «Очистить все свойства». */
  'usagePanel.properties.clearAllTitle': 'Clear all properties',
  /** Текст подтверждения необратимой очистки всех свойств. */
  'usagePanel.properties.clearAllMessage': 'All references to this thought via properties will be removed. This action is irreversible and affects other thoughts.',
  /** Кнопка подтверждения очистки всех свойств. */
  'usagePanel.properties.clearAllConfirm': 'Clear',
  /** Тост после очистки всех свойств (подстановка — число ссылок). */
  'usagePanel.properties.clearedCount': 'References cleared: %1.',
  /** Тост, когда очищать было нечего. */
  'usagePanel.properties.nothingCleared': 'There were no references.',
  /** Заголовок группы «Используется в слоях». */
  'usagePanel.layers.title': 'Used in layers',
  /** Пустое состояние группы слоёв. */
  'usagePanel.layers.empty': 'No layer holds the entity.',
  /** Кнопка строки слоя: удалить слой. */
  'usagePanel.layers.delete': 'Delete layer',
  /** Причина, почему у строки «Основа» нет действия purge в рабочем слое. */
  'usagePanel.layers.baseHint': 'The entity exists in Base: in a working layer it can only be marked for deletion; Delete permanently is available in Base.',
  /** Ссылка из диалога удаления: открыть панель использования. */
  'usagePanel.openLink': 'Open usage…',
  /** Подсказка кнопки/команды «Открыть использование…» в корзине. */
  'usagePanel.openFromTrashTitle': 'Show where the current basket row is used',
  /** Подсказка действия «Вернуть из корзины» в шапке панели. */
  'usagePanel.restoreTitle': 'Unmark this entity for deletion',
  /** Сообщение, когда снимать пометку уже нечего. */
  'usagePanel.restoreNotMarked': 'The entity is no longer marked for deletion.',
  /** Подсказка действия «Удалить совсем» в шапке панели. */
  'usagePanel.purgeTitle': 'Delete the entity permanently (cannot be restored)',
  /** Заголовок подтверждения «Удалить совсем». */
  'usagePanel.purgeConfirmTitle': 'Delete permanently',
  /** Текст подтверждения (подстановка — имя сущности). */
  'usagePanel.purgeConfirmMessage': 'Delete “%1” permanently?',
  // Предупреждение об осиротевших потомках — форма выбирается через `tp`
  // (`plurals.orphanedChildren` ниже): `%1` — число.
  /** Гонка с удерживающим слоем: purge не удалил строку. */
  'usagePanel.purgeRace': 'The entity was not deleted: a layer holds it. The list has been reloaded.',
  /** Гонка: сущность восстановили из корзины до подтверждения удаления. */
  'usagePanel.purgeAlreadyRestored': 'The entity has already been restored from the basket — deletion canceled.',

  // -- Статус realtime-соединения (ошибка de34b35b) -------------------------
  // Подписи и тултипы — по таблице заказчика после проверки GUI: короткая
  // подпись в статус-баре, имя сервера — только в тултипе.
  /** Зелёный индикатор; сокет открыт и кадры приходят. */
  'realtime.status.connected': 'Server: OK',
  /** Первое подключение (жёлтый). */
  'realtime.status.connecting': 'Server: ???',
  /** Проверка живости: зонд отправлен, ждём любой кадр (жёлтый). */
  'realtime.status.suspect': 'Server: ???',
  /** Идёт попытка переподключения (жёлтый). */
  'realtime.status.reconnecting': 'Server: ???',
  /** Сервер штатно закрыл сокет кадром 1001 `server shutdown` (жёлтый). */
  'realtime.status.serverRestart': 'Server: ???',
  /** Сервер обслуживается: 503/кадр `maintenance`/close 1012 (жёлтый, 479e37ed). */
  'realtime.status.serverMaintenance': 'Server: update',
  /** Красный индикатор: ~60 с безуспешных попыток. */
  'realtime.status.offline': 'No connection',
  /** Серый индикатор: ни одна сеть не открыта — не авария. */
  'realtime.status.idle': 'Server: —',
  /** Тултип зелёного индикатора; `%1` — имя сервера (метка профиля). */
  'realtime.tip.connected': 'Connected to %1',
  /** Тултип зелёного индикатора, если имя сервера неизвестно. */
  'realtime.tip.connectedGeneric': 'Connected to the server',
  /** Тултип жёлтого индикатора на первом подключении; `%1` — имя сервера. */
  'realtime.tip.connecting': 'Connecting to %1…',
  /** Тултип жёлтого индикатора на первом подключении без имени сервера. */
  'realtime.tip.connectingGeneric': 'Connecting to the server…',
  /** Тултип жёлтого индикатора при проверке/восстановлении; `%1` — имя сервера. */
  'realtime.tip.recovering': 'Trying to restore the connection to %1…',
  /** Тултип жёлтого индикатора при проверке/восстановлении без имени сервера. */
  'realtime.tip.recoveringGeneric': 'Trying to restore the connection to the server…',
  /** Тултип красного индикатора. */
  'realtime.tip.offline': 'No connection to the server. Data is read-only',
  /** Тултип нейтрального индикатора (сеть не открыта). */
  'realtime.tip.idle': 'No network is open',

  // -- Обслуживание сервера (задача 479e37ed) -------------------------------
  // Единственный источник фразы «сервер обновляется» — пара ключей ниже:
  // собирает её только `lib/server-maintenance-text.ts`. Дубли в блоке
  // `realtime.tip.*` (maintenance/maintenanceNoRetry) сняты замечанием
  // приёмки — вторая фраза разъезжается при первой правке текста.
  /** Единый текст обслуживания с известным сроком; `%1` — секунды. */
  'realtime.maintenance.waiting': 'The server is updating and will be back in about %1 s',
  /** Текст обслуживания без пригодного `retry_after`. */
  'realtime.maintenance.noRetry': 'The server is updating, waiting for recovery',

  // -- Уведомления о связи и черновики (ошибка de34b35b) --------------------
  'realtime.link.lostSuspect': 'Checking the connection to the server — changes are not sent, the edit is saved as a draft.',
  'realtime.link.lostReconnecting': 'Reconnecting to the server — changes are not sent, the edit is saved as a draft.',
  'realtime.link.lostOffline': 'Connection lost — edits are saved as drafts.',
  'realtime.link.lost': 'No connection — the edit is saved as a draft and will be sent once the connection recovers.',
  'realtime.link.recovered': 'Connection restored.',
  'drafts.offline.suspect': 'Checking the connection… The edit is saved as a draft and will be sent once the connection recovers.',
  'drafts.offline.reconnecting': 'Reconnecting… The edit is saved as a draft and will be sent once the connection recovers.',
  'drafts.offline.offline': 'No connection to the server. The edit is saved as a draft and will be sent once the connection recovers.',
  'drafts.offline.default': 'The edit is saved as a draft and will be sent once the connection recovers.',
  'drafts.retry.failed': 'The draft was not sent: %1',
  /**
   * Ретраибельный отказ сервера (4xx, кроме распознанных словарём в `errText`,
   * 351068ed п.7): серверное сообщение английское и адресовано API — в тосте
   * показываем русскую формулировку, текст черновика сохранён.
   */
  'drafts.retry.rejected': 'the server rejected the change',
  // Форма слова «черновик» для счётчиков (fb9d6058) — `plurals.draft` ниже,
  // выбор формы делает `tp` по правилам `Intl.PluralRules`.
  /**
   * Одно агрегированное сообщение на волну досылки (fb9d6058): цель черновика
   * недостижима навсегда (`NOT_FOUND`), строка переведена в терминальный
   * `failed` и больше не ретраится. Без UUID и серверного английского; не
   * обещаем ни просмотра, ни «замены при следующей правке» — текст живёт
   * локально до закрытия клиента и удаляется при следующем запуске.
   * `%1` — счётчик, `%2` — слово «черновик» в нужной форме.
   */
  'drafts.failed.unavailable': 'Not sent: %1 %2 — the entry is unavailable (deleted or in another layer).',
  /**
   * Локальный дефект черновика (битый JSON-конверт/неизвестный тип, 351068ed
   * п.8): ретрай не поможет, строка терминальна (`failed`). Одно сообщение на
   * волну, без технического английского. `%1` — счётчик, `%2` — слово
   * «черновик» в нужной форме.
   */
  'drafts.failed.unusable': 'Not sent: %1 %2 — the edit is corrupted or its type is not supported.',
  /**
   * Стартовое сообщение о чистке черновиков прошлых запусков (fb9d6058,
   * решение пользователя 2026-10-29). Показывается один раз, `%1` — счётчик,
   * `%2` — слово «черновик» в нужной форме.
   */
  'drafts.startup.purged': 'Removed at startup: %1 %2 from the previous session — unsaved edits are not carried over to a new client run.',
  /**
   * Одна попытка на конфликтный черновик — дальше он ждёт следующей правки.
   * Формулировка честная (5726744b, дополнено fb9d6058): слияния нет — upsert
   * следующей правки ПЕРЕЗАПИШЕТ текст черновика, а не отправит его вместе с
   * новой версией; при перезапуске клиента черновик удаляется чисткой старта,
   * поэтому «до закрытия клиента» сказано явно.
   */
  'drafts.conflict.kept': 'The draft was not sent: the entry was changed elsewhere. The draft text is kept locally until the client closes and will be replaced on the next edit of this field.',

  // -- Каркас рабочего стола (screens/workspace.ts) -------------------------
  'workspace.netMenu.title': 'Thought network menu',
  'workspace.networkLabel': 'Thought network',
  'workspace.view.map': 'Thought map',
  'workspace.view.structures': 'Thought structures',
  'workspace.view.chronicle': 'Diary',
  'workspace.view.activity': 'Events',
  'workspace.view.publications': 'Publications',
  'workspace.searchPlaceholder': 'Search the network',
  'workspace.userMenu.title': 'User menu',
  'workspace.eventArea.resize': 'Resize the event area width',
  'workspace.conflict.changed': 'changed by another user',
  'workspace.conflict.show': 'show',
  'workspace.tab.close': 'Close tab',
  'workspace.tab.noAccess': 'No access to the network',
  'workspace.tab.noAccessWithId': 'No access to network %1',
  'workspace.tab.inaccessible': 'The network opened in this tab is no longer available (you were removed from members or the network was deleted).',

  // ------------------------------------------------------------------------
  // Литералы экранов, панелей и меню (задача 3c9f23dc)
  // ------------------------------------------------------------------------
  // -- admin -------------------------------------------------------------
  'admin.key': 'key',
  'admin.sgenerirovatApiKey': 'Generate API key',
  'admin.vklyuchit': 'enable',
  'admin.otklyuchit': 'disable',
  'admin.delete': 'delete',
  'admin.title.sgenerirovatApiKeyTekuschemuUser': 'Generate an API key for the current user',
  'admin.title.vklyuchitOtklyuchitTekuschuyuUchetnuyuRecord': 'Enable/disable the current account',
  'admin.title.deleteTekuschegoUser': 'Delete the current user',
  'admin.placeholder.otobrazhaemoeName': 'Display name',
  'admin.label.admin': 'admin',
  'admin.label.addUser': 'Add user',
  'admin.placeholder.servernyyLimit': 'server limit',
  'admin.emptyServernyyLimit': 'empty — server limit',
  'admin.limitRecordsMcpMin': 'MCP write limit (min)',
  'admin.label.create': 'Create',
  'admin.generaciyaKey': 'Key generation',
  'admin.limitMustBytPolozhitelnymCelymChislom': 'The limit must be a positive integer.',
  'admin.keyPokazanOdinRazSohranitePeredayte': 'The key is shown only once. Save it and give it to the user — it will be unavailable after closing.',
  'admin.keySkopirovan': 'Key copied.',
  'admin.notSucceededCopyKey': 'Failed to copy the key.',
  'admin.title.apiKeyPokazanOdinRaz': 'API key (shown once)',
  'admin.uchetnayaRecordObnovlena': 'Account updated.',
  'admin.editUser': 'Edit user',
  'admin.deleteUser': 'Delete user',
  'admin.delete2': 'Delete “%1”?',
  'admin.userDeleted': 'User deleted.',
  'admin.deleteNetwork': 'delete network',
  'admin.title.deleteTekuschuyuNetwork': 'Delete the current network',
  'admin.deleteNetwork2': 'Delete network',
  'admin.deleteNetwork3': 'Delete network “%1”?',
  'admin.networkDeleted': 'Network deleted.',
  'admin.allKategorii': 'All categories',
  'admin.kategoriya': 'Category:',
  'admin.with': 'from',
  'admin.by': 'to',
  'admin.label.show': 'Show',
  'admin.vsegoRecords': 'Total entries: %1',

  // -- app ---------------------------------------------------------------
  'app.networkNotOpen': 'No network is open.',
  'app.notSelectedThoughtKopirovaniyaSelectThought': 'No thought is selected for copying. Select a thought on the map or in structures.',
  'app.skopirovano': 'Copied: “%1”',
  'app.notSelectedThoughtPasteKlikniteThought': 'No thought is selected for pasting. Click a thought on the map or select one.',
  'app.notSucceededReadSistemnyyBufer': 'Failed to read the system clipboard: %1',

  // -- addDialog ---------------------------------------------------------
  'addDialog.applyLabel.add': 'Add',
  'addDialog.createdSvyazanoErrors': 'Created/linked: %1, errors: %2',
  'addDialog.gotovo': 'Done: %1.',
  'addDialog.label.odna': 'one',
  'addDialog.label.neskolko': 'several',
  'addDialog.enterTitleVstavteList': 'Enter a title or paste a list…',
  'addDialog.enterTitleSearch': 'Enter a title to search…',
  'addDialog.placeholder.withoutType': 'no type',
  'addDialog.label.typeThought': 'Thought type',
  'addDialog.label.typeLink': 'Link type',
  'addDialog.label.propertyLink': 'Link property',
  'addDialog.enterAddListCtrlEnterApply': 'Enter adds to the list, Ctrl+Enter applies. In “several” mode, clicking a found thought adds it to the list.',
  'addDialog.selectOnlySuschestvuyuschihThoughtsEnterKlik': 'Selection from existing thoughts only: Enter or a click on a found thought adds it to the list, Ctrl+Enter applies.',
  'addDialog.searchIdetVsemVashimSetyamThought': 'Search runs across all your networks; thoughts of the current network are unavailable — select a thought from another network.',
  'addDialog.cannotSvyazatThoughtSamoySoboy': 'A thought cannot be linked to itself.',
  'addDialog.thoughtUkazannymIdOtsutstvuet': 'A thought with the specified ID does not exist.',
  'addDialog.sovpadeniyNoCreateNovyhThoughtsOtklyucheno': 'No matches — creating new thoughts is disabled.',
  'addDialog.etaThoughtAlreadyList': 'This thought is already in the list.',
  'addDialog.selected': 'Selected: %1',
  'addDialog.title.clearList': 'Clear list',
  'addDialog.suschestvuyuschayaThoughtTypeThoughtNotMenyaetsya': 'Existing thought — the thought type does not change',
  'addDialog.willCreatedNovayaThought': 'A new thought will be created',
  'addDialog.title.deleteLine': 'Delete row',
  'addDialog.listThoughtsPust': 'The thought list is empty.',
  'addDialog.up': 'up to “%1”',
  'addDialog.down': 'down to “%1”',
  'addDialog.addThought': 'Add thoughts',
  'addDialog.addThought2': 'Add thought (%1)',
  'addDialog.selectThoughts': 'Thought selection',
  'addDialog.notSucceededCreateThought': 'Failed to create thought: %1',

  // -- canvas ------------------------------------------------------------
  'canvas.noOtkrytoyNetwork': 'No network is open',
  'canvas.youRedaktiruete': 'you are editing',
  'canvas.youRedaktirueteEtuThought': 'You are editing this thought.',
  'canvas.redaktiruet': '%1 is editing',
  'canvas.thoughtChangedTekuschemLayerItsEdit': 'The thought is changed in the current layer — its edit will go to Base on merge',
  'canvas.incomingLink': 'Incoming links: %1',
  'canvas.outgoingLink': 'Outgoing links: %1',
  'canvas.vliyayuschihThoughtsNoDvoynoyKlikAdd': 'No influencing thoughts. Double-click to add',
  'canvas.siblings.rodstvennyhThoughtsNo': 'No sibling thoughts',
  'canvas.podchinennyhThoughtsNoDvoynoyKlikAdd': 'No child thoughts. Double-click to add',
  'canvas.notSucceededVypolnitViewTokenNot': 'Failed to run the view: the token was not resolved.',
  'canvas.prichinaNotUkazana': 'reason not specified',
  'canvas.viewVernulEmptyRezultatTokenNot': 'The view returned an empty result: token “%1” was not resolved (%2).',
  'canvas.hasIncomingLink': 'Has incoming links',
  'canvas.incomingLinksNo': 'No incoming links',
  'canvas.hasOutgoingLink': 'Has outgoing links',
  'canvas.outgoingLinksNo': 'No outgoing links',
  'canvas.poziciyaZone': 'Position in zone: %1',
  'canvas.dialogAddThoughtsMoreNotGotov': 'The add thoughts dialog is not ready yet.',
  'canvas.takayaLinkAlreadySuschestvuet': 'Such a link already exists.',
  'canvas.linkCreated': 'Link created.',
  'canvas.notSucceededCreateLink': 'Failed to create link: %1',

  // -- clipboard ---------------------------------------------------------
  'clipboard.thought': 'thought',
  'clipboard.thought2': 'thoughts',
  'clipboard.thoughts': 'thoughts',
  'clipboard.from': ' from “%1”',
  'clipboard.buferObmenaPust': 'The clipboard is empty.',
  'clipboard.vstavleno': 'Pasted: %1 %2',
  'clipboard.paste': 'Paste',
  'clipboard.notSucceededPaste': 'Failed to paste “%1”: %2',
  'clipboard.vstavleno2': 'Pasted: %1 %2, %3 %4.',
  'clipboard.notSucceededPasteNiOdnoyRows': 'Failed to paste any row.',
  'clipboard.link': 'link',
  'clipboard.link2': 'links',
  'clipboard.links': 'links',

  // -- contextMenu -------------------------------------------------------
  'contextMenu.exportZapuschen': 'Export started (%1)…',
  'contextMenu.exportZavershilsyaOshibkoy': 'Export failed.',
  'contextMenu.notSucceededSaveFile': 'Failed to save the file: %1',
  'contextMenu.exportSaved': 'Export saved: %1',
  'contextMenu.exportNotSucceeded': 'Export failed: %1',
  'contextMenu.importNotSucceeded': 'Import failed: %1',
  'contextMenu.importCreatedObnovlenoNovyhLinksAttachments': 'Import %1: created %2, updated %3, new links %4, attachments %5.',
  'contextMenu.editProperties': 'Edit properties',
  'contextMenu.editActive': 'Change active status',
  'contextMenu.invert': 'Invert',
  'contextMenu.linkInverted': 'Link inverted.',
  'contextMenu.inObratnomNapravleniiTakayaLinkAlready': 'Such a link already exists in the opposite direction.',
  'contextMenu.invertLink': 'Invert link',
  'contextMenu.copyId': 'Copy ID',
  'contextMenu.idThoughtSkopirovan': 'Thought ID copied.',
  'contextMenu.notSucceededCopyId': 'Failed to copy ID.',
  'contextMenu.removeSelection': 'Remove from selection',
  'contextMenu.addVydeleniyu': 'Add to selection',
  'contextMenu.upParent': 'up (parent)',
  'contextMenu.downChild': 'down (child)',
  'contextMenu.leftSibling': 'left (sibling)',
  'contextMenu.editOrder': 'Change order',
  'contextMenu.doFirst': 'make first',
  'contextMenu.sdvinutBack': 'move back',
  'contextMenu.sdvinutForward': 'move forward',
  'contextMenu.doLast': 'make last',
  'contextMenu.editType': 'Change type',
  'contextMenu.editIcon': 'Change icon',
  'contextMenu.addAttachment': 'Add attachment',
  'contextMenu.openEditor': 'Open editor',
  'contextMenu.inFocus': 'Focus',
  'contextMenu.export': 'Export…',
  'contextMenu.import': 'Import…',
  'contextMenu.findMapThoughts': 'Find on thought map',
  'contextMenu.unpinThought': 'Unpin thought',
  'contextMenu.pinThought': 'Pin thought',
  'contextMenu.mergeThoughtBase': 'Merge thought into Base…',
  'contextMenu.deleteRestore': 'Delete/restore',
  'contextMenu.title.withoutType': 'No type',
  'contextMenu.homeThoughtCannotDeaktivirovat': 'The HOME thought cannot be deactivated.',
  'contextMenu.emodzi': 'Emoji',
  'contextMenu.addThought': 'Add thought',
  'contextMenu.sort': 'Sort',
  'contextMenu.orderZadaetsyaOtborom': 'order is set by the view',
  'contextMenu.byAlfavituAsc': 'alphabetically (asc)',
  'contextMenu.byAlfavituDesc': 'alphabetically (desc)',
  'contextMenu.byDateCreateAsc': 'by creation date (asc)',
  'contextMenu.byDateCreateDesc': 'by creation date (desc)',
  'contextMenu.byDateProsmotraAsc': 'by view date (asc)',
  'contextMenu.byDateProsmotraDesc': 'by view date (desc)',
  'contextMenu.ruchnoy': 'manual',
  'contextMenu.fileNotSelected': 'no file selected',

  // -- dragCloud ---------------------------------------------------------
  'dragCloud.uporyadochivanieRabotaetSortirovkeZonyRuchnoyPravyy': 'Reordering works when the zone sort is “manual” (right-click a zone → order).',
  'dragCloud.createLink': 'Create link',
  'dragCloud.peremestitThought': 'Move thought',
  'dragCloud.peremestitPodchinenie': 'Move under parent',

  // -- linkFilter --------------------------------------------------------
  'linkFilter.strukturaParentsChildren': 'Structure (Родители/Потомки)',
  'linkFilter.notSucceededLoadFiltrTypesLinks': 'Failed to load the link type filter.',
  'linkFilter.filtrTypesLinksMap': 'Link type filter on the map',
  'linkFilter.title.vernutUmolchaniya': 'Restore defaults',
  'linkFilter.ostavteHotyaOdinTypeLink': 'Leave at least one link type.',
  'linkFilter.notSucceededSaveFiltrTypesLinks': 'Failed to save the link type filter.',

  // -- canvasLinks -------------------------------------------------------
  'canvasLinks.inTrash': ' (in basket)',
  'canvasLinks.linkTrash': 'Link in basket',
  'canvasLinks.youRedaktirueteEtuLink': 'You are editing this link',
  'canvasLinks.linkTrashClickToRestore': 'Link in basket — click to restore',
  'canvasLinks.inTrash2': ' · in basket',
  'canvasLinks.linkWithoutType': 'Link without a type',

  // -- attachments -------------------------------------------------------
  'attachments.b': ' · %1 B',
  'attachments.fileNotFoundUnavailablePath': 'File not found or unavailable at path: %1',
  'attachments.fileGreaterMbLimitAttachments': 'The file is larger than %1 MB — the attachment limit.',
  'attachments.peretaschiteFilesLinkRefSyuda': 'Drag files or links here',
  'attachments.notSucceededAddAttachment': 'Failed to add the attachment.',
  'attachments.peretaschenyNeraspoznannyeDannyePodderzhivayutsyaFilesH': 'Unrecognized data was dropped. Files and http(s) links are supported.',
  'attachments.attachmentsNo': 'No attachments.',
  'attachments.notSucceededOpen': 'Failed to open: %1',
  'attachments.openPrilozheniiDefault': 'Open in the default app',
  'attachments.attachment': 'Attachment',
  'attachments.forThisTypeAttachmentsPreviewUnavailable': 'Preview is unavailable for this attachment type.',
  'attachments.notTekstovoeAttachment': 'not a text attachment',
  'attachments.notSucceededReadFile': 'Failed to read the file',
  'attachments.filePrevyshaetLimitProsmotraPokazanyPervye': 'The file exceeds the preview limit — the first 200,000 characters are shown, editing is disabled.',
  'attachments.iconThoughtObnovlena': 'Thought icon updated.',
  'attachments.notSucceededNaznachitIcon': 'Failed to set the icon: %1',
  'attachments.notSucceededReadFileAttachments': 'Failed to read the attachment file.',
  'attachments.notSucceededPodgotovitPrevyuIcon': 'Failed to prepare the icon preview.',
  'attachments.label.createNovoe': 'Create new',
  'attachments.label.findSuschestvuyuschee': 'Find existing',
  'attachments.label.linkRefUrl': 'Link (URL)',
  'attachments.label.filePath': 'File (path)',
  'attachments.pathFile': 'File path',
  'attachments.label.type': 'Type',
  'attachments.label.adresPath': 'Address / path',
  'attachments.label.titleOptional': 'Title (optional)',
  'attachments.label.kommentariyOptional': 'Comment (optional)',
  'attachments.placeholder.titleFileUrlKommentariy': 'Name, file, URL, comment…',
  'attachments.enterZaprosSearchNetwork': 'Enter a query to search the network.',
  'attachments.label.search': 'Search',
  'attachments.enterZapros': 'Enter a query.',
  'attachments.nichegoNotFound': 'Nothing found.',
  'attachments.label.rezhim': 'Mode',
  'attachments.enterAdresPath': 'Specify an address or path.',

  // -- chronoTab ---------------------------------------------------------
  'chronoTab.notSucceededCreateRecord': 'Failed to create the entry: %1',
  'chronoTab.title.dateRecords': 'Entry date',
  'chronoTab.title': 'Title',
  'chronoTab.notSucceededSave': 'Failed to save: %1',
  'chronoTab.notSucceededDelete': 'Failed to delete: %1',

  // -- comment -----------------------------------------------------------
  'comment.title.kommentariy': 'Comment',
  'comment.placeholder.enterKommentariy': 'Enter a comment…',

  // -- deepLink ----------------------------------------------------------
  'deepLink.notSucceededOpenLinkRef': 'Failed to open the link: %1',
  'deepLink.networkUnavailable': 'Network unavailable: %1',
  'deepLink.publicationDeletedUnavailable': 'The publication is deleted or unavailable: %1',
  'deepLink.thoughtDeletedUnavailable': 'The thought is deleted or unavailable: %1',
  'deepLink.notMoguOpenNeaktualnuyuThoughtNeaktualnye': 'Cannot open an inactive thought — inactive thoughts are not displayed.',
  'deepLink.notSucceededOpenThought': 'Failed to open the thought: %1',

  // -- editor ------------------------------------------------------------
  'editor.title.properties': 'Properties',
  'editor.title.attachments': 'Attachments',
  'editor.title.mentions': 'Mentions',
  'editor.title.dnevnik': 'Diary',
  'editor.title.graph': 'Graph',
  'editor.title.metadata': 'Metadata',
  'editor.title.thought': 'Thoughts',
  'editor.title.polozhenieEditor': 'Editor position',
  'editor.noSoderzhimogo': 'No content.',
  'editor.thoughtTrashClickRestoreDelete': 'The thought is in the basket. Click to restore or delete',
  'editor.link': 'Link',
  'editor.thought': 'Thought',
  'editor.selectThoughtLink': 'Select a thought or link.',
  'editor.label.sprava': 'Right',
  'editor.label.sleva': 'Left',
  'editor.label.sverhu': 'Top',
  'editor.label.snizu': 'Bottom',
  'editor.label.hide': 'Hide',
  'editor.thoughtChangedDrugimPolzovatelemDannyeObnovleny': '⚠ The thought was changed by another user — data updated.',
  'editor.linkChangedDrugimPolzovatelem': '⚠ The link was changed by another user.',
  'editor.vosstanovlenNesohranennyyChernovikTitle': 'An unsaved title draft has been restored.',
  'editor.title.cvetStil': 'Color and style',
  'editor.settingsThought': 'Thought settings',
  'editor.synonymsViaZapyatuyu': 'Synonyms (comma-separated)',
  'editor.label.aktualno': 'active',
  'editor.label.actions': 'Actions ▾',
  'editor.notSucceededLoadFileAttachments': 'Failed to upload the file as an attachment: %1',
  'editor.loadingThought': 'Loading thought',
  'editor.loading': '…loading %1',
  'editor.loadingLink': '…loading link %1',
  'editor.title.cvetStilLinii': 'Line color and style',

  // -- graphTab ----------------------------------------------------------
  'graphTab.loadingGraph': 'Loading graph…',
  'graphTab.graphUnavailableThoughtMoreZagruzhaetsya': 'The graph is unavailable — the thought is still loading.',
  'graphTab.notSucceededLoadGraph': 'Failed to load the graph: %1',
  'graphTab.uThoughtNoPryamyhLinks': 'The thought has no direct links.',

  // -- iconDialog --------------------------------------------------------
  'iconDialog.title.icon': 'Icon',
  'iconDialog.placeholder.urlIzobrazheniya': 'Image URL',
  'iconDialog.previewHint.preview': 'Preview',

  // -- linkValueRemoval --------------------------------------------------
  'linkValueRemoval.linkPomeschenyTrash': 'Links moved to the basket (%1).',
  'linkValueRemoval.linkPomeschenaTrash': 'Link moved to the basket.',
  'linkValueRemoval.chastLinksZablokirovanaOstalasTrash': 'Some links are blocked and remain in the basket.',
  'linkValueRemoval.notSucceededDeleteLinkSovsem': 'Failed to delete the link permanently: %1',
  'linkValueRemoval.linkDeleted': 'Links deleted (%1).',
  'linkValueRemoval.linkDeleted2': 'Link deleted.',

  // -- linksTab ----------------------------------------------------------
  'linksTab.title.linkRefThought': 'Links to the thought',
  'linksTab.title.mentionsTekstah': 'Mentions in texts',
  'linksTab.koncyLinkNotFoundPossibleThought': 'Link endpoints not found — the thoughts may have been deleted.',
  'linksTab.istochnik': 'Source',
  'linksTab.naznachenie': 'Target',
  'linksTab.searchSsylokThought': 'Search links to the thought…',
  'linksTab.niktoNotSsylaetsyaEtuThoughtVia': 'No one references this thought via [[#<id>]]. ',
  'linksTab.searchUpominaniy': 'Search mentions…',
  'linksTab.titleNigdeNotUpominaetsya': 'The title is not mentioned anywhere.',

  // -- markdownField -----------------------------------------------------
  'markdownField.textKommentariya': 'Comment text',
  'markdownField.notSucceededPasteLinkRefTextNot': 'Failed to insert the link: the text “%1” was not found in the source (changed by formatting).',
  'markdownField.notSucceededSaveLinkRef': 'Failed to save the link: %1',
  'markdownField.pasteTextShablonaTypeThought': 'Paste the template text from the thought type',
  'markdownField.notSucceededPasteImageFieldsNo': 'Failed to insert the image: the field has no owner.',
  'markdownField.izobrazhenie': 'image',

  // -- mentions ----------------------------------------------------------
  'mentions.pereyti': 'Go to “%1”',
  'mentions.notSucceededOpen': 'Failed to open “%1”: %2',
  'mentions.pasteLinkRef': 'Insert a link to “%1”',

  // -- metadataTab -------------------------------------------------------
  'metadataTab.waitLoadingThought': 'Wait for the thought to load.',
  'metadataTab.waitLoadingLink': 'Wait for the link to load.',

  // -- miniGraph ---------------------------------------------------------
  'miniGraph.inTrash': '(in basket)',
  'miniGraph.outgoing': 'outgoing',
  'miniGraph.incoming': 'incoming',
  'miniGraph.more': '%1: %2 more %3',
  'miniGraph.inTrashMetkaTrashChipaVosstanovlenie': ', in basket: %1 (the chip\'s basket mark means restore via the basket)',
  'miniGraph.zhivyhLinks': 'live links ',
  'miniGraph.polnyyListVkladke': '%1%2. The full list %3— is on the “%4” tab.',
  'miniGraph.neighbours': 'Neighbours: %1',
  'miniGraph.allPryamyeNeighboursThoughtStrukturnyeParents': 'All direct neighbours of the thought: structural parents and children, plus typed links in both directions. The graph always shows all thought links — thought map filters do not affect it.',
  'miniGraph.hiddenMassovyh': 'Bulk hidden: %1',
  'miniGraph.kogdaOdnimNeighbourSvyazanoMoreReber': 'When %1 or more links of the same type connect one neighbour (counting both sides), one line is drawn per side of the pair, and the rest are combined into a “+N” chip at that neighbour (the chip tooltip shows the type, side and number of hidden links). The counter sums the numbers on chips. They cannot be expanded on the graph; the full list is on the “%2” tab.',
  'miniGraph.moreNotPomestilos': 'Not fitted yet: %1',
  'miniGraph.onGraphPokazanyPervyeNeighboursOstalnye': 'The graph shows the first %1 neighbours; the remaining %2 did not fit. The full list of neighbours and links is on the “%3” tab.',
  'miniGraph.linkTrashClickToOpenTrash': 'Links in basket: %1 — click to open the basket and restore',
  'miniGraph.kolesoZumLevayaKnopkaPustomuMestu': 'Wheel zooms, left button on empty space pans, nodes can be dragged. Hover a link to see its type and highlight. Ctrl+hover for preview.',
  'miniGraph.openLabel.openEditor': 'Open in editor',

  // -- properties --------------------------------------------------------
  'properties.propertyNotFoundSpravochnikeNetwork': 'The property was not found in the network property registry.',
  'properties.editProperty': 'Edit property',
  'properties.pomechennyhLinksThisPropertiesNo': 'There are no marked links of this property.',
  'properties.vosstanovlenoLinks': 'Links restored: %1.',
  'properties.linkRestored': 'Link restored.',
  'properties.propertyMovedTipovye': 'The property was moved to typed properties.',
  'properties.perenestiTipovyeProperties': 'Move to typed properties',
  'properties.rowZerkalnayaPrivyazkaPropertiesZhivetDrugom': 'This row is mirrored: the property binding lives on another type — remove it there.',
  'properties.privyazkaPropertiesNotFound': 'The property binding was not found.',
  'properties.propertyIsklyuchenoTypes': 'The property was excluded from types: %1.',
  'properties.propertyIsklyuchenoTipovyh': 'The property was excluded from typed properties.',
  'properties.isklyuchitTipovyhProperties': 'Exclude from typed properties',
  'properties.propertiesNedostupnyNoPodhodyaschegoType': 'Properties are unavailable — there is no suitable type.',
  'properties.title.propertiesType': 'Type properties',
  'properties.title.addProperty': 'Add property',
  'properties.title.propertiesVneType': 'Out-of-type properties',
  'properties.propertiesNedostupny': 'Properties are unavailable.',
  'properties.label.createNovoe': 'Create new…',
  'properties.notSucceededSaveOrderProperties': 'Failed to save the property order: %1',
  'properties.noValuesVneType': 'No out-of-type values.',
  'properties.propertyLinkNotConnectedTipuOwner': 'The link property is not attached to the owner type — values are edited here; attaching the property to the type will return them to the main table.',
  'properties.typeLinkNotImeetPropertiesReestre': 'The link type has no property in the registry — the link appears as an out-of-type property; it can be deleted by the side display name.',
  'properties.propertyGreaterNotConnectedTipuOwner': 'The property is no longer attached to the owner type — the value is kept for history only.',
  'properties.propertyLinkNotConnectedTipuOwner2': 'The link property is not attached to the owner type — enter values here; attaching the property to the type will return them to the main table.',
  'properties.propertyNotConnectedTipuOwnerEnter': 'The property is not attached to the owner type — enter the value here; attaching the property to the type will return it to the main table.',
  'properties.notSucceededDeleteValue': 'Failed to delete the value: %1',
  'properties.deleteValue': 'Delete value',
  'properties.uTypeNoProperties': 'The type has no properties.',
  'properties.notSucceededSave': 'Failed to save “%1”: %2',
  'properties.label.open': 'Open',
  'properties.title.openSistemnomObrabotchike': 'Open in the system handler',
  'properties.noNetwork': '(no network)',
  'properties.nerezolvleno': ' (unresolved)',
  'properties.lastZhivoyRezolvOtkazalNetworkTarget': 'The last live resolution failed — the network or target was deleted. Click Refresh name in the main table.',

  // -- resourcePicker ----------------------------------------------------
  'resourcePicker.label.iconThoughts': 'Thought icons',
  'resourcePicker.typesThoughtsIkonkamiNotZadany': 'Thought types with icons are not set.',
  'resourcePicker.iconType': 'Icon of type “%1”',

  // -- styleDialog -------------------------------------------------------
  'styleDialog.text': 'Text',
  'styleDialog.fon': 'Background',
  'styleDialog.zh': 'B',
  'styleDialog.zhirnyy': 'Bold',
  'styleDialog.n': 'I',
  'styleDialog.kursiv': 'Italic',
  'styleDialog.p': 'U',
  'styleDialog.podcherknutyy': 'Underline',
  'styleDialog.z': 'S',
  'styleDialog.strikethrough': 'Strikethrough',
  'styleDialog.settingsTypeThought': 'Thought type settings',
  'styleDialog.cvetLinii': 'Line color',
  'styleDialog.sploshnaya': 'solid',
  'styleDialog.shtrihi': 'dashed',
  'styleDialog.tochki': 'dotted',
  'styleDialog.stil': 'Style',
  'styleDialog.tolschina': 'Width',
  'styleDialog.settingsTypeLink': 'Link type settings',
  'styleDialog.settingsLink': 'Link settings',

  // -- valueEditor -------------------------------------------------------
  'valueEditor.uprazdneno': 'deprecated',
  'valueEditor.valuePublicationListStartEnterTitle': 'The value is a publication from the list: start typing a title and select a row',
  'valueEditor.valueNotAddedSelectPublicationList': 'Value not added: select a publication from the list.',
  'valueEditor.obnovlenieNameDostupnoOnlyPropertiesThoughts': 'Name refresh is available only for thought properties.',
  'valueEditor.snapshotyObnovleny': 'Snapshots updated.',
  'valueEditor.obnovlenoNerezolvleno': 'Updated %1 of %2; %3 unresolved.',
  'valueEditor.notSucceededObnovitName': 'Failed to refresh the name: %1',
  'valueEditor.label.obnovitName': 'Refresh name',
  'valueEditor.label.deleteValues': 'Remove from value',
  'valueEditor.nerezolvleno': '%1 — %2 (unresolved)',
  'valueEditor.titleThoughtOtherNetwork': 'Thought title in another network…',
  'valueEditor.valueThoughtListStartEnterTitle': 'The value is a thought from the list: start typing a title and select a row',
  'valueEditor.header.thoughtOtherNetworks': 'Thoughts from other networks',
  'valueEditor.valueNotAddedSelectThoughtList': 'Value not added: select a thought from the list.',
  'valueEditor.selectThoughtOtherNetwork': 'Select a thought from another network',
  'valueEditor.thoughtOtherNetworkNotSelectedKross': 'No thought from another network is selected — a cross-network link to the same network is not allowed.',
  'valueEditor.selectThoughtOtherNetwork2': 'Select a thought from another network…',
  'valueEditor.clearValue': 'Clear value',
  'valueEditor.moreOdnuThought': '+ another thought',
  'valueEditor.row': 'row',
  'valueEditor.number': 'number',
  'valueEditor.date': 'date',
  'valueEditor.daNo': 'yes/no',
  'valueEditor.httpsPathFile': 'https://… or a file path',
  'valueEditor.moreOdnoValue': '+ another value',
  'valueEditor.urlPathFile': 'URL or file path',
  'valueEditor.header.varianty': 'Options',
  'valueEditor.title.selectValueList': 'Select a value from the list',
  'valueEditor.da': 'yes',
  'valueEditor.no': 'no',
  'valueEditor.label.deleteLinkThought': 'Unlink from the thought',
  'valueEditor.label.pomestitLinkTrash': 'Move link to basket',
  'valueEditor.rebroVnetipovoyLinkDeleteLinkDostupno': '%1 — an out-of-type link edge; the link can be deleted from the context menu.',
  'valueEditor.rebraThisTypeLinkNotRedaktiruyutsya': '%1 — edges of this link type are not edited via properties (the link type has no property in the registry).',
  'valueEditor.title.selectCreateThought': 'Select or create thoughts',
  'valueEditor.notSucceededCreate': 'Failed to create “%1”: %2',
  'valueEditor.titleThoughtObyazatelno': 'Thought title… (required)',
  'valueEditor.titleThought': 'Thought title…',

  // -- wikiLink ----------------------------------------------------------
  'wikiLink.notSucceededOpredelitParentNovoyThought': 'Failed to determine the parent for the new thought: %1',
  'wikiLink.notSucceededObnovitLinkRef': 'Failed to update the link: %1',
  'wikiLink.notSucceededFindThoughtPerevodaId': 'Failed to find the thought “%1” to convert to [[#<id>]].',
  'wikiLink.obnovitFormatId': 'Update the format to [[#<id>]] (%1)',
  'wikiLink.notSucceededOpredelitPoziciyuLinkRefDokumente': 'Failed to determine the link position in the document.',
  'wikiLink.label.openThought': 'Open thought',
  'wikiLink.title.thoughtNotOtobrazhaetsya': 'The thought is not displayed',
  'wikiLink.etaThoughtNotOtobrazhaetsyaStruktureThoughts': 'This thought is not displayed in thought structures. Switch to the thought map?',
  'wikiLink.label.no': 'No',
  'wikiLink.label.da': 'Yes',
  'wikiLink.firstOpenNetwork': 'Open a network first.',
  'wikiLink.pokazanyPervyeUtochniteName': 'The first %1 are shown, refine the name.',
  'wikiLink.foundNeskolkoThoughts': 'Several thoughts found: “%1”',
  'wikiLink.networkUnavailableLinkRefThoughtOtherNetwork': 'Network unavailable: %1. A link to a thought in another network cannot be opened.',

  // -- importExport ------------------------------------------------------
  'importExport.label.nameFile': 'File name',
  'importExport.vklyuchitTypesThoughtsLinks': 'Include thought and link types',
  'importExport.vklyuchitAttachmentsFilesVnutriArchive': 'Include attachments (files inside the archive)',
  'importExport.label.vklyuchitHronologicheskieKommentarii': 'Include chronological comments',
  'importExport.label.vklyuchitPodchinennyeThought': 'Include child thoughts',
  'importExport.glubinaPodchinennosti': 'Child depth (1..%1)',
  'importExport.chtoVklyuchitArchive': 'What to include in the archive',
  'importExport.willEksportirovanoThoughts': 'Thoughts to export: %1.',
  'importExport.title.exportEtnx': 'Export to .etnx',
  'importExport.label.eksportirovat': 'Export',
  'importExport.importirovatTypesThoughtsLinks': 'Import thought and link types',
  'importExport.importirovatAttachmentsFilesVnutriArchive': 'Import attachments (files inside the archive)',
  'importExport.label.importirovatHronologicheskieKommentarii': 'Import chronological comments',
  'importExport.label.fileArchive': 'Archive file',
  'importExport.chtoImportirovat': 'What to import',
  'importExport.thoughtSovpadayuschimIdWillObnovlenySovpadeniyu': 'Thoughts with a matching id will be updated; matching by title will be reused (synonyms merged). Everything else will be created anew.',
  'importExport.title.importEtnx': 'Import from .etnx',
  'importExport.label.importirovat': 'Import',

  // -- cloud -------------------------------------------------------------
  'cloud.hasPostoyannyyKommentariy': 'Has a permanent comment',
  'cloud.postoyannogoKommentariyaNo': 'No permanent comment',
  'cloud.hronologicheskihKommentariev': 'Chronological comments: %1',
  'cloud.attachments': 'Attachments: %1',

  // -- dateField ---------------------------------------------------------
  'dateField.placeholder.ggggMmDd': 'YYYY-MM-DD',
  'dateField.title.dateFormateGgggMmDd': 'Date in YYYY-MM-DD format',
  'dateField.title.selectDateKalendare': 'Select a date in the calendar',
  'dateField.title.clearDate': 'Clear date',

  // -- datePeriod --------------------------------------------------------
  'datePeriod.label.date': 'Date',
  'datePeriod.label.period': 'Period',
  'datePeriod.ariaLabel.rezhimDatesPeriod': 'Date or period mode',
  'datePeriod.label.withUkazaniemTime': 'Include time',
  'datePeriod.showUchityvatTimeSutok': 'Show and use the time of day',
  'datePeriod.dateStart': 'Start date',
  'datePeriod.dateOkonchaniya': 'End date',
  'datePeriod.timeStart': 'Start time',
  'datePeriod.timeOkonchaniya': 'End time',
  'datePeriod.datePeriod': 'Date/period',
  'datePeriod.label.ok': 'Apply',

  // -- emoji -------------------------------------------------------------
  'emoji.name.smilesEmotions': 'Smileys and emotions',
  'emoji.name.peopleBody': 'People and body',
  'emoji.name.animalsNature': 'Animals and nature',
  'emoji.name.foodDrinks': 'Food and drinks',
  'emoji.name.travelPlaces': 'Travel and places',
  'emoji.name.activities': 'Activities',
  'emoji.name.objects': 'Objects',
  'emoji.name.symbols': 'Symbols',
  'emoji.name.flags': 'Flags',

  // -- entityPicker ------------------------------------------------------
  'entityPicker.nichegoNotSelected': 'Nothing selected.',
  'entityPicker.addValue': 'Add value…',
  'entityPicker.selectTypeThought': 'Select thought type',
  'entityPicker.selectTypeLink': 'Select link type',
  'entityPicker.thoughts.selectThought': 'Select thought',
  'entityPicker.createNovyy': 'Create new “%1”',

  // -- etnimg ------------------------------------------------------------
  'etnimg.notSucceededOpenFileLinkRefVne': 'Failed to open the file: the link is outside the comment field — the attachment owner is unknown.',
  'etnimg.notSucceededRazobratPathAttachment': 'Failed to parse the path in the attachment: %1',
  'etnimg.notSucceededOpenFileAttachments': 'Failed to open the attachment file: %1',
  'etnimg.attachmentLinkRefNotFoundOwnerKommentariya': 'No attachment at this link was found for the comment owner.',

  // -- filter ------------------------------------------------------------
  'filter.label.contains': 'contains',
  'filter.label.equal': 'equals',
  'filter.label.inList': 'in list',
  'filter.label.notList': 'not in list',
  'filter.label.zapolneno': 'is set',
  'filter.label.notZapolneno': 'is not set',
  'filter.label.greater': 'greater than',
  'filter.label.less': 'less than',
  'filter.label.notEqual': 'does not equal',
  'filter.label.containsLyuboy': 'contains any of',
  'filter.label.containsAll': 'contains all of',
  'filter.notContainsNiOdnogo': 'contains none of',
  'filter.label.byTitle': 'by title',
  'filter.label.byDateCreate': 'by creation date',
  'filter.label.byProsmotru': 'by view',
  'filter.label.byDateChanges': 'by modification date',
  'filter.label.asc': 'ascending',
  'filter.label.desc': 'descending',
  'filter.eq.equal': 'equals',
  'filter.ne.notEqual': 'does not equal',
  'filter.parents.parents': 'Parents',
  'filter.children.children': 'Children',
  'filter.attachments.hasAttachments': 'Has attachments',
  'filter.chronology.hasDnevnikovyeRecords': 'Has diary entries',
  'filter.comment.hasKommentariy': 'Has a comment',
  'filter.active.active': 'Active status',
  'filter.trashed.markedDelete': 'Marked for deletion',
  'filter.keywords.findSlova': 'Find words',
  'filter.author.avtor': 'Author',
  'filter.editor.editor': 'Editor',
  'filter.created_at.dateCreate': 'Creation date',
  'filter.updated_at.dateChanges': 'Modification date',
  'filter.properties.hasProperties': 'Has properties',
  'filter.targets.targetsRecords': 'Entry targets',
  'filter.record_time.periodRecords': 'Entry period',
  'filter.record_title.titleRecords': 'Entry title',
  'filter.record_body.textRecords': 'Entry text',
  'filter.record_author.avtorRecords': 'Entry author',
  'filter.record_editor.editorRecords': 'Entry editor',
  'filter.occurred_at.timeEvents': 'Event time',
  'filter.action.typeActions': 'Action type',
  'filter.entity_type.vidSuschnosti': 'Entity kind',
  'filter.entity_title.titleSuschnosti': 'Entity title',
  'filter.entity_id.suschnost': 'Entity',
  'filter.user.avtorEvents': 'Event author',
  'filter.name.nameAttachments': 'Attachment name',
  'filter.kind.vidAttachments': 'Attachment kind',
  'filter.mime_type.mimePodtip': 'MIME subtype',
  'filter.owner.owners': 'Owners',
  'filter.size.razmer': 'Size',
  'filter.valueNotTrebuetsya': 'value is not required',
  'filter.groupNotObyazanaImetRovnoOdnogo': 'the “not” group must have exactly one child (currently %1)',
  'filter.operandUnavailableProfile': 'operand “%1” is unavailable in profile “%2”',
  'filter.operatorUnavailableOperandaProfile': 'operator “%1” is unavailable for operand “%2” in profile “%3”',
  'filter.viewNotSootvetstvuetProfilyu': 'The view does not match profile “%1”: %2',
  'filter.sohranennoeOpredelenieViewNotChitaetsyaNeizvestnyy': 'the saved view definition cannot be read (unknown operand or operator) — conditions are not shown',
  'filter.sohranennoeOpredelenieViewPovrezhdenoNotChitaetsya': 'the saved view definition is corrupted and cannot be read',
  'filter.conditionPropertyNotRaspoznanoOtbrosheno': 'the property condition was not recognized and was dropped',
  'filter.conditionPropertyOtbroshenoPropertiesGreaterNo': 'the condition on property “%1” was dropped: the property no longer exists in the network',
  'filter.sortProsmotruEditorNotVyrazhaetsyaKey': 'the “by view” sort cannot be expressed in the editor — the key is not shown',
  'filter.not_contains.notContains': 'does not contain',
  'filter.gte.greaterEqual': 'greater than or equal',
  'filter.lte.lessEqual': 'less than or equal',
  'filter.between.between': 'between',
  'filter.not_between.notBetween': 'not between',
  'filter.in.in': 'in',
  'filter.not_in.not': 'not in',
  'filter.any_of.lyuboy': 'any of',
  'filter.all_of.all': 'all of',
  'filter.none_of.niOdnogo': 'none of',
  'filter.matches.hasSlova': 'has words',
  'filter.in_hierarchy.inIerarhii': 'in hierarchy',
  'filter.not_in_hierarchy.notIerarhii': 'not in hierarchy',
  'filter.has.imeetProperty': 'has property',
  'filter.not_has.notImeetProperty': 'does not have property',

  // -- filterDiagnostics -------------------------------------------------
  'filterDiagnostics.groupPustaDobavteConditionGroup': 'the group is empty — add a condition or a group',
  'filterDiagnostics.conditionsTrebuyutOdnovremennogoZapolnenoNotZapolneno': 'conditions require both “is set” and “is not set” — no thought will match',
  'filterDiagnostics.nizhnyayaGranicaDiapazonaNotLessVerhney': 'the lower bound is not less than the upper bound — no thought will match',
  'filterDiagnostics.editZamenitSohranennoeOpredelenie': '%1. Editing will replace the saved definition.',
  'filterDiagnostics.value': 'value “%1”',
  'filterDiagnostics.deleted': '%1 deleted',
  /**
   * Core diagnostics and unresolved tokens — text by machine-readable
   * `code`/`reason` (ADR daab6ac4, §4): the server `message` is English and
   * never shown; `filterIssueReason` appends the name/value/date.
   */
  'filterDiagnostics.server.entityDeleted':
    'a condition entity was deleted from the network — the view cannot be applied',
  'filterDiagnostics.server.propertyDetached':
    'the property is no longer part of this type’s property set',
  'filterDiagnostics.server.unknown': 'the condition is no longer applicable',
  'filterDiagnostics.server.tokenUnknown': 'token “%1” could not be resolved',
  'filterDiagnostics.server.tokenTimeContext': 'token “%1” requires a thought context',
  'filterDiagnostics.server.tokenIncompatible': 'the operation is incompatible with the condition value type',
  'filterDiagnostics.server.tokenUnknownProperty': 'the property was not found in the network registry',
  'filterDiagnostics.server.tokenEmptyValue': 'the value cannot be parsed as a date',
  'filterDiagnostics.server.tokenUnresolved': 'condition “%1” could not be resolved',

  // -- filterEditor ------------------------------------------------------

  // -- filterFooter ------------------------------------------------------
  'filterFooter.clickTextToPereytiRowOshibkoy': 'Click the text to jump to the row with the error',
  'filterFooter.title.writeSettingsView': 'Save view settings',
  'filterFooter.placeholder.nameView': 'view name',
  'filterFooter.ariaLabel.nameView': 'View name',
  'filterFooter.viewChangedMomentaSave': 'the view has changed since it was saved',
  'filterFooter.title.applyView': 'Apply view',
  'filterFooter.title.clearConditionsView': 'Clear view conditions',

  // -- filterForm --------------------------------------------------------
  'filterForm.klyuchevyeSlova': 'Keywords',
  'filterForm.schetVod': 'report* -draft*',
  'filterForm.label.naimenovanie': 'title',
  'filterForm.label.synonyms': 'synonyms',
  'filterForm.label.kommentariy': 'comment',
  'filterForm.roditelskieThought': 'Parent thoughts',
  'filterForm.conditionProperty': '+ property condition',
  'filterForm.property': '— property —',
  'filterForm.placeholder.yyyyMmDdTokenToday7d': 'YYYY-MM-DD or a token ($today+7d)…',
  'filterForm.label.notVazhno': 'any',
  'filterForm.vklyuchayaMarkedDelete': 'Including marked for deletion',
  'filterForm.trash': 'Basket',
  'filterForm.dopolnitelno': 'Additional',
  'filterForm.hasValueProperties': 'Has property value',
  'filterForm.hasHronologiya': 'Has chronology',
  'filterForm.onlyAktualnye': 'Only active',
  'filterForm.yes.aktualnye': 'active',
  'filterForm.no.notAktualnye': 'inactive',
  'filterForm.avtorEditor': 'Author / Editor',
  'filterForm.placeholder.yyyyMmDdToken': 'YYYY-MM-DD or a token…',
  'filterForm.from': 'from',
  'filterForm.to': 'to',
  'filterForm.label.created': 'Created',
  'filterForm.label.changed': 'Changed',
  'filterForm.dates': 'Dates',

  // -- filterPanel -------------------------------------------------------
  'filterPanel.hidePanelView': 'Hide view panel',
  'filterPanel.showPanelView': 'Show view panel',

  // -- filterPhrase ------------------------------------------------------
  'filterPhrase.withoutTitle': 'untitled',
  'filterPhrase.withoutName': 'unnamed',
  'filterPhrase.title.inImenah': 'in names',
  'filterPhrase.comment.inKommentarii': 'in comment',
  'filterPhrase.diary.inDnevnikah': 'in diaries',
  'filterPhrase.in.inSelection': 'in selection',
  'filterPhrase.not_in.notSelection': 'not in selection',
  'filterPhrase.all_in.allSelection': 'all in selection',
  'filterPhrase.and.and': ' AND ',
  'filterPhrase.or.or': ' OR ',
  'filterPhrase.not.not': 'NOT ',
  'filterPhrase.d': 'd',
  'filterPhrase.w': 'w',
  'filterPhrase.mo': 'mo',
  'filterPhrase.g': 'y',
  'filterPhrase.ch': 'h',
  'filterPhrase.min': 'min',
  'filterPhrase.oblastiNotSelected': 'no areas selected',
  'filterPhrase.and': ' and ',
  'filterPhrase.andMore': '%1 and %2 more',
  'filterPhrase.byVsemLinks': ' (all links)',
  'filterPhrase.link': ' (links: %1)',
  'filterPhrase.desc': '%1 (desc)',
  'filterPhrase.sort': 'sort: %1',

  // -- filterSort --------------------------------------------------------
  'filterSort.obratnayaStorona': '%1 · reverse side',
  'filterSort.orderPrimeneniyaOrderChipov': '%1 · %2 · application order — chip order',
  'filterSort.title.keySort': 'Sort key',
  'filterSort.placeholder.searchFields': 'Search field…',
  'filterSort.label.fieldsView': 'View fields',
  'filterSort.label.propertiesNetwork': 'Network properties',
  'filterSort.napravlenieClickToChange': 'direction: %1 — click to change',
  'filterSort.title.removeKeySort': 'Remove sort key',
  'filterSort.title.addKeySort': 'Add sort key',

  // -- filterSubquery ----------------------------------------------------
  'filterSubquery.withoutConditions': 'no conditions',
  'filterSubquery.not': 'NOT (%1)',
  'filterSubquery.clickToOpenSelectionModalnomLayer': '%1\n\nclick to open the selection in a modal layer',
  'filterSubquery.title.removeSelectionValues': 'Remove the selection from the value',
  'filterSubquery.selection': 'Selection',
  'filterSubquery.label.gotovo': 'Done',
  'filterSubquery.changePropertyRows': 'Change the row property?',
  'filterSubquery.inRowSobranaPodSelectionSmene': 'The row contains a sub-selection — it will be reset when the property changes.',
  'filterSubquery.label.list': 'List',
  'filterSubquery.title.perechislitValuesRow': 'List the values in the row',
  'filterSubquery.sobratPodSelectionModalnomLayer': 'Build a sub-selection in a modal layer',
  'filterSubquery.ariaLabel.vidValuesConditions': 'Condition value kind',
  'filterSubquery.changeVidValues': 'Change the value kind?',
  'filterSubquery.inRowSobranaPodSelectionPerehode': 'The row contains a sub-selection — it will be reset when switching to the list.',

  // -- filterTokens ------------------------------------------------------
  'filterTokens.thoughtKontekstView': 'view context thought',
  'filterTokens.titleThoughtKonteksta': 'context thought title',
  'filterTokens.synonymsThoughtOdnoyStrokoy': 'thought synonyms on one line',
  'filterTokens.typeThoughtKonteksta': 'context thought type',
  'filterTokens.activeThoughtKonteksta': 'context thought activity',
  'filterTokens.avtorThoughtKonteksta': 'context thought author',
  'filterTokens.lastEditorThought': 'last thought editor',
  'filterTokens.dateCreateThought': 'thought creation date',
  'filterTokens.dateChangesThought': 'thought modification date',
  'filterTokens.valueProperties': '%1%2 — value of property “%3”, %4',
  'filterTokens.label.todaySegodnya': '$today — today',
  'filterTokens.section.globalnye': 'Global',
  'filterTokens.label.nowCurrentMoment': '$now — current moment',
  'filterTokens.fieldsThought': 'Thought fields',
  'filterTokens.label.userCurrentUser': '$user — current user',
  'filterTokens.header.tokensKonteksta': 'Context tokens',

  // -- filterTree --------------------------------------------------------
  'filterTree.title.sravnenie': 'Comparison',
  'filterTree.title.state': 'State',
  'filterTree.title.slova': 'Words',
  'filterTree.title.property': 'Property',
  'filterTree.currentDen': 'current day',
  'filterTree.proshlyyDen': 'previous day',
  'filterTree.sleduyuschiyDen': 'next day',
  'filterTree.currentWeek': 'current week',
  'filterTree.proshlayaWeek': 'previous week',
  'filterTree.sleduyuschayaWeek': 'next week',
  'filterTree.currentMonth': 'current month',
  'filterTree.proshlyyMonth': 'previous month',
  'filterTree.sleduyuschiyMonth': 'next month',
  'filterTree.currentYear': 'current year',
  'filterTree.proshlyyYear': 'previous year',
  'filterTree.sleduyuschiyYear': 'next year',
  'filterTree.label.zadatVruchnuyu': 'Set manually…',
  'filterTree.operands.harakteristiki': 'Characteristics',
  'filterTree.allConditions': 'all conditions (AND)',
  'filterTree.lyuboeConditions': 'any condition (OR)',
  'filterTree.and': 'AND',
  'filterTree.or': 'OR',
  'filterTree.chronicle_record.recordsDnevnika': 'diary entries',
  'filterTree.activity.events': 'events',
  'filterTree.attachment.attachments': 'attachments',
  'filterTree.publication.publication': 'publications',
  'filterTree.showUsloviyam': 'Show %1 by conditions:',
  'filterTree.podSelection': 'sub-selection (%1)',
  'filterTree.kornevuyuGroupPerenositCannot': 'The root group cannot be moved',
  'filterTree.ishodnoeConditionNotFound': 'Source condition not found',
  'filterTree.groupPriemnikNotFound': 'Target group not found',
  'filterTree.groupCannotVlozhitSamuSebyaIts': 'A group cannot be nested into itself or its descendant',
  'filterTree.fromGroupsNotCannotRemoveEdinstvennoe': 'The only condition cannot be removed from a NOT group',
  'filterTree.inGroupNotCanVlozhitOnly': 'Only one condition can be nested into a NOT group',
  'filterTree.moveNevozmozhen': 'Move is not possible',
  'filterTree.copyImpossible': 'Copy is not possible',
  'filterTree.pereytiRowOshibkoy': 'Go to the row with the error',
  'filterTree.expandGroup': 'Expand group',
  'filterTree.collapseGroup': 'Collapse group',
  'filterTree.title.konnekciyaGroups': 'Group connection',
  'filterTree.label.not': 'NOT',
  'filterTree.unsetNotGroups': 'Clear group negation',
  'filterTree.otricatGroup': 'Negate group',
  'filterTree.notKornevoyGroupsNotPredlagaetsya': 'Negating the root group is not offered',
  'filterTree.title.deleteGroup': 'Delete group',
  'filterTree.groupConditions': 'Condition group',
  'filterTree.conditionView': 'View condition',
  'filterTree.peretaschitConditionGroup': 'Drag a condition or group',
  'filterTree.label.condition': '+ condition',
  'filterTree.label.group': '+ group',
  'filterTree.title.chtoSelect': 'What to select',
  'filterTree.title.chto': 'What',
  'filterTree.placeholder.searchProperties': 'Search property…',
  'filterTree.title.operatorConditions': 'Condition operator',
  'filterTree.title.operator': 'Operator',
  'filterTree.title.deleteCondition': 'Delete condition',
  'filterTree.zadayteValue': 'set a value',
  'filterTree.vidzhetValuesSleduyuschayaZadachaEditor': 'Value widget — the next editor task',
  'filterTree.nichegoNotFound': 'nothing found',
  'filterTree.ariaLabel.searchList': 'Search in list',

  // -- filterValue -------------------------------------------------------
  'filterValue.label.file': 'File',
  'filterValue.label.linkRef': 'Link',
  'filterValue.type.type': 'type',
  'filterValue.string.line': 'string',
  'filterValue.date.date': 'date',
  'filterValue.thisConditionNotPrinimaetItsValue': 'This condition does not accept %1: its value has a different kind',
  'filterValue.parents': 'parents',
  'filterValue.children': 'children',
  'filterValue.attachments': 'attachments',
  'filterValue.dnevnikovyhRecords': 'diary entries',
  'filterValue.values': 'values',
  'filterValue.header.opory': 'Anchors',
  'filterValue.ariaLabel.valuePredikata': 'Predicate value',
  'filterValue.ariaLabel.valueConditions': 'Condition value',
  'filterValue.placeholder.addProperty': 'Add property…',
  'filterValue.optionsHeader.values': 'Values',
  'filterValue.placeholder.slova': 'words…',
  'filterValue.tochnayaDate': 'Exact date',
  'filterValue.otnositelnyeDates': 'RELATIVE DATES',
  'filterValue.sdvigOpory': 'Anchor offset: +30, −30 or 0',
  'filterValue.title.resetSegodnya': 'Reset to “today, 0”',
  'filterValue.label.d': 'd',
  'filterValue.label.w': 'w',
  'filterValue.label.mo': 'mo',
  'filterValue.label.year': 'y',
  'filterValue.label.chas': 'h',
  'filterValue.label.min': 'min',
  'filterValue.removeValuesConditions': 'Remove from the condition value',
  'filterValue.placeholder.select': 'select…',
  'filterValue.label.byStrukture': 'by structure',
  'filterValue.label.byVsemLinks': 'by all links',
  'filterValue.ariaLabel.rezhimObhodaIerarhii': 'Hierarchy traversal mode',

  // -- hoverPreview ------------------------------------------------------
  'hoverPreview.with': 'From %1 · To %2',
  'hoverPreview.networkUnavailableKommentariyNotRead': 'Network unavailable — the comment cannot be read.',
  'hoverPreview.thoughtUnavailableNetwork': 'The thought is unavailable in this network.',
  'hoverPreview.notSucceededReadKommentariiNetwork': 'Failed to read comments of this network.',

  // -- imagePreview ------------------------------------------------------
  'imagePreview.notSucceededUzhatImageLimitIcon': 'failed to shrink the image to the icon limit',

  // -- keymap ------------------------------------------------------------

  // -- layerResync -------------------------------------------------------
  'layerResync.notSucceededFindKornevuyuThoughtNetwork': 'Failed to find the root thought of this network.',

  // -- lockGuard ---------------------------------------------------------
  'lockGuard.notSucceededPostavitZahvat': 'Failed to set the lock: %1',
  'lockGuard.redaktiruetFieldsZablokirovany': '%1 is editing %2 — fields are locked.',
  'lockGuard.etuThought': 'This thought',
  'lockGuard.etuLink': 'This link',
  'lockGuard.etotTypeThought': 'This thought type',
  'lockGuard.etotTypeLink': 'This link type',
  'lockGuard.thisProperty': 'This property',
  'lockGuard.obekt': 'Object',

  // -- metadata ----------------------------------------------------------
  'metadata.avtorCreate': 'Created by',
  'metadata.lastEditor': 'Last editor',
  'metadata.willPrisvoenSohranenii': 'will be assigned on save',
  'metadata.clickToVydelit': 'Click to select',
  'metadata.copyIdBuferObmena': 'Copy ID to clipboard',
  'metadata.idSkopirovan': 'ID copied.',
  'metadata.edit': '(edited: %1)',

  // -- calendar ----------------------------------------------------------
  'calendar.pn': 'Mon',
  'calendar.vt': 'Tue',
  'calendar.sr': 'Wed',
  'calendar.cht': 'Thu',
  'calendar.pt': 'Fri',
  'calendar.sb': 'Sat',
  'calendar.vs': 'Sun',
  'calendar.yanvar': 'January',
  'calendar.fevral': 'February',
  'calendar.mart': 'March',
  'calendar.aprel': 'April',
  'calendar.may': 'May',
  'calendar.iyun': 'June',
  'calendar.iyul': 'July',
  'calendar.avgust': 'August',
  'calendar.sentyabr': 'September',
  'calendar.oktyabr': 'October',
  'calendar.noyabr': 'November',
  'calendar.dekabr': 'December',
  'calendar.yanv': 'Jan',
  'calendar.fev': 'Feb',
  'calendar.mar': 'Mar',
  'calendar.apr': 'Apr',
  'calendar.may2': 'May',
  'calendar.iyun2': 'Jun',
  'calendar.iyul2': 'Jul',
  'calendar.avg': 'Aug',
  'calendar.sen': 'Sep',
  'calendar.okt': 'Oct',
  'calendar.noya': 'Nov',
  'calendar.dek': 'Dec',
  'calendar.title.selectMonth': 'Select month',
  'calendar.title.editYear': 'Edit year',
  'calendar.title.predyduschiyMonth': 'Previous month',
  'calendar.title.pereytiTekuscheyDate': 'Go to the current date',
  'calendar.title.sleduyuschiyMonth': 'Next month',
  'calendar.ariaLabel.year': 'Year',
  'calendar.title.month': 'Month',
  'calendar.week': 'Week %1: %2 — %3',

  // -- periodEditor ------------------------------------------------------
  'periodEditor.label.today1dZavtra': '$today+1d — tomorrow',
  'periodEditor.label.today1dVchera': '$today-1d — yesterday',
  'periodEditor.label.weekstartStartWeek': '$weekStart — start of week',
  'periodEditor.label.weekendEndWeek': '$weekEnd — end of week',
  'periodEditor.weekstart1wStartProshloyWeek': '$weekStart-1w — start of last week',
  'periodEditor.weekstart1wStartBuduscheyWeek': '$weekStart+1w — start of next week',
  'periodEditor.label.monthstartStartMonth': '$monthStart — start of month',
  'periodEditor.label.monthendEndMonth': '$monthEnd — end of month',
  'periodEditor.monthstart1moStartProshlogoMonth': '$monthStart-1mo — start of last month',
  'periodEditor.monthend1moEndBuduschegoMonth': '$monthEnd+1mo — end of next month',
  'periodEditor.label.yearstartStartYear': '$yearStart — start of year',
  'periodEditor.label.yearendEndYear': '$yearEnd — end of year',
  'periodEditor.yearstart1yStartProshlogoYear': '$yearStart-1y — start of last year',
  'periodEditor.yearend1yEndBuduschegoYear': '$yearEnd+1y — end of next year',
  'periodEditor.label.today7dViaWeek': '$today+7d — in a week',
  'periodEditor.label.today7dWeekBack': '$today-7d — a week ago',
  'periodEditor.label.today30dViaMonth': '$today+30d — in a month',
  'periodEditor.label.today30dMonthBack': '$today-30d — a month ago',
  'periodEditor.notTokenPeriodDostupnyTodayNow': '“%1” is not a period token: $today/$now, $weekStart/$weekEnd, $monthStart/$monthEnd, $yearStart/$yearEnd and arithmetic ±Nd/±Nw/±Nmo/±Ny are available (legacy dotted spellings are accepted; $thought.* tokens require a thought context).',
  'periodEditor.by': 'to %1',
  'periodEditor.with': 'from %1',
  'periodEditor.tokensDatesFieldOtklyuchenyEnterDate': 'Date tokens are disabled in this field — specify a date.',
  'periodEditor.ozhidaetsyaGgggMmDdPolnyyIso': '“%1” — expected YYYY-MM-DD, a full ISO instant or a token ($today/$now, week/month/year boundaries ± arithmetic).',
  'periodEditor.periodNotZadan': 'Period not set',
  'periodEditor.label.dateTime': 'Date and time',
  'periodEditor.label.diapazon': 'Range',
  'periodEditor.label.presety': 'Presets',
  'periodEditor.label.segodnya': 'today',
  'periodEditor.label.seychas': 'now',
  'periodEditor.label.startWeek': 'start of week',
  'periodEditor.label.endWeek': 'end of week',
  'periodEditor.label.startMonth': 'start of month',
  'periodEditor.label.endMonth': 'end of month',
  'periodEditor.label.startYear': 'start of year',
  'periodEditor.label.endYear': 'end of year',
  'periodEditor.label.years': 'years',
  'periodEditor.ariaLabel.rezhimPeriod': 'Period mode',
  'periodEditor.rezhimPeriodPresetyDates': 'Period mode: presets or dates',
  'periodEditor.ggggMmDdToday': 'YYYY-MM-DD or $today…',
  'periodEditor.header.tokens': 'Tokens',
  'periodEditor.date': '%1 — date',
  'periodEditor.time': '%1 — time',
  'periodEditor.timeOptional': '%1 — time (optional)',
  'periodEditor.title.editPeriod': 'Edit period',
  'periodEditor.title.clearPeriod': 'Clear period',
  'periodEditor.uchityvatTime': 'Include time',
  'periodEditor.start': 'Start',
  'periodEditor.end': 'End',
  'periodEditor.bazovyyPreset': '%1 — base preset',
  'periodEditor.smeschenieCanOtricatelnoe': '%1 — offset (may be negative)',
  'periodEditor.edinicaSmescheniya': '%1 — offset unit',
  'periodEditor.header.bazovyePresety': 'Base presets',
  'periodEditor.showListPresetov': 'Show preset list',

  // -- propertyList ------------------------------------------------------
  'propertyList.url.urlSaytFile': 'URL (website or file)',
  'propertyList.linkRefThoughtLegacyUnavailable': 'thought link (legacy, unavailable)',
  'propertyList.cross_network_ref.krossSetevayaLinkRef': 'cross-network link',
  'propertyList.publication.publication': 'publication',
  'propertyList.unasledovano': 'inherited',
  'propertyList.connected': 'attached',
  'propertyList.link': 'link (%1 - %2)',
  'propertyList.propertyAlreadyNasleduetsyaThisTipomPredka': 'The property is already inherited by this type from an ancestor',
  'propertyList.thisNameStoronyPropertiesLinkAlready': 'This link-property side name is already attached — the other (reverse) name can be attached.',
  'propertyList.propertyAlreadyConnectedEtomuTipu': 'The property is already attached to this type',

  // -- events ------------------------------------------------------------
  'events.createdThought': 'thought created',
  'events.changedThought': 'thought changed',
  'events.deletedThought': 'thought deleted',
  'events.changedOrderThoughts': 'thought order changed',
  'events.changedOrderProperties': 'property order changed',
  'events.createdLink': 'link created',
  'events.changedLink': 'link changed',
  'events.deletedLink': 'link deleted',
  'events.createdTypeThoughts': 'thought type created',
  'events.changedTypeThoughts': 'thought type changed',
  'events.deletedTypeThoughts': 'thought type deleted',
  'events.createdTypeLinks': 'link type created',
  'events.changedTypeLinks': 'link type changed',
  'events.deletedTypeLinks': 'link type deleted',
  'events.addedPropertyType': 'type property added',
  'events.changedPropertyType': 'type property changed',
  'events.deletedPropertyType': 'type property deleted',
  'events.addedProperty': 'property added',
  'events.changedProperty': 'property changed',
  'events.deletedProperty': 'property deleted',
  'events.addedKommentariy': 'comment added',
  'events.changedKommentariy': 'comment changed',
  'events.deletedKommentariy': 'comment deleted',
  'events.addedAttachment': 'attachment added',
  'events.changedAttachment': 'attachment changed',
  'events.deletedAttachment': 'attachment deleted',
  'events.uAttachmentsAddedOwner': 'attachment owner added',
  'events.uAttachmentsUnsetOwner': 'attachment owner removed',
  'events.changedNetwork': 'network changed',
  'events.networkDeleted': 'network deleted',
  'events.addedMemberNetwork': 'network member added',
  'events.memberPokinulNetwork': 'member left the network',
  'events.changedRolMember': 'member role changed',
  'events.memberPodklyuchilsya': 'member connected',
  'events.memberOtklyuchilsya': 'member disconnected',
  'events.memberSmenilFocus': 'member changed focus',
  'events.obnovlenySettings': 'settings updated',
  'events.obnovlenaSortZon': 'zone sort updated',
  'events.obnovlenOrderZony': 'zone order updated',
  'events.obnovlenProsmotr': 'view updated',
  'events.savedView': 'view saved',
  'events.changedView': 'view changed',
  'events.deletedView': 'view deleted',
  'events.obnovlenyZakreplennye': 'pinned items updated',
  'events.mergedLayer': 'layer merged',
  'events.zahvachenObekt': 'object locked',
  'events.unsetZahvat': 'lock removed',
  'events.sbroshenZahvat': 'lock reset',
  'events.addedViewType': 'type view added',
  'events.changedViewType': 'type view changed',
  'events.deletedViewType': 'type view deleted',
  'events.ispolnenView': 'view executed',
  'events.addedViewThought': 'thought view added',
  'events.changedViewThought': 'thought view changed',
  'events.deletedViewThought': 'thought view deleted',
  'events.changedPublication': 'publication changed',
  'events.changedOrderPublication': 'publication order changed',
  'events.changedIsklyucheniyaPublication': 'publication exclusions changed',
  'events.publicationPeresobrana': 'publication rebuilt',
  'events.publicationTrash': 'publication in basket',
  'events.publicationRestored': 'publication restored',
  'events.publicationDeleted': 'publication deleted',
  'events.changedShelf': 'shelf changed',
  'events.shelfDeleted': 'shelf deleted',
  'events.incomingLink': 'Incoming links',
  'events.outgoingLink': 'Outgoing links',
  'events.copy': '%1 (copy)',
  'events.copy2': '%1 (copy %2)',
  'events.b': 'B',
  'events.kb': 'KB',
  'events.mb': 'MB',
  'events.gb': 'GB',
  'events.tb': 'TB',
  'events.base': 'Base',

  // -- savedFilters ------------------------------------------------------
  'savedFilters.title.deleteSettingsView': 'Delete view settings',
  'savedFilters.title.selectSohranennyyView': 'Select a saved view',
  'savedFilters.enterNameView': 'Enter a view name',
  'savedFilters.saveView': 'Save view',
  'savedFilters.viewSaved': 'View “%1” saved',
  'savedFilters.viewTakimNameNotFound': 'No view with this name found',
  'savedFilters.deleteView': 'Delete view',
  'savedFilters.deleteSohranennyyView': 'Delete saved view “%1”?',
  'savedFilters.pereimenovatView': 'Rename view',
  'savedFilters.name': 'Name',
  'savedFilters.copyView': 'Copy view',

  // -- suggest -----------------------------------------------------------
  'suggest.poslednieValues': 'Recent values',

  // -- thoughtCloud ------------------------------------------------------
  'thoughtCloud.thoughtNahoditsyaTrashClickDeleteRestore': 'The thought is in the basket. Click to delete/restore',
  'thoughtCloud.thoughtOtherNetwork': 'Thought from another network: %1',
  'thoughtCloud.removeValues': 'Remove from value',

  // -- userSelect --------------------------------------------------------
  'userSelect.neizvestnyyMember': 'unknown member',
  'userSelect.lyuboy': 'any',

  // -- main --------------------------------------------------------------
  'main.notSucceededZapustitPrilozhenie': 'Failed to start the application.',

  // -- pinned ------------------------------------------------------------
  'pinned.title.zakreplennyeThought': 'Pinned thoughts',
  'pinned.pinCanNotMoreThoughtsFirst': 'No more than %1 thoughts can be pinned. First unpin extra thoughts from the pinned panel.',
  'pinned.notSucceededEditZakreplennye': 'Failed to change pinned items: %1',
  'pinned.zakrepiteThought': 'pin a thought',
  'pinned.zakreplennyeSkryty': 'pinned hidden',
  'pinned.ostalnyeZakreplennye': 'Other pinned',

  // -- about -------------------------------------------------------------
  'about.inZaycevAkaNerkuda': '© 2026 V. Zaytsev (aka Nerkuda)',
  'about.label.novoeVersion': 'What\'s new in the version',
  'about.label.sobrannyeRelizy': 'Built releases',
  'about.label.textLicenzii': 'License text',
  'about.version': 'Version …',
  'about.theEndlessThoughtNetworkSelfHosted': 'The Endless Thought Network — self-hosted thought graph',
  'about.licenziya': '%1 · License %2',
  'about.title.oProgramme': 'About',
  'about.version2': 'Version %1',
  'about.serverNoPodklyucheniya': 'Server: no connection',
  'about.server': 'server',
  'about.serverVersion': 'Server: %1 · version %2',

  // -- activity ----------------------------------------------------------
  'activity.label.views': 'Views…',
  'activity.conditionPrezhnegoViewNotVyrazhaetsyaProfilem': 'A condition of the previous view cannot be expressed by the “Events” profile and was dropped: %1.',
  'activity.forThisTypeLinkMoreNo': 'This link type has no property in the registry yet — editing is not possible.',
  'activity.openPropertyLink': 'Open link property',
  'activity.suschnostDeletedUnavailableSnapshotLog': 'The entity is deleted or unavailable. Snapshot from the log:',
  'activity.name.action': 'Action',
  'activity.name.title': 'Title',
  'activity.name.kogda': 'When',
  'activity.name.layer': 'Layer',
  'activity.name.idSuschnosti': 'entity id',
  'activity.title.snapshotEvents': 'Event snapshot',
  'activity.title.collapseLogDates': 'Roll the log up to a date',
  'activity.deletedRecords': 'Records deleted: %1.',
  'activity.deletedOstavleno': 'Deleted %1, kept %2.',
  'activity.title.obrezatLogDates': 'Truncate the log to a date',
  'activity.buttonLabel.obrezat': 'Truncate',
  'activity.allRecordsLogDatesWillZatronuty': 'All log records up to this date will be affected.',
  'activity.label.dateVklyuchitelno': 'Date (inclusive)',
  'activity.operationNeobratimaRecordsWillDeletedWithout': 'The operation is irreversible — records will be deleted without the possibility of recovery.',
  'activity.allRecordsLogAktivnostiVybrannoyDates': '%1 all activity log records up to the selected date? The action is irreversible.',
  'activity.label.typeThought': 'thought type',
  'activity.label.typeLink': 'link type',
  'activity.label.property': 'property',
  'activity.label.attachment': 'attachment',
  'activity.label.layer': 'layer',

  // -- chrono ------------------------------------------------------------
  'chrono.dateTitle.periodDnevnikovoyRecords': 'Diary entry period',
  'chrono.title.actionsDnevnikovoyRecord': 'Diary entry actions',
  'chrono.title.unsetPrivyazku': 'Unlink',
  'chrono.name.moiRecordsZaWeek': 'My entries for the week',
  'chrono.name.recordsZaDney': 'Entries for 30 days',
  'chrono.record': 'Entry',
  'chrono.header.naydennyeRecords': 'Matching entries',
  'chrono.title.searchZapisyam': 'Search entries',
  'chrono.slovaViaProbelAllObyazatelnyLyubye': 'Space-separated words, all required; * matches any characters; -word excludes. The condition searches an entry in two ways (OR): by the entry body and title, and by target thoughts in the selected areas. The “Matching entries” hint opens an entry by navigating (period from the entry, scrolling and highlighting).',
  'chrono.label.firstStarye': 'Oldest first',
  'chrono.label.firstNovye': 'Newest first',
  'chrono.ariaLabel.napravlenieSort': 'Sort direction',
  'chrono.label.thought': '+ thought',

  // -- history -----------------------------------------------------------
  'history.noPredyduschihThoughts': 'no previous thoughts',
  'history.ostalnayaIstoriya': 'Other history',

  // -- layerMerge --------------------------------------------------------
  'layerMerge.base': 'Base',
  'layerMerge.thought': 'thought “%1”',
  'layerMerge.vybrannyhThoughtsIzmenennyhLayer': '%1 selected thoughts changed in the layer',
  'layerMerge.editsLayerRazreshayutsyaOtnosheniyu': 'Edits of %1 in layer “%2” are resolved against “%3”.',
  'layerMerge.notSucceededReadOtlichiyaThoughtVariant': 'Failed to read thought differences — the “Merge changes” option is unavailable.',
  'layerMerge.otkazatsyaChanges': 'Discard changes',
  'layerMerge.allEditsLayerWillDeletedVernetsya': 'All edits in the layer will be deleted — version “%1” will return. This cannot be undone.',
  'layerMerge.polnostyuPerepisatThoughtBase': 'Overwrite the thought in Base completely',
  'layerMerge.versionLayerPerenositsyaCelikomChangesThis': 'The layer version is carried over entirely; changes of “%1” to these thoughts are overwritten.',
  'layerMerge.mergeChanges': 'Merge changes',
  'layerMerge.postoyannyyKommentariyObedinyaetsyaBaseMarkeryKonflikto': 'The permanent comment is merged with Base (git-style conflict markers); links, properties and synonyms are taken from the layer.',
  'layerMerge.mergeThought': 'Merge the thought into “%1”?',
  'layerMerge.mergeVybrannyeThought': 'Merge the selected thoughts into “%1”?',
  'layerMerge.label.vypolnit': 'Execute',
  'layerMerge.otkazatsyaChanges2': 'Discard changes?',
  'layerMerge.allEditsLayerWillDeletedBezvozvratno': 'All edits of %1 in the layer will be deleted irrevocably. Base will not change.',
  'layerMerge.changesDeletedLayer': 'Changes of %1 deleted from the layer.',
  'layerMerge.mergedThoughtsKommentariyObedinenKonfliktnyhBlokov': 'Thoughts merged: %1. The comment was merged, conflict blocks: %2.',
  'layerMerge.merged': 'Merged into “%1”: %2.',
  'layerMerge.notSucceededRazreshitChanges': 'Failed to resolve changes',

  // -- layers ------------------------------------------------------------
  'layers.propertiesLayer': 'Layer properties',
  'layers.layerNotFound': 'Layer %1 not found',
  'layers.dark': 'dark',
  'layers.light': 'light',
  'layers.polosaFocus': 'Focus strip',
  'layers.fonHolsta': 'Canvas background',
  'layers.cvetaTemyVtoroyVariantVychislyaetsyaInversiey': 'Colors for the %1 theme; the second variant is computed by inverting lightness.',
  'layers.notSucceededSaveLayer': 'Failed to save the layer',
  'layers.propertiesBase': 'Base properties',
  'layers.propertiesLayer2': 'Properties of layer “%1”',
  'layers.placeholder.naprimerEditsAvgusta': 'For example: August edits',
  'layers.zachemLayerToSleduyuschiyAgentPonyal': 'Why this layer exists — so the next person (or agent) understands without asking',
  'layers.placeholder.vetkaGitOptional': 'git branch (optional)',
  'layers.editsOstanutsyaLayerBaseNotIzmenitsya': 'Edits will remain in the layer. Base will not change until you merge the layer.',
  'layers.novyyLayerPoluchitSobstvennyeCvetaMap': 'The new layer will get its own map colors (focus strip and background) so it is visible; they can be changed in “Layer properties”.',
  'layers.label.vetkaGit': 'Git branch',
  'layers.notSucceededCreateLayer': 'Failed to create the layer',
  'layers.title.novyyLayerChanges': 'New change layer',
  'layers.layerWillDeletedVmesteDochernimiLayers': 'The layer will be deleted along with %1 child layers: %2.',
  'layers.deleteLayerNotMenyaetBaseTenevye': 'Deleting a layer does not change Base: the layer\'s shadow edits will be lost, everything else stays as is.',
  'layers.deleteLayer': 'Delete layer “%1”?',
  'layers.label.deleteLayer': 'Delete layer',
  'layers.notSucceededDeleteLayer': 'Failed to delete the layer',
  'layers.allEditsLayerWillMovedKonflikte': 'All layer edits will be moved to “%1”. On a conflict (a row changed in Base after the layer was created) the merge will not run — you will see a list of differences.',
  'layers.merge': 'Merge “%1” into “%2”?',
  'layers.label.merge': 'Merge',
  'layers.mergeRejected': 'Merge rejected',
  'layers.movedRows': 'Rows moved:',
  'layers.orderLinksChangedThoughtsSvernuto': 'Link order changed for %1 thoughts (collapsed).',
  'layers.linkIscheznuvshimKoncomPropuscheny': 'Links with a vanished end were skipped: %1.',
  'layers.beforeSliyaniemCreatedRezervnyyLayerRuchnogo': 'A reserve layer was created before the merge for manual rollback.',
  'layers.rezervnyyLayerNotNeeded': 'The reserve layer was not needed.',
  'layers.title.layerMerged': 'Layer merged',
  'layers.loadingListOtlichiy': 'Loading the list of differences…',
  'layers.title.otlichiyNo': 'No differences',
  'layers.layerNotMenyaetBaseSravnivatNechego': 'The layer does not change Base — there is nothing to compare.',
  'layers.notSucceededLoadOtlichiya': 'Failed to load differences: %1',
  'layers.notSucceededDogruzitOtlichiya': 'Failed to load more differences: %1',
  'layers.label.povtorit': 'Retry',
  'layers.otlichiya': 'Diff of “%1” against “%2”',
  'layers.dobavlennyeLink': 'Added links',
  'layers.udalennyeLink': 'Deleted links',
  'layers.izmenennyyTypeLink': 'Changed link type',
  'layers.izmenennyyOrderLinks': 'Changed link order',
  'layers.smenennyyParent': 'Changed parent',
  'layers.izmenennyeThought': 'Changed thoughts',
  'layers.izmenennyeLink': 'Changed links',
  'layers.showPostrochnyyDiff': 'Show line-by-line diff',
  'layers.link': '≈ link %1',
  'layers.link2': 'link %1',
  'layers.loadingTekstovogoDiffa': 'Loading text diff…',
  'layers.notSucceededLoadTekstovyyDiff': 'Failed to load the text diff: %1',
  'layers.editsThought': 'Edits of thought “%1”',
  'layers.synonyms.synonyms': 'Synonyms',
  'layers.comment.postoyannyyKommentariy': 'Permanent comment',
  'layers.thoughtLayerSovpadaetBase': 'The thought in the layer matches Base.',
  'layers.layer': 'layer',

  // -- networks ----------------------------------------------------------
  'networks.owner': 'owner',
  'networks.member': 'member',
  'networks.mysleseti': 'Thought networks',
  'networks.label.createNetwork': 'Create network',
  'networks.label.otklyuchitsya': 'Disconnect',
  'networks.podklyucheny': 'Connected as %1',
  'networks.uVasPokaNoNetworksSozdayte': 'You have no networks yet. Create the first one!',
  'networks.owner2': 'Owner: %1',
  'networks.vernutsyaEkranuPodklyucheniya': 'Return to the connection screen?',
  'networks.label.titleNetwork': 'Network name',
  'networks.label.descriptionOptional': 'Description (optional)',
  'networks.enterTitleNetwork': 'Enter a network name.',
  'networks.title.createMysleset': 'Create thought network',

  // -- onboarding --------------------------------------------------------
  'onboarding.selfHostedGraphThoughtsPodklyuchitesSvoemu': 'Self-hosted thought graph. Connect to your ETN server to get started.',
  'onboarding.sohranennyeServery': 'Saved servers',
  'onboarding.novoePodklyuchenie': 'New connection',
  'onboarding.moyServerOptional': 'My server (optional)',
  'onboarding.label.adresServer': 'Server address',
  'onboarding.label.podklyuchitsya': 'Connect',
  'onboarding.deleteServerAktivnoePodklyuchenieWillRazorvano': 'Delete server “%1” (%2)? The active connection will be terminated, and local data (tabs, drafts, history) will be deleted. This action is irreversible.',
  'onboarding.deleteServerLokalnyeDannyeThisProfilya': 'Delete server “%1” (%2)? Local data of this profile will be deleted. This action is irreversible.',
  'onboarding.deleteSohranennyyServer': 'Delete saved server',
  'onboarding.enterAdresServerNaprimerHttpLocalhost': 'Enter the server address, for example http://localhost:3000',
  'onboarding.enterApiKey': 'Enter the API key.',

  // -- propertyManager ---------------------------------------------------
  'propertyManager.connected': 'attached to %1 %2',
  'propertyManager.zapolneno': 'set in %1 %2',
  'propertyManager.deleteProperty': 'Delete property',
  'propertyManager.propertyCannotDeleteFirstOtklyuchiteIts': 'Property “%1” cannot be deleted: %2. First detach it from all types and clear values in the “Out-of-type properties” group.',
  'propertyManager.deletePropertyLink2etoActionIrreversible': 'Delete link property %1? %2This action is irreversible.',
  'propertyManager.deletePropertyThisActionIrreversible': 'Delete property “%1”? This action is irreversible.',
  'propertyManager.deletedStrukturnymiParentsChildren': 'Deleted. %1 %2 %3 structural “Родители/Потомки”.',
  'propertyManager.propertyDeleted': 'Property deleted.',
  'propertyManager.valueDefaultAllTypes': 'Default value for all types',
  'propertyManager.valueDefaultIstochnikovLyubyhTypesCan': 'Default value for sources of any types. It can be overridden by values in the table rows above',
  'propertyManager.valueDefaultNaznacheniyLyubyhTypesCan': 'Default value for targets of any types. It can be overridden by values in the table rows above',
  'propertyManager.descriptionPropertiesOnoZnachitKakomFormate': 'Property description: what it means and what format the value has (a hint in the thought editor and for AI agents)',
  'propertyManager.propertyTakimNameAlreadyHas': 'A property with this name already exists.',
  'propertyManager.label.vidValues': 'Value kind',
  'propertyManager.label.description': 'Description',
  'propertyManager.risovatLinkMapDefault': 'draw the link on the map by default',
  'propertyManager.zapolnennayaLinkRefBlokiruetDeleteTargets': 'a filled link blocks deletion of the target',
  'propertyManager.skalyarnoeProperty': 'Scalar property',
  'propertyManager.titlePropertiesObyazatelno': 'Property title (required)',
  'propertyManager.label.nameProperties': 'Property name',
  'propertyManager.label.valueDefault': 'Default value',
  'propertyManager.propertyLink': 'Link property',
  'propertyManager.fromIstochnikaNaznacheniyu': 'From source to target',
  'propertyManager.fromNaznacheniyaIstochniku': 'From target to source',
  'propertyManager.label.nameIstochnike': 'Name on the source',
  'propertyManager.label.nameNaznachenii': 'Name on the target',
  'propertyManager.placeholder.withoutParent': 'No parent',
  'propertyManager.label.oformlenie': 'Appearance…',
  'propertyManager.label.roditelskiyTypeLink': 'Parent link type',
  'propertyManager.typesIstochnikov': 'Source types',
  'propertyManager.typesNaznacheniy': 'Target types',
  'propertyManager.typesThoughts': 'Thought types',
  'propertyManager.label.addType': 'Add type',
  'propertyManager.addPrivyazkuPropertiesTipuThought': 'Add a property attachment to a thought type',
  'propertyManager.obyazatelnoe': 'Required',
  'propertyManager.noPrivyazokClickAddType': 'No attachments. Click Add type.',
  'propertyManager.title.otmetitAll': 'Check all',
  'propertyManager.metadataPoyavyatsyaAfterSave': 'Metadata will appear after saving.',
  'propertyManager.changeKategoriyuSkalyarLinkCannotValues': 'The category (scalar ↔ link) cannot be changed: link values live as edges, not in the values table.',
  'propertyManager.enterNamesObeihStoron': 'Specify names for both sides.',
  'propertyManager.titlePropertiesObyazatelno2': 'The property name is required.',
  'propertyManager.changeTypeValues': 'Change value type',
  'propertyManager.changeTypeValuesPropertiesValuesAll': 'Change the value type of property “%1”? Values in all elements will be converted to the new type; incompatible ones will be cleared.',
  'propertyManager.zhditeVypolnyaetsyaObrabotkaValues': 'Wait: values are being processed…',
  'propertyManager.obrabotkaVypolnenaPreobrazovanoDeleted': 'Processing completed: converted %1, deleted %2.',
  'propertyManager.obrabotkaVypolnena': 'Processing completed.',
  'propertyManager.novoeProperty': 'New property',
  'propertyManager.property': 'Property — “%1”',
  'propertyManager.emptySozdaniiThoughtIspolzuetsyaObscheeValue': 'Empty — when a thought is created, the shared value of the attachment side is used.',
  'propertyManager.variantyValuesOdnomuRow': 'Value options — one per line',
  'propertyManager.label.vybiratList': 'choose from list',
  'propertyManager.label.neskolkoValues': 'multiple values',
  'propertyManager.tipu': 'to type',
  'propertyManager.tipam': 'to types',
  'propertyManager.types': 'types',
  'propertyManager.value': 'value',
  'propertyManager.values': 'values',
  'propertyManager.ispolzovanie': 'Usage',
  'propertyManager.valuesType': 'Values in the type',
  'propertyManager.propertyNiChemuNotConnected': 'The property is not attached to anything.',
  'propertyManager.title.openType': 'Open type',
  'propertyManager.vsegoValuesTypeVneType': 'Total values in the type: %1. Out of type: %2.',
  'propertyManager.forThisTypeLinkMoreNo': 'This link type has no property in the registry yet. A link type without a property is useless — create a property via “Add”.',
  'propertyManager.stanutStrukturnymiParentsChildrenPoyavyatsyaIerarhii': '%1 %2 become structural “Родители/Потомки” and will appear in the thought hierarchy. ',
  'propertyManager.stalo': 'became',
  'propertyManager.stali': 'became',

  // -- settingsLogs ------------------------------------------------------
  'settingsLogs.client': 'Client',
  'settingsLogs.fileLogClientDiagnosticsToggleApply': 'Client file log for diagnostics. The toggle applies immediately; ERROR records are always written.',
  'settingsLogs.label.loggingClient': 'Client logging',
  'settingsLogs.loggingClientEnabled': 'Client logging enabled.',
  'settingsLogs.loggingClientDisabled': 'Client logging disabled.',
  'settingsLogs.title.openFileLog': 'Open the log file',
  'settingsLogs.deleteAllFilesLogClient': 'Delete all client log files',
  'settingsLogs.currentFileLog': 'Current log file:',
  'settingsLogs.deleteLogsClient': 'Delete client logs?',
  'settingsLogs.allFilesLogClientWillDeleted': 'All client log files will be deleted, and the current daily file will be cleared. This action is irreversible.',
  'settingsLogs.deletedFilesCurrentFileUsechen': 'Files deleted: %1; the current file was truncated.',
  'settingsLogs.server': 'Server',
  'settingsLogs.upravlenieLogServerDostupnoAdminPodklyuchennom': 'Server log management is available to the administrator when a server is connected.',
  'settingsLogs.fileLogServerDiagnosticsFlagZhivet': 'Server file log for diagnostics. The flag lives in server memory and resets on restart; the toggle applies immediately.',
  'settingsLogs.label.loggingServer': 'Server logging',
  'settingsLogs.loggingServerEnabled': 'Server logging enabled.',
  'settingsLogs.loggingServerDisabled': 'Server logging disabled.',
  'settingsLogs.filesLogServerMoreNo': 'There are no server log files yet.',
  'settingsLogs.label.download': 'Download…',
  'settingsLogs.title.downloadFileLogServer': 'Download a server log file',
  'settingsLogs.openCurrentFileLogServer': 'Open the current server log file',
  'settingsLogs.deleteAllFilesLogServer': 'Delete all server log files',
  'settingsLogs.katalogLogServerHranenieD': 'Server log directory (kept for %1 days):',
  'settingsLogs.filesLogSelectFileSkachivaniya': 'Log files (select a file to download):',
  'settingsLogs.saved': 'Saved: %1',
  'settingsLogs.deleteLogsServer': 'Delete server logs?',
  'settingsLogs.allFilesLogServerWillDeleted': 'All server log files will be deleted, and the current daily file will be cleared. This action is irreversible.',
  'settingsLogs.filesLogServerDeleted': 'Server log files deleted.',
  'settingsLogs.noPravAdminUpravlenieLogServer': 'No administrator rights: server log management is available to the administrator only.',
  'settingsLogs.serverUnavailablePoprobuytePozzhe': 'Server unavailable, try again later.',
  'settingsLogs.notSucceededPoluchitStateLogServer': 'Failed to get the server log state: %1',
  'settingsLogs.b': '%1 B',
  'settingsLogs.kb': '%1 KB',
  'settingsLogs.mb': '%1 MB',

  // -- settings ----------------------------------------------------------
  'settings.user.user': 'User',
  'settings.network.mysleset': 'Thought network',
  'settings.logs.logging': 'Logging',
  'settings.when_to_use.kogdaUse': 'When to use',
  'settings.conventions.pravila': 'Rules',
  'settings.examples.examples': 'Examples',
  'settings.naznachenieNetworkOdnomDvuhAbzacahUvidit': 'The purpose of the network in one or two paragraphs. Seen by both humans and AI agents when choosing a network.',
  'settings.kogdaAgentuObraschatsyaNetworkKazhdogoUse': 'When an agent should consult this network. For each use case — which other network fields to read.\n\nExample:\n- Coding → conventions, structure\n- Project retrospective → examples, conventions',
  'settings.pravilaRecordsFormatHronologiyPometkaActive': 'Recording rules: chronology format, active flag, naming, references to types and templates.',
  'settings.examplesHoroshihPlohihRecordsToAgent': 'Examples of good and bad entries — so the agent does not invent the form.',
  'settings.label.ponedelnik': 'Monday',
  'settings.label.vtornik': 'Tuesday',
  'settings.label.sreda': 'Wednesday',
  'settings.label.chetverg': 'Thursday',
  'settings.label.pyatnica': 'Friday',
  'settings.label.subbota': 'Saturday',
  'settings.label.voskresene': 'Sunday',
  'settings.shiftEnterApplyCtrlEnterApply': 'Shift+Enter — apply, Ctrl+Enter — apply and close',
  'settings.profileNotLoaded': 'Profile not loaded.',
  'settings.notZadano': 'Not set',
  'settings.profileUser': 'User profile',
  'settings.label.nameOtobrazheniya': 'Display name',
  'settings.label.login': 'Login',
  'settings.nameOtobrazhaetsyaTulbareOtherMestahInterfeysa': 'The name is displayed in the toolbar and other parts of the interface. The login is set when the account is created.',
  'settings.emptyLabel.notZadano': '— not set —',
  'settings.placeholder.typeThought': 'Thought type…',
  'settings.showNeaktualnyeThoughtLinkNetwork': 'Show inactive thoughts and links in this network',
  'settings.showSoderzhimoeTrashNetwork': 'Show basket contents in this network',
  'settings.theseFieldsZadaetOwnerNetworkAdmin': 'These fields are set by the network owner or the server administrator; changes are saved for all members.',
  'settings.theseFieldsZadaetOwnerNetworkAdmin2': 'These fields are set by the network owner or the server administrator. You can view them but cannot change them.',
  'settings.settingsNetwork': 'Network settings',
  'settings.label.firstDenWeek': 'First day of week',
  'settings.commonSettingAllCalendarVidzhetovNetwork': 'A common setting for all calendar widgets of the network and the $weekStart/$weekEnd calendar tokens. When a network is created, the value is taken from the server OS locale.',
  'settings.samoopisanieNetworkLyudeyAiAgentsMarkdown': 'Self-description of the network for people and AI agents. Markdown: links, lists, images. In the “When to use” tab, list the scenarios this network suits.',
  'settings.uzlovoyTypeRazdelaOpredelyaetStrukturuNetwork': 'The section root type defines the network structure (read via `etn.networks.structure`). All active thoughts of the selected type become sections. The type selected here cannot be deleted until the reference is removed.',
  'settings.label.uzlovoyTypeRazdela': 'Section root type',
  'settings.typeInstructionAgentsZadaetKakieThought': 'The agent instruction type defines which thoughts are served by `etn.instructions` (ADR 717f04df). Without a selection, the showcase returns an empty list. The type selected here is protected from deletion just like the root type.',
  'settings.label.typeInstructionAgents': 'Agent instruction type',
  'settings.vidimost': 'Visibility',
  'settings.commonSettingAllVashihKlientovNetwork': 'A common setting for all your clients in this network.',
  'settings.label.light': 'Light',
  'settings.label.dark': 'Dark',
  'settings.tema': 'Theme',
  'settings.applyAllEkranahAppliesOnlyClient': 'Applies to all screens. Affects this client only.',
  'settings.razmerOblachka': 'Bubble size',
  'settings.shirinaOblachkaPx': 'Bubble width, px (%1–%2)',
  'settings.otstupBetweenOblachkamiPx': 'Spacing between bubbles, px (%1–%2)',
  'settings.hranitsyaOnlyClient': 'Stored on this client only.',
  'settings.settingsSaved': 'Settings saved.',

  // -- structures --------------------------------------------------------
  'structures.komandyView': 'View commands',
  'structures.viewPustKomandaNotPrimenena': 'The view is empty — the command was not applied.',
  'structures.addedVydeleniyu': 'Added to selection: %1.',
  'structures.ubranoSelection': 'Removed from selection: %1.',
  'structures.selectedThoughtsVydeleniiNo': 'There are no selected thoughts in the selection.',
  'structures.podchinennyeThought': 'Child thoughts',
  'structures.notSucceededCreateNovyhThoughtsOni': 'Failed to create %1 new thoughts — they were skipped.',
  'structures.createdNovyhThoughts': 'New thoughts created: %1.',
  'structures.confirmTitle.doEdinstvennymiParents': 'Make only parents',
  'structures.uSelectedThoughtsWillDeletedAll': 'All incoming links of %1 selected thoughts will be deleted except links to the selected thoughts (%2). Continue?',
  'structures.razorvat': 'Unlink',
  'structures.razorvatLinkParents': 'Unlink from parents',
  'structures.razorvatLinkPodchinennymi': 'Unlink from children',
  'structures.uSelectedThoughtsWillDeletedLink': 'Links to the selected thoughts (%2) will be deleted for %1 selected thoughts. Continue?',
  'structures.confirmTitle.deleteThought': 'Delete thoughts',
  'structures.deleteSelectedThoughts': 'Delete %1 selected thoughts?',
  'structures.notSucceededApplyThoughts': 'Failed to apply to %1 of %2 thoughts (%3).',
  'structures.primenenoThoughts': 'Applied to %1 thoughts.',
  'structures.notSucceededVypolnitKomandu': 'Failed to execute the command: %1',
  'structures.label.komandy': 'Commands ▾',
  'structures.komandyNadVsemiThoughtsViewWithout': 'Commands over all thoughts of the view (ignoring pagination)',
  'structures.name.sirotskieThoughtWithoutParents': 'Orphan thoughts (no parents)',
  'structures.name.createdWeek': 'Created this week',
  'structures.name.createdZaDney': 'Created in the last 30 days',
  'structures.name.markedDelete': 'Marked for deletion',
  'structures.errorView': 'View error: %1',
  'structures.notSucceededRaskryt': 'Failed to expand: %1',
  'structures.notSucceededLoadMore': 'Failed to load more: %1',
  'structures.notSucceededOpenLink': 'Failed to open the link: %1',
  'structures.nichegoNotFoundIzmeniteKriteriiView': 'Nothing found — change the view criteria',
  'structures.showMore': 'Show more',
  'structures.pokazano': '%1 of %2 shown',
  'structures.link': 'Link: %1',

  // -- tabs --------------------------------------------------------------
  'tabs.openNetwork': 'Open network',
  'tabs.selectNetworkSozdayteNovuyuCloseLyuboy': 'Select a network or create a new one. Close — any other tab.',
  'tabs.label.createNetwork': '+ Create network',
  'tabs.more': '%1 more',
  'tabs.aktivirovat': 'Activate',
  'tabs.closeTab': 'Close tab',
  'tabs.networkUnavailable': 'Network unavailable',

  // -- thoughtTypes ------------------------------------------------------
  'thoughtTypes.viewsPublikuyutKnopkiPolosyPodThought': 'Views are published by the buttons of the strip under the thought in focus',
  'thoughtTypes.label.view': '+ view',
  'thoughtTypes.title.createView': 'Create view',
  'thoughtTypes.sohraniteTypeToDobavlyatViewsNovogo': 'Save the type to add views — a new type has no id yet.',
  'thoughtTypes.viewsDostupnyOnlyBase': 'Views are available in Base only.',
  'thoughtTypes.uTypePokaNoViews': 'The type has no views yet.',
  'thoughtTypes.umloch': 'default',
  'thoughtTypes.otkryvaetsyaDefault': 'Opens by default',
  'thoughtTypes.alreadyFirstAboveNowhere': 'Already first — cannot move up',
  'thoughtTypes.above': 'Up',
  'thoughtTypes.alreadyLastBelowNowhere': 'Already last — cannot move down',
  'thoughtTypes.below': 'Down',
  'thoughtTypes.unsetPriznakDefault': 'Clear the default mark',
  'thoughtTypes.doOtboromDefault': 'Make default view',
  'thoughtTypes.forAddViewsPereklyuchitesBase': 'Switch to Base to add views.',
  'thoughtTypes.firstSohraniteTypeToDobavlyatViews': 'First save the type to add views.',
  'thoughtTypes.forChangesViewPereklyuchitesBase': 'Switch to Base to edit the view.',
  'thoughtTypes.forDeleteViewPereklyuchitesBase': 'Switch to Base to delete the view.',
  'thoughtTypes.deleteViewThisActionIrreversible': 'Delete view “%1”? This action is irreversible.',
  'thoughtTypes.perestavitView': 'Reorder view',

  // -- typeManager -------------------------------------------------------
  'typeManager.bool.bulevo': 'boolean',
  'typeManager.thought_ref.linkRefThoughtLegacy': 'thought link (legacy)',
  'typeManager.placeholder.withoutParent': 'no parent',
  'typeManager.typeTakimNameAlreadySuschestvuet': 'A type with this name already exists.',
  'typeManager.iconType': 'Type icon',
  'typeManager.titleTypeObyazatelno': 'Type name (required)',
  'typeManager.title.settingsType': 'Type settings',
  'typeManager.parentNasledovaniePropertiesStilya': 'Parent (property and style inheritance)',
  'typeManager.kornevoyTypeParentNotImeet': 'Root type — has no parent.',
  'typeManager.kommentariyDescriptionTypePravilaPrimeneniya': 'Comment: type description, usage rules…',
  'typeManager.idPoyavitsyaAfterFirstRecordsType': 'The id will appear after the type is saved for the first time.',
  'typeManager.titleTypeObyazatelno2': 'The type name is required.',
  'typeManager.changeParentOtmenena': 'The parent change was canceled.',
  'typeManager.novyyTypeThought': 'New thought type',
  'typeManager.resetOverrideDescription': 'Reset description override',
  'typeManager.editNatureProperties': 'Edit property nature',
  'typeManager.otklyuchitProperty': 'Detach property',
  'typeManager.otklyuchitPropertyTypeValuesOstanutsyaThoughts': 'Detach property “%1” from the type? Values will remain with thoughts and links and will be shown in the “Out-of-type properties” group.',
  'typeManager.sohraniteTypeToDobavlyatPropertiesNovogo': 'Save the type to add properties — a new type has no id yet.',
  'typeManager.propertiesPoyavyatsyaAfterSaveType': 'Properties will appear after the type is saved.',
  'typeManager.byDefault': 'By default',
  'typeManager.zerkalnoePropertyLinkPorozhdenoPropertyDrugogo': 'Mirrored link property: generated by property “%1” of another type via the target type restriction. The link type and direction are not edited here.',
  'typeManager.zerkalo': 'mirror · %1',
  'typeManager.label.description': 'description…',
  'typeManager.title.pereopredelitDescriptionProperties': 'Override the property description',
  'typeManager.label.reset': 'reset ◆',
  'typeManager.unasledovannyhPropertiesNo': 'No inherited properties.',
  'typeManager.storona': 'Side',
  'typeManager.editNaturePropertiesNameTypeValues': 'Edit property nature (name, value type, description) — applies to all types at once',
  'typeManager.unsetPrivyazkuPropertiesValuesNotDeleted': 'Detach the property attachment — values are not deleted',
  'typeManager.uTypeNoSobstvennyhProperties': 'The type has no own properties.',
  'typeManager.istochnik': 'source',
  'typeManager.naznachenie': 'target',
  'typeManager.podklyuchitProperty': 'Attach property',
  'typeManager.label.createProperty': 'Create property',
  'typeManager.propertyConnectedTipamPotomkamPodklyuchitIts': 'Property “%1” is attached to descendant types %2. If it is attached to type “%3”, the descendants\' own attachments of this property will be removed (they will inherit it from your type). Property values in thoughts and links will not change.',
  'typeManager.target': 'target',
  'typeManager.targets': 'targets',
  'typeManager.celey': 'targets',
  'typeManager.descriptionPropertiesThisTypeEmptyNasleduetsya': 'Property description for this type (empty — inherited from the parent)',
  'typeManager.propertyNasleduetsyaTypeHereZadaetsyaDescription': 'Property “%1” is inherited from type “%2”. The description is set here for this type only (and its descendants until they override it themselves).',
  'typeManager.descriptionProperties': 'Property description — “%1”',
  'typeManager.label.resetOverride': 'Reset override',
  'typeManager.changeParentPovliyaetIzmenitsyaSostavNasleduemyh': 'Changing the parent will affect %1 %2: the set of inherited properties will change for %3 (attachments will appear or disappear), and default and description overrides may become dangling — values will be kept as “out-of-type” and shown read-only. Continue?',
  'typeManager.changeParentTypeThought': 'Change thought type parent',
  'typeManager.nee': 'it',
  'typeManager.nih': 'them',

  // -- workspaceMenus ----------------------------------------------------
  'workspaceMenus.rol': 'Role',
  'workspaceMenus.unsetBlokirovki': 'Clear locks (%1)',
  'workspaceMenus.unsetBlokirovki2': 'Clear locks',
  'workspaceMenus.doVladelcem': 'Make owner',
  'workspaceMenus.isklyuchit': 'Exclude',
  'workspaceMenus.peredachaVladeniya': 'Ownership transfer',
  'workspaceMenus.peredatVladenieNetworkUser': 'Transfer network ownership to user “%1”?',
  'workspaceMenus.isklyuchitMember': 'Exclude member',
  'workspaceMenus.isklyuchitNetwork': 'Exclude “%1” from the network?',
  'workspaceMenus.selectUser': '— select a user —',
  'workspaceMenus.idUser': 'User ID',
  'workspaceMenus.title.membersNetwork': 'Network members',
  'workspaceMenus.unsetAllBlokirovki': 'Clear all locks',
  'workspaceMenus.unsetAllBlokirovkiMemberActionIrreversible': 'Clear all locks of member “%1”? This action is irreversible.',
  'workspaceMenus.unsetBlokirovok': 'Locks cleared: %1.',
  'workspaceMenus.notSucceededUnsetBlokirovki': 'Failed to clear locks: %1',
  'workspaceMenus.vyytiNetwork': 'Leave network',
  'workspaceMenus.youPokineteNetworkPoteryaeteNeyAccess': 'You will leave the network and lose access to it.',

  // -- search ------------------------------------------------------------
  'search.title.settingsSearch': 'Search settings',
  'search.errorSearch': 'Search error',
  'search.thoughtId': 'Thought by ID (%1)',
  'search.enterZaprosMinimumSimvola': 'Enter a query (at least 3 characters).',
  'search.title.foundImenam': 'Found by names',
  'search.title.foundTekstam': 'Found by texts',
  'search.title.foundLinks': 'Found links',
  'search.title.foundHronologii': 'Found in chronology',
  'search.placesSearch': 'Search areas:',
  'search.hroniki': 'chronology',

  // -- selection ---------------------------------------------------------
  'selection.selection': 'Selection',
  'selection.actions': 'Actions',
  'selection.selection2': 'Selection (%1)',
  'selection.title.removeSelection': 'Remove from selection',
  'selection.label.addPodchinennyeThought': 'Add child thoughts',
  'selection.label.addRoditelskieThought': 'Add parent thoughts',
  'selection.label.addThought': 'Add thought…',
  'selection.label.clearListSelectionThoughts': 'Clear the list of selected thoughts',
  'selection.label.copyThought': 'Copy thoughts',
  'selection.label.mergeBase': 'Merge into Base…',
  'selection.addThoughtFocusRoditelskim': 'Add the thought in focus to parents…',
  'selection.doThoughtFocusOnlyParent': 'Make the thought in focus the only parent…',
  'selection.addThoughtFocusPodchinennym': 'Add the thought in focus to children…',
  'selection.isklyuchitThoughtFocusParents': 'Exclude the thought in focus from parents',
  'selection.isklyuchitThoughtFocusPodchinennyh': 'Exclude the thought in focus from children',
  'selection.label.export': 'Export',
  'selection.label.zipArchiveEtnx': 'zip archive (.etnx)…',
  'selection.label.markNeaktualnymi': 'Mark inactive',
  'selection.label.markAktualnymi': 'Mark active',
  'selection.label.editSettings': 'Change settings…',
  'selection.label.editTypeThoughts': 'Change thought type…',
  'selection.label.editValueProperties': 'Change property value…',
  'selection.notSucceededPoluchitNeighbours': 'Failed to get neighbours: %1',
  'selection.notSucceededPoluchitThoughtKopirovaniya': 'Failed to get thoughts for copying.',
  'selection.skopirovano': 'Copied %1 %2.',
  'selection.notSucceededCopy': 'Failed to copy: %1',
  'selection.typeLinkThoughtFocus': 'Link type to the thought in focus',
  'selection.doOnlyParent': 'Make the only parent',
  'selection.uSelectionThoughtsWillDeletedAll': 'All incoming links of %1 selected thoughts will be deleted except the link to thought “%2”. Continue?',
  'selection.notSucceededChangeTypeLinkThoughts': 'Failed to change the link type for %1 thoughts.',
  'selection.settingsSelection': 'Selection settings',
  'selection.notSucceededApplyThoughts': 'Failed to apply to %1 thoughts.',
  'selection.gruppovayaOperation': 'Bulk operation',
  'selection.firstSfokusiruyteThoughtOnaStanetParent': 'First focus a thought — it will become the parent of the imported graph.',

  // -- trash -------------------------------------------------------------
  'trash.ispolzuetsyaPropertiesOtherThoughts': '%1 is used in properties of other thoughts',
  'trash.suschestvuetBaseLayerItsCanOnly': '%1 exists in Base — in a layer it can only be marked for deletion',
  'trash.changedLayers': '%1 is changed in layers: %2',
  'trash.deleteThought': 'Delete thought',
  'trash.cannotDeleteSovsem': 'Cannot delete permanently — %1.',
  'trash.ostanetsyaWithoutParents': '%1 %2 will be left without parents.',
  'trash.deleteThought2': 'Deleting thought “%1”',
  'trash.thoughtVozvraschenaTrash': 'The thought was restored from the basket.',
  'trash.thoughtPomeschenaTrash': 'The thought was moved to the basket.',
  'trash.deleteLink': 'Delete link',
  'trash.title.deleteLink': 'Deleting link',
  'trash.linkNotDeletedTeperZablokirovanaUderzhivayuschiy': 'The link was not deleted: it is now blocked (holding layer).',
  'trash.linkVozvraschenaTrash': 'The link was restored from the basket.',
  'trash.deleteVybrannogo': 'Delete selected',
  'trash.allRowsTrash': 'All rows — “To basket”',
  'trash.nezablokirovannyeRowsDeleteZablokirovannyeTrash': 'Unblocked rows — “Delete”, blocked rows — “To basket”',
  'trash.cannotDeleteSovsem2': 'Cannot delete permanently — %1',
  'trash.lishitsyaParent': '%1 %2 will lose their parent.',
  'trash.deleteVybrannogo2': 'Delete selected (%1)',
  'trash.applyUkazannyeDeletePomeschenieTrash': 'Apply the specified deletion / move to basket',
  'trash.primenenoErrors': 'Applied, errors: %1.',
  'trash.primeneno': 'Applied.',
  'trash.zablokirovanoDelete': 'blocked from deletion',
  'trash.vernutTekuschuyuLineTrash': 'Restore the current row from the basket',
  'trash.title.deleteTekuschuyuLineSovsem': 'Delete the current row permanently',
  'trash.label.deleteAllPossible': 'Delete everything possible',
  'trash.fizicheskiDeleteAllNezablokirovannyeRowsTrash': 'Physically delete all unblocked basket rows',
  'trash.deletedOstalosZablokirovano': 'Deleted %1, still blocked %2.',
  'trash.clearTrash': 'Clear basket',
  'trash.thought': 'thought',
} as const;

/** Ключи английского языка — основа типа `MessageKey`-паритета с `ru`. */
export type EnMessageKey = keyof typeof en;

/**
 * Формы плюрализации английского языка (задача d08c422d): ключ → формы,
 * которые выбирает `Intl.PluralRules('en')` — `one` (1), `other` (0, 2+,
 * дробные). Каталог рядом с текстами языка — по типу `PluralCatalog`
 * (`lib/plural.ts`); паритет категорий проверяет сторож
 * `tests/guard-plural-categories.test.ts`.
 */
export const enPlurals = {
  /** Потомок мысли — предупреждения корзины и панели использования. */
  'plurals.child': {
    one: 'child',
    other: 'children',
  },
  /** Черновик — счётчик неотправленных правок (fb9d6058). */
  'plurals.draft': {
    one: 'draft',
    other: 'drafts',
  },
  /** Связь — счётчик скрытых рёбер вкладки «Граф» (42a7c0a1). */
  'plurals.link': {
    one: 'link',
    other: 'links',
  },
  /** Условие отбора — подпись подзапроса (фраза отбора). */
  'plurals.condition': {
    one: 'condition',
    other: 'conditions',
  },
  /** Предупреждение панели использования об осиротевших потомках (aca92904). */
  'plurals.orphanedChildren': {
    one: 'Warning: %1 child will be left without parents.',
    other: 'Warning: %1 children will be left without parents.',
  },
} satisfies PluralCatalog;
