/**
 * Диалог «Статистика мыслесети» (задача c69b078d, 0.9.1).
 *
 * Проверяются: модель строк таблицы (порядок, подписи, пустые разбивки у
 * онтологии и слоёв), итоговая строка по вложениям и сборка диалога на
 * DOM-шиме — заголовок из словаря, таблица фасада `lib/ui/table` и футер
 * «Закрыть». Числа приходят из подменённого `window.etn.networks.statistics`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { NetworkStats } from '@etn/shared';

import { ShimElement } from './dom-shim.js';
import { readRendererCss } from './renderer-css.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

const FIXTURE: NetworkStats = {
  thought_types: 5,
  link_types: 3,
  properties: 7,
  thoughts: { total: 12, active: 9, inactive: 2, trashed: 1 },
  links: { total: 20, active: 18, inactive: 1, trashed: 1 },
  publications: { total: 6, active: 4, inactive: 1, trashed: 1 },
  shelves: 3,
  layers: 2,
  attachments: { total: 5, files: 2, file_size_bytes: 1536 },
};

function installShim(): void {
  /** Элемент сетки Vaadin в шиме: фасад зовёт методы, которых у ShimElement нет. */
  const gridElement = (): ShimElement => {
    const el = new ShimElement('vaadin-grid') as ShimElement & {
      clearCache?: () => void;
      generateCellPartNames?: () => void;
      scrollToIndex?: (index: number) => void;
      getEventContext?: () => null;
    };
    el.clearCache = () => undefined;
    // Подсветка текущей строки (ошибка 85dea121) — лёгкая перегенерация частей
    // видимых ячеек вместо clearCache; фасад зовёт её на смене текущей строки.
    el.generateCellPartNames = () => undefined;
    el.scrollToIndex = () => undefined;
    el.getEventContext = () => null;
    return el;
  };
  (globalThis as any).document = {
    createElement: (tag: string) => (tag === 'vaadin-grid' ? gridElement() : new ShimElement(tag)),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

installShim();

const { buildStatisticsRows, formatAttachmentsSummary, showNetworkStatisticsDialog } =
  await import('../src/renderer/screens/network-stats.js');
const { store } = await import('../src/renderer/state.js');

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Найти открытый диалог по классу подложки. */
function backdrop(): ShimElement {
  const found = body().children.find((c) => c.classList.contains('dialog-backdrop'));
  assert.ok(found !== undefined, 'диалог смонтирован');
  return found;
}

after(() => {
  body().replaceChildren();
  store.update({ networkId: null });
});

describe('модель строк статистики (c69b078d)', () => {
  it('порядок и подписи строк — по требованиям диалога', () => {
    const rows = buildStatisticsRows(FIXTURE);
    assert.deepEqual(
      rows.map((r) => r.label),
      [
        'Типы мыслей',
        'Типы связей',
        'Свойства мыслей',
        'Мысли',
        'Связи',
        'Публикации',
        'Полки',
        'Слои',
      ],
    );
    assert.deepEqual(
      rows.map((r) => r.key),
      [
        'thought_types',
        'link_types',
        'properties',
        'thoughts',
        'links',
        'publications',
        'shelves',
        'layers',
      ],
    );
  });

  it('разбивка заполнена только у мыслей, связей и публикаций; у онтологии, полок и слоёв — пусто', () => {
    const byKey = new Map(buildStatisticsRows(FIXTURE).map((r) => [r.key, r]));
    for (const key of ['thought_types', 'properties', 'shelves', 'layers']) {
      const row = byKey.get(key)!;
      assert.equal(row.active, null, `${key}: нет разбивки`);
      assert.equal(row.inactive, null);
      assert.equal(row.trashed, null);
    }
    assert.deepEqual(byKey.get('thoughts'), {
      key: 'thoughts',
      label: 'Мысли',
      total: 12,
      active: 9,
      inactive: 2,
      trashed: 1,
    });
    assert.deepEqual(byKey.get('links'), {
      key: 'links',
      label: 'Связи',
      total: 20,
      active: 18,
      inactive: 1,
      trashed: 1,
    });
    assert.deepEqual(byKey.get('publications'), {
      key: 'publications',
      label: 'Публикации',
      total: 6,
      active: 4,
      inactive: 1,
      trashed: 1,
    });
    assert.deepEqual(byKey.get('shelves'), {
      key: 'shelves',
      label: 'Полки',
      total: 3,
      active: null,
      inactive: null,
      trashed: null,
    });
  });

  it('итог по вложениям — «Вложений: N, файлов N, общий размер <размер>»', () => {
    assert.equal(
      formatAttachmentsSummary(FIXTURE),
      'Вложений: 5, файлов 2, общий размер 1,5 КБ',
    );
  });
});

describe('сборка диалога «Статистика мыслесети» (c69b078d)', () => {
  it('рисует заголовок из словаря, таблицу и футер «Закрыть»', async () => {
    let requestedNetwork: string | null = null;
    (globalThis as any).window.etn = {
      networks: {
        statistics: async (id: string): Promise<NetworkStats> => {
          requestedNetwork = id;
          return FIXTURE;
        },
      },
    };
    store.update({ networkId: 'net-1' });

    await showNetworkStatisticsDialog();

    assert.equal(requestedNetwork, 'net-1', 'запрошена статистика открытой сети');
    const dialog = backdrop();
    assert.equal(dialog.querySelector('.dialog-title')?.textContent, 'Статистика мыслесети');
    assert.ok(
      dialog.querySelector('.dialog-box')?.classList.contains('dialog-stats') === true,
      'диалог несёт модификатор ширины dialog-stats (ошибка 8ca000f0)',
    );
    assert.ok(
      dialog.flatText().includes('Вложений: 5, файлов 2, общий размер 1,5 КБ'),
      'итог по вложениям виден в теле диалога',
    );
    assert.ok(
      dialog.findAll('ui-table').length > 0 || dialog.findAll((n) => n.tagName === 'vaadin-grid').length > 0,
      'таблица фасада смонтирована в теле диалога',
    );
    const labels = dialog
      .findAll((n) => n.classList.contains('ui-btn'))
      .map((n) => n.textContent);
    assert.ok(labels.includes('Закрыть'), 'в футере есть «Закрыть»');
  });

  it('ширина формы — 650px токеном, шапка таблицы переносит строки (8ca000f0)', () => {
    // Ширина — тот же `--dialog-w`, что у ролей размера, но от токена; селектор
    // модификатора перебивает правило роли по специфичности.
    assert.match(
      readRendererCss(),
      /\.dialog-box\[data-dialog-size\]\.dialog-stats\s*\{[^}]*--dialog-w:\s*var\(--dialog-w-stats\)/s,
      'ширина диалога статистики не задана модификатором dialog-stats',
    );
    assert.match(
      readFileSync(path.join(RENDERER_ROOT, 'styles', 'tokens.css'), 'utf8'),
      /--dialog-w-stats:\s*650px\s*;/,
      'ширина 650px обязана быть токеном --dialog-w-stats, а не литералом',
    );
    // Длинные заголовки колонок переносятся: шапке таблицы статистики разрешён
    // перенос (иначе nowrap распирает узкие колонки значений, грабли f2a047ee).
    assert.match(
      readFileSync(path.join(RENDERER_ROOT, 'lib', 'ui', 'table.css'), 'utf8'),
      /\.dialog-stats \.ui-table \.ui-table-grid::part\(header-cell\)\s*\{[^}]*white-space:\s*normal/s,
      'шапке таблицы статистики не разрешён перенос строк',
    );
  });

  it('ошибка запроса показывается диалогом ошибки, а не пустой сводкой', async () => {
    body().replaceChildren();
    (globalThis as any).window.etn = {
      networks: {
        statistics: async () => {
          throw new Error('нет связи');
        },
      },
    };
    store.update({ networkId: 'net-1' });

    await showNetworkStatisticsDialog();

    const dialog = backdrop();
    assert.equal(dialog.querySelector('.dialog-title')?.textContent, 'Статистика мыслесети');
    assert.ok(dialog.flatText().includes('нет связи'), 'текст ошибки показан');
  });
});
