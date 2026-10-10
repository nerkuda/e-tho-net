/**
 * Диалог выбора иконки восстанавливает текущий выбор (ошибка e2407f6d).
 *
 * Проверяется:
 *   1. Активная вкладка при открытии — по виду текущей иконки: `icon` →
 *      «Библиотека», `emoji` → «Эмодзи», `image` (URL) → «URL».
 *   2. Эмодзи: категория текущего глифа развёрнута, сам глиф помечен
 *      `emoji-cell-current` (иначе выбор скрыт в свёрнутой группе).
 *   3. Библиотека: текущий значок помечен `icon-library-cell-current`; источник
 *      объявляет корректный выбор, и нижняя «Применить» активна — смена только
 *      цвета не требует повторного поиска; `apply` отдаёт текущий значок с
 *      выбранным цветом.
 *   4. Вложение-картинка (ошибка 846c426a): вид `image` с `icon_attachment_id`
 *      открывает вкладку «Вложения» общего компонента выбора вложения (задача
 *      0f6c3e39), текущее показано выбранным (`att-pick-preview-current`),
 *      «Применить» активна, а применение без изменений отдаёт тот же
 *      `attachmentId` (повторная загрузка не нужна).
 *   5. Картинка ТИПА мысли (ошибка 844c426a): вид `image` с самодостаточным
 *      `data:`-превью (без вложения) тоже открывает «Вложения» с показанным
 *      выбранным превью и активной «Применить»; применение сохраняет превью.
 *
 * jsdom в проекте нет — минимальный DOM-шим (конвенция `resource-picker.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

function installShim(): void {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
    activeElement: body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    etn: {},
    setTimeout: (fn: () => void, ms?: number) => (globalThis as any).setTimeout(fn, ms),
    clearTimeout: (handle: any) => (globalThis as any).clearTimeout(handle),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

installShim();

const { showIconDialog } = await import('../src/renderer/editor/icon-dialog.js');
const { libraryIconSourceTab } = await import('../src/renderer/editor/resource-picker.js');
const { attachmentPickerSourceTab } = await import(
  '../src/renderer/editor/attachment-picker.js'
);
const { loadIconCatalog } = await import('../src/renderer/lib/ui/icon.js');
const { t } = await import('../src/renderer/lib/i18n.js');

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Последний открытый диалог (диалоги стопкой — верхний в конце). */
function lastBox(): ShimElement {
  const backdrops = body().children.filter((c) => c.classList.contains('dialog-backdrop'));
  const backdrop = backdrops[backdrops.length - 1];
  assert.ok(backdrop !== undefined, 'диалог открыт');
  const box = backdrop.querySelector('.dialog-box');
  assert.ok(box !== null, 'в диалоге есть тело');
  return box as ShimElement;
}

/** Подпись активной вкладки диалога. */
function activeTabLabel(): string {
  const btn = lastBox()
    .querySelectorAll('.ui-tab')
    .find((b) => b.classList.contains('active'));
  assert.ok(btn !== undefined, 'в диалоге есть активная вкладка');
  return (btn as unknown as ShimElement).textContent ?? '';
}

/** Все потомки с данным тегом (шим понимает простые селекторы). */
function findByTag(root: ShimElement, tag: string): ShimElement[] {
  const wanted = tag.toUpperCase();
  const hits: ShimElement[] = [];
  const walk = (node: ShimElement): void => {
    for (const child of node.children) {
      if ((child.tagName ?? '').toUpperCase() === wanted) hits.push(child);
      walk(child);
    }
  };
  walk(root);
  return hits;
}

/** Кнопка футера по подписи. */
function footerBtn(label: string): ShimElement {
  const footer = lastBox().querySelector('.dialog-footer');
  assert.ok(footer !== null, 'футер диалога построен');
  const btn = findByTag(footer as ShimElement, 'BUTTON').find((b) => b.textContent === label);
  assert.ok(btn !== undefined, `кнопка «${label}» в футере`);
  return btn;
}

function isDisabled(node: ShimElement): boolean {
  return (node as unknown as { disabled?: boolean }).disabled === true;
}

/** Открывает диалог иконки с данным текущим выбором. */
function open(current: {
  icon: string | null;
  kind: 'emoji' | 'icon' | 'image';
  color: string | null;
  attachmentId?: string | null;
}): void {
  showIconDialog({ current, onPick: () => Promise.resolve(true) });
}

describe('диалог иконки: активная вкладка по виду иконки (e2407f6d)', () => {
  beforeEach(() => installShim());

  it('вид «icon» открывает вкладку «Библиотека»', () => {
    open({ icon: 'star', kind: 'icon', color: '#ff0000' });
    assert.equal(activeTabLabel(), t('icons.library.tab'));
    assert.equal(activeTabLabel(), 'Библиотека');
  });

  it('вид «emoji» открывает вкладку «Эмодзи»', () => {
    open({ icon: '😀', kind: 'emoji', color: null });
    assert.equal(activeTabLabel(), 'Эмодзи');
  });

  it('вид «image» с URL открывает вкладку «URL» и подставляет адрес', () => {
    open({ icon: 'https://example.test/pic.png', kind: 'image', color: null });
    assert.equal(activeTabLabel(), 'URL');
    const input = findByTag(lastBox(), 'INPUT').find((el) => (el as any).type === 'text');
    assert.ok(input !== undefined, 'поле URL построено');
    assert.equal(input!.value, 'https://example.test/pic.png', 'текущий адрес подставлен');
  });
});

describe('диалог иконки: текущий эмодзи отмечен и его группа раскрыта (e2407f6d)', () => {
  beforeEach(() => installShim());

  it('глиф из НЕ первой категории разворачивает свою группу и выделяется', async () => {
    // 🚀 — категория «Путешествия и места» (не первая, по умолчанию свёрнута).
    open({ icon: '🚀', kind: 'emoji', color: null });
    // Тело группы монтируется асинхронно (collapsibleSection) — даём микрозадаче пройти.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const marked = lastBox()
      .querySelectorAll('.emoji-cell-current')
      .map((el) => (el as unknown as ShimElement).textContent);
    assert.deepEqual(marked, ['🚀'], 'текущий глиф помечен и построен (группа раскрыта)');
  });
});

describe('вкладка «Библиотека»: текущий значок и «Применить» (e2407f6d)', () => {
  beforeEach(() => installShim());

  it('текущий значок выделен, «Применить» активна, apply отдаёт значок с цветом', async () => {
    let ready = false;
    const ctx: any = { close: () => undefined, setReady: (v: boolean) => (ready = v) };
    const picked: Array<{ name: string; color: string | null }> = [];
    const tab = libraryIconSourceTab({
      initialIcon: 'star',
      initialColor: '#ff0000',
      onPick: (name, color) => {
        picked.push({ name, color });
      },
    });
    const root = tab.build(ctx) as unknown as ShimElement;
    assert.equal(ready, true, 'источник объявил корректный выбор — «Применить» активна');
    // Каталог грузится лениво — дожидаемся его, затем ждём отрисовку сетки.
    await loadIconCatalog();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const current = root.querySelector('.icon-library-cell-current');
    assert.ok(current !== null, 'текущий значок помечен классом');
    assert.equal((current as any).dataset['icon'], 'star');

    assert.ok(tab.apply !== undefined, 'у источника есть apply (смена только цвета)');
    tab.apply!(ctx);
    assert.deepEqual(picked, [{ name: 'star', color: '#ff0000' }], 'apply применяет текущий значок с цветом');
  });

  it('без текущего значка выбор не объявлен', () => {
    let ready = false;
    const ctx: any = { close: () => undefined, setReady: (v: boolean) => (ready = v) };
    libraryIconSourceTab({ initialIcon: null, onPick: () => undefined }).build(ctx);
    assert.equal(ready, false, 'нет текущего выбора — источник молчит');
  });
});

describe('диалог иконки: «Применить» активна при открытии на библиотеке (e2407f6d)', () => {
  beforeEach(() => installShim());

  it('нижняя «Применить» доступна сразу после открытия с видом icon', async () => {
    open({ icon: 'star', kind: 'icon', color: '#ff0000' });
    await loadIconCatalog();
    assert.equal(isDisabled(footerBtn(t('actions.apply'))), false, '«Применить» активна');
  });
});

describe('диалог иконки: текущее вложение-картинка отмечено (846c426a)', () => {
  beforeEach(() => installShim());

  it('вид «image» из вложения открывает вкладку «Вложения» и «Применить» активна', () => {
    open({ icon: 'data:image/png;base64,AAAA', kind: 'image', color: null, attachmentId: 'att-1' });
    assert.equal(activeTabLabel(), t('publication.cover.tab.attachments'));
    assert.equal(activeTabLabel(), 'Вложения');
    assert.notEqual(activeTabLabel(), 'URL');
    assert.equal(isDisabled(footerBtn(t('actions.apply'))), false, '«Применить» активна');
    assert.ok(
      lastBox().querySelector('.att-pick-preview-current') !== null,
      'текущее вложение показано выбранным',
    );
  });

  it('вид «image» без вложения (URL) по-прежнему открывает «URL»', () => {
    open({ icon: 'https://example.test/pic.png', kind: 'image', color: null });
    assert.equal(activeTabLabel(), 'URL');
  });
});

describe('вкладка «Вложения»: текущее вложение и «Применить» (846c426a)', () => {
  beforeEach(() => installShim());

  it('восстанавливает вложение: выделено, «Применить» активна, apply отдаёт тот же id', async () => {
    let ready = false;
    const ctx: any = { close: () => undefined, setReady: (v: boolean) => (ready = v) };
    const picked: Array<{ preview: string; attachmentId?: string | null }> = [];
    const tab = attachmentPickerSourceTab({
      label: t('publication.cover.tab.attachments'),
      current: { preview: 'data:image/png;base64,AAAA', attachmentId: 'att-1' },
      onPick: (pick) => {
        picked.push({ preview: pick.preview, attachmentId: pick.attachmentId });
      },
    });
    const root = tab.build(ctx) as unknown as ShimElement;
    assert.equal(ready, true, 'источник объявил выбор — «Применить» активна');
    assert.ok(root.querySelector('.att-pick-preview-current') !== null, 'превью помечено выбранным');
    assert.ok(tab.apply !== undefined, 'у источника есть apply');
    await tab.apply!(ctx);
    assert.deepEqual(
      picked,
      [{ preview: 'data:image/png;base64,AAAA', attachmentId: 'att-1' }],
      'применение без изменений сохраняет то же вложение (без перезагрузки)',
    );
  });

  it('без текущего вложения выбор не объявлен', () => {
    let ready = false;
    const ctx: any = { close: () => undefined, setReady: (v: boolean) => (ready = v) };
    attachmentPickerSourceTab({
      label: t('publication.cover.tab.attachments'),
      onPick: () => undefined,
    }).build(ctx);
    assert.equal(ready, false, 'нет текущего вложения — источник молчит');
  });
});

describe('диалог иконки: текущая картинка ТИПА мысли (вид image без вложения) отмечена (844c426a)', () => {
  beforeEach(() => installShim());

  it('вид «image» с data:-превью открывает вкладку «Вложения», «Применить» активна', () => {
    open({ icon: 'data:image/png;base64,BBBB', kind: 'image', color: null });
    assert.equal(activeTabLabel(), 'Вложения');
    assert.notEqual(activeTabLabel(), 'URL');
    assert.equal(isDisabled(footerBtn(t('actions.apply'))), false, '«Применить» активна');
    assert.ok(
      lastBox().querySelector('.att-pick-preview-current') !== null,
      'текущая картинка показана выбранной',
    );
  });

  it('вид «image» с data:-превью не оставляет активной пустую вкладку «URL»', () => {
    open({ icon: 'data:image/png;base64,BBBB', kind: 'image', color: null });
    // Вкладка «URL» ленивая и не активна — поля ввода АДРЕСА (URL изображения)
    // в диалоге нет; у вкладки «Вложения» поле поиска вложений.
    const urlInput = findByTag(lastBox(), 'INPUT').find(
      (el) => (el as any).placeholder === 'URL изображения',
    );
    assert.equal(urlInput, undefined, 'поля URL нет на активной вкладке «Вложения»');
  });

  it('применение без изменений сохраняет самодостаточное data:-превью (без вложения)', async () => {
    let ready = false;
    const ctx: any = { close: () => undefined, setReady: (v: boolean) => (ready = v) };
    const picked: Array<{ preview: string; attachmentId?: string | null }> = [];
    const tab = attachmentPickerSourceTab({
      label: t('publication.cover.tab.attachments'),
      current: { preview: 'data:image/png;base64,BBBB', attachmentId: null },
      onPick: (pick) => {
        picked.push({ preview: pick.preview, attachmentId: pick.attachmentId });
      },
    });
    tab.build(ctx);
    assert.equal(ready, true, 'источник объявил выбор — «Применить» активна');
    await tab.apply!(ctx);
    assert.deepEqual(
      picked,
      [{ preview: 'data:image/png;base64,BBBB', attachmentId: null }],
      'превью сохранено как есть, вложения нет',
    );
  });
});
