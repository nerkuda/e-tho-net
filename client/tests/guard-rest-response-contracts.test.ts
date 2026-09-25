/**
 * Сторож форм ОТВЕТОВ `RestClient` (задача 120385ba, версия 0.8.2;
 * дополняет серверный `server/tests/guard-rest-contracts.test.ts` из
 * коммита 217e5db, который следит за ВХОДОМ).
 *
 * Нормативное правило — стандарт мыслесети ETN `01268f2d` «Клиент: тип ответа
 * RestClient — именованный общий контракт @etn/shared» (0.8.3, задача 0284c89e):
 * формулировка стандарта и две проверки ниже обязаны совпадать.
 *
 * Прецедент — ошибка c83f0215 (коммит d548888): клиент объявлял ответ
 * `PATCH /properties/{id}` как конверт `{ property, converted, dropped }`,
 * а сервер отдавал ПЛОСКИЙ `{ ...property, converted, dropped }`. Обе стороны
 * компилировались (у каждой был свой inline-тип), рассинхрон всплыл только на
 * новых операциях. Класс лечится контракт-центрично: составные формы ответа
 * объявлены один раз в `@etn/shared` (`shared/src/types/rest.ts`), сервер
 * собирает payload с `satisfies <общий тип>` (компилятор ловит расхождение),
 * клиент читает тот же тип.
 *
 * Сторож закрывает оставшуюся лазейку — inline-тип в `rest-client.ts`:
 *
 *  1. Ответ публичного метода `RestClient` не может быть inline-формой
 *     (объектным литералом в типе возврата) — он обязан быть именованным типом
 *     из `@etn/shared`. Исключение — три метода сырого транспорта (байты, не
 *     JSON-контракт), перечисленные явно ниже. Краснеет на умышленном
 *     рассинхроне: вернуть ответ к inline-форме — тест падает.
 *  2. Каждый общий тип, которым типизирован ответ, должен использоваться и на
 *     сервере (`server/src/**`) — иначе «общий» тип на деле односторонний и
 *     снова может разойтись.
 *
 * Проверка статическая: разбор исходников без запуска сервера.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CLIENT_TEST_DIR, '..', '..');
const REST_CLIENT_TS = path.join(REPO_ROOT, 'client', 'src', 'main', 'net', 'rest-client.ts');
const SHARED_TS_DIR = path.join(REPO_ROOT, 'shared', 'src');
const SERVER_TS_DIR = path.join(REPO_ROOT, 'server', 'src');

/**
 * Методы сырого транспорта: ответ — байты файла/архива, а не JSON-контракт,
 * поэтому собственный inline-тип здесь уместен (имя поля — обёртка содержимого,
 * а не форма сущности сервера).
 */
const RAW_TRANSPORT_METHODS = new Set(['getAttachmentRaw', 'downloadJob', 'downloadServerLogFile']);

/**
 * Формы, которые клиент СОБИРАЕТ сам из success-конверта (`data` + `meta`) —
 * у сервера нет такого одного объекта, поэтому имени на сервере и не будет.
 * Сущности внутри них (`AuditLogEntry`, `ThoughtTypeView`, `ThoughtRef`) —
 * общие типы из `@etn/shared`, они проходят первую проверку и типизируются на
 * сервере. Список закрытый: новый односторонний тип сюда не попадёт молча.
 */
const CLIENT_COMPOSED_RESULTS = new Set([
  'AuditListResult',
  'ThoughtTypeViewsResult',
  'RunThoughtTypeViewResult',
  // Форма порции соседей (задача c8fa74ba): сервер отдаёт страницу через
  // `sendList` (`data` + `meta{total,limit,offset}`), клиент сводит их в одну
  // форму `NeighborPage`; единого серверного объекта с таким именем нет.
  'NeighborPage',
]);

/** Собрать все `.ts` под каталогом (рекурсивно). */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Имена, экспортируемые `@etn/shared` (интерфейсы/типы/константы). */
function sharedTypeNames(): Set<string> {
  const names = new Set<string>();
  const re = /export (?:interface|type|const|class|function) (\w+)/g;
  for (const file of collectTsFiles(SHARED_TS_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    for (let m = re.exec(src); m !== null; m = re.exec(src)) names.add(m[1]!);
  }
  return names;
}

/** Публичные методы `RestClient` с текстом типа возврата. */
function publicResponseTypes(source: string): Array<{ name: string; ret: string; line: number }> {
  const lines = source.split('\n');
  const re = /^\s*public (?:async )?(\w+)/;
  const out: Array<{ name: string; ret: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(re);
    if (m === null) continue;
    const buf: string[] = [];
    for (let j = i; j < lines.length && j - i <= 30; j++) {
      buf.push(lines[j]!);
      const all = buf.join('\n');
      const idx = all.indexOf('Promise<');
      if (idx === -1) continue;
      // Открывающая `<` уже пройдена — глубина начинается с 1.
      let depth = 1;
      let end = -1;
      for (let k = idx + 'Promise<'.length; k < all.length; k++) {
        const c = all[k];
        if (c === '<') depth++;
        else if (c === '>') {
          depth--;
          if (depth === 0) {
            end = k;
            break;
          }
        }
      }
      if (end !== -1) {
        out.push({ name: m[1]!, ret: all.slice(idx + 'Promise<'.length, end), line: i + 1 });
        i = j;
        break;
      }
    }
  }
  return out;
}

describe('guard: формы ответов RestClient — общие контракты @etn/shared', () => {
  it('ответы типизированы именованными общими типами, не inline-формами', () => {
    const methods = publicResponseTypes(fs.readFileSync(REST_CLIENT_TS, 'utf8'));
    assert.ok(methods.length > 100, `методы RestClient не найдены: ${methods.length}`);

    const inline = methods
      .filter((m) => m.ret.includes('{') && !RAW_TRANSPORT_METHODS.has(m.name))
      .map((m) => `rest-client.ts:${m.line} ${m.name} — ${m.ret.replace(/\s+/g, ' ')}`);

    assert.deepEqual(
      inline,
      [],
      'ответ описан inline-объектом в типе возврата — вынесите форму в ' +
        '`shared/src/types/rest.ts` и используйте на обеих сторонах ' +
        `(ошибка c83f0215):\n  ${inline.join('\n  ')}`,
    );
  });

  it('общие типы ответов используются и на сервере', () => {
    const shared = sharedTypeNames();
    const serverSrc = collectTsFiles(SERVER_TS_DIR)
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n');

    const referenced = new Set<string>();
    for (const m of publicResponseTypes(fs.readFileSync(REST_CLIENT_TS, 'utf8'))) {
      for (const id of m.ret.matchAll(/[A-Za-z_$][\w$]*/g)) {
        if (shared.has(id[0])) referenced.add(id[0]);
      }
    }

    const clientOnly = [...referenced]
      .filter((name) => !serverSrc.includes(name) && !CLIENT_COMPOSED_RESULTS.has(name))
      .sort();
    assert.ok(referenced.size > 20, `общих типов в ответах не найдено: ${referenced.size}`);
    assert.deepEqual(
      clientOnly,
      [],
      'тип ответа RestClient объявлен в @etn/shared, но сервер его не ' +
        'использует — форма не общая, рассинхрон снова возможен. ' +
        `Привяжите серверный payload через \`satisfies\`:\n  ${clientOnly.join('\n  ')}`,
    );
  });
});
