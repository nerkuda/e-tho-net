/**
 * Сторож стандарта «Сервер: тест записи покрывает каждое значение вида
 * REST-контракта и MCP-инструмента» для MCP-транспорта (задача aff41ab1,
 * версия 0.8.3; REST-половину того же стандарта держит
 * `guard-view-coverage.test.ts` из задачи c85e53ec / 0.8.2).
 *
 * Зачем MCP-половина. Класс дефекта 0a8b9da3 (непокрытое значение вида живёт
 * незамеченным) не зависит от транспорта: ветки поведения у MCP-инструментов
 * те же «спящие». До этого сторожа реестр REST-контрактов знал имена
 * MCP-видов (`collision_policy`, `link_direction`, `duplicate_policy`), но
 * сами MCP-контракты никто не обходил: у `etn.import.*` не было ни одного
 * теста на `collision_policy`, у `etn.thoughts.copy_subtree` — на `fail`/`skip`,
 * у `etn.attachments.add` — на `kind=file`. (В 0.8.3 ветки реализованы и
 * покрыты тестами: ошибки ebe93450, cb741cec.)
 *
 * Правило. Каждый MCP-инструмент, принимающий параметр-вид с перечислимыми
 * значениями, обязан иметь тест исполнения (вызов инструмента) на КАЖДОЕ
 * значение — либо явное исключение с обоснованием. Инструменты только чтения
 * под правило не попадают: записи, которую надо покрывать, у них нет; они
 * перечислены явно и обязаны быть помечены `readOnlyHint: true` в
 * `MCP_TOOL_ANNOTATIONS`.
 *
 * Как проверяется:
 *   1. охват — обход реестра `contractsByName` (все контракты `etn.*` — это
 *      ровно то, что рекламируется в `tools/list`): в `zod`-схеме ищутся поля
 *      с именами {@link VIEW_FIELDS}; каждое найденное поле обязано быть
 *      заявлено ровно в одном реестре (записи или чтения), лишних записей нет.
 *   2. классификация — вид чтения допустим только на инструменте с
 *      `readOnlyHint: true`; вид записи на таком инструменте требует
 *      `writeOnReadOnlyReason` (например, `etn.thoughts.mentions_scan`
 *      помечен read-only для ветки без `create_links`, но `link_direction`
 *      относится к пишущей ветке).
 *   3. значения — из `z.enum` схемы контракта; расширение enum даёт
 *      непокрытое значение и красный сторож. Для полей, объявленных
 *      `z.string()` с валидацией в домене, значения задаёт реестр (`values`).
 *   4. покрытие — значение обязано иметь тест исполнения (`tests`) либо
 *      исключение с обоснованием (`excluded`); тест проверяется по тексту
 *      файла (`it('<точное название>')`).
 *
 * Исключение — не «отписка»: параметр без ветки поведения заводится ошибкой
 * („Завести ошибку“) и ссылается на неё в обосновании. Так снятие исключения
 * без реализации ветки видно, а не молчит.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';

import { contractsByName } from '../src/contracts.js';
import { OPS_ACTIONS_BY_TOOL } from '../src/mcp/tools/ops-catalog.js';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Имена полей-видов: значение выбирает вариант поведения инструмента.
 * Список намеренно совпадает с REST-сторожем (`guard-view-coverage.test.ts`) —
 * вид один и тот же на обоих транспортах.
 */
const VIEW_FIELDS = new Set([
  'view',
  'scope',
  'kind',
  'format',
  'dir',
  'group_by',
  'link_scope',
  'duplicate_policy',
  'collision_policy',
  'link_direction',
]);

/** Минимальная длина обоснования исключения — «не тестируемо» без причины не принимается. */
const MIN_EXCLUSION_NOTE = 20;

/** Запись реестра видов ЗАПИСИ MCP-инструментов. */
interface McpWriteViewEntry {
  /** Имя MCP-инструмента — оно же имя контракта в `contractsByName`. */
  tool: string;
  /** Поле-вид в схеме контракта. */
  field: string;
  /** Значения вида — только для полей, объявленных `z.string()` с валидацией в домене. */
  values?: readonly string[];
  /** значение → `<файл в tests/>::<точное название теста исполнения>`. */
  tests?: Record<string, string>;
  /** значение → причина, почему тест ветки осознанно не заводится. */
  excluded?: Record<string, string>;
  /**
   * Почему вид записи стоит на инструменте с `readOnlyHint: true`. Обязательно
   * для такой пары — иначе одна из сторон (реестр или аннотация) врёт.
   */
  writeOnReadOnlyReason?: string;
}

/** Реестр видов ЗАПИСИ MCP-инструментов. */
const MCP_WRITE_VIEW_COVERAGE: readonly McpWriteViewEntry[] = [
  {
    tool: 'etn.attachments.add',
    field: 'kind',
    tests: {
      url: 'mcp-view-coverage.test.ts::etn.attachments.add: каждое значение kind (url/file) создаёт вложение',
      file: 'mcp-view-coverage.test.ts::etn.attachments.add: каждое значение kind (url/file) создаёт вложение',
    },
  },
  {
    tool: 'etn.thoughts.copy_subtree',
    field: 'duplicate_policy',
    tests: {
      fail: 'mcp-view-coverage.test.ts::etn.thoughts.copy_subtree: каждое значение duplicate_policy отрабатывает свою ветку',
      reuse:
        'mcp-view-coverage.test.ts::etn.thoughts.copy_subtree: каждое значение duplicate_policy отрабатывает свою ветку',
      skip: 'mcp-view-coverage.test.ts::etn.thoughts.copy_subtree: каждое значение duplicate_policy отрабатывает свою ветку',
      create_always:
        'mcp-view-coverage.test.ts::etn.thoughts.copy_subtree: каждое значение duplicate_policy отрабатывает свою ветку',
    },
  },
  {
    tool: 'etn.thoughts.mentions_scan',
    field: 'link_direction',
    // `mentions_scan` помечен readOnlyHint: true (верно для ветки без
    // `create_links`), но `link_direction` управляет рёбрами, которые создаёт
    // ветка `create_links: true`, — это вид записи.
    writeOnReadOnlyReason:
      'link_direction управляет направлением связей, которые создаёт ветка create_links: true; аннотация readOnlyHint описывает только ветку без create_links',
    tests: {
      out: 'mcp-view-coverage.test.ts::etn.thoughts.mentions_scan: каждое значение link_direction создаёт связи в нужном направлении',
      in: 'mcp-view-coverage.test.ts::etn.thoughts.mentions_scan: каждое значение link_direction создаёт связи в нужном направлении',
    },
  },
  {
    tool: 'etn.import.subgraph',
    field: 'collision_policy',
    tests: {
      fail: 'mcp-view-coverage.test.ts::etn.import.subgraph: каждое значение collision_policy отрабатывает свою ветку',
      rename:
        'mcp-view-coverage.test.ts::etn.import.subgraph: каждое значение collision_policy отрабатывает свою ветку',
      skip: 'mcp-view-coverage.test.ts::etn.import.subgraph: каждое значение collision_policy отрабатывает свою ветку',
      overwrite:
        'mcp-view-coverage.test.ts::etn.import.subgraph: каждое значение collision_policy отрабатывает свою ветку',
    },
  },
  {
    // 0.8.3 (задача d379e091): схема `etn.ontology.delete` переехала из
    // `tools/ontology.ts` в `contracts.ts`, поэтому контракт стал виден сторожу
    // (раньше регистрировался лениво при сборке инструментов). Все пять
    // значений `kind` покрыты: `thought_type`/`type_view` — прежними тестами,
    // `link_type`/`property`/`type_property` — добавленными в
    // `mcp-ontology-write.test.ts`.
    tool: 'etn.ontology.delete',
    field: 'kind',
    tests: {
      thought_type:
        'mcp-ontology-write.test.ts::etn.ontology.delete with force removes the type and clears thoughts.type_id (HOME untouched)',
      link_type:
        'mcp-ontology-write.test.ts::etn.ontology.delete { kind: link_type, force } каскадит связи типа',
      property:
        'mcp-ontology-write.test.ts::etn.ontology.delete { kind: property, force } удаляет свойство и его значения',
      type_property:
        'mcp-ontology-write.test.ts::etn.ontology.delete { kind: type_property } снимает привязку свойства',
      type_view: 'mcp-views.test.ts::etn.ontology.delete { kind: type_view } удаляет отбор',
    },
  },
];

/**
 * Виды операций только чтения: тест исполнения для них не существует, потому
 * правило к ним не применяется. Запись обязательна — иначе сторож не отличит
 * осознанное исключение от забытого вида.
 */
const MCP_READ_ONLY_VIEWS: readonly { tool: string; field: string; note: string }[] = [
  {
    tool: 'etn.thoughts.search',
    field: 'scope',
    note: 'только чтение (readOnlyHint): вид выбирает область полнотекстового поиска.',
  },
  {
    tool: 'etn.instructions',
    field: 'scope',
    note: 'только чтение (readOnlyHint): вид выбирает охват перечня инструкций (roots/all), записи нет.',
  },
  {
    tool: 'etn.thoughts.get',
    field: 'view',
    note: 'только чтение (readOnlyHint): проекция ответа compact/full, без записи.',
  },
  {
    tool: 'etn.thoughts.resolve',
    field: 'view',
    note: 'только чтение (readOnlyHint): проекция ответа compact/full, без записи.',
  },
  {
    tool: 'etn.thoughts.neighbors',
    field: 'dir',
    note: 'только чтение (readOnlyHint): вид выбирает зону соседства, запись не производится.',
  },
  {
    tool: 'etn.thoughts.neighbors',
    field: 'view',
    note: 'только чтение (readOnlyHint): проекция ответа compact/full, без записи.',
  },
  {
    tool: 'etn.thoughts.subgraph',
    field: 'view',
    note: 'только чтение (readOnlyHint): проекция ответа compact/full, без записи.',
  },
  {
    tool: 'etn.thoughts.usage',
    field: 'view',
    note: 'только чтение (readOnlyHint): проекция ответа compact/full, без записи.',
  },
  {
    tool: 'etn.attachments.search',
    field: 'kind',
    note: 'только чтение (readOnlyHint): фильтр вида вложения в поиске, записи нет.',
  },
  {
    tool: 'etn.export.subgraph',
    field: 'format',
    note: 'только чтение (readOnlyHint): вид выбирает рендерер документа; рендерер общий с REST-контрактом RestExport, покрытым REST-сторожем.',
  },
  {
    tool: 'etn.types.list',
    field: 'scope',
    note: 'только чтение (readOnlyHint): вид выбирает каталог типов (мысли/связи), записи нет.',
  },
  {
    tool: 'etn.metrics.reads',
    field: 'kind',
    note: 'только чтение (readOnlyHint): вид выборки метрик (top/cold), записи нет.',
  },
  {
    tool: 'etn.metrics.tools',
    field: 'group_by',
    note: 'только чтение (readOnlyHint): группировка агрегата метрик, записи нет.',
  },
  {
    tool: 'etn.chronicle.query',
    field: 'link_scope',
    note: 'только чтение (readOnlyHint): вид выбирает сторону связи в запросе хроники, записи нет.',
  },
  {
    tool: 'etn.import.dry_run',
    field: 'collision_policy',
    note: 'превью без побочных эффектов (readOnlyHint): записывать нечего; политика отражается в плане (счётчики create/reuse/skip) и в списке conflicts — тест исполнения mcp-view-coverage.test.ts.',
  },
];

interface ZodLike {
  _zod?: {
    def?: {
      type?: string;
      innerType?: unknown;
      out?: unknown;
      entries?: Record<string, string>;
    };
  };
}

/** Разворачивает обёртки zod (`optional`/`nullable`/`default`/`pipe`) до базового типа. */
function unwrapZod(type: unknown): ZodLike | undefined {
  let cur = type as ZodLike | undefined;
  for (let i = 0; i < 10 && cur?._zod?.def; i++) {
    const kind = cur._zod.def.type;
    if (
      kind === 'optional' ||
      kind === 'nullable' ||
      kind === 'default' ||
      kind === 'prefault' ||
      kind === 'readonly'
    ) {
      cur = cur._zod.def.innerType as ZodLike;
      continue;
    }
    if (kind === 'pipe') {
      cur = cur._zod.def.out as ZodLike;
      continue;
    }
    break;
  }
  return cur;
}

/** Значения `z.enum` (или `undefined`, если поле не enum). */
function enumValues(type: unknown): string[] | undefined {
  const unwrapped = unwrapZod(type);
  if (unwrapped?._zod?.def?.type !== 'enum') return undefined;
  return Object.keys(unwrapped._zod.def.entries ?? {});
}

/** Поля-виды во всех MCP-контрактах (`etn.*` — ровно то, что рекламирует `tools/list`). */
function mcpViewFields(): Array<{ tool: string; field: string; values?: string[] }> {
  const found: Array<{ tool: string; field: string; values?: string[] }> = [];
  for (const [tool, contract] of contractsByName) {
    if (!tool.startsWith('etn.')) continue;
    const shape = (contract as { schema?: { shape?: Record<string, unknown> } }).schema?.shape;
    if (shape === undefined) continue;
    for (const field of Object.keys(shape).sort()) {
      if (!VIEW_FIELDS.has(field)) continue;
      const values = enumValues(shape[field]);
      found.push({ tool, field, ...(values !== undefined ? { values } : {}) });
    }
  }
  return found;
}

/** `readOnlyHint` инструмента из общей таблицы аннотаций. Для операций,
 *  снятых в `etn.ops` (0.8.3, задача 86ef2ff4), признак `readOnly` берётся из
 *  реестра действий — у них больше нет собственной тул-уровневой аннотации. */
function readOnlyHint(tool: string): boolean {
  const table = MCP_TOOL_ANNOTATIONS as Readonly<Record<string, { readOnlyHint?: boolean } | undefined>>;
  if (table[tool]?.readOnlyHint === true) return true;
  return OPS_ACTIONS_BY_TOOL.get(tool)?.readOnly === true;
}

const viewKey = (tool: string, field: string): string => `${tool}.${field}`;

describe('guard: каждое значение вида MCP-инструмента покрыто тестом исполнения', () => {
  it('охват: каждое поле-вид MCP-контракта заявлено в реестре', () => {
    const found = mcpViewFields();
    const foundKeys = new Set(found.map((f) => viewKey(f.tool, f.field)));

    const writeKeys = MCP_WRITE_VIEW_COVERAGE.map((e) => viewKey(e.tool, e.field));
    const readKeys = MCP_READ_ONLY_VIEWS.map((e) => viewKey(e.tool, e.field));

    for (const [name, keys] of [
      ['MCP_WRITE_VIEW_COVERAGE', writeKeys],
      ['MCP_READ_ONLY_VIEWS', readKeys],
    ] as const) {
      const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
      assert.deepEqual(dupes, [], `${name}: поле-вид заявлено дважды: ${dupes.join(', ')}`);
    }
    const bothLists = writeKeys.filter((k) => readKeys.includes(k));
    assert.deepEqual(bothLists, [], `поле-вид заявлено и как запись, и как чтение: ${bothLists.join(', ')}`);

    const declared = new Set([...writeKeys, ...readKeys]);
    const undeclared = [...foundKeys].filter((key) => !declared.has(key)).sort();
    assert.deepEqual(
      undeclared,
      [],
      `поля-виды MCP-инструментов не рассмотрены стандартом (добавь в MCP_WRITE_VIEW_COVERAGE или MCP_READ_ONLY_VIEWS): ${undeclared.join(', ')}`,
    );

    const stale = [...declared].filter((key) => !foundKeys.has(key)).sort();
    assert.deepEqual(
      stale,
      [],
      `реестр ссылается на несуществующие поля-виды (контракт переименован/поле убрано): ${stale.join(', ')}`,
    );
  });

  it('классификация: вид чтения — только на readOnlyHint-инструменте, вид записи на нём — с причиной', () => {
    for (const entry of MCP_READ_ONLY_VIEWS) {
      assert.ok(
        readOnlyHint(entry.tool),
        `${viewKey(entry.tool, entry.field)}: заявлен видом чтения, но инструмент не помечен readOnlyHint: true`,
      );
      assert.ok(
        entry.note.trim().length >= MIN_EXCLUSION_NOTE,
        `${viewKey(entry.tool, entry.field)}: read-only без внятного обоснования`,
      );
    }
    for (const entry of MCP_WRITE_VIEW_COVERAGE) {
      if (!readOnlyHint(entry.tool)) continue;
      assert.ok(
        (entry.writeOnReadOnlyReason ?? '').trim().length >= MIN_EXCLUSION_NOTE,
        `${viewKey(entry.tool, entry.field)}: вид записи на инструменте с readOnlyHint: true — обоснуй в writeOnReadOnlyReason`,
      );
    }
  });

  it('каждое значение вида покрыто тестом исполнения или исключением', () => {
    const found = new Map(mcpViewFields().map((f) => [viewKey(f.tool, f.field), f]));

    for (const entry of MCP_WRITE_VIEW_COVERAGE) {
      const key = viewKey(entry.tool, entry.field);
      const view = found.get(key);
      assert.ok(view !== undefined, `${key}: поле-вид не найдено в MCP-контрактах`);

      const values = view.values ?? entry.values;
      assert.ok(
        values !== undefined && values.length > 0,
        `${key}: не удалось определить значения вида — задай их в поле values реестра`,
      );

      const tested = Object.keys(entry.tests ?? {});
      const excluded = Object.keys(entry.excluded ?? {});
      const uncovered = values.filter((v) => !tested.includes(v) && !excluded.includes(v));
      assert.deepEqual(
        uncovered,
        [],
        `${key} (${entry.tool}): значения вида без теста исполнения или исключения: ${uncovered.join(', ')}`,
      );

      const extra = [...tested, ...excluded].filter((v) => !values.includes(v));
      assert.deepEqual(extra, [], `${key}: в реестре лишние значения (нет в контракте): ${extra.join(', ')}`);

      const both = tested.filter((v) => excluded.includes(v));
      assert.deepEqual(both, [], `${key}: значение не может быть и покрыто, и исключено: ${both.join(', ')}`);

      for (const [value, reason] of Object.entries(entry.excluded ?? {})) {
        assert.ok(
          reason.trim().length >= MIN_EXCLUSION_NOTE,
          `${key} value=${value}: исключение без обоснования`,
        );
      }
    }
  });

  it('заявленные тесты исполнения существуют и названы точно', () => {
    for (const entry of MCP_WRITE_VIEW_COVERAGE) {
      for (const [value, ref] of Object.entries(entry.tests ?? {})) {
        const separator = ref.indexOf('::');
        assert.ok(separator > 0, `${viewKey(entry.tool, entry.field)}: ссылка «${ref}» без «::»`);
        const file = ref.slice(0, separator);
        const title = ref.slice(separator + 2);
        const abs = path.join(TESTS_DIR, file);
        assert.ok(fs.existsSync(abs), `${viewKey(entry.tool, entry.field)}: файл тестов «${file}» не найден`);
        const content = fs.readFileSync(abs, 'utf8');
        const present = content.includes(`it('${title}'`) || content.includes(`it("${title}"`);
        assert.ok(
          present,
          `${viewKey(entry.tool, entry.field)} value=${value}: в ${file} нет теста «${title}»`,
        );
      }
    }
  });
});
