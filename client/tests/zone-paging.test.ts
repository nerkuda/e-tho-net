/**
 * Юнит-тесты чистой логики порционной подгрузки секторов карты мыслей
 * (задача c8fa74ba): счётчики, порог догрузки и подпись индикатора. Без DOM —
 * отрисовка и запросы живут в `canvas/canvas.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createZonePaging,
  hasMore,
  isNearBottom,
  planZoneReconcile,
  shouldLoadMore,
  totalKnown,
  zoneCountLabel,
  ZONE_FETCH_THRESHOLD_PX,
  ZONE_PAGE_SIZE,
} from '../src/renderer/lib/zone-paging.js';

describe('zone-paging: счётчики порции', () => {
  it('новые счётчики: количество неизвестно, догружать нечего', () => {
    const c = createZonePaging();
    assert.equal(c.total, -1);
    assert.equal(totalKnown(c), false);
    assert.equal(hasMore(c), false);
  });

  it('количество известно и есть остаток — hasMore true', () => {
    assert.equal(hasMore({ loaded: 50, total: 120, loading: false }), true);
  });

  it('пока идёт запрос, повторно не догружаем', () => {
    assert.equal(hasMore({ loaded: 50, total: 120, loading: true }), false);
  });

  it('всё загружено — hasMore false', () => {
    assert.equal(hasMore({ loaded: 120, total: 120, loading: false }), false);
    assert.equal(hasMore({ loaded: 130, total: 120, loading: false }), false);
  });

  it('размер порции — 50 (дефолт сервера для соседей)', () => {
    assert.equal(ZONE_PAGE_SIZE, 50);
  });
});

describe('zone-paging: близость к нижней границе', () => {
  it('внизу контента — близко', () => {
    assert.equal(isNearBottom({ scrollTop: 800, clientHeight: 200, scrollHeight: 1000 }), true);
  });

  it('в самом низу — близко (остаток 0)', () => {
    assert.equal(isNearBottom({ scrollTop: 900, clientHeight: 100, scrollHeight: 1000 }), true);
  });

  it('вверху длинного списка — не близко', () => {
    assert.equal(
      isNearBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 5000 }),
      false,
    );
  });

  it('порог настраивается', () => {
    const scroll = { scrollTop: 0, clientHeight: 400, scrollHeight: 1000 };
    // остаток 600: не близко при пороге 200, близко при пороге 1000
    assert.equal(isNearBottom(scroll, 200), false);
    assert.equal(isNearBottom(scroll, 1000), true);
    assert.equal(ZONE_FETCH_THRESHOLD_PX, 200);
  });
});

describe('zone-paging: решение о догрузке', () => {
  const bottom = { scrollTop: 800, clientHeight: 200, scrollHeight: 1000 };
  const top = { scrollTop: 0, clientHeight: 200, scrollHeight: 5000 };

  it('остаток есть и мы внизу — догружаем', () => {
    assert.equal(shouldLoadMore({ loaded: 50, total: 300, loading: false }, bottom), true);
  });

  it('всё загружено — не догружаем', () => {
    assert.equal(shouldLoadMore({ loaded: 300, total: 300, loading: false }, bottom), false);
  });

  it('вверху — не догружаем, даже если есть остаток', () => {
    assert.equal(shouldLoadMore({ loaded: 50, total: 300, loading: false }, top), false);
  });

  it('количество неизвестно — не догружаем (ждём total)', () => {
    assert.equal(shouldLoadMore(createZonePaging(), bottom), false);
  });
});

describe('zone-paging: подпись индикатора-числа', () => {
  it('положительное количество — строка с числом', () => {
    assert.equal(zoneCountLabel(1), '1');
    assert.equal(zoneCountLabel(123), '123');
  });

  it('пустой или неизвестный сектор — индикатор скрыт', () => {
    assert.equal(zoneCountLabel(0), null);
    assert.equal(zoneCountLabel(-1), null);
  });
});

describe('zone-paging: сверка со свежим количеством (ошибка ec5ba58c)', () => {
  it('счётчики ещё неизвестны — префикс равен первой порции ответа фокуса', () => {
    const plan = planZoneReconcile(createZonePaging(), 66);
    assert.deepEqual(plan.counters, { loaded: 50, total: 66 });
    assert.equal(plan.grew, false, 'сравнивать не с чем — роста нет');
  });

  it('сектор короче порции — префикс равен количеству, догружать нечего', () => {
    const plan = planZoneReconcile(createZonePaging(), 7);
    assert.deepEqual(plan.counters, { loaded: 7, total: 7 });
    assert.equal(plan.grew, false);
  });

  it('первая порция свежего ответа того же фокуса уже показана — порция не перезапрашивается (31ed1d43)', () => {
    // До правки сектор был пуст (loaded 0, total 0), затем у фокуса появился
    // подчинённый, и свежий ответ фокуса принёс его первой же порцией. Префикс
    // «израсходованного» обязан учесть эту порцию, иначе догрузка запросит
    // страницу с offset = 0 заново и задвоит строку в `zoneAppended` — мысль
    // переживёт удаление связи и останется висеть на карте.
    const plan = planZoneReconcile({ loaded: 0, total: 0, loading: false }, 1, ZONE_PAGE_SIZE, 1);
    assert.deepEqual(plan.counters, { loaded: 1, total: 1 });
    assert.equal(
      hasMore({ ...plan.counters, loading: false }),
      false,
      'первая порция уже показана ответом фокуса — догружать нечего',
    );
  });

  it('первая порция свежего ответа не сжимает уже израсходованный префикс', () => {
    const plan = planZoneReconcile({ loaded: 120, total: 200, loading: false }, 200, ZONE_PAGE_SIZE, 50);
    assert.deepEqual(plan.counters, { loaded: 120, total: 200 });
    assert.equal(plan.grew, false);
  });

  it('рост за первой порцией с учётом показанной порции — догрузка идёт с её конца', () => {
    // Фокус показывал 50 подчинённых; появился 51-й — порция запрашивается с
    // offset 50, а не 0.
    const plan = planZoneReconcile({ loaded: 50, total: 50, loading: false }, 51, ZONE_PAGE_SIZE, 50);
    assert.deepEqual(plan.counters, { loaded: 50, total: 51 });
    assert.equal(plan.grew, true);
    assert.equal(hasMore({ ...plan.counters, loading: false }), true);
  });

  it('своя запись добавила мысль за префиксом — количество выросло, нужна порция', () => {
    // Фокус с 66 подчинёнными показывал первые 50; новая мысль встала в хвост.
    const plan = planZoneReconcile({ loaded: 50, total: 66, loading: false }, 67);
    assert.deepEqual(plan.counters, { loaded: 50, total: 67 });
    assert.equal(plan.grew, true, 'новая мысль за загруженным префиксом');
  });

  it('показанный префикс не теряется при сверке без роста', () => {
    // Пользователь долистал до 120 мыслей; следующая сверка под тем же фокусом
    // не должна «забыть» порции и вернуть сектор к первым 50.
    const plan = planZoneReconcile({ loaded: 120, total: 200, loading: false }, 200);
    assert.deepEqual(plan.counters, { loaded: 120, total: 200 });
    assert.equal(plan.grew, false);
  });

  it('сектор уменьшился — префикс сжимается вместе с ним, индикатор не врёт', () => {
    const plan = planZoneReconcile({ loaded: 100, total: 100, loading: false }, 42);
    assert.deepEqual(plan.counters, { loaded: 42, total: 42 });
    assert.equal(plan.grew, false);
    assert.equal(hasMore({ ...plan.counters, loading: false }), false);
  });

  it('рост с непоказанным префиксом — hasMore подсказывает догрузку', () => {
    const plan = planZoneReconcile({ loaded: 50, total: 66, loading: false }, 67);
    assert.equal(hasMore({ ...plan.counters, loading: false }), true);
    assert.equal(shouldLoadMore({ ...plan.counters, loading: false }, {
      scrollTop: 800,
      clientHeight: 200,
      scrollHeight: 1000,
    }), true);
  });
});
