/**
 * Сторож коалесирования realtime-перечитываний (задача `96d7f05d`, ошибка
 * `49e05ea0`).
 *
 * Правило живого слоя: realtime-перечитывания идут ТОЛЬКО через коалесирующий
 * канал реестра. Для этого событие обязано доехать до реестра ПРИЧИНОЙ
 * инвалидации (`invalidateQueries(prefix, evt)`) или до производного эффекта
 * с событием (`scheduleRefresh(evt)` / `invalidateRef(id, true)`), а сами
 * effect-модули не вправе ходить в сеть напрямую — иначе снова появляется
 * запрос на каждое событие.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`; мутация «убрать
 * причину из вызова» делает его красным.
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

const ROUTER = 'lib/live/event-router.ts';
const EFFECTS = 'realtime-effects.ts';

/** Строка комментария — не код: примеры в JSDoc правилом не считаются. */
function isCommentLine(_rel: string, line: string): boolean {
  return /^\s*(?:\*|\/\/|\/\*)/.test(line);
}

describe('guard: realtime-перечитывания коалесируются (96d7f05d)', () => {
  it('роутер передаёт событие причиной инвалидации', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'realtime-invalidation-carries-cause',
        description:
          'Роутер обязан звать invalidateQueries(prefix, evt): без причины реестр ' +
          'не отличит realtime-волну от локальной мутации и не отложит перечитывание ' +
          'в окно (ошибка 49e05ea0).',
        include: (rel) => rel === ROUTER,
        pattern: /invalidateQueries\(\s*prefix\s*\)/,
        allow: isCommentLine,
      },
    ]);
  });

  it('производные эффекты передают событие в перечитывание и помечают realtime-ref', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'realtime-refresh-carries-event',
        description:
          'scheduleRefresh() без причины исполняет фокус-перечитывание по старому ' +
          'локальному пути (дебаунс + микротаска) — волна снова даст запрос на ' +
          'каждое событие. Передавай событие: scheduleRefresh(evt).',
        include: (rel) => rel === EFFECTS,
        pattern: /scheduleRefresh\(\s*\)/,
        allow: isCommentLine,
      },
      {
        name: 'realtime-ref-invalidation-windowed',
        description:
          'Сброс ref-кэша по realtime-событию обязан нести realtime=true: иначе ' +
          'догрузка имён/облачков уйдёт немедленно на каждое событие волны, а не ' +
          'соберётся в окно thoughts.resolve.',
        include: (rel) => rel === EFFECTS,
        pattern: /invalidateRef\(\s*evt\.data\.id\s*\)/,
        allow: isCommentLine,
      },
      {
        name: 'no-direct-network-in-effects',
        description:
          'Производные эффекты и роутер не ходят в сеть сами: перечитывание ' +
          'запускает только реестр по ключу (иначе коалесирование обходится).',
        include: (rel) => rel === EFFECTS || rel === ROUTER,
        pattern: /\betn\./,
        allow: isCommentLine,
      },
    ]);
  });
});
