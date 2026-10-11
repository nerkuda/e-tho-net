#!/usr/bin/env node
/**
 * fixture-slice — нарезчик минимальных снимков фикстур из бэкапа сети `.etnx`.
 *
 * Зачем. Планка тестов (задача cf236d42) требует, чтобы фикстуры были
 * снимками РЕАЛЬНЫХ данных (реальный markdown комментария, реальный HTML
 * единого рендерера, реальный JSON-ответ API), а не рукодельными мини-сетами.
 * Этот скрипт режет такие снимки из экспорта/бэкапа сети `.etnx` по указанию
 * (id мысли, имя типа мысли, общий префикс комментариев), детерминированно:
 * стабильная сортировка, без дат создания и прочих «плавающих» полей — один
 * и тот же `.etnx` всегда даёт побайтово одинаковые файлы (удобно коммитить
 * и сравнивать диффы).
 *
 * Источник `.etnx` — экспорт сети полигона `etn-dev` (MCP `etn.ops`
 * `export.subgraph`, `format: "etnx"`). Карточка тестовой сети — `a29fd66f`
 * в ETN; процедура восстановления — в её постоянном комментарии.
 *
 * Что пишет на каждую выбранную пару (мысль, комментарий):
 *
 *   * `<base>.md`   — РЕАЛЬНЫЙ markdown постоянного/хроно-комментария
 *                     (`comment.body_md` из манифеста, байт-в-байт).
 *   * `<base>.html` — РЕАЛЬНЫЙ вывод единого рендерера `@etn/markdown`
 *                     (`renderMarkdown(<base>.md)` из сборки пакета).
 *   * `<base>.json` — снимок мысли в форме REST-контракта
 *                     (`{ "data": <Thought> }` — конверт `GET /thoughts/:id`,
 *                     см. `server/src/http/responses.ts`) с вырезанными
 *                     «плавающими» полями ради детерминизма.
 *
 * Зависимостей не добавляет: только node builtins и уже подключённый
 * workspace-пакет `@etn/markdown` (его `dist` — собери `npm run build:shared`
 * или `npm -w @etn/markdown run build`, если `dist` устарел).
 *
 * Использование
 * -------------
 *   node client/scripts/fixture-slice.mjs --etnx .tmp/test1.etnx --list
 *   node client/scripts/fixture-slice.mjs --etnx .tmp/test1.etnx \
 *        --thought <id> [--name my-fixture] [--kind permanent|chronological|all] \
 *        --out client/tests/fixtures/<set>
 *   node client/scripts/fixture-slice.mjs --etnx .tmp/test1.etnx \
 *        --type "ключевой раздел" --limit 5 --out client/tests/fixtures/<set>
 *
 * Опции:
 *   --etnx <path>    путь к архиву `.etnx` (обязателен)
 *   --out <dir>      каталог-приёмник фикстур (обязателен, кроме --list)
 *   --thought <id>   id мысли: брать её комментарии
 *   --type <name>    имя типа мысли (по `thought_types` манифеста)
 *   --kind <kind>    permanent | chronological | all (по умолчанию all)
 *   --limit <n>      ограничить число вырезаемых пар
 *   --name <base>    базовое имя файлов (только с одиночным --thought/--type+--limit=1)
 *   --list           показать кандидатов (для выбора цели), ничего не писать
 *
 * Формат `.etnx`: zip-архив с `manifest.json` в корне и файлами в
 * `attachments/` (`server/src/domain/etnx-format.ts`, §9). Читается встроенным
 * минимальным reader'ом (`node:zlib`) — без внешних zip-пакетов.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { renderMarkdown } from '@etn/markdown';

// ---------------------------------------------------------------------------
// Минимальный zip-reader (только чтение одного нужного entry)
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** Каталог центрального каталога: {entries: [{name, method, csize, lho}], ...}. */
function readZipIndex(buf) {
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('не найден конец zip-архива (EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset >= buf.length) throw new Error('смещение центрального каталога вне архива');
  const entries = [];
  let off = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) throw new Error(`битая запись каталога #${n}`);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    entries.push({ name, method, csize, lho });
    off += 46 + nlen + elen + clen;
  }
  return entries;
}

/** Прочитать содержимое одного entry по имени (Buffer). */
function readZipEntry(buf, entry) {
  if (buf.readUInt32LE(entry.lho) !== LOC_SIG) throw new Error(`битый локальный заголовок ${entry.name}`);
  const nlen = buf.readUInt16LE(entry.lho + 26);
  const elen = buf.readUInt16LE(entry.lho + 28);
  const start = entry.lho + 30 + nlen + elen;
  const raw = buf.subarray(start, start + entry.csize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`неподдерживаемый способ сжатия zip: ${entry.method}`);
}

/** Прочитать `manifest.json` из `.etnx`. */
function readManifest(buf) {
  const entries = readZipIndex(buf);
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  if (!manifestEntry) throw new Error('в архиве нет manifest.json');
  const json = JSON.parse(readZipEntry(buf, manifestEntry).toString('utf8'));
  if (json.format !== 'etnx') throw new Error(`не .etnx-манифест (format=${json.format})`);
  return json;
}

// ---------------------------------------------------------------------------
// Детерминированное представление REST-снимка мысли
// ---------------------------------------------------------------------------

/** «Плавающие» поля, вырезаемые ради детерминизма фикстуры. */
const VOLATILE_KEYS = new Set([
  'created_at',
  'updated_at',
  'created_at_ms',
  'updated_at_ms',
  'created_by',
  'updated_by',
  'version',
  'marked_for_deletion_at',
  'marked_for_deletion_by',
]);

/**
 * Нормализовать запись мысли к форме REST-контракта `GET /thoughts/:id`
 * (`{ data: <Thought> }`): фиксированный порядок ключей, массив синонимов
 * отсортирован, «плавающие» поля вырезаны.
 */
function thoughtSnapshot(thought, synonyms) {
  const known = [
    'id',
    'title',
    'type_id',
    'icon',
    'icon_kind',
    'icon_color',
    'fg_color',
    'bg_color',
    'font_bold',
    'font_italic',
    'font_underline',
    'font_strike',
    'active',
    'is_protected',
    'is_root',
    'marked_for_deletion',
  ];
  const data = {};
  for (const key of known) {
    if (thought[key] !== undefined) data[key] = thought[key];
  }
  data.synonyms = [...synonyms].sort();
  for (const key of Object.keys(thought).sort()) {
    if (known.includes(key) || key === 'synonyms' || VOLATILE_KEYS.has(key)) continue;
    data[key] = thought[key];
  }
  return { data };
}

// ---------------------------------------------------------------------------
// Имена файлов
// ---------------------------------------------------------------------------

/** Транслитерация кириллицы — файлы фикстур остаются ASCII-safe. */
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

function slugify(input) {
  const lower = input.toLowerCase();
  let out = '';
  for (const ch of lower) {
    if (TRANSLIT[ch] !== undefined) out += TRANSLIT[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else out += '-';
  }
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'fixture';
}

// ---------------------------------------------------------------------------
// Разбор аргументов
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { kind: 'all' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const value = argv[++i];
      if (value === undefined) throw new Error(`опция --${key} требует значения`);
      args[key] = value;
    } else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Выбор кандидатов
// ---------------------------------------------------------------------------

/** Оценка «богатства» комментария — для сортировки в --list. */
function richness(md) {
  let s = 0;
  if (/^#/m.test(md)) s += 8;
  if (/\[\[#/.test(md)) s += 4;
  if (/- \[[ x]\]/.test(md)) s += 4;
  if (/==/.test(md)) s += 2;
  if (/<u>/.test(md)) s += 2;
  if (/```/.test(md)) s += 3;
  if (/^\s*\|/m.test(md)) s += 2;
  if (/!\[\[/.test(md)) s -= 1000; // трансклюзии не рендерятся простым renderMarkdown
  return s;
}

function selectComments(manifest, args) {
  const typeNameById = new Map(manifest.thought_types.map((t) => [t.id, t.name]));
  const thoughtById = new Map(manifest.thoughts.map((t) => [t.id, t]));
  const comments = manifest.comments.filter((c) => typeof c.body_md === 'string' && c.body_md.length > 0);

  let selected;
  if (args.thought) {
    const wanted = args.thought;
    const ownerIds = new Set(
      manifest.thoughts.filter((t) => t.id === wanted || t.id.startsWith(wanted)).map((t) => t.id),
    );
    if (ownerIds.size === 0) throw new Error(`мысль «${wanted}» не найдена в манифесте`);
    if (ownerIds.size > 1) throw new Error(`префикс «${wanted}» неоднозначен (${ownerIds.size} мыслей)`);
    selected = comments.filter((c) => ownerIds.has(c.owner_id));
    if (selected.length === 0) throw new Error(`у мысли ${wanted} нет комментариев с текстом`);
  } else if (args.type) {
    const typeIds = new Set(
      manifest.thought_types.filter((t) => t.name === args.type).map((t) => t.id),
    );
    if (typeIds.size === 0) throw new Error(`тип мысли «${args.type}» не найден в манифесте`);
    const ownerIds = new Set(
      manifest.thoughts.filter((t) => typeIds.has(t.type_id)).map((t) => t.id),
    );
    selected = comments.filter((c) => ownerIds.has(c.owner_id));
    if (selected.length === 0) throw new Error(`у мыслей типа «${args.type}» нет комментариев с текстом`);
  } else {
    selected = [...comments];
  }

  if (args.kind && args.kind !== 'all') {
    selected = selected.filter((c) => c.kind === args.kind);
  }

  // Стабильная сортировка: по заголовку мысли, затем по id комментария.
  selected.sort((a, b) => {
    const ta = thoughtById.get(a.owner_id)?.title ?? '';
    const tb = thoughtById.get(b.owner_id)?.title ?? '';
    return ta.localeCompare(tb, 'ru') || a.id.localeCompare(b.id);
  });

  if (args.limit !== undefined) {
    const n = Number(args.limit);
    if (!Number.isInteger(n) || n < 1) throw new Error('--limit должен быть целым >= 1');
    selected = selected.slice(0, n);
  }

  return { selected, thoughtById, typeNameById };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.etnx) throw new Error('нужен --etnx <path>');
  const buf = fs.readFileSync(args.etnx);
  const manifest = readManifest(buf);
  const { selected, thoughtById, typeNameById } = selectComments(manifest, args);

  if (args.list) {
    console.log(`# кандидаты (${selected.length}), отсортированы по богатству для --list-просмотра:`);
    const ranked = selected
      .map((c) => ({ c, score: richness(c.body_md) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.c.id.localeCompare(b.c.id))
      .slice(0, 60);
    for (const { c, score } of ranked) {
      const t = thoughtById.get(c.owner_id);
      const typeName = t && typeNameById.get(t.type_id);
      console.log(
        `  score=${String(score).padStart(3)} ${c.kind.padEnd(12)} len=${String(c.body_md.length).padStart(5)}` +
          ` | ${c.owner_id.slice(0, 8)} | ${(typeName ?? '—').padEnd(18)} | ${t?.title ?? '?'}`,
      );
    }
    return;
  }

  if (!args.out) throw new Error('нужен --out <dir>');
  fs.mkdirSync(args.out, { recursive: true });

  const synonymsById = new Map();
  for (const s of manifest.thought_synonyms ?? []) {
    if (!synonymsById.has(s.thought_id)) synonymsById.set(s.thought_id, []);
    synonymsById.get(s.thought_id).push(s.synonym);
  }

  const single = selected.length === 1;
  const usedNames = new Set();
  let written = 0;
  for (const c of selected) {
    const thought = thoughtById.get(c.owner_id);
    let base;
    if (single && args.name) base = args.name;
    else if (single) base = `${slugify(thought?.title ?? c.owner_id)}-${c.kind}`;
    else base = `${slugify(thought?.title ?? c.owner_id)}-${c.kind}-${c.id.slice(0, 8)}`;
    while (usedNames.has(base)) base += '-x';
    usedNames.add(base);

    const md = c.body_md;
    const html = renderMarkdown(md);
    const json = thoughtSnapshot(thought ?? { id: c.owner_id }, synonymsById.get(c.owner_id) ?? []);

    fs.writeFileSync(path.join(args.out, `${base}.md`), md, 'utf8');
    fs.writeFileSync(path.join(args.out, `${base}.html`), html, 'utf8');
    fs.writeFileSync(path.join(args.out, `${base}.json`), JSON.stringify(json, null, 2) + '\n', 'utf8');
    written++;
    console.log(`  + ${base}.{md,html,json}  (${md.length} символов md)`);
  }
  console.log(`готово: ${written} фикстур в ${args.out}`);
}

try {
  main();
} catch (err) {
  console.error(`fixture-slice: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
