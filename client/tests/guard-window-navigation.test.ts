/**
 * Сторож правила «ОКНО ETN НИКОГДА НЕ УВОДИТСЯ» (ошибка 37458cbc, круг 2).
 *
 * Зачем. Просмотр показывает пользовательский markdown со ссылками любой формы —
 * абсолютными `http(s)`, protocol-relative (`//example.com/x`), относительными
 * (`relative.html`), с экзотическими схемами. Клик по такой ссылке без гейта
 * уводил окно со страницы приложения на чужой сайт или на
 * `chrome-error://chromewebdata/`. Правило «окно не уводится» защищено СИСТЕМНО:
 * главный процесс отклоняет top-frame навигацию всем, кроме собственной
 * страницы приложения (`webContents.on('will-navigate')` +
 * `main/navigation-policy.ts`), а внешние `http`/`https`/`mailto` уходят в
 * системный браузер (как и `setWindowOpenHandler`).
 *
 * Сторож краснеет, если: политика разрешит навигацию на чужой адрес или на
 * схему вне http(s)/mailto (в т.ч. вернёт её как внешнюю), либо из главного
 * процесса исчезнет сама обвязка `will-navigate` + `decideNavigation`.
 *
 * Чистая логика — без Electron; входит в обычный `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { decideNavigation, EXTERNAL_SCHEMES } from '../src/main/navigation-policy.js';

const CLIENT_ROOT = resolve(import.meta.dirname, '..');

/** Страница приложения: prod-сборка (файл) и dev-сервер (origin). */
const APP_FILE = 'file:///C:/R/ETN/client/out/renderer/index.html';
const APP_DEV = 'http://localhost:5173/index.html';

describe('политика навигации окна: своё приложение можно, остальное — нет (37458cbc)', () => {
  it('страница самого приложения — разрешена (файл prod и origin dev)', () => {
    assert.deepEqual(decideNavigation(APP_FILE, APP_FILE), { allow: true, external: null });
    assert.deepEqual(decideNavigation(APP_DEV, APP_DEV), { allow: true, external: null });
    // Хеш-переход внутри документа (якоря публикации) — та же страница.
    assert.deepEqual(decideNavigation(`${APP_FILE}#pub-1`, APP_FILE), {
      allow: true,
      external: null,
    });
  });

  it('protocol-relative, относительный и ошибка навигации — отказ БЕЗ внешнего открытия', () => {
    // Electron резолвит `//example.com/x` относительно file://-страницы в
    // `file://example.com/x`; относительный адрес — в соседний файл; ошибка
    // навигации Chromium приходит как `chrome-error://`.
    for (const target of [
      'file://example.com/x',
      'file:///C:/R/ETN/client/out/renderer/relative-target.html',
      'chrome-error://chromewebdata/',
      'about:blank',
    ]) {
      assert.deepEqual(
        decideNavigation(target, APP_FILE),
        { allow: false, external: null },
        target,
      );
    }
  });

  it('схемы вне http(s)/mailto НИКОГДА не уходят в системный браузер', () => {
    // Ни `allow`, ни `external` — иначе `shell.openExternal` получил бы
    // `javascript:`/`data:`/`file:`/`etnimg:`/`etn:` из навигации.
    for (const target of [
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'file:///C:/Windows/System32/calc.exe',
      'etnimg://c/pics/a.png',
      'etn://open?thought=1',
      'vbscript:msgbox(1)',
      'blob:file:///abc',
    ]) {
      assert.deepEqual(
        decideNavigation(target, APP_FILE),
        { allow: false, external: null },
        target,
      );
    }
  });

  it('внешние http(s)/mailto — окно НЕ навигируется, адрес идёт в браузер', () => {
    assert.deepEqual(decideNavigation('https://example.com/a?x=1', APP_FILE), {
      allow: false,
      external: 'https://example.com/a?x=1',
    });
    assert.deepEqual(decideNavigation('http://example.com/', APP_FILE), {
      allow: false,
      external: 'http://example.com/',
    });
    assert.deepEqual(decideNavigation('mailto:a@b.c', APP_FILE), {
      allow: false,
      external: 'mailto:a@b.c',
    });
    // В dev-page protocol-relative резолвится в http на ЧУЖОЙ origin: окно не
    // уводится, адрес открывается системным браузером.
    assert.deepEqual(decideNavigation('http://example.com/x', APP_DEV), {
      allow: false,
      external: 'http://example.com/x',
    });
  });

  it('мусор и враждебные адреса — отказ (fail-closed)', () => {
    assert.deepEqual(decideNavigation('не url', APP_FILE), { allow: false, external: null });
    assert.deepEqual(decideNavigation('//example.com/x', APP_FILE), {
      allow: false,
      external: null,
    });
  });

  it('главный процесс ОБЯЗАН держать гейт will-navigate с этой политикой', () => {
    const main = readFileSync(resolve(CLIENT_ROOT, 'src', 'main', 'index.ts'), 'utf8');
    assert.match(
      main,
      /webContents\.on\('will-navigate'/,
      'в главном процессе нет обвязки will-navigate — окно снова может уйти со страницы приложения',
    );
    assert.match(
      main,
      /decideNavigation\(url, win\.webContents\.getURL\(\)\)/,
      'will-navigate обязан решать по политике navigation-policy.ts',
    );
    assert.match(main, /event\.preventDefault\(\)/, 'навигацию окна надо гасить');
  });

  it('набор внешних схем ОДИН на оба гейта: политика и setWindowOpenHandler', () => {
    // Раньше оба места сравнивали схемы своими литералами, и добавление схемы
    // в одно место (например `tel` в setWindowOpenHandler) не краснило НИ ОДИН
    // тест. Теперь источник один — `EXTERNAL_SCHEMES` из политики; сторож
    // проверяет и содержимое набора, и отсутствие дублирующих литералов.
    const main = readFileSync(resolve(CLIENT_ROOT, 'src', 'main', 'index.ts'), 'utf8');
    assert.match(
      main,
      /import \{[^}]*EXTERNAL_SCHEMES[^}]*\} from '\.\/navigation-policy\.js'/,
      'обвязка нового окна обязана брать набор схем из политики, а не из литералов',
    );
    assert.match(
      main,
      /EXTERNAL_SCHEMES\.has\(scheme\)/,
      'setWindowOpenHandler обязан решать по общему набору EXTERNAL_SCHEMES',
    );
    for (const literal of [/scheme === 'tel'/, /scheme === 'ftp'/, /scheme === 'file'/]) {
      assert.doesNotMatch(
        main,
        literal,
        `схемы сравниваются литералом (${String(literal)}) в обход общего набора`,
      );
    }
    // Содержимое набора: ровно http/https/mailto.
    assert.deepEqual([...EXTERNAL_SCHEMES].sort(), ['http', 'https', 'mailto']);
  });
});
