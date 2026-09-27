/**
 * Диалог даты/периода: полный показ без прокрутки тела (ошибка 214ab5da,
 * задача 7ce662c4, итерация приёмки №5). Пользователь отклонил результат по
 * компоновке: роль размера `s` (потолок высоты 320px) + прокручиваемое тело
 * каркаса обрезали календарную сетку, «С указанием времени», строку значения и
 * кнопки.
 *
 * Что закрепляем:
 *   1. диалог открывается «по содержимому» — каркас получает `fitContent`,
 *      окно помечается `data-dialog-fit="true"`, подложка — `dialog-backdrop-scroll`;
 *   2. тело диалога «по содержимому» НЕ прокручивается (`overflow` не `auto`),
 *      потолок высоты снят — все контролы видны одновременно;
 *   3. корень `dpd` не несёт собственной вертикальной прокрутки;
 *   4. заголовок — дефолтный «Дата/период»: вызывающие его не подменяют.
 *
 * Дом — минимальный DOM-шим (конвенция `chronicle-acceptance-iter5.test.ts`),
 * CSS читается собранным (`tests/renderer-css.js`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import { readRendererCss } from './renderer-css.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(rel: string): string {
  return readFileSync(resolve(RENDERER, ...rel.split('/')), 'utf8');
}

const CSS = readRendererCss();
const DP_DIALOG = read('lib/date-period-dialog.ts');
const DP_SKELETON = read('lib/dialog.ts');
const CHRONICLE_CSS = read('styles/screens/chronicle.css');

/** Минимальный DOM-шим: хватает для сборки диалога и каркаса `showDialog`. */
function installShim(): void {
  (globalThis as any).document = {
    documentElement: new ShimElement('html'),
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body: new ShimElement('body'),
    activeElement: new ShimElement('body'),
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
}

/** Тело блока CSS по селектору (в собранном CSS). */
function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  assert.ok(match !== null, `нет правила ${selector}`);
  return match[1]!;
}

describe('диалог даты/периода: полный показ без прокрутки тела (ошибка 214ab5da)', () => {
  it('каркас: диалог открывается «по содержимому» (fitContent + подложка со скроллом)', async () => {
    installShim();
    const { openDatePeriodDialog } = await import('../src/renderer/lib/date-period-dialog.js');
    // Открываем, не дожидаясь решения: проверяем разметку модального слоя.
    void openDatePeriodDialog({ allowPeriod: true, allowTime: true });

    const body = (globalThis as any).document.body as ShimElement;
    const backdrop = body.children.find((c) => c.classList.contains('dialog-backdrop'));
    assert.ok(backdrop !== undefined, 'диалог открыт');
    const box = backdrop!.querySelector('.dialog-box');
    assert.ok(box !== null, 'есть окно диалога');

    assert.equal(
      box!.dataset['dialogFit'],
      'true',
      'окно диалога помечено «по содержимому» (data-dialog-fit)',
    );
    assert.ok(
      backdrop!.classList.contains('dialog-backdrop-scroll'),
      'переполнение уходит в прокрутку подложки, а не тела диалога',
    );
    const title = backdrop!.querySelector('.dialog-title');
    assert.equal(title?.textContent, 'Дата/период', 'заголовок по умолчанию');
  });

  it('CSS: тело «по содержимому» не прокручивается и не ограничено по высоте', () => {
    const box = cssRule(".dialog-box[data-dialog-fit='true']");
    assert.match(box, /width:\s*fit-content/, 'ширина — по содержимому');
    assert.match(box, /max-height:\s*none/, 'потолок высоты роли снят');
    assert.match(box, /min-width:/, 'нижняя граница ширины (7 колонок календаря)');

    const bodyRule = cssRule(".dialog-box[data-dialog-fit='true'] .dialog-body");
    assert.match(bodyRule, /overflow:\s*visible/, 'тело без прокрутки');
    assert.ok(
      !/overflow(?:-y)?:\s*auto/.test(bodyRule),
      'тело диалога не уходит в собственную прокрутку',
    );

    assert.match(
      cssRule('.dialog-backdrop-scroll'),
      /overflow-y:\s*auto/,
      'прокручивается подложка при переполнении окна',
    );
  });

  it('каркас подключает fitContent к атрибуту окна и классу подложки', () => {
    assert.match(
      DP_SKELETON,
      /opts\.fitContent === true[\s\S]*dataset\['dialogFit'\] = 'true'/,
      'флаг fitContent ставит data-dialog-fit',
    );
    assert.match(
      DP_SKELETON,
      /dialog-backdrop-scroll/,
      'флаг fitContent включает прокрутку подложки',
    );
  });

  it('корень dpd не несёт собственной вертикальной прокрутки', () => {
    const dpd = cssRule('.dpd');
    assert.ok(!/overflow/.test(dpd), 'у .dpd нет overflow — прокручивать нечего');
    assert.ok(
      !/\.dpd\s*\{[^}]*overflow-y:\s*auto/.test(CHRONICLE_CSS),
      'нет правила .dpd { overflow-y: auto }',
    );
  });

  it('заголовок не подменяется: вызывающие не передают title в диалог', () => {
    assert.match(DP_DIALOG, /title: opts\.title \?\? 'Дата\/период'/, 'дефолт каркаса');
    for (const rel of [
      'screens/chronicle/chronicle.ts',
      'editor/chrono-tab.ts',
      'screens/chronicle/filter-panel.ts',
    ]) {
      const src = read(rel);
      const start = src.indexOf('openDatePeriodDialog({');
      assert.ok(start >= 0, `${rel}: диалог открывается`);
      const call = src.slice(start, src.indexOf('});', start));
      assert.ok(!/\btitle:/.test(call), `${rel}: заголовок диалога не переопределяется`);
    }
  });
});
