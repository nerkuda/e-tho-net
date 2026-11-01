/**
 * Экран подключения: предзаполнение нового подключения от установщика
 * (ошибка 0f8dd0f3, п.6 карточки 860def0d).
 *
 * Установщик после установки сервера запускает клиент с
 * `--connect-url=http://localhost:<порт> --connect-name="Локальный сервер"`.
 * Клиент на первом запуске обязан показать форму нового подключения с уже
 * заполненными названием и адресом — пользователю остаётся ввести API-ключ.
 *
 * Тест монтирует реальный `buildOnboarding` на общем DOM-шиме и проверяет два
 * контракта:
 *  1) main отдал предзаполнение (`server.connectPrefill`) → поля «Название» и
 *     «Адрес сервера» заполнены, поле API-key пустое;
 *  2) предзаполнения нет (обычный запуск из меню) → все поля пустые, как
 *     раньше.
 *
 * Мутации, которые краснят: не читать `connectPrefill` на онбординге; писать
 * предзаполнение в поле ключа; заполнять адрес без названия.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Подсказки полей онбординга — по ним тест находит контролы (как в продукте). */
const LABEL_PLACEHOLDER = 'Мой сервер (необязательно)';
const URL_PLACEHOLDER = 'http://localhost:3000';
const KEY_PLACEHOLDER = 'etn_…';

/**
 * Минимальные `document`/`window`-шимы. Ставятся ДО первого динамического
 * импорта `onboarding.ts` (он тянет `app.ts`) — тот же приём, что в
 * `realtime-fallback-maxwait.test.ts`.
 */
function shimDom(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => {
      const node = new ShimElement('#text');
      (node as any).textData = text;
      return node;
    },
    body: new ShimElement('body'),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
    getSelection: () => null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = (handler: (...args: any[]) => void, ms?: number, ...rest: any[]) =>
    (globalThis as any).setTimeout(handler, ms, ...rest);
  win.clearTimeout = (id: any) => (globalThis as any).clearTimeout(id);
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.innerWidth = 1600;
  win.innerHeight = 900;
}

interface Prefill {
  name: string;
  url: string;
}

/** Счётчик вызовов предзаполнения: доказывает, что путь исполнялся. */
const prefillCalls = { count: 0 };

/**
 * Заглушка моста: онбордингу нужны только список сохранённых серверов и
 * предзаполнение. `window.etn` читается живым proxy из `lib/etn`, поэтому
 * заглушку можно ставить до импорта экрана.
 */
function stubBridge(prefill: Prefill | null): void {
  const win = (globalThis as any).window;
  win.etn = {
    server: {
      listProfiles: async () => [],
      connectPrefill: async () => {
        prefillCalls.count += 1;
        return prefill;
      },
    },
  };
}

/** Смонтировать онбординг (импорт после установки шимов). */
async function mountOnboarding(): Promise<ShimElement> {
  const { buildOnboarding } = await import('../src/renderer/screens/onboarding.js');
  return buildOnboarding() as unknown as ShimElement;
}

/** Контрол по подсказке: продукт задаёт placeholder каждому полю. */
function inputByPlaceholder(root: ShimElement, placeholder: string): ShimElement {
  const input = root
    .querySelectorAll('input')
    .find((node) => (node as any).placeholder === placeholder);
  assert.notEqual(input, undefined, `не найдено поле с подсказкой «${placeholder}»`);
  return input as ShimElement;
}

/** Дождаться условия (асинхронная загрузка профилей/предзаполнения). */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(`не дождались: ${what}`);
}

describe('onboarding: предзаполнение подключения от установщика', () => {
  it('connect-параметры → название и адрес заполнены, API-key пуст', async () => {
    prefillCalls.count = 0;
    shimDom();
    stubBridge({ name: 'Локальный сервер', url: 'http://localhost:4321' });

    const root = await mountOnboarding();
    const url = inputByPlaceholder(root, URL_PLACEHOLDER);
    const label = inputByPlaceholder(root, LABEL_PLACEHOLDER);
    const key = inputByPlaceholder(root, KEY_PLACEHOLDER);

    await waitFor(() => (url as any).value === 'http://localhost:4321', 'адрес предзаполнен');
    assert.equal((label as any).value, 'Локальный сервер');
    assert.equal((key as any).value, '');
    assert.ok(prefillCalls.count > 0, 'предзаполнение запрошено у main');
  });

  it('без connect-параметров → поля пустые (обычный запуск)', async () => {
    prefillCalls.count = 0;
    shimDom();
    stubBridge(null);

    const root = await mountOnboarding();
    const url = inputByPlaceholder(root, URL_PLACEHOLDER);
    const label = inputByPlaceholder(root, LABEL_PLACEHOLDER);
    const key = inputByPlaceholder(root, KEY_PLACEHOLDER);

    // Ждём сам вызов: пустые поля до ответа main ничего не доказывают.
    await waitFor(() => prefillCalls.count > 0, 'предзаполнение запрошено');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((url as any).value, '');
    assert.equal((label as any).value, '');
    assert.equal((key as any).value, '');
  });
});
