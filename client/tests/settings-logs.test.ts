/**
 * Tests for the «Логирование» section of the settings dialog
 * (`client/src/renderer/screens/settings-logs.ts`, task 92b89e6f,
 * 08-ui-spec.md §9.7).
 *
 * Pure TS — the module runs under Node with a minimal DOM shim (the pattern
 * of `renderer-editor-open.test.ts`); `window.etn.system.*` is a recording
 * mock, and the destructive-action confirmation is injected through the
 * `confirm` seam instead of the real dialog.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * The module under test reaches the preload bridge through `lib/etn.ts`, whose
 * Proxy captures `window` at import time — so the tests install `window` (and
 * the `window.etn.system` mock) FIRST and load the module through a dynamic
 * import afterwards. `makeMock` mutates the same `window` object between
 * tests instead of replacing it, keeping the captured reference valid.
 */
type SettingsLogsModule = typeof import('../src/renderer/screens/settings-logs.js');
let modulePromise: Promise<SettingsLogsModule> | null = null;
function loadModule(): Promise<SettingsLogsModule> {
  modulePromise ??= import('../src/renderer/screens/settings-logs.js');
  return modulePromise;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Minimal DOM shim — the subset `lib/dom.ts` helpers and the section builder
// touch: element creation, class list, append/replaceChildren, attribute
// fields (type/checked/disabled/title/value) and event listeners that tests
// fire explicitly through `fire()`.
// ---------------------------------------------------------------------------

class ShimElement {
  tagName: string;
  private _className = '';
  children: ShimElement[] = [];
  dataset: Record<string, string> = {};
  textContent = '';
  type = '';
  checked = false;
  disabled = false;
  title = '';
  name = '';
  parent: ShimElement | null = null;
  private listeners = new Map<string, Array<(event?: unknown) => void>>();
  readonly classes = new Set<string>();
  classList = {
    add: (c: string): void => {
      this.classes.add(c);
      this._syncClassName();
    },
    remove: (c: string): void => {
      this.classes.delete(c);
      this._syncClassName();
    },
    toggle: (c: string, on?: boolean): void => {
      if (on === undefined) {
        if (this.classes.has(c)) this.classes.delete(c);
        else this.classes.add(c);
      } else if (on) this.classes.add(c);
      else this.classes.delete(c);
      this._syncClassName();
    },
    contains: (c: string): boolean => this.classes.has(c),
  };

  constructor(tag: string, className?: string, text?: string) {
    this.tagName = tag;
    if (className !== undefined && className !== '') this.className = className;
    if (text !== undefined) this.textContent = text;
  }

  get className(): string {
    return this._className;
  }
  set className(value: string) {
    this._className = value;
    this.classes.clear();
    for (const c of value.split(/\s+/).filter((s) => s !== '')) this.classes.add(c);
  }
  private _syncClassName(): void {
    this._className = [...this.classes].join(' ');
  }
  get isConnected(): boolean {
    return this.parent !== null || this.children.length > 0;
  }
  append(...nodes: Array<ShimElement | string>): void {
    for (const node of nodes) {
      const el = typeof node === 'string' ? new ShimElement('#text', undefined, node) : node;
      el.parent = this;
      this.children.push(el);
    }
  }
  replaceChildren(...nodes: Array<ShimElement | string>): void {
    this.children = [];
    for (const node of nodes) this.append(node);
  }
  addEventListener(type: string, fn: (event?: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(): void {}
  /** Fires all listeners of `type` (test driver — not a real DOM method). */
  fire(type: string, event?: unknown): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
  setAttribute(name: string, value: string): void {
    (this as Record<string, unknown>)[name] = value;
  }
  querySelector(selector: string): ShimElement | null {
    return findFirst(this, selector);
  }
  querySelectorAll(selector: string): ShimElement[] {
    const out: ShimElement[] = [];
    walk(this, (node) => {
      if (node !== this && matches(node, selector)) out.push(node);
    });
    return out;
  }
  /** Flat concatenation of this node's and descendants' text (assert helper). */
  flatText(): string {
    let out = this.textContent;
    for (const child of this.children) out += child.flatText();
    return out;
  }
}

function matches(node: ShimElement, selector: string): boolean {
  if (selector.startsWith('.')) return node.classes.has(selector.slice(1));
  return node.tagName === selector;
}

function findFirst(root: ShimElement, selector: string): ShimElement | null {
  for (const child of root.children) {
    if (matches(child, selector)) return child;
    const inner = findFirst(child, selector);
    if (inner !== null) return inner;
  }
  return null;
}

function walk(root: ShimElement, cb: (n: ShimElement) => void): void {
  for (const child of root.children) {
    cb(child);
    walk(child, cb);
  }
}

// ---------------------------------------------------------------------------
// Recording window.etn mock
// ---------------------------------------------------------------------------

interface MockCalls {
  getClientLogState: number;
  setClientLogging: Array<boolean>;
  openClientLog: number;
  deleteClientLogs: number;
  getServerLogging: number;
  setServerLogging: Array<boolean>;
  downloadServerLog: Array<string | undefined>;
  openServerLog: number;
  deleteServerLogs: number;
}

interface MockOptions {
  clientState?: {
    enabled: boolean;
    logFile?: string;
    logDir?: string;
  };
  clientStateError?: Error;
  serverStatus?: {
    enabled: boolean;
    logDir?: string;
    retentionDays?: number;
    files?: Array<{ name: string; sizeBytes: number; date: string }>;
  };
  serverError?: Error;
  downloadResult?: { saved_path: string | null; cancelled: boolean; error?: string };
}

function makeMock(opts: MockOptions = {}): { calls: MockCalls } {
  const calls: MockCalls = {
    getClientLogState: 0,
    setClientLogging: [],
    openClientLog: 0,
    deleteClientLogs: 0,
    getServerLogging: 0,
    setServerLogging: [],
    downloadServerLog: [],
    openServerLog: 0,
    deleteServerLogs: 0,
  };
  // Mutate the EXISTING global `window` (never replace it — `lib/etn.ts`
  // captured the object reference at import time).
  const w = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  w.etn = {
    system: {
        getClientLogState: () => {
          calls.getClientLogState++;
          if (opts.clientStateError) return Promise.reject(opts.clientStateError);
          return Promise.resolve({
            enabled: opts.clientState?.enabled ?? false,
            logFile: opts.clientState?.logFile ?? 'C:\\logs\\client-2026-09-04.log',
            logDir: opts.clientState?.logDir ?? 'C:\\logs',
          });
        },
        setClientLogging: (enabled: boolean) => {
          calls.setClientLogging.push(enabled);
          return Promise.resolve({
            enabled,
            logFile: opts.clientState?.logFile ?? 'C:\\logs\\client-2026-09-04.log',
            logDir: opts.clientState?.logDir ?? 'C:\\logs',
          });
        },
        openClientLog: () => {
          calls.openClientLog++;
          return Promise.resolve('');
        },
        deleteClientLogs: () => {
          calls.deleteClientLogs++;
          return Promise.resolve({ deleted: 2, truncated: 1 });
        },
        getServerLogging: () => {
          calls.getServerLogging++;
          if (opts.serverError) return Promise.reject(opts.serverError);
          return Promise.resolve({
            enabled: opts.serverStatus?.enabled ?? false,
            logDir: opts.serverStatus?.logDir ?? '/var/lib/etn/logs',
            retentionDays: opts.serverStatus?.retentionDays ?? 30,
            files: opts.serverStatus?.files ?? [
              { name: 'server-2026-09-03.log', sizeBytes: 2048, date: '2026-09-03' },
              { name: 'server-2026-09-04.log', sizeBytes: 5 * 1024 * 1024, date: '2026-09-04' },
            ],
          });
        },
        setServerLogging: (enabled: boolean) => {
          calls.setServerLogging.push(enabled);
          return Promise.resolve({
            enabled,
            logDir: '/var/lib/etn/logs',
            retentionDays: 30,
            files: [],
          });
        },
        downloadServerLog: (filename?: string) => {
          calls.downloadServerLog.push(filename);
          return Promise.resolve(opts.downloadResult ?? { saved_path: 'C:\\out\\log.log', cancelled: false });
        },
        openServerLog: () => {
          calls.openServerLog++;
          return Promise.resolve('');
        },
        deleteServerLogs: () => {
          calls.deleteServerLogs++;
          return Promise.resolve(undefined);
        },
      },
    };
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    documentElement: { dataset: {} },
    body: new ShimElement('body'),
    addEventListener: () => undefined,
  };
  return { calls };
}

/** Lets the section's initial async loads resolve and re-render. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** Loads the module (after `window.etn` is mocked) and builds the section. */
async function makeSection(
  opts?: import('../src/renderer/screens/settings-logs.js').LogsSectionOptions,
): Promise<HTMLElement> {
  const mod = await loadModule();
  return mod.buildLogsSection(opts);
}

/** All checkbox toggles inside a rendered section (client first, server second). */
function toggles(section: ShimElement): ShimElement[] {
  return section
    .querySelectorAll('input')
    .filter((n) => n.type === 'checkbox');
}

/** All buttons of the section by label text. */
function buttonsByLabel(section: ShimElement, label: string): ShimElement[] {
  return section.querySelectorAll('button').filter((n) => n.textContent === label);
}

// ---------------------------------------------------------------------------
// Section rendering
// ---------------------------------------------------------------------------

describe('раздел «Логирование»: первичный рендер', () => {
  it('загружает состояние клиента и сервера и отражает их в тумблерах и пути', async () => {
    const { calls } = makeMock({
      clientState: { enabled: true, logFile: 'C:\\userData\\logs\\client-2026-09-04.log' },
      serverStatus: { enabled: false, files: [{ name: 'server-2026-09-04.log', sizeBytes: 2048, date: '2026-09-04' }] },
    });
    const section = (await makeSection()) as unknown as ShimElement;
    await flush();

    assert.equal(calls.getClientLogState, 1);
    assert.equal(calls.getServerLogging, 1);

    const [clientToggle, serverToggle] = toggles(section);
    assert.ok(clientToggle !== undefined && serverToggle !== undefined);
    assert.equal(clientToggle.checked, true, 'client toggle reflects the loaded flag');
    assert.equal(serverToggle.checked, false, 'server toggle reflects the loaded flag');

    const text = section.flatText();
    assert.ok(text.includes('client-2026-09-04.log'), 'client log file path is shown');
    assert.ok(text.includes('server-2026-09-04.log'), 'server file list is shown');
    assert.ok(text.includes('2.0 КБ'), 'file size is human-readable');
    assert.ok(text.includes('2026-09-04'), 'file date is shown');
  });

  it('при ошибке сервера блок показывает причину и не рисует управление', async () => {
    makeMock({ serverError: new Error('EtnError: Требуются права администратора.') });
    const section = (await makeSection()) as unknown as ShimElement;
    await flush();

    const text = section.flatText();
    assert.ok(text.includes('Нет прав администратора'), 'reason is human-readable');
    // The server block stays inert: no server checkbox, no action buttons.
    const [clientToggle, serverToggle] = toggles(section);
    assert.ok(clientToggle !== undefined, 'client block still works');
    assert.equal(serverToggle, undefined, 'server toggle must not render');
    assert.equal(buttonsByLabel(section, 'Скачать…').length, 0);
  });

  it('различает «нет прав» и «сервер недоступен»', async () => {
    makeMock({ serverError: new Error('fetch failed: ECONNREFUSED') });
    const section = (await makeSection()) as unknown as ShimElement;
    await flush();
    assert.ok(section.flatText().includes('Сервер недоступен'));
  });
});

// ---------------------------------------------------------------------------
// Immediate-effect toggles
// ---------------------------------------------------------------------------

describe('тумблеры применяются немедленно', () => {
  it('клиентский тумблер шлёт setClientLogging сразу, без «Применить»', async () => {
    const { calls } = makeMock({ clientState: { enabled: false } });
    const section = (await makeSection()) as unknown as ShimElement;
    await flush();

    const [clientToggle] = toggles(section);
    assert.ok(clientToggle !== undefined);
    clientToggle.checked = true;
    clientToggle.fire('change');
    await flush();

    assert.deepEqual(calls.setClientLogging, [true]);
  });

  it('серверный тумблер шлёт setServerLogging сразу', async () => {
    const { calls } = makeMock({ serverStatus: { enabled: false } });
    const section = (await makeSection()) as unknown as ShimElement;
    await flush();

    const togglesInSection = toggles(section);
    const serverToggle = togglesInSection[1];
    assert.ok(serverToggle !== undefined);
    serverToggle.checked = true;
    serverToggle.fire('change');
    await flush();

    assert.deepEqual(calls.setServerLogging, [true]);
  });

  it('сбой применения откатывает тумблер и показывает ошибку inline', async () => {
    const { calls } = makeMock({ clientState: { enabled: false } });
    (globalThis as any).window.etn.system.setClientLogging = () =>
      Promise.reject(new Error('бой'));
    const section = (await makeSection()) as unknown as ShimElement;
    await flush();

    const [clientToggle] = toggles(section);
    assert.ok(clientToggle !== undefined);
    clientToggle.checked = true;
    clientToggle.fire('change');
    await flush();

    assert.equal(clientToggle.checked, false, 'toggle reverts on failure');
    assert.ok(section.flatText().includes('бой'), 'error text is inline');
  });
});

// ---------------------------------------------------------------------------
// File actions
// ---------------------------------------------------------------------------

describe('действия с файлами журналов', () => {
  it('«Скачать…» передаёт выбранный файл; без выбора — текущий (undefined)', async () => {
    const { calls } = makeMock({
      serverStatus: {
        enabled: false,
        files: [
          { name: 'server-2026-09-03.log', sizeBytes: 10, date: '2026-09-03' },
          { name: 'server-2026-09-04.log', sizeBytes: 20, date: '2026-09-04' },
        ],
      },
    });
    const section = (await makeSection()) as unknown as ShimElement;
    await flush();

    const [btnDownload] = buttonsByLabel(section, 'Скачать…');
    assert.ok(btnDownload !== undefined, 'download button present');

    // No file selected yet — download the newest file (no explicit name).
    btnDownload.fire('click');
    await flush();
    assert.deepEqual(calls.downloadServerLog, [undefined]);

    // Select the first radio (older file) and download again.
    const radios = section.querySelectorAll('input').filter((n) => n.type === 'radio');
    assert.equal(radios.length, 2, 'one radio per server file');
    const firstRadio = radios[0];
    assert.ok(firstRadio !== undefined);
    firstRadio.checked = true;
    firstRadio.fire('change');
    btnDownload.fire('click');
    await flush();
    assert.deepEqual(calls.downloadServerLog, [undefined, 'server-2026-09-03.log']);
  });

  it('«Удалить» клиента спрашивает подтверждение и действует только при согласии', async () => {
    const { calls } = makeMock();
    let confirmed = false;
    const section = (await makeSection({ confirm: async () => confirmed })) as unknown as ShimElement;
    await flush();

    const [btnDelete] = buttonsByLabel(section, 'Удалить');
    assert.ok(btnDelete !== undefined);
    btnDelete.fire('click');
    await flush();
    assert.equal(calls.deleteClientLogs, 0, 'refused confirmation must not delete');

    confirmed = true;
    btnDelete.fire('click');
    await flush();
    assert.equal(calls.deleteClientLogs, 1);
    assert.ok(section.flatText().includes('Удалено файлов: 2'), 'result is reported inline');
  });

  it('«Открыть» клиента вызывает openClientLog', async () => {
    const { calls } = makeMock();
    const section = (await makeSection({ confirm: async () => true })) as unknown as ShimElement;
    await flush();

    const [btnOpen] = buttonsByLabel(section, 'Открыть');
    assert.ok(btnOpen !== undefined);
    btnOpen.fire('click');
    await flush();
    assert.equal(calls.openClientLog, 1);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('logsSectionInternals', () => {
  it('formatBytes форматирует Б/КБ/МБ', async () => {
    const { logsSectionInternals } = await loadModule();
    assert.equal(logsSectionInternals.formatBytes(0), '0 Б');
    assert.equal(logsSectionInternals.formatBytes(1023), '1023 Б');
    assert.equal(logsSectionInternals.formatBytes(2048), '2.0 КБ');
    assert.equal(logsSectionInternals.formatBytes(5 * 1024 * 1024), '5.0 МБ');
    assert.equal(logsSectionInternals.formatBytes(Number.NaN), '—');
  });

  it('serverUnavailableReason классифицирует причину', async () => {
    const { logsSectionInternals } = await loadModule();
    assert.match(
      logsSectionInternals.serverUnavailableReason(new Error('Требуются права администратора.')),
      /Нет прав администратора/,
    );
    assert.match(
      logsSectionInternals.serverUnavailableReason(new Error('fetch failed')),
      /Сервер недоступен/,
    );
    assert.match(
      logsSectionInternals.serverUnavailableReason(new Error('что-то иное')),
      /что-то иное/,
    );
  });
});
