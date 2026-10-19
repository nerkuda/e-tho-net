#!/usr/bin/env node
/**
 * version-metrics — метрики эффективности разработки версии по базе ETN (REST).
 *
 * Зачем. Критерий приёмки реорганизации процесса («в следующей версии меньше
 * переделок и GUI-находок», ретро-исследование `c2ca8173`) без инструмента
 * недоказуем: эффект нечем измерить. Скрипт собирает числа версии одной
 * командой и умеет сравнивать две версии.
 *
 * Что считает (все числа — по хроникам и git-истории, без ручного ввода):
 *   1. fix:feat по коммитам диапазона ветки версии (`git log --format`):
 *      диапазон — предыдущий тег..тег версии (например `v0.11.2..v0.12.1`).
 *   2. состав работ версии — мысли, привязанные к версии свойством-связью
 *      «запланировано в версию» (REST `POST /thoughts/query`), с разбивкой по
 *      типам (тех.проект/задача/ошибка), актуальные и снятые с учёта.
 *   3. first-pass — доля задач, принятых с первой сдачи: по хроно-комментариям
 *      работы ищутся вердикты верификатора («не принято» → переделка).
 *      Группировка — по тех.проектам версии (задача относится к ближайшему
 *      тех.проекту в цепочке её структурных родителей).
 *   4. повторные делегации — работы, делегированные повторно уже после того,
 *      как были сделаны/исправлены (по хроно).
 *   5. пользовательские GUI-находки — ошибки, в постоянном комментарии которых
 *      источником указан пользователь (найдено/сообщил/выявлено пользователем).
 *      С 0.13.2 находки делятся на полировку и дефекты (`userGuiFindings` с
 *      полями `polish`/`defect`): реальные ошибки агента — отдельно от
 *      неизбежной доводки интерфейса (задача 3e30f200).
 *   6. длительность версии — от создания мысли-версии до даты публикации.
 *
 * Вывод: человекочитаемый отчёт + машинный JSON (`--json <файл>`); `--compare`
 * печатает две версии рядом и дельту.
 *
 * Зависимостей нет: только node builtins (global fetch, node:child_process) —
 * Node 22 LTS.
 *
 * Доступ к базе
 * -------------
 * Адрес REST и ключ берутся (в порядке приоритета) из:
 *   1. флагов `--base` / `--token`;
 *   2. переменных окружения `ETN_REMOTE_URL` / `ETN_REMOTE_TOKEN` (также
 *      принимаются `ETN_TOKEN`, `ETN_URL`);
 *   3. MCP-конфига ZCode с сервером `etn-remote`: `--config <файл>`, затем
 *      `.zcode/config.json` репозитория, `~/.zcode/cli/config.json`,
 *      `~/.zcode/config.json`. Из блока берётся `url` (без хвоста `/mcp`) и
 *      заголовок `Authorization: Bearer …`.
 * Ключ в код НЕ зашит и в отчёт не попадает.
 *
 * Использование
 * -------------
 *   node client/scripts/version-metrics.mjs v0.12.1
 *   node client/scripts/version-metrics.mjs --version 30a10102-… --json .tmp/0.12.1.json
 *   node client/scripts/version-metrics.mjs --compare v0.11.2..v0.12.1 v0.12.1..HEAD
 *   node client/scripts/version-metrics.mjs --compare v0.11.2 v0.12.1
 *
 * Карточка инструмента — задача `81a9a521` в мыслесети ETN.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Сеть ETN по умолчанию (переопределяется `--network` / `ETN_NETWORK_ID`). */
export const DEFAULT_NETWORK_ID = '253431e2-780d-466b-879e-6373f73fbad5';

/**
 * Id свойства-связи «запланировано в версию» (переопределяется
 * `--link-property` / `ETN_VERSION_LINK_PROPERTY`). Идентификатор стабилен в
 * сети ETN; вынесен в константу, чтобы не искать свойство по имени каждый раз.
 */
export const DEFAULT_VERSION_LINK_PROPERTY_ID = '88a23f24-8de0-45d4-aa72-0127b036c747';

/** Типы мыслей-работ и их имена (etn-types ETN). */
export const WORK_TYPE_IDS = Object.freeze({
  techProject: '7923a043-6930-4484-a813-a012ee496049',
  error: '3d31c615-d6b0-42e9-a027-e8197f7cbe8b',
  task: '8ea58f4c-1132-4f0a-93b8-41b6c83ac19d',
});

/** Тип мысли «версия» (для поиска мысли-версии по номеру). */
export const VERSION_TYPE_ID = '7cd59c3d-b061-44ef-8d61-cca141021a1c';

const WORK_TYPE_NAMES = {
  [WORK_TYPE_IDS.techProject]: 'тех.проект',
  [WORK_TYPE_IDS.error]: 'ошибка',
  [WORK_TYPE_IDS.task]: 'задача',
};

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Чистые функции (покрыты unit-тестами: client/tests/version-metrics.test.ts)
// ---------------------------------------------------------------------------

/**
 * Разобрать subject коммита в стиле Conventional Commits с префиксом задачи
 * в квадратных скобках: `[<id>] feat(scope): …`, `[<id>][<id>] fix(scope): …`,
 * `docs: …`, `Merge …`. Возвращает `{ type, scope, taskIds, merge }`;
 * `type`/`scope` — `null`, если распознать не удалось.
 */
export function parseCommitSubject(subject) {
  const raw = String(subject ?? '').trim();
  const merge = /^Merge\b/i.test(raw);
  let rest = raw;
  const taskIds = [];
  // Снимаем все ведущие группы [ … ] (бывает двойной префикс задач).
  for (;;) {
    const m = rest.match(/^\[([^\]]+)\]\s*/);
    if (m === null) break;
    const id = m[1].trim();
    if (id !== '') taskIds.push(id);
    rest = rest.slice(m[0].length);
  }
  const m = rest.match(/^([A-Za-z]+)(?:\(([^)]*)\))?!?:/);
  if (m === null) return { type: null, scope: null, taskIds, merge };
  return { type: m[1].toLowerCase(), scope: m[2] ?? null, taskIds, merge };
}

/** Сводка по списку subject'ов коммитов: всего, по типам, fix/feat. */
export function summariseCommits(subjects) {
  const byType = {};
  let total = 0;
  let fix = 0;
  let feat = 0;
  for (const subject of subjects) {
    total += 1;
    const { type } = parseCommitSubject(subject);
    const key = type ?? '(прочее)';
    byType[key] = (byType[key] ?? 0) + 1;
    if (type === 'fix') fix += 1;
    if (type === 'feat') feat += 1;
  }
  return {
    total,
    fix,
    feat,
    fixToFeat: feat === 0 ? null : Number((fix / feat).toFixed(2)),
    byType,
  };
}

/** Текст хроно-записей работы (без постоянного комментария). */
function chronologicalText(comments) {
  return (comments ?? [])
    .filter((c) => c.kind !== 'permanent')
    .map((c) => `${c.title ?? ''}\n${c.body_md ?? ''}`)
    .join('\n');
}

/** Текст постоянного комментария работы. */
function permanentText(comments) {
  const c = (comments ?? []).find((x) => x.kind === 'permanent');
  return c === undefined ? '' : `${c.title ?? ''}\n${c.body_md ?? ''}`;
}

/**
 * Задача принята с первой сдачи: ни один вердикт верификатора не содержит
 * «не принято» (в любом регистре, включая «НЕ ПРИНЯТО»). Переделки без явного
 * вердикта «не принято» эвристикой не ловятся — это осознанное упрощение,
 * дающее воспроизводимое число (документировано в version-metrics.md).
 */
export function firstPassAccepted(comments) {
  const text = chronologicalText(comments);
  return !/не\s*принят/i.test(text);
}

/** Число вердиктов верификатора в хроно работы (для диагностики расхождений). */
export function verifierRoundCount(comments) {
  const text = chronologicalText(comments);
  return (text.match(/вердикт/gi) ?? []).length;
}

/**
 * Пользовательская GUI-находка. Источник — пользователь/заказчик в постоянном
 * комментарии ошибки.
 *
 * Два семейства маркеров:
 *   * классические («найдено/сообщил/выявлено/обнаружено пользователем», «живая
 *     проверка пользователя», «со слов пользователя», «запрос пользователя»,
 *     «симптом (пользователь…»);
 *   * замечания заказчика по визуальной проверке (ретро 0.13.1): «замечания
 *     заказчика», «по визуальной проверке», «формулировки заказчика»,
 *     «заказчик требует/надоело». До 0.13.2 такие карточки не считались —
 *     метрика показывала 1 находку вместо ~65 (задача 92674032).
 *
 * `title` — название работы: у реальных полировочных карточек слово
 * «полировка» есть только в заголовке, а «формулировки заказчика» — в теле.
 */
export function hasUserGuiFinding(text, title = '') {
  const body = String(text ?? '');
  // Классические маркеры источника-пользователя.
  const fromUser =
    /(найдено пользовател|сообщил пользовател|выявлен[оа][^\n]{0,40}пользовател|обнаружен[оа][^\n]{0,40}пользовател|живая проверка пользовател|визуальная проверка пользовател|со слов пользовател|запрос пользовател|симптом \(пользовател|пользователь сообщ)/i.test(
      body,
    );
  // Маркеры полировочной карточки заказчика.
  const polish =
    /(замечани[а-яё]*\s+заказчик[а-яё]*|по\s+визуальной\s+проверке|заказчик[а-яё]*\s+(?:требует|надоело))/i.test(
      body,
    );
  // «Формулировки заказчика» — уточняющий маркер: сам по себе это заголовок
  // чек-листа, который встречается и в ранних визуальных аудитах (0.13.1:
  // 498876c4); в счёт идёт только в карточке, явно помеченной «полировка» —
  // в заголовке работы (у реальных карточек 0.13.1) или в тексте комментария.
  const customerFormulations = /формулировк[а-яё]*\s+заказчик[а-яё]*/i.test(body);
  const polishContext = `${title}\n${body}`;
  return fromUser || polish || (customerFormulations && /полиров/i.test(polishContext));
}

/** Повторная делегация: работа делегирована вновь после того, как была сделана. */
export function hasRepeatedDelegation(text) {
  return /(повторн\w*\s+делегац|повторно делегир|уже (?:исправлено|сделано|реализовано|закрыт|выполнен))/i.test(
    String(text ?? ''),
  );
}

/** Маркеры полировки: доводка интерфейса, а не неверное поведение (задача 3e30f200). */
export const POLISH_MARKERS = Object.freeze([
  /полиров/i,
  /стало\s+(?:значительно\s+)?(?:лучше|удобн)/i,
  /переименова/i,
  /компактн/i,
  /перенест/i,
  /убрать\s+(?:кнопк|строк)/i,
  /порядок\s+пар/i,
  /вместо\s+id/i,
  /(?:не\s+)?помеща/i,
  // «ширина» — только про UI-объект: техническое «из-за ширины блока» в
  // описании причины дефекта полировкой не считается (пример 39553204).
  /ширин[а-яё]*[^\n]{0,30}(?:колонк|строк|пол[яе]|панел|диалог|таблиц|окн|меню|кнопк|чип|редактор|элемент)/i,
  /тултип/i,
]);

/**
 * Маркеры дефекта. «ОШИБКА»/«КРИТИЧНО» — только капсом: строчное «ошибка» —
 * обычное слово в тексте карточки и маркером не является.
 */
export const DEFECT_MARKERS = Object.freeze([
  /ОШИБКА/,
  /КРИТИЧНО/,
  /не\s+работает/i,
  /падает|роняет/i,
  /теряется/i,
  /не\s+совпадает\s+с/i,
  /нарушает\s+(?:требовани|ADR)/i,
  /пустой\s+результат/i,
]);

/**
 * Класс пользовательской GUI-находки: `polish` (доводка) или `defect`
 * (реальная ошибка агента). Эвристика по формулировкам карточки: заголовок
 * работы + текст постоянного комментария.
 *
 * Правила (границы — в `version-metrics.md`):
 *   * есть любой маркер дефекта → `defect` — даже если рядом маркеры
 *     полировки: смешанный состав классифицируется консервативно (карточка
 *     «полировка» с пунктом «ОШИБКА:» — дефект);
 *   * иначе есть маркер полировки → `polish`;
 *   * ни одного маркера → `defect` — сомнительная находка не раздувает
 *     полировки.
 */
export function classifyUserGuiFinding(text, title = '') {
  const source = `${title}\n${String(text ?? '')}`;
  if (DEFECT_MARKERS.some((re) => re.test(source))) return 'defect';
  if (POLISH_MARKERS.some((re) => re.test(source))) return 'polish';
  return 'defect';
}

/**
 * Сводка по работам версии. Вход:
 *   works        — [{ id, title, type_id, active }];
 *   commentsById — { [thoughtId]: [{ kind, title, body_md, valid_from? }] };
 *   groups       — [{ name, taskIds }] (проекты версии и их задачи).
 * Возвращает счётчики, разбивку по типам, first-pass по проектам и в целом,
 * пользовательские находки (всего/полировка/дефект) и повторные делегации.
 */
export function summariseWorks({ works, commentsById, groups = [] }) {
  const byType = {};
  for (const w of works) {
    const name = WORK_TYPE_NAMES[w.type_id] ?? w.type_id;
    byType[name] = (byType[name] ?? 0) + 1;
  }
  const comments = (id) => commentsById[id] ?? [];

  const errors = works.filter((w) => w.type_id === WORK_TYPE_IDS.error);
  const userGuiFindingWorks = errors.filter((w) =>
    hasUserGuiFinding(permanentText(comments(w.id)), w.title),
  );
  const polishWorks = userGuiFindingWorks.filter(
    (w) => classifyUserGuiFinding(permanentText(comments(w.id)), w.title) === 'polish',
  );
  const defectWorks = userGuiFindingWorks.filter(
    (w) => classifyUserGuiFinding(permanentText(comments(w.id)), w.title) === 'defect',
  );
  const repeatedDelegations = works.filter((w) => hasRepeatedDelegation(chronologicalText(comments(w.id))));

  const byGroup = [];
  let acceptedAll = 0;
  let totalAll = 0;
  for (const group of groups) {
    const tasks = group.taskIds.map((id) => works.find((w) => w.id === id)).filter(Boolean);
    const accepted = tasks.filter((w) => firstPassAccepted(comments(w.id)));
    byGroup.push({
      name: group.name,
      accepted: accepted.length,
      total: tasks.length,
      ratio: tasks.length === 0 ? null : Number((accepted.length / tasks.length).toFixed(3)),
      taskIds: tasks.map((w) => w.id),
      notAccepted: tasks.filter((w) => !firstPassAccepted(comments(w.id))).map((w) => ({ id: w.id, title: w.title })),
    });
    acceptedAll += accepted.length;
    totalAll += tasks.length;
  }

  return {
    total: works.length,
    active: works.filter((w) => w.active).length,
    inactive: works.filter((w) => !w.active).length,
    byType,
    errors: errors.length,
    userGuiFindings: {
      total: userGuiFindingWorks.length,
      polish: polishWorks.length,
      defect: defectWorks.length,
    },
    userGuiFindingIds: userGuiFindingWorks.map((w) => w.id),
    userGuiPolishIds: polishWorks.map((w) => w.id),
    userGuiDefectIds: defectWorks.map((w) => w.id),
    repeatedDelegations: repeatedDelegations.length,
    repeatedDelegationIds: repeatedDelegations.map((w) => w.id),
    firstPass: {
      accepted: acceptedAll,
      total: totalAll,
      ratio: totalAll === 0 ? null : Number((acceptedAll / totalAll).toFixed(3)),
      byGroup,
    },
  };
}

/** Сравнить два semver-тега вида `vX.Y.Z` (иные — в конец, лексикографически). */
function compareTags(a, b) {
  const va = a.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  const vb = b.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (va !== null && vb !== null) {
    for (let i = 1; i <= 3; i += 1) {
      const d = Number(va[i]) - Number(vb[i]);
      if (d !== 0) return d;
    }
    return a.localeCompare(b);
  }
  if (va !== null) return -1;
  if (vb !== null) return 1;
  return a.localeCompare(b);
}

/** Отсортированный список тегов версий (по возрастанию). */
export function orderTags(tags) {
  return [...tags].sort(compareTags);
}

/** Предыдущий тег перед `tag` (для диапазона «предыдущая версия..версия»). */
export function previousTag(tags, tag) {
  const sorted = orderTags(tags);
  const idx = sorted.indexOf(tag);
  return idx > 0 ? sorted[idx - 1] : null;
}

/**
 * Длительность версии: от создания мысли до даты публикации (свойство «Дата
 * публикации»), иначе — до последнего изменения. Возвращает `{ from, to, days }`
 * или `null`, если дат нет.
 */
export function versionDuration(createdAt, publishedDate, updatedAt) {
  if (typeof createdAt !== 'string' || createdAt === '') return null;
  const to = typeof publishedDate === 'string' && publishedDate !== '' ? publishedDate : updatedAt;
  if (typeof to !== 'string' || to === '') return null;
  const from = Date.parse(createdAt);
  const till = Date.parse(to);
  if (Number.isNaN(from) || Number.isNaN(till)) return null;
  return {
    from: createdAt,
    to,
    days: Number(((till - from) / 86_400_000).toFixed(2)),
  };
}

/**
 * Достать адрес и ключ `etn-remote` из JSON MCP-конфига ZCode. Понимает
 * обе обёртки: `{ mcp: { servers: { … } } }` и `{ mcpServers: { … } }`,
 * а также конфиг с одним сервером без имени. Возвращает
 * `{ url, token }` (url — без хвоста `/mcp`) или `null`.
 */
export function readMcpConfig(text, serverName = 'etn-remote') {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const servers =
    json?.mcp?.servers ?? json?.mcpServers ?? (typeof json === 'object' && json !== null ? json : {});
  const entry = servers?.[serverName];
  if (entry === undefined || entry === null) return null;
  const rawUrl = typeof entry.url === 'string' ? entry.url.trim() : '';
  if (rawUrl === '') return null;
  const url = rawUrl.replace(/\/mcp\/?$/i, '').replace(/\/$/, '');
  const authHeader =
    entry.headers?.Authorization ?? entry.headers?.authorization ?? entry.Authorization ?? '';
  const token = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';
  return { url, token };
}

/** Разобрать аргументы командной строки. */
export function parseArgs(argv) {
  const opts = {
    specs: [],
    compare: false,
    base: null,
    token: null,
    config: null,
    network: null,
    linkProperty: null,
    repo: null,
    json: null,
    noGit: false,
    help: false,
  };
  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const next = () => {
      i += 1;
      return args[i];
    };
    if (a === '--version' || a === '-v') opts.specs.push(next());
    else if (a === '--compare') opts.compare = true;
    else if (a === '--base' || a === '--url') opts.base = next();
    else if (a === '--token') opts.token = next();
    else if (a === '--config') opts.config = next();
    else if (a === '--network') opts.network = next();
    else if (a === '--link-property') opts.linkProperty = next();
    else if (a === '--repo') opts.repo = next();
    else if (a === '--json') opts.json = next();
    else if (a === '--no-git') opts.noGit = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!a.startsWith('-')) opts.specs.push(a);
  }
  return opts;
}

/**
 * Разрешить подключение к базе: адрес, ключ, network id. Приоритет — флаги,
 * затем окружение, затем MCP-конфиг (см. шапку файла). `deps` инжектится в
 * тестах (`readFile`, `env`, `home`, `repoRoot`).
 */
export function resolveEndpoint({ argv, env, readFile, home, repoRoot }) {
  const opts = parseArgs(argv);
  const base = opts.base ?? env.ETN_REMOTE_URL ?? env.ETN_URL ?? null;
  const token = opts.token ?? env.ETN_REMOTE_TOKEN ?? env.ETN_TOKEN ?? null;
  const networkId = opts.network ?? env.ETN_NETWORK_ID ?? DEFAULT_NETWORK_ID;
  const linkProperty = opts.linkProperty ?? env.ETN_VERSION_LINK_PROPERTY ?? DEFAULT_VERSION_LINK_PROPERTY_ID;

  const candidates = [];
  if (opts.config !== null) candidates.push(resolve(opts.config));
  if (repoRoot !== undefined) candidates.push(join(repoRoot, '.zcode', 'config.json'));
  candidates.push(join(home ?? homedir(), '.zcode', 'cli', 'config.json'));
  candidates.push(join(home ?? homedir(), '.zcode', 'config.json'));

  let cfgUrl = null;
  let cfgToken = null;
  for (const file of candidates) {
    const cfg = readMcpConfig(readFile(file));
    if (cfg !== null) {
      cfgUrl = cfgUrl ?? cfg.url;
      cfgToken = cfgToken ?? cfg.token;
      if (cfgUrl !== null && cfgToken !== null) break;
    }
  }

  const resolvedBase = base ?? cfgUrl;
  const resolvedToken = token ?? cfgToken;
  if (resolvedBase === null || resolvedToken === null) {
    throw new Error(
      'Не найдены адрес/ключ etn-remote. Задайте --base/--token, ETN_REMOTE_URL/ETN_REMOTE_TOKEN ' +
        'или укажите --config с MCP-конфигом ZCode.',
    );
  }
  return {
    base: resolvedBase.replace(/\/$/, ''),
    apiBase: `${resolvedBase.replace(/\/$/, '')}/api/v1`,
    token: resolvedToken,
    networkId,
    linkProperty,
    repo: opts.repo ?? repoRoot ?? process.cwd(),
    json: opts.json,
    noGit: opts.noGit,
  };
}

// ---------------------------------------------------------------------------
// REST-клиент и git
// ---------------------------------------------------------------------------

/** Ошибка REST-ответа базы (для понятного текста в CLI). */
class ApiError extends Error {}

function createClient({ apiBase, token, networkId, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch }) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function call(method, path, body) {
    // Таймаут — через AbortSignal.timeout (Node 18+); ссылаемся на globalThis,
    // чтобы не ловить no-undef в flat-конфиге ESLint для скриптов.
    const res = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: globalThis.AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      throw new ApiError(`Некорректный ответ базы на ${method} ${path}: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const message = json?.error?.message ?? res.statusText;
      throw new ApiError(`${method} ${path} → ${res.status}: ${message}`);
    }
    return json;
  }
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    networkId,
  };
}

/** Все страницы `POST /thoughts/query` с курсором. */
async function queryAll(client, body, pageLimit = 100) {
  const items = [];
  let cursor = undefined;
  for (;;) {
    const payload = { ...body, limit: pageLimit };
    if (cursor !== undefined) payload.cursor = cursor;
    const page = await client.post(`/networks/${client.networkId}/thoughts/query`, payload);
    const data = Array.isArray(page.data) ? page.data : [];
    items.push(...data);
    const meta = page.meta ?? {};
    if (data.length === 0 || meta.next_cursor === undefined || meta.has_more === false) break;
    cursor = meta.next_cursor;
  }
  return items;
}

/** Работы версии: мысли, привязанные свойством-связью «запланировано в версию». */
async function fetchVersionWorks(client, linkPropertyId, versionId) {
  const filter = {
    properties: [{ property_id: linkPropertyId, op: 'eq', value: versionId }],
  };
  const active = await queryAll(client, { ...filter, active: true });
  const done = await queryAll(client, { ...filter, active: false });
  const seen = new Set();
  const works = [];
  for (const w of [...active, ...done]) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    works.push({
      id: w.id,
      title: w.title,
      type_id: w.type_id,
      active: w.active === true,
      created_at: w.created_at ?? null,
    });
  }
  return works;
}

async function fetchComments(client, thoughtId) {
  const page = await client.get(`/networks/${client.networkId}/thoughts/${thoughtId}/comments`);
  const items = Array.isArray(page.data) ? page.data : (page.data?.items ?? []);
  return items.map((c) => ({ kind: c.kind, title: c.title ?? '', body_md: c.body_md ?? '', valid_from: c.valid_from ?? null }));
}

/** Кэширующее чтение структурных родителей мысли. */
async function fetchParentIds(client, thoughtId, cache) {
  if (cache[thoughtId] !== undefined) return cache[thoughtId];
  const page = await client.get(
    `/networks/${client.networkId}/thoughts/${thoughtId}/hierarchy?dir=parents&show_inactive=true`,
  );
  const ids = (page.data?.neighbors ?? []).map((n) => n.id);
  cache[thoughtId] = ids;
  return ids;
}

/**
 * Отнести каждую задачу версии к ближайшему тех.проекту (поднимаемся по
 * структурным родителям, пока не встретим проект; глубина ограничена). Проект
 * получает задачи, для которых он — ближайший родитель-проект; задачи без
 * проекта в поддереве возвращаются в `ungroupedTasks`.
 */
async function assignTasksToProjects(client, works, projects, maxUp = 5) {
  const projectSet = new Set(projects.map((p) => p.id));
  const tasks = works.filter((w) => w.type_id === WORK_TYPE_IDS.task);
  const cache = {};
  const byProject = new Map(projects.map((p) => [p.id, []]));
  const ungroupedTasks = [];
  for (const task of tasks) {
    const seen = new Set([task.id]);
    let level = [task.id];
    let owner = null;
    for (let depth = 0; depth < maxUp && owner === null && level.length > 0; depth += 1) {
      const next = [];
      for (const id of level) {
        for (const parentId of await fetchParentIds(client, id, cache)) {
          if (seen.has(parentId)) continue;
          seen.add(parentId);
          if (projectSet.has(parentId)) {
            owner = parentId;
            break;
          }
          next.push(parentId);
        }
        if (owner !== null) break;
      }
      level = next;
    }
    if (owner === null) ungroupedTasks.push(task.id);
    else byProject.get(owner).push(task.id);
  }
  return {
    groups: projects.map((p) => ({ name: p.title, taskIds: byProject.get(p.id) })),
    ungroupedTasks,
  };
}

async function fetchThoughtProperties(client, thoughtId) {
  const page = await client.get(`/networks/${client.networkId}/thoughts/${thoughtId}/properties`);
  const items = Array.isArray(page.data) ? page.data : [];
  const map = {};
  for (const p of items) {
    const key = p.property_name ?? p.key ?? p.name;
    if (typeof key === 'string') map[key] = p.value;
  }
  return map;
}

/** Найти мысль-версию по номеру (заголовок равен номеру без ведущего `v`). */
async function findVersionByNumber(client, number) {
  const versions = await queryAll(client, { type_ids: [VERSION_TYPE_ID], show_inactive: true });
  // typeIds версии может не быть в контракте — тогда ищем по точному заголовку.
  const byTitle = versions.filter((v) => v.title === number || v.title === `v${number}`);
  if (byTitle.length === 1) return byTitle[0].id;
  const all = await queryAll(client, { keywords: number, show_inactive: true });
  const exact = all.filter((v) => v.title === number || v.title === `v${number}`);
  if (exact.length === 1) return exact[0].id;
  throw new Error(`Не найдена мысль-версия «${number}» (найдено кандидатов: ${exact.length}).`);
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitTags(repo) {
  return git(repo, ['tag', '-l'])
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function gitSubjects(repo, range) {
  return git(repo, ['log', '--format=%s', range])
    .split('\n')
    .map((s) => s.trimEnd())
    .filter((s) => s !== '');
}

// ---------------------------------------------------------------------------
// Сбор метрик одной версии
// ---------------------------------------------------------------------------

/** Разобрать спецификацию версии или диапазона `A..B`. */
function parseSpec(spec) {
  if (spec.includes('..')) {
    const [left, right] = spec.split('..');
    return { kind: 'range', range: spec, left, right, number: right.replace(/^v/, '') };
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(spec)) {
    return { kind: 'id', id: spec };
  }
  return { kind: 'tag', tag: spec.startsWith('v') ? spec : `v${spec}`, number: spec.replace(/^v/, '') };
}

async function collectVersion({ client, repo, spec, noGit, linkPropertyId }) {
  const parsed = parseSpec(spec);

  // 1. Мысль-версия и её свойства (номер, публикация, слой).
  let versionId;
  let number;
  if (parsed.kind === 'id') {
    versionId = parsed.id;
    const t = await client.get(`/networks/${client.networkId}/thoughts/${versionId}`);
    number = t.data?.title ?? versionId;
  } else {
    number = parsed.number;
    versionId = await findVersionByNumber(client, number);
  }
  const thought = (await client.get(`/networks/${client.networkId}/thoughts/${versionId}`)).data;
  const props = await fetchThoughtProperties(client, versionId);
  const duration = versionDuration(thought.created_at, props['Дата публикации'], thought.updated_at);

  // 2. Состав работ и комментарии.
  const works = await fetchVersionWorks(client, linkPropertyId, versionId);
  const commentsById = {};
  for (const w of works) commentsById[w.id] = await fetchComments(client, w.id);

  // 3. Группы по тех.проектам версии (проект — ближайший структурный
  //    родитель-тех.проект задачи; порядок — по дате создания проекта).
  const projectWorks = works.filter((w) => w.type_id === WORK_TYPE_IDS.techProject);
  const projects = [];
  for (const p of projectWorks) {
    const t = await client.get(`/networks/${client.networkId}/thoughts/${p.id}`);
    projects.push({ id: p.id, title: p.title, created_at: t.data?.created_at ?? '' });
  }
  projects.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const assignment = await assignTasksToProjects(client, works, projects);
  const groups = assignment.groups;

  const summary = summariseWorks({ works, commentsById, groups });
  summary.firstPass.ungroupedTasks = assignment.ungroupedTasks.length;

  // 4. Git: диапазон и разбивка коммитов.
  let commits = null;
  let range = null;
  if (!noGit) {
    const tags = gitTags(repo);
    if (parsed.kind === 'range') {
      range = parsed.range;
    } else {
      const tag = parsed.kind === 'tag' ? parsed.tag : `v${number}`;
      const prev = previousTag(tags, tag);
      range = prev === null ? tag : `${prev}..${tag}`;
    }
    commits = summariseCommits(gitSubjects(repo, range));
  }

  return {
    spec,
    number,
    versionId,
    layerId: typeof props['слой'] === 'string' ? props['слой'] : null,
    published: props['Опубликована'] === true,
    publishedDate: props['Дата публикации'] ?? null,
    duration,
    works: summary,
    commits,
    gitRange: range,
  };
}

// ---------------------------------------------------------------------------
// Вывод
// ---------------------------------------------------------------------------

function pct(value) {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

/** Человекочитаемый отчёт по одной версии. */
export function formatReport(r) {
  const lines = [];
  lines.push(`# Метрики версии ${r.number}`);
  lines.push('');
  lines.push(`Мысль-версия: ${r.versionId}${r.layerId !== null ? `, слой ${r.layerId}` : ''}`);
  if (r.duration !== null) {
    lines.push(`Длительность: ${r.duration.days} дн. (${r.duration.from.slice(0, 10)} → ${r.duration.to.slice(0, 10)})`);
  }
  lines.push('');
  lines.push('## Работы');
  lines.push(`Всего: ${r.works.total} (актуальных ${r.works.active}, снято ${r.works.inactive})`);
  lines.push(
    `По типам: ${Object.entries(r.works.byType)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
  );
  lines.push(
    `Ошибок: ${r.works.errors}; пользовательских GUI-находок: ${r.works.userGuiFindings.total}` +
      ` (полировка ${r.works.userGuiFindings.polish}, дефект ${r.works.userGuiFindings.defect})`,
  );
  lines.push(`Повторных делегаций: ${r.works.repeatedDelegations}`);
  lines.push('');
  lines.push('## First-pass (принято с первой сдачи)');
  lines.push(
    `Всего: ${r.works.firstPass.accepted}/${r.works.firstPass.total} = ${pct(r.works.firstPass.ratio)}`,
  );
  for (const g of r.works.firstPass.byGroup) {
    lines.push(`  - ${g.name}: ${g.accepted}/${g.total} = ${pct(g.ratio)}`);
  }
  lines.push('');
  lines.push('## Коммиты');
  if (r.commits === null) {
    lines.push('— (git отключён)');
  } else {
    lines.push(`Диапазон ${r.gitRange}: всего ${r.commits.total}, fix ${r.commits.fix}, feat ${r.commits.feat}` +
      (r.commits.fixToFeat === null ? '' : ` (fix/feat = ${r.commits.fixToFeat})`));
    lines.push(
      `По типам: ${Object.entries(r.commits.byType)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}

/** Сравнение двух версий: таблица метрика → A → B → дельта. */
export function formatComparison(a, b) {
  const row = (label, av, bv, delta) => `  ${label.padEnd(46)} ${String(av).padStart(10)} ${String(bv).padStart(10)}   ${delta}`;
  const num = (v) => (v === null || v === undefined ? '—' : v);
  const lines = [];
  lines.push(`# Сравнение версий ${a.number} → ${b.number}`);
  lines.push(row('метрика', a.number, b.number, 'Δ'));
  lines.push(row('работ всего', num(a.works.total), num(b.works.total), num(b.works.total - a.works.total)));
  lines.push(row('ошибок', num(a.works.errors), num(b.works.errors), num(b.works.errors - a.works.errors)));
  lines.push(
    row('пользовательских находок', num(a.works.userGuiFindings.total), num(b.works.userGuiFindings.total), num(b.works.userGuiFindings.total - a.works.userGuiFindings.total)),
  );
  lines.push(
    row('  — полировка', num(a.works.userGuiFindings.polish), num(b.works.userGuiFindings.polish), num(b.works.userGuiFindings.polish - a.works.userGuiFindings.polish)),
  );
  lines.push(
    row('  — дефект', num(a.works.userGuiFindings.defect), num(b.works.userGuiFindings.defect), num(b.works.userGuiFindings.defect - a.works.userGuiFindings.defect)),
  );
  lines.push(
    row('повторных делегаций', num(a.works.repeatedDelegations), num(b.works.repeatedDelegations), num(b.works.repeatedDelegations - a.works.repeatedDelegations)),
  );
  lines.push(row('first-pass', pct(a.works.firstPass.ratio), pct(b.works.firstPass.ratio), ''));
  if (a.commits !== null && b.commits !== null) {
    lines.push(row('коммитов', num(a.commits.total), num(b.commits.total), num(b.commits.total - a.commits.total)));
    lines.push(row('fix / feat', `${a.commits.fix} / ${a.commits.feat}`, `${b.commits.fix} / ${b.commits.feat}`, ''));
  }
  if (a.duration !== null && b.duration !== null) {
    lines.push(row('длительность, дн.', num(a.duration.days), num(b.duration.days), num(Number((b.duration.days - a.duration.days).toFixed(2)))));
  }
  lines.push('');
  lines.push(`## First-pass по проектам (${a.number} → ${b.number})`);
  const names = new Set([...a.works.firstPass.byGroup.map((g) => g.name), ...b.works.firstPass.byGroup.map((g) => g.name)]);
  for (const name of names) {
    const ga = a.works.firstPass.byGroup.find((g) => g.name === name);
    const gb = b.works.firstPass.byGroup.find((g) => g.name === name);
    lines.push(row(name, ga ? `${ga.accepted}/${ga.total}` : '—', gb ? `${gb.accepted}/${gb.total}` : '—', ''));
  }
  return lines.join('\n');
}

function usage() {
  return [
    'version-metrics — метрики версии ETN по хроникам и git',
    '',
    'Использование:',
    '  node client/scripts/version-metrics.mjs <версия>',
    '  node client/scripts/version-metrics.mjs --compare <A> <B>',
    '',
    '  <версия> — тег (v0.12.1), номер (0.12.1), id мысли-версии или диапазон git',
    '            (v0.11.2..v0.12.1). Для двух версий: --compare A B.',
    '',
    'Опции:',
    '  -v, --version <spec>   версия (можно повторять)',
    '      --compare          сравнить две версии',
    '      --base <url>       адрес REST (иначе ETN_REMOTE_URL / MCP-конфиг)',
    '      --token <key>      ключ (иначе ETN_REMOTE_TOKEN / MCP-конфиг; в код не зашит)',
    '      --config <file>    MCP-конфиг ZCode с сервером etn-remote',
    '      --network <id>     id сети (по умолчанию — ETN)',
    '      --link-property <id>  id свойства «запланировано в версию»',
    '      --repo <dir>       корень git-репозитория (по умолчанию — текущий)',
    '      --json <file>      сохранить машинный отчёт в файл',
    '      --no-git           не считать коммиты (только база)',
    '  -h, --help             эта справка',
  ].join('\n');
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help || opts.specs.length === 0) {
    process.stdout.write(`${usage()}\n`);
    return opts.specs.length === 0 && !opts.help ? 1 : 0;
  }
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const endpoint = resolveEndpoint({
    argv,
    env: process.env,
    readFile: (file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    home: homedir(),
    repoRoot,
  });
  const client = createClient({ apiBase: endpoint.apiBase, token: endpoint.token, networkId: endpoint.networkId });

  const results = [];
  for (const spec of opts.specs.slice(0, opts.compare ? 2 : 1)) {
    results.push(
      await collectVersion({
        client,
        repo: endpoint.repo,
        spec,
        noGit: endpoint.noGit,
        linkPropertyId: endpoint.linkProperty,
      }),
    );
  }

  const text = opts.compare && results.length === 2 ? formatComparison(results[0], results[1]) : formatReport(results[0]);
  process.stdout.write(`${text}\n`);

  if (opts.json !== null) {
    const payload = opts.compare && results.length === 2 ? { compare: results } : results[0];
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(dirname(resolve(opts.json)), { recursive: true });
    writeFileSync(resolve(opts.json), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    process.stdout.write(`\nJSON: ${resolve(opts.json)}\n`);
  }
  return 0;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`Ошибка: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
