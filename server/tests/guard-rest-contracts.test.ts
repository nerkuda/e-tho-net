/**
 * Сторож договорной дисциплины REST-роутов (регрессия вехи 8, релиз 0.8.2):
 * каждое поле, которое хендлер читает из результата `parseRest(...)`,
 * обязано быть объявлено в контракте — в zod-схеме или в REST-карте
 * (`from`/`t`). Контракт, забывший поле, отдаёт хендлеру `undefined`:
 * POST /thoughts/edges из-за пропавшего `network_id` падал 500-м на каждом
 * вызове, и это прошло и typecheck (возврат parseRest пересекается с
 * Record<string, unknown>), и юнит-тесты (роут не был покрыт).
 *
 * Как проверяется: статический обход `server/src/routes/*.ts`. Результат
 * `parseRest` привязывается к переменной (`const input = parseRest(C, req)`
 * или инлайн `parseRest(C, req).field`); слежение за переменной живёт до её
 * следующего присвоения (в т.ч. локальным парсерам тел — их поля не нашего
 * класса) или до конца окна в 200 строк. Объявленность поля сверяется по
 * тексту блока контракта в `server/src/contracts.ts`.
 *
 * Дополнено (0.10.1, итерация приёмки №11, ошибка f45fac74): проверка «поле
 * в zod-схеме ⇒ поле в REST-карте». `parseRest` обходит ТОЛЬКО ключи
 * REST-карты и возвращает `out`, поэтому схемное поле без записи в карте
 * всегда доходит до хендлера как `undefined` — именно так терялся `use_time`
 * при правке комментария (схема его объявляла, карта — нет; старый сторож
 * считал поле объявленным по тексту блока и пропускал дыру).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { contractsByName } from '../src/contracts.js';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const CONTRACTS_TS = path.join(SERVER_SRC, 'contracts.ts');
const ROUTES_DIR = path.join(SERVER_SRC, 'routes');

/** Максимальная дальность привязки «переменная → parseRest» в строках. */
const BIND_WINDOW = 200;

/** Блок исходника одного контракта (от объявления до следующего export const). */
function contractBlocks(source: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const re = /export const (\w+) = defineContract\(/g;
  const starts: Array<{ name: string; idx: number }> = [];
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    starts.push({ name: m[1]!, idx: m.index });
  }
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1]!.idx : source.length;
    blocks.set(starts[i]!.name, source.slice(starts[i]!.idx, end));
  }
  return blocks;
}

/** Ключ объявлен в блоке контракта: `key:` на верхнем уровне схемы или карты. */
function declaresField(block: string, key: string): boolean {
  return new RegExp(`(?:^|[\\s{,])${key}\\s*:`, 'm').test(block);
}

describe('guard: REST-контракты объявляют всё, что читают хендлеры', () => {
  it('поля результата parseRest объявлены в контракте', () => {
    const blocks = contractBlocks(fs.readFileSync(CONTRACTS_TS, 'utf8'));
    assert.ok(blocks.size > 100, `контракты не найдены: ${blocks.size}`);

    const holes: string[] = [];
    const check = (file: string, line: number, contract: string, key: string): void => {
      const block = blocks.get(contract);
      if (block !== undefined && !declaresField(block, key)) {
        holes.push(`${file}:${line} ${contract} → ${key}`);
      }
    };

    for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'))) {
      const lines = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8').split('\n');
      // varName → контракт (null, когда переменная переприсвоена не-parseRest).
      const binding = new Map<string, { contract: string | null; line: number }>();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;

        // Новые привязки: parseRest (простая, деструктуризация) или иная.
        const direct = line.match(/(?:const|let)\s+(\w+)\s*=\s*parseRest\((\w+),/);
        const destructure = line.match(/(?:const|let)\s+\{([^}]+)\}\s*=\s*parseRest\((\w+),/);
        if (direct !== null) {
          binding.set(direct[1]!, { contract: direct[2]!, line: i });
        } else if (destructure !== null) {
          for (const name of destructure[1]!.split(',')) {
            binding.set(name.trim(), { contract: destructure[2]!, line: i });
          }
        } else {
          const other = line.match(/(?:const|let)\s+(\w+)\s*=/);
          if (other !== null) binding.set(other[1]!, { contract: null, line: i });
        }

        // Инлайн-чтение прямо из вызова: parseRest(C, req).field.
        for (const im of line.matchAll(/parseRest\((\w+),[^)]*\)\.(\w+)/g)) {
          check(file, i + 1, im[1]!, im[2]!);
        }

        // Чтение через привязанную переменную.
        for (const [name, b] of binding) {
          if (b.contract === null || i - b.line > BIND_WINDOW) continue;
          for (const rm of line.matchAll(new RegExp(`\\b${name}\\.(\\w+)`, 'g'))) {
            check(file, i + 1, b.contract, rm[1]!);
          }
        }
      }
    }
    assert.deepEqual(
      holes,
      [],
      'хендлер читает поле, которого нет в контракте (упадёт в undefined ' +
        `на рантайме):\n  ${holes.join('\n  ')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Схема ⊄ REST-карта: parseRest читает только карту (ошибка f45fac74)
// ---------------------------------------------------------------------------

/**
 * Контракты, у которых поле zod-схемы намеренно НЕ читается из REST-карты.
 * Каждое исключение обязано быть обосновано и проверяется на актуальность
 * (пока асимметрия есть — исключение живо; исчезла — его надо убрать).
 */
const REST_MAP_EXCEPTIONS: Record<string, string> = {
  'rest:structures.query-body':
    'Поля фильтра (keywords, keyword_scope, parent_ids, type_ids, link_type_ids, ' +
    'link_filter, show_inactive/trashed/…, properties, created_*/updated_*) разбирает ' +
    'не parseRest, а общий shared-парсер parseStructureFilter в роуте (делегат). ' +
    'REST-карта держит только sort/order/paging и REST-only поля (show_trash). ' +
    'Схема объявляет фильтры как z.unknown ради strict-отклонения неизвестных ключей.',
};

/** Схемные поля контракта, отсутствующие в REST-карте (parseRest вернёт undefined). */
function schemaFieldsOutsideRestMap(contract: {
  schema: { shape?: Record<string, unknown> };
  rest: Record<string, unknown>;
}): string[] {
  const shape = contract.schema.shape ?? {};
  const restKeys = new Set(Object.keys(contract.rest));
  return Object.keys(shape).filter((key) => !restKeys.has(key));
}

describe('guard: REST-карта объявляет поля zod-схемы (0.10.1, f45fac74)', () => {
  it('нет схемных полей, которые parseRest молча не читает (кроме исключений)', () => {
    const holes: string[] = [];
    for (const [name, contract] of contractsByName) {
      if (!name.startsWith('rest:')) continue;
      const missing = schemaFieldsOutsideRestMap(contract as never);
      if (missing.length === 0) continue;
      if (name in REST_MAP_EXCEPTIONS) continue;
      holes.push(`${name} → ${missing.join(', ')}`);
    }
    assert.deepEqual(
      holes,
      [],
      'поле объявлено в схеме, но не в REST-карте — parseRest не вернёт его ' +
        `хендлеру (undefined):\n  ${holes.join('\n  ')}`,
    );
  });

  it('исключения актуальны: контракт существует и всё ещё асимметричен', () => {
    for (const [name, reason] of Object.entries(REST_MAP_EXCEPTIONS)) {
      const contract = contractsByName.get(name);
      assert.ok(contract !== undefined, `исключение «${name}» ссылается на несуществующий контракт`);
      assert.ok(reason.trim().length > 0, `у исключения «${name}» нет причины`);
      const missing = schemaFieldsOutsideRestMap(contract as never);
      assert.ok(
        missing.length > 0,
        `исключение «${name}» устарело: асимметрии больше нет — убери его из списка`,
      );
    }
  });

  it('rest:comments.update читает use_time (ошибка f45fac74)', () => {
    const contract = contractsByName.get('rest:comments.update');
    assert.ok(contract !== undefined, 'контракт rest:comments.update существует');
    assert.ok(
      'use_time' in (contract!.rest as Record<string, unknown>),
      'use_time объявлен в REST-карте — PATCH доводит флаг до домена',
    );
  });
});
