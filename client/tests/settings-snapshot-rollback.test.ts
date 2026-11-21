/**
 * Диалог «Все настройки»: снимок «принятого» состояния и откат (задача
 * a6ad0143).
 *
 * Мгновенные разделы («Оформление», «Логирование») применяются сразу, но
 * входят в признак «есть непринятые изменения»: «Применить»/«Применить и
 * закрыть» доступны при расхождении со снимком, «Применить» фиксирует снимок и
 * снова гасит кнопки, «Отмена» и «Не сохранять» возвращают тему, режим,
 * картинку активной сети и тумблеры журналирования к снимку и закрывают окно.
 *
 * Диалог монтируется целиком под DOM-шимом (образец —
 * `settings-show-trash.test.ts`); картинка меняется через РЕАЛЬНЫЕ
 * `uploadWallpaper`/`removeWallpaper` из `lib/wallpaper-state.js` — нативный
 * выбор файла не нужен, путь после него тот же. `window.etn` — записывающий
 * мок: он же помнит «серверное» состояние, поэтому откат виден и как вызовы,
 * и как содержимое превью при повторном открытии.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { USER_SETTING_KEY } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

function installShim(): void {
  windowListeners.length = 0;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    setTimeout,
    clearTimeout,
    addEventListener: (type: string, listener: (event: any) => void) => {
      windowListeners.push({ type, listener });
    },
    removeEventListener: (type: string, listener: (event: any) => void) => {
      const index = windowListeners.findIndex((l) => l.type === type && l.listener === listener);
      if (index >= 0) windowListeners.splice(index, 1);
    },
  };
}

/**
 * Дождаться разрешения промисов диалога (загрузки, применения, отката).
 * Откат теперь сначала ждёт хвост записей тумблеров («Отмена» во время
 * записи), поэтому цепочка микрозадач длиннее одного тика.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}

/** Esc — всем слушателям keydown окна (нижние диалоги игнорируют). */
function pressEscape(): void {
  const event = {
    key: 'Escape',
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
  };
  for (const { type, listener } of [...windowListeners]) {
    if (type === 'keydown') listener(event);
  }
}

type WallpaperState = import('../src/main/ipc/contract.js').WallpaperState;

/** «Серверное» состояние, которое помнит мок: откат виден по нему. */
interface FakeServer {
  /** Имя темы интерфейса (`ui_theme`). */
  uiTheme: string;
  /** Режим интерфейса (`ui_mode`): `light` / `dark`. */
  uiMode: string;
  clientLogging: boolean;
  serverLogging: boolean;
  admin: boolean;
  wallpaper: WallpaperState;
  /** Управляемая запись тумблера сервера: держит ответ до `release` теста. */
  gateServer?: Gate;
  /** Запись тумблера сервера завершается ошибкой. */
  failServerWrite?: boolean;
}

/** Промис, который тест отпускает сам: воспроизводит запись «в полёте». */
interface Gate {
  promise: Promise<void>;
  release: () => void;
}

/** Управляемая запись: `release()` завершает её. */
function makeGate(): Gate {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

interface Calls {
  settingWrites: Array<{ key: string; value: unknown }>;
  uploads: Array<{ data_base64: string; mime_type: string; meta: unknown }>;
  removes: number;
  setClientLogging: boolean[];
  setServerLogging: boolean[];
}

function okWallpaper(dataBase64: string, hash: string): WallpaperState {
  return {
    status: 'ok',
    network_id: 'n1',
    data_url: `data:image/png;base64,${dataBase64}`,
    mime_type: 'image/png',
    file_size: 128,
    content_hash: hash,
    meta: { width: 1920, height: 1080, avg_luminance: 0.4, dominant_hue: 210, dominant_sat: 0.3 },
    source: 'server',
  };
}

interface Harness {
  backdrop: ShimElement;
  server: FakeServer;
  calls: Calls;
  store: typeof import('../src/renderer/state.js').store;
}

/** Монтирует диалог настроек на нужном разделе с моком `window.etn`. */
async function openDialog(
  section: 'appearance' | 'logs',
  initial: Partial<FakeServer> = {},
): Promise<Harness> {
  installShim();
  const server: FakeServer = {
    uiTheme: 'current',
    uiMode: 'dark',
    clientLogging: false,
    serverLogging: false,
    admin: false,
    wallpaper: { status: 'none' },
    ...initial,
  };
  const calls: Calls = {
    settingWrites: [],
    uploads: [],
    removes: 0,
    setClientLogging: [],
    setServerLogging: [],
  };
  (globalThis as any).window.etn = {
    me: {
      getWallpaper: async () => server.wallpaper,
      uploadWallpaper: async (input: {
        data_base64: string;
        mime_type: string;
        meta: unknown;
        networkId: string;
      }) => {
        calls.uploads.push({
          data_base64: input.data_base64,
          mime_type: input.mime_type,
          meta: input.meta,
        });
        server.wallpaper = okWallpaper(input.data_base64, `h-${input.data_base64}`);
        return server.wallpaper;
      },
      removeWallpaper: async () => {
        calls.removes += 1;
        server.wallpaper = { status: 'none' };
        return server.wallpaper;
      },
      setSetting: async (key: string, value: unknown) => {
        calls.settingWrites.push({ key, value });
        if (key === USER_SETTING_KEY.UI_THEME) server.uiTheme = String(value);
        if (key === USER_SETTING_KEY.UI_MODE) server.uiMode = String(value);
      },
      update: async () => {
        throw new Error('PATCH профиля в этом тесте не ожидается');
      },
    },
    meta: { set: async () => undefined, get: async () => null },
    ui: { setState: async () => undefined, setWindowBackground: async () => undefined },
    networks: {
      setPreference: async () => undefined,
      update: async () => {
        throw new Error('PATCH сети в этом тесте не ожидается');
      },
    },
    system: {
      getClientLogState: async () => ({ enabled: server.clientLogging }),
      setClientLogging: async (enabled: boolean) => {
        calls.setClientLogging.push(enabled);
        server.clientLogging = enabled;
        return { enabled };
      },
      getServerLogging: async () => {
        if (!server.admin) throw new Error('Требуются права администратора.');
        return { enabled: server.serverLogging, logDir: '/logs', retentionDays: 30, files: [] };
      },
      setServerLogging: async (enabled: boolean) => {
        calls.setServerLogging.push(enabled);
        if (server.gateServer !== undefined) await server.gateServer.promise;
        if (server.failServerWrite === true) throw new Error('Сервер отверг запись журнала.');
        server.serverLogging = enabled;
        return { enabled, logDir: '/logs', retentionDays: 30, files: [] };
      },
      setWindowBackground: async () => undefined,
    },
  };

  const { store } = await import('../src/renderer/state.js');
  store.update({
    networkId: 'n1',
    me: { id: 'u1', username: 'me', display_name: 'Me', is_admin: server.admin },
    network: {
      id: 'n1',
      display_name: 'Сеть',
      description: null,
      when_to_use: null,
      conventions: null,
      examples: null,
      type_roles: {},
      owner_id: 'u1',
    },
    thoughtTypes: [],
    linkTypes: [],
    activeView: 'map',
    theme: server.uiMode,
    uiTheme: server.uiTheme,
  } as any);

  // Картинка — модульное состояние рендерера: между сценариями его сбрасываем,
  // иначе превью покажет картинку прошлого теста.
  const wallpaperState = await import('../src/renderer/lib/wallpaper-state.js');
  wallpaperState.resetWallpaperState();

  const { showSettingsDialog } = await import('../src/renderer/screens/settings.js');
  showSettingsDialog(section);
  const backdrop = ((globalThis as any).document.body as ShimElement).findAll('dialog-backdrop')[0];
  assert.ok(backdrop !== undefined, 'диалог настроек смонтирован');
  await flush();
  return { backdrop, server, calls, store };
}

/** Кнопка футера диалога по точной подписи. */
function footerButton(backdrop: ShimElement, label: string): ShimElement {
  const btn = backdrop.querySelectorAll('button').find((b) => (b.textContent ?? '') === label);
  assert.ok(btn !== undefined, `кнопка футера «${label}» найдена`);
  return btn!;
}

/** Текущий раздел диалога. */
function section(backdrop: ShimElement): ShimElement {
  const found = backdrop.findAll('settings-section')[0];
  assert.ok(found !== undefined, 'раздел диалога смонтирован');
  return found!;
}

/** Выбор темы интерфейса (раздел «Оформление»). */
function themeSelect(backdrop: ShimElement): ShimElement {
  const select = section(backdrop).querySelectorAll('select')[0];
  assert.ok(select !== undefined, 'поле темы на месте');
  return select!;
}

/** Радиокнопки режима «тёмный/светлый». */
function modeRadio(backdrop: ShimElement, value: 'light' | 'dark'): ShimElement {
  const radio = section(backdrop)
    .querySelectorAll('input')
    .find((n) => n.type === 'radio' && n.name === 'settings-ui-mode' && n.value === value);
  assert.ok(radio !== undefined, `режим «${value}» на месте`);
  return radio!;
}

/** Превью картинки в разделе «Оформление». */
function wallpaperPreview(backdrop: ShimElement): ShimElement {
  const img = section(backdrop).querySelector('.settings-wallpaper-preview');
  assert.ok(img !== null, 'превью картинки на месте');
  return img!;
}

/** Тумблеры журналирования (клиент, сервер) в разделе «Логирование». */
function logToggles(backdrop: ShimElement): ShimElement[] {
  return section(backdrop)
    .querySelectorAll('input')
    .filter((n) => n.type === 'checkbox');
}

/** Закрыть диалог «Отменой» (чистое состояние — молча). */
async function closeDialogs(backdrop: ShimElement): Promise<void> {
  if (backdrop.parent === null) return;
  footerButton(backdrop, 'Отмена').click();
  await flush();
}

describe('настройки: снимок и откат мгновенных изменений (a6ad0143)', () => {
  it('тема включает «Применить»; после применения кнопки снова недоступны', async () => {
    const { backdrop, calls, store } = await openDialog('appearance');
    assert.equal(footerButton(backdrop, 'Применить').disabled, true, 'сразу применять нечего');

    const select = themeSelect(backdrop);
    select.value = 'blue-topaz';
    select.fire('change');
    await flush();

    assert.equal(store.state.uiTheme, 'blue-topaz', 'тема применена сразу');
    assert.equal(footerButton(backdrop, 'Применить').disabled, false, '«Применить» доступна');
    assert.equal(
      footerButton(backdrop, 'Применить и закрыть').disabled,
      false,
      '«Применить и закрыть» доступна',
    );

    footerButton(backdrop, 'Применить').click();
    await flush();

    assert.deepEqual(calls.settingWrites, [
      { key: USER_SETTING_KEY.UI_THEME, value: 'blue-topaz' },
    ]);
    assert.equal(
      footerButton(backdrop, 'Применить').disabled,
      true,
      'после «Применить» применять нечего',
    );
    assert.equal(footerButton(backdrop, 'Применить и закрыть').disabled, true);

    // Повторное «Применить» без правок ничего не пишет (черновик и снимок
    // совпали) и не закрывает диалог.
    footerButton(backdrop, 'Применить').click();
    await flush();
    assert.equal(calls.settingWrites.length, 1, 'повтор ничего не пишет');
    await closeDialogs(backdrop);
  });

  it('«Отмена» откатывает тему и режим к последнему снимку', async () => {
    const { backdrop, calls, store } = await openDialog('appearance');
    const select = themeSelect(backdrop);
    select.value = 'blue-topaz';
    select.fire('change');
    await flush();
    footerButton(backdrop, 'Применить').click();
    await flush();
    assert.equal(store.state.uiTheme, 'blue-topaz');

    // После «Применить» снимок — blue-topaz + dark: меняем режим и отменяем.
    const light = modeRadio(backdrop, 'light');
    light.checked = true;
    light.fire('change');
    await flush();
    assert.equal(store.state.theme, 'light');
    assert.equal(footerButton(backdrop, 'Применить').disabled, false);

    footerButton(backdrop, 'Отмена').click();
    await flush();

    assert.equal(store.state.theme, 'dark', 'режим вернулся к снимку');
    assert.equal(store.state.uiTheme, 'blue-topaz', 'тема осталась принятой');
    assert.deepEqual(
      calls.settingWrites.slice(-1),
      [{ key: USER_SETTING_KEY.UI_MODE, value: 'dark' }],
      'откат записал режим снимка',
    );
    assert.equal(
      (globalThis as any).document.body.findAll('dialog-backdrop').length,
      0,
      '«Отмена» закрыла диалог',
    );
  });

  it('«Не сохранять» в подтверждении Esc возвращает тему и закрывает окно', async () => {
    const { backdrop, store } = await openDialog('appearance');
    const select = themeSelect(backdrop);
    select.value = 'blue-topaz';
    select.fire('change');
    await flush();

    pressEscape();
    await flush();

    const dialogs = (globalThis as any).document.body.findAll('dialog-backdrop');
    assert.equal(dialogs.length, 2, 'открыто подтверждение закрытия');
    const confirm = dialogs[dialogs.length - 1] as ShimElement;
    const labels = confirm
      .querySelectorAll('button')
      .map((b) => (b.textContent ?? '').trim())
      .filter((label) => label !== '');
    assert.deepEqual(
      labels,
      ['Отменить закрытие', 'Не сохранять', 'Применить'],
      'подписи подтверждения — «применить/не сохранять»',
    );

    confirm
      .querySelectorAll('button')
      .find((b) => (b.textContent ?? '') === 'Не сохранять')!
      .click();
    await flush();

    assert.equal(store.state.uiTheme, 'current', 'тема откатилась к снимку открытия');
    assert.equal(
      (globalThis as any).document.body.findAll('dialog-backdrop').length,
      0,
      'оба диалога закрыты',
    );
  });

  it('«Отмена» возвращает прежнюю картинку сети её же байтами', async () => {
    const { backdrop, calls, server } = await openDialog('appearance', {
      wallpaper: okWallpaper('AAA', 'h-AAA'),
    });
    assert.equal(wallpaperPreview(backdrop).src, 'data:image/png;base64,AAA');

    // Реальная загрузка тем же путём, что после выбора файла.
    const wallpaperState = await import('../src/renderer/lib/wallpaper-state.js');
    await wallpaperState.uploadWallpaper({
      data_base64: 'BBB',
      mime_type: 'image/png',
      meta: { width: 1920, height: 1080, avg_luminance: 0.4 },
    });
    await flush();
    assert.equal(wallpaperPreview(backdrop).src, 'data:image/png;base64,BBB');
    assert.equal(footerButton(backdrop, 'Применить').disabled, false, 'картинка — изменение');

    footerButton(backdrop, 'Отмена').click();
    await flush();

    const lastUpload = calls.uploads[calls.uploads.length - 1];
    assert.equal(lastUpload?.data_base64, 'AAA', 'откат вернул прежние байты');
    assert.equal(calls.removes, 0, 'прежняя картинка не удаляется');
    assert.equal(server.wallpaper.status, 'ok');
    assert.equal(
      server.wallpaper.status === 'ok' ? server.wallpaper.content_hash : null,
      'h-AAA',
      'на сервере снова прежняя картинка',
    );

    // Повторное открытие показывает восстановленное состояние.
    const second = await openDialog('appearance', { wallpaper: server.wallpaper });
    assert.equal(wallpaperPreview(second.backdrop).src, 'data:image/png;base64,AAA');
    assert.equal(footerButton(second.backdrop, 'Применить').disabled, true, 'применять нечего');
    await closeDialogs(second.backdrop);
  });

  it('«Отмена» удаляет загруженную картинку, если прежней не было', async () => {
    const { backdrop, calls, server } = await openDialog('appearance');
    assert.equal(wallpaperPreview(backdrop).hidden, true, 'превью пустое');

    const wallpaperState = await import('../src/renderer/lib/wallpaper-state.js');
    await wallpaperState.uploadWallpaper({
      data_base64: 'CCC',
      mime_type: 'image/png',
      meta: { width: 1920, height: 1080, avg_luminance: 0.4 },
    });
    await flush();
    assert.equal(wallpaperPreview(backdrop).hidden, false);

    footerButton(backdrop, 'Отмена').click();
    await flush();

    assert.equal(calls.removes, 1, 'загруженная картинка удалена');
    assert.equal(server.wallpaper.status, 'none', 'на сервере снова «нет картинки»');
  });

  it('«Применить» фиксирует картинку: «Отмена» больше её не удаляет', async () => {
    const { backdrop, calls } = await openDialog('appearance');
    const wallpaperState = await import('../src/renderer/lib/wallpaper-state.js');
    await wallpaperState.uploadWallpaper({
      data_base64: 'DDD',
      mime_type: 'image/png',
      meta: { width: 1920, height: 1080, avg_luminance: 0.4 },
    });
    await flush();
    footerButton(backdrop, 'Применить').click();
    await flush();
    assert.equal(
      footerButton(backdrop, 'Применить').disabled,
      true,
      'картинка принята — применять нечего',
    );

    footerButton(backdrop, 'Отмена').click();
    await flush();
    assert.equal(calls.removes, 0, 'принятая картинка не удаляется');
    assert.equal(calls.uploads.length, 1, 'лишней загрузки при откате нет');
  });

  it('тумблер журналирования клиента делает «Применить» доступной, откат возвращает значение', async () => {
    const { backdrop, calls, server } = await openDialog('logs', { clientLogging: false });
    const [clientToggle] = logToggles(backdrop);
    assert.ok(clientToggle !== undefined, 'тумблер клиента на месте');

    clientToggle.checked = true;
    clientToggle.fire('change');
    await flush();
    assert.deepEqual(calls.setClientLogging, [true], 'применяется сразу');
    assert.equal(footerButton(backdrop, 'Применить').disabled, false, 'изменение учтено');

    footerButton(backdrop, 'Отмена').click();
    await flush();
    assert.deepEqual(calls.setClientLogging, [true, false], 'откат выключил журналирование');
    assert.equal(server.clientLogging, false);

    // Повторное открытие читает восстановленное значение.
    const second = await openDialog('logs', { clientLogging: server.clientLogging });
    const [secondToggle] = logToggles(second.backdrop);
    assert.equal(secondToggle?.checked, false, 'журналирование клиента снова выключено');
    await closeDialogs(second.backdrop);
  });

  it('тумблер журналирования сервера учитывается только у администратора', async () => {
    const admin = await openDialog('logs', { admin: true, serverLogging: false });
    const adminToggles = logToggles(admin.backdrop);
    assert.equal(adminToggles.length, 2, 'у администратора видны оба тумблера');
    const serverToggle = adminToggles[1];
    assert.ok(serverToggle !== undefined);
    serverToggle.checked = true;
    serverToggle.fire('change');
    await flush();
    assert.deepEqual(admin.calls.setServerLogging, [true]);
    assert.equal(footerButton(admin.backdrop, 'Применить').disabled, false);

    footerButton(admin.backdrop, 'Отмена').click();
    await flush();
    assert.deepEqual(admin.calls.setServerLogging, [true, false], 'откат вернул прежнее значение');
    assert.equal(admin.server.serverLogging, false);

    const user = await openDialog('logs', { admin: false });
    assert.equal(logToggles(user.backdrop).length, 1, 'у пользователя только клиентский тумблер');
    await closeDialogs(user.backdrop);
  });
  it('«Отмена» во время записи тумблера ждёт запись и возвращает снимок', async () => {
    const gate = makeGate();
    const { backdrop, calls, server } = await openDialog('logs', {
      admin: true,
      serverLogging: false,
      gateServer: gate,
    });
    const serverToggle = logToggles(backdrop)[1];
    assert.ok(serverToggle !== undefined, 'тумблер сервера на месте');

    serverToggle.checked = true;
    serverToggle.fire('change');
    await flush();
    assert.deepEqual(calls.setServerLogging, [true], 'запись пошла');
    assert.equal(
      footerButton(backdrop, 'Применить').disabled,
      false,
      'выбор учтён сразу, не дожидаясь ответа',
    );

    footerButton(backdrop, 'Отмена').click();
    await flush();
    assert.deepEqual(
      calls.setServerLogging,
      [true],
      'откат ждёт начатую запись, второй запрос ещё не отправлен',
    );
    assert.equal(
      (globalThis as any).document.body.findAll('dialog-backdrop').length,
      1,
      'диалог открыт, пока запись в полёте',
    );

    gate.release();
    for (let i = 0; i < 4; i++) await flush();
    assert.deepEqual(
      calls.setServerLogging,
      [true, false],
      'после записи откат вернул значение снимка',
    );
    assert.equal(server.serverLogging, false, 'итоговое состояние = снимок');
    assert.equal(
      (globalThis as any).document.body.findAll('dialog-backdrop').length,
      0,
      'после отката диалог закрыт',
    );
  });

  it('ошибка записи тумблера: «Отмена» закрывает диалог без лишних запросов', async () => {
    const { backdrop, calls, server } = await openDialog('logs', {
      admin: true,
      serverLogging: false,
      failServerWrite: true,
    });
    const serverToggle = logToggles(backdrop)[1];
    assert.ok(serverToggle !== undefined, 'тумблер сервера на месте');

    serverToggle.checked = true;
    serverToggle.fire('change');
    await flush();
    assert.deepEqual(calls.setServerLogging, [true], 'запись отвергнута сервером');

    footerButton(backdrop, 'Отмена').click();
    for (let i = 0; i < 4; i++) await flush();
    assert.deepEqual(
      calls.setServerLogging,
      [true],
      'фактическое значение уже совпадает со снимком — лишнего запроса нет',
    );
    assert.equal(server.serverLogging, false, 'на сервере по-прежнему снимок');
    assert.equal(
      (globalThis as any).document.body.findAll('dialog-backdrop').length,
      0,
      'ошибка записи не мешает закрыть диалог',
    );
  });
});
