/**
 * Сторож: производный заголовок вкладки «Дневник» РЕДАКТОРА резолвит ID-формы
 * wiki-ссылок (ошибка 8b647f6c, тот же класс и корень, что 6b4e402a у ленты).
 *
 * Причина. `recordTitle(comment)` (ячейка «Заголовок» таблицы) и `titleLabel()`
 * (заголовок открытой записи) клали в надпись результат `recordDisplayTitle`
 * над СЫРЫМ `body_md` мимо общего резолвера ID-форм
 * (`paintWikiIdsInSnippet`/`resolveWikiIdsInSnippet`, `editor/wiki-link-resolver.ts`),
 * поэтому запись без `title` с телом, начинающимся `[[#<uuid>]]`, показывала
 * сырой код. Правится тем же резолвером, что лента (второй не заводится).
 *
 * Сторож фиксирует ПРОВОДКУ (вкладка под Node не импортируется — тянет
 * Electron-каркас); поведенческий сквозной сценарий — GUI-стенд
 * (`client/scripts/ui-probe.chrono-tab-title-wiki-links.scenario.json`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const CHRONO_TAB = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'chrono-tab.ts'),
  'utf8',
);

/** Тело функции по имени (до закрывающей скобки на нулевом отступе). */
function bodyOf(source: string, signature: string): string {
  const re = new RegExp(`function ${signature}\\([\\s\\S]*?\\n\\}`);
  return re.exec(source)?.[0] ?? '';
}

describe('сторож: резолв ID-форм в заголовке вкладки «Дневник» редактора (8b647f6c)', () => {
  it('chrono-tab.ts подключает общий резолвер сниппетов, а не второй свой', () => {
    assert.match(
      CHRONO_TAB,
      /import\s*\{[^}]*paintWikiIdsInSnippet[^}]*\}\s*from\s*'\.\/wiki-link-resolver\.js'/,
      'синхронный резолвер сниппетов подключён из общего модуля',
    );
    assert.match(
      CHRONO_TAB,
      /import\s*\{[^}]*resolveWikiIdsInSnippet[^}]*\}\s*from\s*'\.\/wiki-link-resolver\.js'/,
      'батч-резолвер сниппетов подключён из общего модуля',
    );
  });

  it('derivedTitleLabel резолвит ID-формы синхронно через paintWikiIdsInSnippet', () => {
    const body = bodyOf(CHRONO_TAB, 'derivedTitleLabel');
    assert.ok(body !== '', 'тело derivedTitleLabel найдено');
    assert.match(
      body.replace(/\/\/[^\n]*/g, ''),
      /paintWikiIdsInSnippet\(/,
      'заголовок проходит через резолвер, а не рисуется сырым',
    );
  });

  it('recordTitle идёт через derivedTitleLabel (не сырой recordDisplayTitle над body_md)', () => {
    const body = bodyOf(CHRONO_TAB, 'recordTitle');
    assert.ok(body !== '', 'тело recordTitle найдено');
    assert.match(body, /derivedTitleLabel\(/, 'надпись ячейки резолвит ID-формы');
    assert.ok(
      !/recordDisplayTitle\(\s*comment\.title\s*,\s*comment\.body_md/.test(CHRONO_TAB),
      'нет сырого пути recordDisplayTitle(comment.title, comment.body_md)',
    );
  });

  it('заголовок открытой записи дорезолвит надпись батчем (resolveWikiIdsInSnippet)', () => {
    const refresh = bodyOf(CHRONO_TAB, 'refreshTitleView');
    assert.ok(refresh !== '', 'тело refreshTitleView найдено');
    assert.match(refresh, /resolveWikiIdsInSnippet\(/, 'батч-дорезолв через общий резолвер');
    const view = bodyOf(CHRONO_TAB, 'showTitleView');
    assert.ok(view !== '', 'тело showTitleView найдено');
    assert.match(
      view.replace(/\/\/[^\n]*/g, ''),
      /refreshTitleView\(\)/,
      'показ заголовка в просмотре запускает дорезолв',
    );
  });

  it('таблица дорезолвит заголовки строк тем же резолвером', () => {
    const body = bodyOf(CHRONO_TAB, 'resolveRowTitles');
    assert.ok(body !== '', 'тело resolveRowTitles найдено');
    assert.match(body, /resolveWikiIdsInSnippet\(/, 'строки таблицы дорезолвят имена батчем');
    assert.match(body, /table\.refresh\(\)/, 'после дорезолва таблица перерисовывается');
  });
});
