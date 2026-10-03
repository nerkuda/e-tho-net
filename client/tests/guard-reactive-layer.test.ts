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
 * TODO G5 — редактор (комментарии/свойства/упоминания/менеджер свойств/типы).
 * TODO G4 — публикации (карточка).
 * TODO G6 — старый switch и легаси-леера.
 * `lib/lock-cache.ts` — инфраструктура замков, прямой подписчик допустим.
 */
const ON_REALTIME_WHITELIST = new Set<string>([
  // инфраструктура слоя
  'realtime.ts',
  'app.ts',
  'realtime-ui.ts',
  'lib/lock-cache.ts',
  // G4 — публикации
  'editor/publication-card.ts',
  // G5 — редактор
  'editor/editor.ts',
  'editor/comments.ts',
  'editor/properties.ts',
  'editor/mentions-annotate.ts',
  'screens/property-manager.ts',
  'screens/thought-type/views-tab.ts',
  // G6 — легаси-леера
  'screens/layers.ts',
].map((p) => p.replace(/\\/g, '/')));

/** Текущие импортёры локальных каналов — заморожены, новых быть не должно. */
const LOCAL_CHANNEL_IMPORTERS = new Set<string>([
  'lib/publication-events.ts',
  'editor/publication-card.ts',
  'editor/attachments.ts',
  'editor/editor.ts',
  'screens/publications/workspace.ts',
  'screens/publications/publications.ts',
]);

const LOCAL_CHANNEL_IMPORT_PATTERN =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*(?:publication-events|attachment-events)(?:\.js)?['"]/;

describe('guard: реактивный слой данных (269016e2, G1)', () => {
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
