/**
 * Реестр редких операций MCP — данные для `etn.guide` и диспетчера `etn.ops`
 * (задача 86ef2ff4, версия 0.8.3; ADR «Прогрессивное раскрытие MCP вместо
 * роста описаний инструментов» b2eebf8b; ADR «Поглощённые MCP-инструменты
 * снимаются одним мажором, без сосуществования» 8358eea9).
 *
 * Каждая запись — одна поглощённая операция: имя действия, та же схема входа,
 * что была у снятого инструмента (валидация `params` в `etn.ops` идёт по ней
 * — семантика ошибок не меняется), признаки `destructive` (нужен `confirm`)
 * и `readOnly`, плюс лаконичные тексты «когда нужно» (реестр гайда),
 * эффектов и кодов ошибок (инструкция по `topic`).
 *
 * Данные — в коде (не внешний файл): обновляются вместе с операцией, не
 * расходятся с ней и не грузятся при отсутствии вызова (цель прогрессивного
 * раскрытия — не платить описаниями в префилле каждой сессии).
 */

import { z } from 'zod';

import { writeBatchHowToText } from '../how-to.js';
import { ACTIVITY_LIMIT_DEFAULT, ACTIVITY_LIMIT_MAX } from '../../domain/activity-service.js';
import type { OperationContract } from '../../contracts.js';
import {
  ActivityRollup,
  ActivityTruncate,
  AttachmentsAdd,
  AttachmentsCopy,
  AttachmentsDelete,
  AttachmentsSearch,
  AttachmentsUpdate,
  ChangesList,
  CommentsDelete,
  ExportSubgraph,
  ImportDryRun,
  ImportSubgraph,
  LayersCreate,
  LayersDelete,
  LayersDiff,
  LayersDiffDoc,
  LayersConflicts,
  LayersDiscard,
  LayersMerge,
  LayersResetOverride,
  LayersUpdate,
  LinksRestore,
  LocksAcquire,
  LocksClear,
  LocksList,
  LocksRelease,
  MembersList,
  MetricsReads,
  MetricsTools,
  NetworksDelete,
  NetworksWrite,
  OntologyDelete,
  PropertiesRemove,
  PropertiesResolve,
  ThoughtsBacklinks,
  ThoughtsCopySubtree,
  ThoughtsDelete,
  ThoughtsDeletionCheck,
  ThoughtsMentions,
  ThoughtsMentionsScan,
  ThoughtsPath,
  ThoughtsTrash,
  ThoughtsUsageClear,
  TrashList,
  TrashPurge,
} from '../../contracts.js';

/** Один параметр действия в инструкции гайда. */
export interface OpParamDoc {
  name: string;
  required?: boolean;
  desc: string;
}

/**
 * Запись реестра редких операций. `tool` — имя снятого инструмента (совпадает
 * с именем операции в `audit_log` и в реестре аннотаций: аудит-след и события
 * операции переносятся без изменений). `action` — короткое имя для `etn.ops`.
 */
export interface OpEntry {
  /** Короткое имя действия, например `locks.acquire`. */
  action: string;
  /** Полное имя снятого инструмента, например `etn.locks.acquire`. */
  tool: string;
  /** Группа реестра (для упорядочивания в реестре гайда). */
  group: string;
  /** Одна строка реестра: когда операция нужна. */
  when: string;
  /** Состав `params` для инструкции по `topic`. */
  params: readonly OpParamDoc[];
  /** Деструктивна: без `confirm: true` на верхнем уровне — VALIDATION_ERROR. */
  destructive: boolean;
  /** Read-only: не тратит write-бюджет, не пишет audit_log на содержательную правку. */
  readOnly: boolean;
  /** Эффекты операции (инструкция по `topic`). */
  effects: string;
  /** Коды ошибок операции (инструкция по `topic`). */
  errors: string;
  /** Схема `params` (та же, что была у снятого инструмента). */
  paramsContract: OperationContract;
}

/**
 * Убрать из схемы контракта поле `confirm`: у поглощённых `networks.delete` и
 * `import.subgraph` подтверждение переехало на верхний уровень `etn.ops`, в
 * `params` его быть не должно. Иначе повторное требование `confirm` внутри
 * `params` конфликтовало бы с top-level гейтом.
 */
function withoutConfirm(contract: OperationContract): OperationContract {
  return {
    name: contract.name,
    // Все три схемы — `z.object(...).strict()` (или strict из defineContract).
    schema: (contract.schema as z.ZodObject).omit({ confirm: true }),
    rest: contract.rest,
  } as OperationContract;
}

const NETWORKS_DELETE = withoutConfirm(NetworksDelete);
const IMPORT_SUBGRAPH = withoutConfirm(ImportSubgraph);

/** `etn.networks.list` был беспараметрическим инструментом — параметров нет
 *  (схема-пустышка, чтобы диспетчер `etn.ops` единообразно валидировал `params`). */
const NETWORKS_LIST: OperationContract = {
  name: 'etn.networks.list',
  schema: z.object({}).strict(),
  rest: {},
};

/** Полный реестр редких операций в порядке групп. */
export const OPS_ACTIONS: readonly OpEntry[] = [
  // ---- locks ---------------------------------------------------------------
  {
    action: 'locks.acquire',
    tool: 'etn.locks.acquire',
    group: 'locks',
    when: 'захватить объект (thought/link) под редактирование; повтор для себя продлевает захват',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'entity_type', required: true, desc: 'тип объекта, например `thought`' },
      { name: 'entity_id', required: true, desc: 'id объекта' },
    ],
    destructive: false,
    readOnly: false,
    effects: 'создаёт/продлевает захват, событие `edit.acquired`, строка audit_log.',
    errors: '`LOCKED` (чужой захват, `details.holder`), `VALIDATION_ERROR`.',
    paramsContract: LocksAcquire,
  },
  {
    action: 'locks.release',
    tool: 'etn.locks.release',
    group: 'locks',
    when: 'снять свой захват по `lock_id`',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'lock_id', required: true, desc: 'id захвата' },
    ],
    destructive: false,
    readOnly: false,
    effects: 'удаляет захват, событие `edit.released`.',
    errors: '`FORBIDDEN` (чужой), `LOCK_NOT_FOUND`.',
    paramsContract: LocksRelease,
  },
  {
    action: 'locks.clear',
    tool: 'etn.locks.clear',
    group: 'locks',
    when: 'снять ВСЕ захваты участника (любой участник может)',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'user_id', required: true, desc: 'id участника' },
    ],
    destructive: false,
    readOnly: false,
    effects: 'снимает захваты, события `edit.cleared`.',
    errors: '`VALIDATION_ERROR`.',
    paramsContract: LocksClear,
  },
  {
    action: 'locks.list',
    tool: 'etn.locks.list',
    group: 'locks',
    when: 'активные захваты сети (с фильтром по user_id/client_id)',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'user_id', desc: 'фильтр по участнику (один)' },
      { name: 'client_id', desc: 'фильтр по клиенту (один)' },
    ],
    destructive: false,
    readOnly: true,
    effects: 'чтение, без записи.',
    errors: '`VALIDATION_ERROR`.',
    paramsContract: LocksList,
  },

  // ---- attachments ---------------------------------------------------------
  {
    action: 'attachments.add',
    tool: 'etn.attachments.add',
    group: 'attachments',
    when: 'прикрепить URL или файл к мысли/связи',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'owner_type', required: true, desc: '`thought` | `link`' },
      { name: 'owner_id', required: true, desc: 'id владельца' },
      { name: 'kind', required: true, desc: '`url` (тогда `url`) | `file` (тогда `file_path`)' },
      { name: 'url', desc: 'URL для kind=url' },
      { name: 'file_path', desc: 'путь к файлу для kind=file' },
      { name: 'title', desc: 'подпись' },
      { name: 'description', desc: 'описание' },
    ],
    destructive: false,
    readOnly: false,
    effects: 'создаёт вложение, событие `attachment.created`.',
    errors: '`VALIDATION_ERROR`, `NOT_FOUND`.',
    paramsContract: AttachmentsAdd,
  },
  {
    action: 'attachments.copy',
    tool: 'etn.attachments.copy',
    group: 'attachments',
    when: 'скопировать существующее вложение на несколько владельцев (файл не дублируется)',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'attachment_id', required: true, desc: 'id вложения-источника' },
      { name: 'target_owner_type', required: true, desc: '`thought` | `link`' },
      { name: 'target_owner_ids', required: true, desc: 'массив id владельцев' },
    ],
    destructive: false,
    readOnly: false,
    effects: 'создаёт строки вложений; уже владеющие — пропускаются молча.',
    errors: '`VALIDATION_ERROR`, `NOT_FOUND`.',
    paramsContract: AttachmentsCopy,
  },
  {
    action: 'attachments.search',
    tool: 'etn.attachments.search',
    group: 'attachments',
    when: 'найти вложения по ключевым словам (title/description/url/file_path)',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'q', required: true, desc: 'мини-синтаксис поиска: слова, `-слово`, `*`' },
      { name: 'kind', desc: '`url` | `file`' },
      { name: 'exclude_owner_type', desc: 'скрыть владельцев этого типа' },
      { name: 'exclude_owner_id', desc: 'скрыть конкретного владельца' },
      { name: 'limit', desc: '≤ 200' },
      { name: 'offset', desc: 'смещение' },
    ],
    destructive: false,
    readOnly: true,
    effects: 'чтение, без записи.',
    errors: '`VALIDATION_ERROR`.',
    paramsContract: AttachmentsSearch,
  },
  {
    action: 'attachments.update',
    tool: 'etn.attachments.update',
    group: 'attachments',
    when: 'правка метаданных вложения (last-write-wins), `kind` неизменяем',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'attachment_id', required: true, desc: 'id вложения' },
      { name: 'title', desc: 'новая подпись' },
      { name: 'description', desc: 'новое описание' },
      { name: 'url', desc: 'новый URL' },
      { name: 'file_path', desc: 'новый путь к файлу' },
    ],
    destructive: false,
    readOnly: false,
    effects: 'обновляет метаданные, событие `attachment.updated`.',
    errors: '`VALIDATION_ERROR`, `NOT_FOUND`.',
    paramsContract: AttachmentsUpdate,
  },
  {
    action: 'attachments.delete',
    tool: 'etn.attachments.delete',
    group: 'attachments',
    when: 'отвязать вложение от владельца (файл не удаляется)',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'attachment_id', required: true, desc: 'id вложения' },
    ],
    destructive: true,
    readOnly: false,
    effects: 'удаляет строку вложения, событие `attachment.deleted`; судьбу файла решает домен.',
    errors: '`VALIDATION_ERROR`, `NOT_FOUND`.',
    paramsContract: AttachmentsDelete,
  },

  // ---- activity ------------------------------------------------------------
  {
    action: 'activity.rollup',
    tool: 'etn.activity.rollup',
    group: 'activity',
    when: 'свернуть журнал активности до `until_ms` (для живых сущностей остаются крайние записи)',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'until_ms', required: true, desc: 'граница в мс' },
    ],
    destructive: false,
    readOnly: false,
    effects: 'НЕОБРАТИМО удаляет лишние строки журнала одной транзакцией; возвращает `{ removed, kept }`.',
    errors: '`VALIDATION_ERROR`.',
    paramsContract: ActivityRollup,
  },
  {
    action: 'activity.truncate',
    tool: 'etn.activity.truncate',
    group: 'activity',
    when: 'жёстко обрезать журнал активности до `until_ms` (включая записи создания/удаления)',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'until_ms', required: true, desc: 'граница в мс' },
    ],
    destructive: true,
    readOnly: false,
    effects: 'НЕОБРАТИМО удаляет все строки с `occurred_at_ms <= until_ms`; возвращает `{ removed }`.',
    errors: '`VALIDATION_ERROR`.',
    paramsContract: ActivityTruncate,
  },

  // ---- layers --------------------------------------------------------------
  {
    action: 'layers.create',
    tool: 'etn.layers.create',
    group: 'layers',
    when: 'создать слой под родителем (по умолчанию — текущий слой сессии); не переключает сессию',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'title', required: true, desc: 'имя слоя' },
      { name: 'parent_id', desc: 'родитель (по умолчанию — слой сессии)' },
      { name: 'comment', desc: 'зачем слой' },
      { name: 'git_branch', desc: 'имя ветки' },
    ],
    destructive: false,
    readOnly: false,
    effects: 'создаёт слой; журнальная строка `layer.created`.',
    errors: '`VALIDATION_ERROR`.',
    paramsContract: LayersCreate,
  },
  {
    action: 'layers.update',
    tool: 'etn.layers.update',
    group: 'layers',
    when: 'переименовать слой и/или изменить его комментарий',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'layer_id', required: true, desc: 'id слоя' },
      { name: 'title', desc: 'новое имя (у базового слоя неизменно)' },
      { name: 'comment', desc: 'новый комментарий' },
      { name: 'expected_version', desc: 'оптимистичная блокировка' },
    ],
    destructive: false,
    readOnly: false,
    effects: 'обновляет слой; журнальная строка `layer.updated`.',
    errors: '`VALIDATION_ERROR` (нечего менять), `VERSION_CONFLICT`.',
    paramsContract: LayersUpdate,
  },
  {
    action: 'layers.delete',
    tool: 'etn.layers.delete',
    group: 'layers',
    when: 'удалить слой вместе с поддеревом потомков; базовый слой удалить нельзя',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'layer_id', required: true, desc: 'id слоя' },
      { name: 'cascade', desc: 'число потомков из `layers.list` (подтверждение каскада)' },
    ],
    destructive: true,
    readOnly: false,
    effects: 'физически сносит тени и надгробия поддерева, авто-очистка корзины.',
    errors: '`VALIDATION_ERROR`, `409` при несовпадении `cascade`, `422` при живых потомках.',
    paramsContract: LayersDelete,
  },
  {
    action: 'layers.diff',
    tool: 'etn.layers.diff',
    group: 'layers',
    when: 'структурное отличие слоя от родителя (ссылки: добавлено/удалено/сменён тип/переподчинено), постранично и по секциям',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'layer_id', required: true, desc: 'id слоя' },
      {
        name: 'sections',
        desc:
          'подмножество секций: `links.added`/`links.removed`/`links.type_changed`/' +
          '`links.reorder_collapsed`/`links.reparented`/`overridden.thought_ids`/' +
          '`overridden.link_ids` (по умолчанию — все; неизвестная секция → VALIDATION_ERROR)',
      },
      {
        name: 'limit',
        desc: 'размер страницы в элементах, 1…1000 (по умолчанию 200); байтовый бюджет может вернуть меньше',
      },
      { name: 'cursor', desc: '`next_cursor` предыдущей страницы (непрозрачный keyset: секция + id)' },
    ],
    destructive: false,
    readOnly: true,
    effects:
      'чтение, без записи. Ответ ВСЕГДА постраничный: `counts` — итоги по всем секциям, ' +
      '`links`/`overridden` — только запрошенные секции со страницей элементов, ' +
      '`truncated: true` + `reason: "has_more"` + `next_cursor` при остатке. Каждая страница ' +
      'гарантированно укладывается в бюджет MCP (~48 КБ против `maxModelBytes = 50000`), ' +
      'транспорт её не режет. Вызов без параметров — первая страница (дефолтный лимит).',
    errors: '`VALIDATION_ERROR` (неизвестная секция, невалидный/чужой курсор), `NOT_FOUND`.',
    paramsContract: LayersDiff,
  },
  {
    action: 'layers.diff_doc',
    tool: 'etn.layers.diff_doc',
    group: 'layers',
    when: 'содержательное отличие слоя — два markdown-документа для построчного сравнения (малые слои, точечный аудит)',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'layer_id', required: true, desc: 'id слоя' },
    ],
    destructive: false,
    readOnly: true,
    effects:
      'чтение, без записи. НЕ секционируется и НЕ пагинируется: вся разница отдаётся одним ' +
      'markdown-блоком (`layer_doc` + `target_doc`). Ориентиры: слой ~1142 перекрытые строки ' +
      'давал ~17,5 МБ markdown — модели нечитаемо. Назначение — малые слои и точечный аудит; ' +
      'для больших слоёв берите постраничный `layers.diff` (sections + cursor).',
    errors: '`VALIDATION_ERROR`, `NOT_FOUND`.',
    paramsContract: LayersDiffDoc,
  },
  {
    action: 'layers.merge',
    tool: 'etn.layers.merge',
    group: 'layers',
    when: 'слить слой в родителя — целиком, замкнутым подмножеством `tables` или одной мыслью `thought_id`',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'layer_id', required: true, desc: 'id слоя' },
      { name: 'tables', desc: '`{ ветвимая_таблица: [id…] }` для частичного слияния' },
      {
        name: 'thought_id',
        desc: 'слить одну мысль: сервер сам собирает замкнутое подмножество её строк (сама мысль, синонимы, свойства, комментарии, вложения, её рёбра)',
      },
      {
        name: 'mode',
        desc: 'с `thought_id`: `overwrite` (по умолчанию — версия слоя побеждает) | `combine` (постоянный комментарий объединяется с основой, маркеры конфликтов)',
      },
    ],
    destructive: true,
    readOnly: false,
    effects:
      'применяет изменения слоя в родителя; при конфликте — отказ целиком (кроме слияния мысли: `base_version` расхождения по её строкам снимаются — выбранный вариант «версия слоя побеждает»); создаёт резервный слой.',
    errors: '`VALIDATION_ERROR` (`conflicts`/`missing_closure`), `NOT_FOUND`.',
    paramsContract: LayersMerge,
  },
  {
    action: 'layers.discard',
    tool: 'etn.layers.discard',
    group: 'layers',
    when: '«Отказаться от изменений»: убрать из слоя все правки одной мысли (мысль вернётся к состоянию основы)',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'layer_id', required: true, desc: 'id слоя' },
      { name: 'thought_id', required: true, desc: 'мысль, чьи правки в слое отбрасываются' },
    ],
    destructive: true,
    readOnly: false,
    effects:
      'физически удаляет из слоя строки мысли (сама мысль, синонимы, значения свойств, комментарии с целями, ' +
      'вложения и её рёбра); основа не затрагивается. Мысль возвращается к состоянию основы, созданная только ' +
      'в слое — исчезает. Журнальная строка `layer.updated`, audit-запись.',
    errors: '`VALIDATION_ERROR` (основа/служебный слой, нет изменений мысли), `NOT_FOUND`.',
    paramsContract: LayersDiscard,
  },
  {
    action: 'layers.conflicts',
    tool: 'etn.layers.conflicts',
    group: 'layers',
    when: 'предстоящие конфликты слияния слоя: строки, чей base_version отстал от основы (read-only предпросмотр)',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'layer_id', required: true, desc: 'слой' },
    ],
    destructive: false,
    readOnly: true,
    effects:
      'чтение: строки слоя, из-за которых слияние будет отклонено целиком (§8.1), ' +
      'с расхождением «было в основе / стало в слое» (§8.5). Записи нет; пробное слияние не нужно.',
    errors: '`VALIDATION_ERROR` (основа/служебный слой), `NOT_FOUND`.',
    paramsContract: LayersConflicts,
  },
  {
    action: 'layers.reset_override',
    tool: 'etn.layers.reset_override',
    group: 'layers',
    when: 'сбросить перекрытие выбранных строк слоя: перепривязать base_version к актуальной основе, чтобы слияние прошло',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'layer_id', required: true, desc: 'слой' },
      {
        name: 'tables',
        required: true,
        desc: '`{ ветвимая_таблица: [id…] }` — конкретные строки слоя (не слой целиком)',
      },
    ],
    destructive: true,
    readOnly: false,
    effects:
      'у выбранных теневых строк `base_version` становится текущей версией той же строки в предке; ' +
      'содержимое слоя сохраняется, основа не меняется. Отставшая версия тени поднимается до версии основы, ' +
      'чтобы слияние не откатило нумерацию. Журнальная строка `layer.updated`, audit-запись.',
    errors:
      '`VALIDATION_ERROR` (строки нет в слое — `details.unknown`, пустой набор, основа/служебный слой), `NOT_FOUND`.',
    paramsContract: LayersResetOverride,
  },

  // ---- thoughts ------------------------------------------------------------
  {
    action: 'thoughts.path',
    tool: 'etn.thoughts.path',
    group: 'thoughts',
    when: 'кратчайший путь между двумя мыслями по ненаправленным рёбрам родитель/потомок',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'from_id', required: true, desc: 'начало' },
      { name: 'to_id', required: true, desc: 'конец' },
      { name: 'max_depth', desc: 'предел глубины (по умолчанию TRAVERSAL_DEFAULTS.MAX_DEPTH, ≤ 100)' },
      { name: 'link_filter', desc: '`{ type_ids?, include_structural? }`' },
    ],
    destructive: false,
    readOnly: true,
    effects: 'чтение, без записи.',
    errors: '`VALIDATION_ERROR`.',
    paramsContract: ThoughtsPath,
  },
  {
    action: 'thoughts.mentions',
    tool: 'etn.thoughts.mentions',
    group: 'thoughts',
    when: 'где мысль упоминается по имени/синониму в текстах комментариев (FTS)',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'thought_id', required: true, desc: 'мысль' },
    ],
    destructive: false,
    readOnly: true,
    effects: 'чтение, без записи.',
    errors: '`VALIDATION_ERROR`.',
    paramsContract: ThoughtsMentions,
  },
  {
    action: 'thoughts.backlinks',
    tool: 'etn.thoughts.backlinks',
    group: 'thoughts',
    when: 'явные ID-ссылки `[[#<id>]]` на мысль в текстах комментариев',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'thought_id', required: true, desc: 'мысль' },
    ],
    destructive: false,
    readOnly: true,
    effects: 'чтение, без записи.',
    errors: '`VALIDATION_ERROR`.',
    paramsContract: ThoughtsBacklinks,
  },
  {
    action: 'thoughts.mentions_scan',
    tool: 'etn.thoughts.mentions_scan',
    group: 'thoughts',
    when: 'скан текста/комментария на упоминания мыслей; с `create_links: true` ещё и создаёт связи',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'text', desc: 'текст для скана (XOR с `source`)' },
      { name: 'source', desc: '`{ comment_id }` или `{ thought_id }` — брать текст оттуда (XOR с `text`)' },
      { name: 'case_sensitive', desc: 'учёт регистра' },
      { name: 'use_synonyms', desc: 'учитывать синонимы' },
      { name: 'use_wildcards', desc: '`*`-инфикс' },
      { name: 'min_confidence', desc: 'порог уверенности 0..1' },
      { name: 'create_links', desc: 'создавать связи (требует `link_type` и `source_thought_id`)' },
      { name: 'link_type', desc: 'тип создаваемой связи' },
      { name: 'link_direction', desc: '`out` | `in`' },
      { name: 'source_thought_id', desc: 'мысль-источник создаваемых связей' },
    ],
    destructive: false,
    readOnly: true,
    effects: 'без `create_links` — чтение; с `create_links` — создаёт связи (write-бюджет).',
    errors: '`VALIDATION_ERROR`.',
    paramsContract: ThoughtsMentionsScan,
  },
  {
    action: 'thoughts.copy_subtree',
    tool: 'etn.thoughts.copy_subtree',
    group: 'thoughts',
    when: 'скопировать подграф между сетями (BFS-снапшот, ≤ 50 узлов)',
    params: [
      { name: 'source_network_id', required: true, desc: 'сеть-источник' },
      { name: 'target_network_id', required: true, desc: 'целевая сеть (нужна онтология под типы)' },
      { name: 'root_thought_ids', required: true, desc: 'корни копирования' },
      { name: 'max_depth', desc: '≤ 20, по умолчанию 5' },
      { name: 'include', desc: 'части: `thought`/`links`/`properties`/`comments`/`attachments`' },
      { name: 'duplicate_policy', desc: '`fail` | `reuse` | `skip` | `create_always`' },
      { name: 'id_remap', desc: 'вернуть карты сопоставления id (по умолчанию true)' },
      { name: 'target_parent_thought_id', desc: 'куда подвесить корни (по умолчанию — без родителя)' },
    ],
    destructive: false,
    readOnly: false,
    effects: 'материализует подграф в целевой сети одной транзакцией; события созданных мыслей/связей.',
    errors: '`VALIDATION_ERROR` (дубли/недостающая онтология/HOME как корень).',
    paramsContract: ThoughtsCopySubtree,
  },
  {
    action: 'thoughts.delete',
    tool: 'etn.thoughts.delete',
    group: 'thoughts',
    when: 'физически удалить мысль (сначала — проверка блокировки)',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'thought_id', required: true, desc: 'мысль' },
      { name: 'expected_version', desc: 'оптимистичная блокировка' },
    ],
    destructive: true,
    readOnly: false,
    effects: 'каскадно удаляет связи/комментарии/вложения/значения свойств; событие `thought.deleted`.',
    errors: '`VALIDATION_ERROR` (блокировка), `NOT_FOUND`, `FORBIDDEN` (HOME).',
    paramsContract: ThoughtsDelete,
  },
  {
    action: 'thoughts.deletion_check',
    tool: 'etn.thoughts.deletion_check',
    group: 'thoughts',
    when: 'что блокирует физическое удаление мыслей (использование в свойствах, слои, будущие сироты)',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'thought_ids', required: true, desc: 'массив мыслей (≤ 200)' },
    ],
    destructive: false,
    readOnly: true,
    effects: 'чтение, без записи.',
    errors: '`VALIDATION_ERROR`.',
    paramsContract: ThoughtsDeletionCheck,
  },
  {
    action: 'usage_clear',
    tool: 'etn.thoughts.usage_clear',
    group: 'thoughts',
    when: 'снять блокировку «использование в свойствах»: пометить на удаление все рёбра свойств, ссылающиеся на мысль',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'thought_id', required: true, desc: 'мысль' },
    ],
    destructive: false,
    readOnly: false,
    effects: 'помечает рёбра-использования на удаление; возвращает `{ cleared }`.',
    errors: '`VALIDATION_ERROR`, `NOT_FOUND`.',
    paramsContract: ThoughtsUsageClear,
  },
  {
    action: 'thoughts.trash',
    tool: 'etn.thoughts.trash',
    group: 'thoughts',
    when: 'поместить мысль в корзину (`trashed: true`) или вернуть из неё (`trashed: false`); блокировку не проверяет',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'thought_id', required: true, desc: 'мысль' },
      { name: 'trashed', required: true, desc: '`true` — в корзину, `false` — вернуть' },
    ],
    destructive: false,
    readOnly: false,
    effects: 'обратимая операция: правит только пометку `marked_for_deletion`, события `thought.updated`, журнал `trashed`/`restored`.',
    errors: '`VALIDATION_ERROR`, `NOT_FOUND`.',
    paramsContract: ThoughtsTrash,
  },
  {
    action: 'links.restore',
    tool: 'etn.links.restore',
    group: 'links',
    when: 'вернуть связь из корзины (`trashed: false`) — единственная операция семьи `etn.links.*`',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'link_id', required: true, desc: 'id связи' },
    ],
    destructive: false,
    readOnly: false,
    effects: 'обратимая операция: снимает пометку `marked_for_deletion` со связи, событие `link.updated`, журнал `restored`.',
    errors: '`VALIDATION_ERROR`, `NOT_FOUND`.',
    paramsContract: LinksRestore,
  },
  {
    action: 'properties.resolve',
    tool: 'etn.properties.resolve',
    group: 'properties',
    when: 'явный резолв значений свойства-ссылки `cross_network_ref`: открыть целевые сети и обновить снапшоты имён',
    params: [
      { name: 'network_id', required: true, desc: 'сеть-владелец свойства' },
      { name: 'owner_type', required: true, desc: '`thought` | `link`' },
      { name: 'owner_id', required: true, desc: 'id владельца свойства' },
      { name: 'key', required: true, desc: 'ключ свойства вида `cross_network_ref`' },
    ],
    destructive: false,
    readOnly: true,
    effects: 'служебное чтение с обновлением снапшота; цель/сеть пропала → значение помечается `unresolved` (старое имя сохраняется). Возвращает `values`. Без write-бюджета и audit-строки.',
    errors: '`VALIDATION_ERROR` (свойство не `cross_network_ref`), `NOT_FOUND`.',
    paramsContract: PropertiesResolve,
  },
  {
    action: 'ontology.delete',
    tool: 'etn.ontology.delete',
    group: 'ontology',
    when: 'удалить одну сущность онтологии (`thought_type` / `link_type` / `property` / `type_property` / `type_view`); без `force` используемый элемент отвергается со счётчиками',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'kind', required: true, desc: '`thought_type` | `link_type` | `property` | `type_property` | `type_view`' },
      { name: 'id', required: true, desc: 'id сущности' },
      { name: 'force', desc: 'каскадное удаление используемого элемента' },
    ],
    destructive: true,
    readOnly: false,
    effects: 'с `force` — каскад по правилам (обнуление `type_id` мыслей / удаление связей / `property_values` / привязок / каскад отборов типа); элемент в `type_roles` отвергается даже с `force`. Один write-бюджет + одна строка audit_log.',
    errors: '`VALIDATION_ERROR` (используемый элемент без `force`, роль в `type_roles`), `NOT_FOUND`.',
    paramsContract: OntologyDelete,
  },

  // ---- trash ---------------------------------------------------------------
  {
    action: 'trash.list',
    tool: 'etn.trash.list',
    group: 'trash',
    when: 'корзина сети: помеченные на удаление мысли и связи с проверкой блокировки',
    params: [{ name: 'network_id', required: true, desc: 'сеть' }],
    destructive: false,
    readOnly: true,
    effects: 'чтение, без записи.',
    errors: '`VALIDATION_ERROR`.',
    paramsContract: TrashList,
  },
  {
    action: 'trash.purge',
    tool: 'etn.trash.purge',
    group: 'trash',
    when: 'очистить корзину: физически удалить всё, что не заблокировано',
    params: [{ name: 'network_id', required: true, desc: 'сеть' }],
    destructive: true,
    readOnly: false,
    effects: 'физически удаляет разблокированное одной транзакцией; возвращает `{ purged, skipped }`.',
    errors: '`VALIDATION_ERROR`.',
    paramsContract: TrashPurge,
  },

  // ---- export / import -----------------------------------------------------
  {
    action: 'export.subgraph',
    tool: 'etn.export.subgraph',
    group: 'export',
    when: 'выгрузить подграф как Markdown/HTML/`.etnx`-архив',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'seed_ids', required: true, desc: 'ядра обхода (≤ 50)' },
      { name: 'radius', required: true, desc: 'радиус обхода' },
      { name: 'format', desc: '`markdown` (по умолчанию) | `html` | `etnx`' },
      { name: 'etnx_options', desc: 'для `etnx`: `{ include_types?, include_attachments?, include_chronology?, include_subtree?, subtree_depth? }`' },
    ],
    destructive: false,
    readOnly: true,
    effects: 'чтение; `format: etnx` отдаёт base64-архив в `content_b64`.',
    errors: '`VALIDATION_ERROR`, `INTERNAL`.',
    paramsContract: ExportSubgraph,
  },
  {
    action: 'import.dry_run',
    tool: 'etn.import.dry_run',
    group: 'import',
    when: 'превью импорта `.etnx`: план и конфликты без побочных эффектов',
    params: [
      { name: 'network_id', required: true, desc: 'целевая сеть' },
      { name: 'source', required: true, desc: '`{ kind: "etnx_file", path }` или `{ kind: "etnx_base64", content_base64 }`' },
      { name: 'collision_policy', desc: '`fail` | `rename` | `skip` | `overwrite`' },
    ],
    destructive: false,
    readOnly: true,
    effects:
      'чтение (валидация manifest + план); без записи. `plan.rejected: true` при `collision_policy: fail` с конфликтами — импорт будет отвергнут целиком.',
    errors: '`VALIDATION_ERROR`.',
    paramsContract: ImportDryRun,
  },
  {
    action: 'import.subgraph',
    tool: 'etn.import.subgraph',
    group: 'import',
    when: 'применить `.etnx` к сети одной транзакцией',
    params: [
      { name: 'network_id', required: true, desc: 'целевая сеть' },
      { name: 'source', required: true, desc: '`{ kind: "etnx_file", path }` или `{ kind: "etnx_base64", content_base64 }`' },
      { name: 'collision_policy', desc: '`fail` | `rename` | `skip` | `overwrite` (по умолчанию overwrite)' },
      { name: 'parent_thought_id', desc: 'куда подвесить корни (по умолчанию — HOME)' },
    ],
    destructive: true,
    readOnly: false,
    effects: 'материализует мысли/связи/комментарии/вложения; возвращает счётчики и `layer`.',
    errors: '`VALIDATION_ERROR` (коллизии при `fail`).',
    paramsContract: IMPORT_SUBGRAPH,
  },

  // ---- metrics -------------------------------------------------------------
  {
    action: 'metrics.reads',
    tool: 'etn.metrics.reads',
    group: 'metrics',
    when: 'счётчики чтений мыслей: `top` (популярные) или `cold` (не читанные)',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'kind', desc: '`top` (по умолчанию) | `cold`' },
      { name: 'since', desc: 'для `cold`: не читались с этой ISO-даты' },
      { name: 'limit', desc: '≤ 200' },
      { name: 'include_inactive', desc: 'включать неактуальные' },
    ],
    destructive: false,
    readOnly: true,
    effects: 'чтение, без записи.',
    errors: '`NOT_FOUND`, `FORBIDDEN`.',
    paramsContract: MetricsReads,
  },
  {
    action: 'metrics.tools',
    tool: 'etn.metrics.tools',
    group: 'metrics',
    when: 'телеметрия вызовов инструментов MCP (частота и ошибки) — база для ревизии ростера',
    params: [
      { name: 'network_id', desc: 'ограничить сетью' },
      { name: 'from_ms', desc: 'нижняя граница `last_call_at`' },
      { name: 'to_ms', desc: 'верхняя граница' },
      { name: 'group_by', desc: '`tool` (по умолчанию) | `tool+network` | `tool+key`' },
      { name: 'limit', desc: '≤ 200' },
    ],
    destructive: false,
    readOnly: true,
    effects: 'чтение, без записи.',
    errors: '`FORBIDDEN`.',
    paramsContract: MetricsTools,
  },

  // ---- networks / members / changes ---------------------------------------
  {
    action: 'networks.list',
    tool: 'etn.networks.list',
    group: 'networks',
    when: 'сети, доступные пользователю ключа (с ролью и числом участников)',
    params: [],
    destructive: false,
    readOnly: true,
    effects: 'чтение, без записи.',
    errors: '—',
    paramsContract: NETWORKS_LIST,
  },
  {
    action: 'networks.write',
    tool: 'etn.networks.write',
    group: 'networks',
    when: 'создать сеть (без `network_id`) или изменить её (владелец/админ)',
    params: [
      { name: 'network_id', desc: 'нет — создание; есть — правка' },
      { name: 'display_name', desc: 'имя (обязательно при создании)' },
      { name: 'description', desc: 'описание' },
      { name: 'when_to_use', desc: 'когда использовать сеть' },
      { name: 'conventions', desc: 'правила сети' },
      { name: 'examples', desc: 'примеры' },
      { name: 'type_roles', desc: 'карта ролей типов (`null` снимает роль)' },
    ],
    destructive: false,
    readOnly: false,
    effects: 'создаёт/патчит сеть; событие `network.updated` на изменённые поля.',
    errors: '`VALIDATION_ERROR` (неизвестные роли/типы), `FORBIDDEN`, `NOT_FOUND`.',
    paramsContract: NetworksWrite,
  },
  {
    action: 'networks.delete',
    tool: 'etn.networks.delete',
    group: 'networks',
    when: 'удалить сеть и её `data.db` (только админ)',
    params: [{ name: 'network_id', required: true, desc: 'сеть' }],
    destructive: true,
    readOnly: false,
    effects: 'удаляет сеть; событие `network.deleted`.',
    errors: '`FORBIDDEN` (не админ), `NOT_FOUND`.',
    paramsContract: NETWORKS_DELETE,
  },
  {
    action: 'members.list',
    tool: 'etn.members.list',
    group: 'networks',
    when: 'участники сети (user_id, display_name, role, joined_at)',
    params: [{ name: 'network_id', required: true, desc: 'сеть' }],
    destructive: false,
    readOnly: true,
    effects: 'чтение, без записи.',
    errors: '`FORBIDDEN`.',
    paramsContract: MembersList,
  },
  {
    action: 'changes.list',
    tool: 'etn.changes.list',
    group: 'changes',
    when: 'дельта событий сети для агента с собственным кэшем (`seq > since_seq`)',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'since_seq', required: true, desc: 'последняя применённая последовательность' },
      { name: 'limit', desc: 'по умолчанию 1000' },
    ],
    destructive: false,
    readOnly: true,
    effects: 'чтение с учётом слоя сессии; `truncated: true` — нужна полная пересинхронизация.',
    errors: '`NOT_FOUND`, `FORBIDDEN`.',
    paramsContract: ChangesList,
  },

  // ---- comments / properties ----------------------------------------------
  {
    action: 'comments.delete',
    tool: 'etn.comments.delete',
    group: 'comments',
    when: 'удалить комментарий (постоянный или хронологический) вместе с вложениями',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'comment_id', required: true, desc: 'id комментария' },
      { name: 'expected_version', desc: 'оптимистичная блокировка' },
    ],
    destructive: true,
    readOnly: false,
    effects: 'удаляет комментарий, событие `comment.deleted`.',
    errors: '`NOT_FOUND`, `VERSION_CONFLICT`.',
    paramsContract: CommentsDelete,
  },
  {
    action: 'properties.remove',
    tool: 'etn.properties.remove',
    group: 'properties',
    when: 'убрать одну цель из свойства-связи (помечает ребро на удаление, комментарий сохраняется)',
    params: [
      { name: 'network_id', required: true, desc: 'сеть' },
      { name: 'owner_type', required: true, desc: '`thought` | `link`' },
      { name: 'owner_id', required: true, desc: 'id владельца свойства' },
      { name: 'key', required: true, desc: 'ключ свойства-связи' },
      { name: 'value', required: true, desc: 'id цели' },
    ],
    destructive: false,
    readOnly: false,
    effects: 'помечает ребро на удаление; возвращает `{ link_id }` (idempotent).',
    errors: '`VALIDATION_ERROR`.',
    paramsContract: PropertiesRemove,
  },
];

/** Быстрый индекс реестра по короткому имени действия. */
export const OPS_ACTIONS_BY_NAME: ReadonlyMap<string, OpEntry> = new Map(
  OPS_ACTIONS.map((entry) => [entry.action, entry]),
);

/** Индекс по полному имени снятого инструмента — для аудита и аннотаций. */
export const OPS_ACTIONS_BY_TOOL: ReadonlyMap<string, OpEntry> = new Map(
  OPS_ACTIONS.map((entry) => [entry.tool, entry]),
);

/** Все короткие имена действий (для ошибок и реестра гайда). */
export const OPS_ACTION_NAMES: readonly string[] = OPS_ACTIONS.map((e) => e.action);

// ---------------------------------------------------------------------------
// Темы гайда для частых операций (0.8.3, задача 2bf09236; ADR b2eebf8b)
// ---------------------------------------------------------------------------

/**
 * Дополнительная тема справочника `etn.guide`. Держит подробности ЧАСТОЙ
 * операции, снятые из `description` инструмента (таблицы, семантику фильтров,
 * примеры, исторические экскурсы): витрина `tools/list` остаётся короткой, а
 * деталь читается по `topic` без бюджета префилла. В реестре гайда каждая тема
 * — одна строка, поэтому реестр обязан оставаться ≤ 10 КБ.
 */
export interface GuideTopic {
  /** Имя темы (совпадает с именем инструмента, чьи детали она держит). */
  topic: string;
  /** Одна строка реестра: какие детали здесь лежат. */
  when: string;
  /** Полный текст темы (markdown), отдаётся по `etn.guide { topic }`. */
  body_md: string;
}

/** Темы справочника для частых операций. */
export const GUIDE_TOPICS: readonly GuideTopic[] = [
  {
    topic: 'ontology.write',
    when: 'детали секций батча, конверсия value_type, жизненный цикл свойства-связи ↔ link_type, смена родителя',
    body_md: [
      '# ontology.write — батч-запись онтологии',
      '',
      'Идемпотентный upsert онтологии сети одной транзакцией. Пять секций:',
      '`thought_types[]` / `link_types[]` / `properties[]` / `type_properties[]` / `type_views[]`.',
      'Повторный вызов с теми же аргументами не меняет состояние (`action: unchanged` для',
      'каждого элемента). Локальные `ref` (`parent_ref` для типов,',
      '`type_ref`/`property_ref` для привязок, `thought_type_ref`/`ref_for_update` для отборов)',
      'действуют только внутри батча. Цикл `parent_ref` → `VALIDATION_ERROR`.',
      '',
      '## Адресация и создание элементов',
      '`id` XOR `name` (`name_forward`/`name_reverse` для типов связей) — но не равнозначны:',
      '`id` адресует ТОЛЬКО существующий элемент (патч); для несуществующего id — `NOT_FOUND`',
      '(`details.field = "<секция>[i].id"`). Новый элемент создаётся по имени/паре имён, а id ему',
      'генерирует сервер — задать id нового элемента нельзя (внутри одного батча новый элемент',
      'адресуют через `ref`). `name`, совпавшее с существующим, даёт патч.',
      '`parent` — id существующего родительского типа (имя в `parent` не резолвится →',
      '`NOT_FOUND`, `details.field = "<секция>[i].parent"`) либо `null`/`""` — прикрепить тип',
      'под корневой; родитель из этого же батча — `parent_ref`. У существующего типа пропущенный',
      '`parent` (ключ не задан) оставляет родителя без изменений. `type`/`property` в',
      '`type_properties[]` резолвятся по ИМЕНИ',
      '(`type_ref`/`property_ref` — `ref` из батча).',
      '',
      '## Свойства и `value_type`',
      'Смена `value_type` использует ту же доменную конверсию, что `PATCH /properties/{id}`;',
      'ответ несёт `converted_values`/`dropped_values`. Свойство-связь ↔ link_type — единый',
      'жизненный цикл: `properties[]` с `value_type="link"` и парой `name_forward`/`name_reverse`',
      'создаёт связанный link_type автоматически. Явный `parent_link_type_id` работает и на патче',
      'СУЩЕСТВУЮЩЕГО свойства-связи: правит `parent_id` связанного link_type (с защитой',
      '`reparent_blocked_by_layer`), `null` — прикрепить под корневой тип связи, пропущенный ключ',
      'родителя не трогает (семантика как у `parent` типа). Для структурных свойств игнорируется.',
      '`type_properties[].side` — `source`/`target`,',
      'сторона привязки свойства-связи. `type_properties[].default_value` — дефолт привязки: скаляр,',
      '`null` (сброс) или массив id мыслей; пишется строкой `type_property_overrides` с учётом стороны.',
      '',
      '## Отборы типа (`type_views[]`)',
      '`action: create|update|delete`, `thought_type` XOR `thought_type_ref`; для update/delete —',
      '`id` XOR `ref_for_update`. Доменная валидация имени (уникальность в пределах типа),',
      'токенов и `is_default` — как у `POST /thought-types/{id}/views`.',
      '',
      '## Смена родителя типа',
      'Для типа мысли или связи смена `parent`/`parent_ref` применяется немедленно, интерактива',
      'нет. Явно заданный `parent` (id существующего типа, `null` или `""` — под корень) работает',
      'и на патче существующего типа, а не только на создании; у КОРНЕВОГО типа родителя нет —',
      'явный `parent`/`parent_ref` на нём отвергается `VALIDATION_ERROR` «у корневого типа нет',
      'родителя» (паритет с REST, ошибка 1eb2a430).',
      'Если в ЛЮБОМ живом (не базовом) слое есть мысли (для thought-types) или связи',
      '(для link-types) с типом из множества {изменяемый + потомки + старый/новый родитель} —',
      'отказ `422` с `details.kind = "reparent_blocked_by_layer"` и перечнем слоёв. Для типов',
      'мыслей без живых слоёв записи применяются без интерактивного подтверждения.',
      '',
      '## Бюджет и события',
      'Один write-бюджет + одна строка `audit_log` на ВЕСЬ вызов; real-time события — по одному на',
      'изменённую сущность (`thought-type.*`, `link-type.*`, `property-registry.*`,',
      '`property-definition.*`). Неизвестные ключи верхнего уровня (секция вне перечисленных)',
      'отвергаются `VALIDATION_ERROR` (`details.fields`), а не игнорируются.',
    ].join('\n'),
  },
  {
    topic: 'thoughts.query',
    when: 'справочник фильтров и операторов, семантика свойств-связей, диапазоны дат, link_filter',
    body_md: [
      '# thoughts.query — справочник фильтров',
      '',
      'Структурная выборка мыслей без текстового запроса; фильтры комбинируются по AND.',
      '',
      '| Фильтр | Что делает |',
      '|---|---|',
      '| `in_subtree_of` (+`max_depth`) | направленные потомки; каждый хит несёт `depth` |',
      '| `type_id[]` / `type[]` | фильтр по типу; имена резолвятся без учёта регистра (`NOT_FOUND`, `VALIDATION_ERROR` с `details.candidates` при неоднозначности) |',
      '| `active` / `trashed` | `true`/`false`/`any`; `trashed` по умолчанию `false` |',
      '| `keywords` | мини-синтаксис по названию и синонимам: слова обязательны, `*` — инфиксный шаблон, `-слово` — исключение |',
      '| `properties[]` | `property_id` (или имя `property`) + оператор + значение |',
      '| `created_*` / `updated_*` | ISO-8601 диапазоны |',
      '| `author_id` / `editor_id` | создатель / последний изменивший |',
      '| `link_filter` | `{ type_ids?, include_structural? }` ограничивает рёбра спуска `in_subtree_of` |',
      '',
      '## Операторы свойств',
      '`eq`/`ne`/`contains`/`gt`/`gte`/`lt`/`lte`/`any_of`/`all_of`/`none_of`. Неизвестный',
      '`property_id` не матчит ничего. `value_type` выбирает колонку: number → `value_number`,',
      'bool → `value_bool`, остальные — текстовые.',
      '',
      'Свойство-связь (`value_type: "link"`) переводится в запрос по рёбрам, а не по значениям:',
      '`eq`/`ne` со строкой — связь с конкретной целью (id мысли), с boolean — связь такого типа',
      'есть/отсутствует независимо от цели; работает в обе стороны по направлению свойства.',
      '',
      '`any_of`/`all_of`/`none_of` — для наборов (свойство-связь и `config.multiple` url): `value` —',
      'непустой массив id/строк; пересечение непусто / набор содержит все перечисленные / пересечения нет.',
      '',
      '## Ответ',
      'Несёт справочник `thought_types` плюс опциональные эхо `resolved_types`/`resolved_properties`',
      'для входов, заданных по имени.',
    ].join('\n'),
  },
  {
    // Ошибка 5f08daee-5bb6-45c5-a7ed-53eda44c3c38: постоянный инструмент
    // `etn.activity.list` остался без темы в реестре гайда — группа `activity`
    // знала только `rollup`/`truncate`. Тема добавлена; правило «у каждой
    // операции набора MCP либо полное описание в tools/list, либо тема в
    // etn.guide» держит сторож `guard-mcp-guide-coverage.test.ts`.
    topic: 'activity.list',
    when: 'журнал активности сети: фильтры from_ms/to_ms/user_id/entity_type/entity_id, пагинация limit/offset, сортировка occurred_at_ms DESC',
    body_md: [
      '# activity.list — лента журнала активности',
      '',
      'Read-only лента мутирующих операций сети: одна строка на операцию участника —',
      'создание, правка, удаление, корзина/восстановление мысли, связи, типа, свойства,',
      'комментария, вложения или слоя. `entity_title` — снимок имени на момент события;',
      'захваты `edit.*` (locks) в журнал не пишутся.',
      '',
      '## Фильтры (комбинируются по AND)',
      '',
      '| Фильтр | Что делает |',
      '|---|---|',
      '| `from_ms` / `to_ms` | диапазон `occurred_at_ms` включительно (`>=` / `<=`) |',
      '| `user_id` | только операции указанного участника |',
      '| `entity_type` | тип сущности, например `thought`, `link`, `comment`, `attachment`, `layer` |',
      '| `entity_id` | id конкретной сущности (в паре с `entity_type`) |',
      '',
      'Пустая строка в `user_id`/`entity_type`/`entity_id` фильтр не накладывает.',
      '',
      '## Пагинация и сортировка',
      '',
      `- \`limit\` — размер страницы, 1…${ACTIVITY_LIMIT_MAX} (по умолчанию ${ACTIVITY_LIMIT_DEFAULT});`,
      `  значения вне диапазона зажимаются к границам.`,
      '- `offset` — смещение от начала выборки (по умолчанию 0).',
      '- Сортировка — `occurred_at_ms DESC`, при равенстве — `id DESC` (свежие сверху).',
      '',
      '## Ответ',
      '',
      '`data[]` — строки выборки, `meta { total, offset, limit }`, где `total` — число строк',
      'под фильтром ДО пагинации (для листания). Паритет с REST `GET /activity`.',
    ].join('\n'),
  },
  {
    // Ошибка e05d4688-8180-41c6-bcd9-733d088c8981: описание `etn.thoughts.write`
    // ссылается на «etn.how_to_write_batch», но темы в реестре гайда не было —
    // `etn.guide { topic: "how_to_write_batch" }` падал VALIDATION_ERROR. Текст
    // общий с одноимённым промптом (`how-to.ts`), чтобы не расходились.
    topic: 'how_to_write_batch',
    when: 'пошаговая инструкция батч-записи `etn.thoughts.write`: секции, `ref`/`target_ref`, `on_duplicate`, лимиты, миграция с поглощённых инструментов',
    body_md: writeBatchHowToText('<network_id>'),
  },
];

/** Индекс тем гайда по имени. */
export const GUIDE_TOPICS_BY_NAME: ReadonlyMap<string, GuideTopic> = new Map(
  GUIDE_TOPICS.map((t) => [t.topic, t]),
);

/** Все имена тем гайда (для ошибок и реестра). */
export const GUIDE_TOPIC_NAMES: readonly string[] = GUIDE_TOPICS.map((t) => t.topic);
