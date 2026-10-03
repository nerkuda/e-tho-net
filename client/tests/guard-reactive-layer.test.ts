/**
 * Сторож реактивного слоя данных (этап G1 техпроекта `269016e2`).
 *
 * Два правила техпроекта, защищающие слой от эрозии:
 *
 * 1. **Прямые подписки `onRealtimeEvent` запрещены вне whitelist.** Все чужие
 *    события обязаны идти через роутер слоя (`lib/live/event-router.ts`) и
 *    реестр запросов, а не мимо — иначе экран снова заводит собственную логику
 *    «затрагивает ли меня событие». Whitelist замораживает текущий набор
 *    легаси-подписчиков: они снимаются по мере миграции экранов (G2–G6),
 *    каждый помечен этапом ниже. Новый файл с подпиской — красный сторож.
 *
 * 2. **Локальные каналы обновления закрыты для новых импортов.**
 *    `lib/publication-events.ts` и `lib/attachment-events.ts` — временные
 *    механизмы эпохи эхо-подавления; G4 техпроекта сносит их. Новые импорты
 *    этих модулей запрещены: данные идут через mutator-слой
 *    (`commitEntity`/`putMutationResult`).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { REALTIME_EVENT_TYPES } from '@etn/shared';

import { IGNORED_REALTIME_EVENT_TYPES, realtimeRoutes } from '../src/renderer/lib/live/index.js';
import { assertGuardClean } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/**
 * Легаси-подписчики `onRealtimeEvent`, замороженные до миграции.
 *
 * TODO G6 — старый switch (`realtime-ui.ts`), легаси-леера (`layers.ts`) и мост
 * `app.ts` (регистрация `applyRealtimeToUi`).
 * `lib/lock-cache.ts` — инфраструктура замков, прямой подписчик допустим.
 *
 * G4 (публикации) снят с whitelist: карточка публикации читает живые данные
 * через слой (`lib/live`).
 *
 * G5 (редактор/индикаторы/пины/wiki) снят: `editor/editor.ts`,
 * `editor/comments.ts`, `editor/properties.ts`, `editor/mentions-annotate.ts`,
 * `screens/property-manager.ts`, `screens/thought-type/views-tab.ts` читают
 * живые данные через слой (подписка на инвалидации ключей, причина — событие).
 */
const ON_REALTIME_WHITELIST = new Set<string>([
  // инфраструктура слоя
  'realtime.ts',
  'lib/lock-cache.ts',
  // G6 — легаси-мост, switch и легаси-леера
  'app.ts',
  'realtime-ui.ts',
  'screens/layers.ts',
].map((p) => p.replace(/\\/g, '/')));

/**
 * Импортёры локальных каналов обновления. Оба модуля
 * (`lib/publication-events.ts`, `lib/attachment-events.ts`) СНЕСЕНЫ на G4 —
 * набор пуст: любой импорт по этому шаблону теперь красный (файлов нет).
 */
const LOCAL_CHANNEL_IMPORTERS = new Set<string>([]);

const LOCAL_CHANNEL_IMPORT_PATTERN =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*(?:publication-events|attachment-events)(?:\.js)?['"]/;

describe('guard: реактивный слой данных (269016e2, G1)', () => {
  it('таблица маршрутов полна: каждый тип либо в таблице, либо в ignore-списке', () => {
    // Замечание 4 верификатора: типы, не влияющие на кэш слоя, обязаны быть
    // перечислены ЯВНО (IGNORED_REALTIME_EVENT_TYPES), а не выпадать из таблицы
    // молча. Новый тип в REALTIME_EVENT_TYPES заставит осознанно отнести его
    // к маршрутам или к игнорируемым.
    const ignored = new Set<string>(IGNORED_REALTIME_EVENT_TYPES);
    const missing = REALTIME_EVENT_TYPES.filter(
      (type) => realtimeRoutes[type] === undefined && !ignored.has(type),
    );
    if (missing.length > 0) {
      throw new Error(
        `Типы realtime-событий без маршрута и без ignore-списка (${missing.length}):\n` +
          missing.map((t) => `  • ${t}`).join('\n') +
          '\nДобавь маршрут в realtimeRoutes или запись в IGNORED_REALTIME_EVENT_TYPES (event-router.ts).',
      );
    }
    // Обратная сторона: игнорируемый тип не должен одновременно иметь маршрут.
    const both = IGNORED_REALTIME_EVENT_TYPES.filter((type) => realtimeRoutes[type] !== undefined);
    if (both.length > 0) {
      throw new Error(
        `Типы одновременно и в таблице, и в ignore-списке: ${both.join(', ')}`,
      );
    }
  });

  it('прямые подписки onRealtimeEvent только у замороженного whitelist', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-direct-onrealtimeevent',
        description:
          'Экраны и модули читают живые данные через слой lib/live (роутер событий + ' +
          'реестр запросов), а не подписываются на onRealtimeEvent напрямую. ' +
          'Whitelist — легаси-подписчики до миграции G2–G6; новый файл надо ' +
          'перевести на queryStore/мутатор слоя.',
        pattern: /\bonRealtimeEvent\s*\(/,
        allow: (rel) => ON_REALTIME_WHITELIST.has(rel),
      },
    ]);
  });

  it('мигрированные модули G2/G3/G4 не подписываются на realtime напрямую', () => {
    // холст и «Структуры» переведены на слой (G2), лента «Дневника» — на слой
    // (G3), публикации (библиотека, рабочая область, карточка) — на слой (G4):
    // данные и перерисовку ведут реестр запросов и роутер, а не прямой
    // `onRealtimeEvent`. `properties.ts` остаётся в whitelist до G5 — у него
    // легаси-хук открытого редактора.
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'g2-g3-g4-migrated-no-direct-subscription',
        description:
          'canvas, «Структуры» (G2 65286909), «Дневник» (G3 40fa8118) и публикации ' +
          '(G4 461bb279: publications.ts, workspace.ts, editor/publication-card.ts) ' +
          'читают живые данные через слой: прямых подписок onRealtimeEvent быть ' +
          'не должно.',
        pattern: /\bonRealtimeEvent\s*\(/,
        include: (rel) =>
          /(?:^|\/)canvas\/canvas\.ts$/.test(rel) ||
          /(?:^|\/)screens\/structures\/structures\.ts$/.test(rel) ||
          /(?:^|\/)screens\/chronicle\/chronicle\.ts$/.test(rel) ||
          /(?:^|\/)screens\/publications\/publications\.ts$/.test(rel) ||
          /(?:^|\/)screens\/publications\/workspace\.ts$/.test(rel) ||
          /(?:^|\/)editor\/publication-card\.ts$/.test(rel),
        allow: () => false,
      },
    ]);
  });

  it('G5-мигрированные модули не подписываются на realtime напрямую', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'g5-migrated-no-direct-realtime',
        description:
          'Редактор (editor.ts, comments.ts, properties.ts, mentions-annotate.ts), ' +
          'менеджер свойств и вкладка отборов читают живые данные через слой ' +
          '(подписка на инвалидации ключей, причина — событие), не через ' +
          'onRealtimeEvent. G5 задачи 8a039ea3.',
        pattern: /\bonRealtimeEvent\s*\(/,
        include: (rel) =>
          /(?:^|\/)editor\/editor\.ts$/.test(rel) ||
          /(?:^|\/)editor\/comments\.ts$/.test(rel) ||
          /(?:^|\/)editor\/properties\.ts$/.test(rel) ||
          /(?:^|\/)editor\/mentions-annotate\.ts$/.test(rel) ||
          /(?:^|\/)screens\/property-manager\.ts$/.test(rel) ||
          /(?:^|\/)screens\/thought-type\/views-tab\.ts$/.test(rel),
        allow: () => false,
      },
      {
        name: 'no-direct-realtime-onEvent',
        description:
          'Низкоуровневая подписка `etn.realtime.onEvent` запрещена вне моста ' +
          'realtime.ts: события проходят через роутер слоя (event-router), а ' +
          'экраны читают данные ключей. G5 задачи 8a039ea3.',
        pattern: /etn\.realtime\.onEvent\s*\(/,
        allow: (rel) => rel === 'realtime.ts',
      },
    ]);
  });

  it('локальные каналы обновления не получают новых импортов', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-new-local-channel-imports',
        description:
          'Импорт lib/publication-events и lib/attachment-events закрыт: их сносит G4 ' +
          'техпроекта 269016e2. Данные мутаций идут через mutator-слой ' +
          '(commitEntity / putMutationResult), чужие события — через роутер.',
        filePattern: LOCAL_CHANNEL_IMPORT_PATTERN,
        allow: (rel) => LOCAL_CHANNEL_IMPORTERS.has(rel),
      },
    ]);
  });
});
