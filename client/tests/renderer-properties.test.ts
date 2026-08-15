/**
 * Regression test for the editor properties group body (renderer).
 *
 * Runs the REAL buildPropertiesBody under Node with a minimal DOM shim and a
 * fake window.etn. Guards the failure class where the group gets stuck at
 * «Загрузка…»: a throw anywhere on the reload path (e.g. the temporal-dead-zone
 * ReferenceError shipped in the everMounted guard) rejects the fire-and-forget
 * reload promise and leaves the placeholder forever.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Smallest element stub that survives the properties render path. */
class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = '';
  value = '';
  type = '';
  checked = false;
  title = '';
  placeholder = '';
  isConnected = false;
  classList = {
    add: () => undefined,
    remove: () => undefined,
    toggle: () => undefined,
    contains: () => false,
  };
  constructor(tag: string, className?: string, text?: string) {
    this.tagName = tag;
    if (className !== undefined) this.className = className;
    if (text !== undefined) this.textContent = text;
  }
  append(...nodes: ShimElement[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: ShimElement[]): void {
    this.children = nodes;
  }
  remove(): void {
    this.parent = null;
  }
  parent: ShimElement | null = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  closest(): ShimElement | null {
    return null;
  }
  querySelector(): ShimElement | null {
    return null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }
}

/** Installs the DOM/window shims and imports the module against fixtures. */
async function buildWithFixtures(): Promise<ShimElement> {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
  };
  (globalThis as any).window = {
    etn: {
      types: {
        listTypeProperties: async () => [
          {
            id: 'p1',
            owner_type: 'thought_type',
            owner_id: 'ty1',
            key: 'Город',
            value_type: 'text',
            config: { options: ['Москва', 'СПб'], multiple: true },
            required: false,
            position: 0,
          },
          {
            id: 'p2',
            owner_type: 'thought_type',
            owner_id: 'ty1',
            key: 'Автор',
            value_type: 'thought_ref',
            config: { allowed_type_ids: ['ty2'] },
            required: false,
            position: 1,
          },
        ],
      },
      properties: { get: async () => [] },
      thoughts: { resolve: async () => [] },
    },
  };

  const { propertiesInternals } = await import('../src/renderer/editor/properties.js');
  const { store } = await import('../src/renderer/state.js');
  store.update({ networkId: 'n1' } as any);

  const ctx = {
    ownerType: 'thought' as const,
    ownerId: 't1',
    thought: {
      id: 't1',
      title: 'T',
      type_id: 'ty1',
      icon: null,
      icon_kind: 'emoji',
      active: true,
      is_protected: false,
      is_root: false,
      fg_color: null,
      bg_color: null,
      font_bold: null,
      font_italic: null,
      font_underline: null,
      font_strike: null,
      synonyms: [],
      version: 1,
      created_at: '2026',
      updated_at: '2026',
    },
    link: null,
  };
  return propertiesInternals.buildPropertiesBody(ctx as any) as unknown as ShimElement;
}

describe('editor properties group body (DOM-shimmed)', () => {
  it('renders the definitions table instead of getting stuck on «Загрузка…»', async () => {
    const box = await buildWithFixtures();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const tableWrap = box.children[0];
    assert.ok(tableWrap !== undefined, 'table wrapper rendered');
    const table = tableWrap.children[0];
    assert.ok(table !== undefined, 'table replaced the loading placeholder');
    assert.match(table.className, /table-list/);

    const tbody = table.children[1];
    assert.ok(tbody !== undefined, 'tbody present');
    assert.equal(tbody.children.length, 2, 'one row per property definition');
    // The text property with options carries the picker caret button.
    const textCell = tbody.children[0]?.children[1];
    const buttons = textCell?.children[0]?.children.filter((c) => c.tagName === 'button') ?? [];
    assert.equal(buttons.length, 1, 'options picker caret rendered');
  });
});
