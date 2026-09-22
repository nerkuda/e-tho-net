/**
 * Regression tests for `buildConfig` (property-manager.ts).
 *
 * The pre-fix version had no `value_type = 'link'` branch at all: any edit of
 * an existing link property through the «Свойства» dialog rebuilt `config`
 * from scratch and lost `link_type_id`/`direction`/`show_on_map`/
 * `blocks_target_deletion` — the server then rejected the patch
 * with `VALIDATION_ERROR` («свойство-связь требует config.link_type_id»), so
 * saving (or creating) a link property through the GUI was impossible. These
 * tests pin the fixed behaviour: a full round trip of every link-only field,
 * the structural (system-seeded) variant, and that the plain scalar path is
 * unaffected.
 *
 * Ограничение типов значения (`allowed_target_type_ids`/`allowed_source_type_ids`)
 * из этой утилиты убрано (ошибка a6513df0): источник истины — привязки
 * противоположной стороны свойства, а не ключи `config`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildConfig, type LinkConfigDraft } from '../src/renderer/screens/property-manager.js';

/** A link draft with every optional flag off — callers override as needed. */
function linkDraft(overrides: Partial<LinkConfigDraft> = {}): LinkConfigDraft {
  return {
    structural: false,
    linkTypeId: null,
    direction: 'out',
    showOnMap: false,
    blocksTargetDeletion: false,
    legacyMultiple: false,
    ...overrides,
  };
}

describe('buildConfig — value_type "link"', () => {
  it('returns link_type_id + direction for a non-structural property (the fields the pre-fix dialog dropped)', () => {
    const config = buildConfig('link', null, { choiceOn: false, optionsText: '', multipleOn: false }, linkDraft({
      linkTypeId: 'lt-1',
      direction: 'in',
    }));
    assert.deepEqual(config, { direction: 'in', link_type_id: 'lt-1' });
  });

  it('omits link_type_id when none is picked yet (pre-apply state)', () => {
    const config = buildConfig('link', null, { choiceOn: false, optionsText: '', multipleOn: false }, linkDraft());
    assert.deepEqual(config, { direction: 'out' });
  });

  it('never writes type-restriction config keys (source of truth — bindings, a6513df0)', () => {
    const config = buildConfig('link', null, { choiceOn: false, optionsText: '', multipleOn: false }, linkDraft({
      linkTypeId: 'lt-1',
    }));
    assert.equal('allowed_target_type_ids' in (config ?? {}), false);
    assert.equal('allowed_source_type_ids' in (config ?? {}), false);
  });

  it('includes show_on_map / blocks_target_deletion only when true', () => {
    const config = buildConfig('link', null, { choiceOn: false, optionsText: '', multipleOn: false }, linkDraft({
      linkTypeId: 'lt-1',
      showOnMap: true,
      blocksTargetDeletion: true,
    }));
    assert.deepEqual(config, {
      direction: 'out',
      link_type_id: 'lt-1',
      show_on_map: true,
      blocks_target_deletion: true,
    });
  });

  it('preserves a legacy multiple flag left by the thought_ref→link migration (040)', () => {
    const config = buildConfig('link', null, { choiceOn: false, optionsText: '', multipleOn: false }, linkDraft({
      linkTypeId: 'lt-1',
      legacyMultiple: true,
    }));
    assert.equal(config?.multiple, true);
  });

  it('renders the structural (Родители/Потомки) shape without link_type_id', () => {
    const config = buildConfig('link', null, { choiceOn: false, optionsText: '', multipleOn: false }, linkDraft({
      structural: true,
      direction: 'in',
    }));
    assert.deepEqual(config, { direction: 'in', structural: true });
  });

  it('stores the default target set, deduplicated (bb67e546)', () => {
    const config = buildConfig('link', ['t1', 't2', 't1'], { choiceOn: false, optionsText: '', multipleOn: false }, linkDraft({
      linkTypeId: 'lt-1',
    }));
    assert.deepEqual(config?.default_value, ['t1', 't2']);
  });

  it('drops an empty default target set (reset, not `[]`)', () => {
    const config = buildConfig('link', [], { choiceOn: false, optionsText: '', multipleOn: false }, linkDraft({
      linkTypeId: 'lt-1',
    }));
    assert.equal('default_value' in (config ?? {}), false);
  });

  it('drops a stale scalar default left over from a value-type switch', () => {
    const config = buildConfig('link', 'текст', { choiceOn: false, optionsText: '', multipleOn: false }, linkDraft({
      linkTypeId: 'lt-1',
    }));
    assert.equal('default_value' in (config ?? {}), false);
  });

  it('never returns null for a link property (server requires an object)', () => {
    const config = buildConfig('link', null, { choiceOn: false, optionsText: '', multipleOn: false }, linkDraft());
    assert.notEqual(config, null);
  });
});

describe('buildConfig — scalar kinds unaffected by the link branch', () => {
  const noLink = linkDraft();

  it('returns null when there is nothing to store', () => {
    assert.equal(buildConfig('text', null, { choiceOn: false, optionsText: '', multipleOn: false }, noLink), null);
  });

  it('still stores a default value for a scalar kind', () => {
    const config = buildConfig('number', 42, { choiceOn: false, optionsText: '', multipleOn: false }, noLink);
    assert.deepEqual(config, { default_value: 42 });
  });

  it('still stores text options + multiple', () => {
    const config = buildConfig(
      'text',
      null,
      { choiceOn: true, optionsText: 'a\nb\n', multipleOn: true },
      noLink,
    );
    assert.deepEqual(config, { options: ['a', 'b'], multiple: true });
  });
});
