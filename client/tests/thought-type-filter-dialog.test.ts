/**
 * Tests for the thought-type view editor dialog (task e37f3f04, spec
 * e0257ca5, 0.7.3).
 *
 * Covered behaviours (pure-function checks, no DOM harness):
 *   * The «Работы версии» example: a state whose condition value uses a
 *     `$thought.[<property_key>]` token serialises to a wire
 *     `SavedFilterDefinition` the server accepts.
 *   * The token-picker lists the focus type's properties plus each
 *     ancestor's properties; multiple properties are tagged `listOnly`
 *     and excluded from scalar-op value fields.
 *   * The wire builder drops empty criteria, normalises the keyword scope
 *     to the default (`title+synonyms`), and always emits `sort`/`order`.
 *   * The author's `op` is preserved when not `eq` (in/not_in), and the
 *     scalar string is sent for `eq`/`ne`.
 *
 * The dialog's full DOM harness is exercised visually in the renderer
 * (the focus-filter-strip.test.ts follows the same «no DOM» convention):
 * the static shape of `buildWireDefinition` and the token builder is
 * enough to lock the public contract.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import type {
  EffectiveTypeProperty,
  NetworkProperty,
  PropertyValueType,
  ThoughtType,
} from '@etn/shared';

import { store } from '../src/renderer/state.js';

const FOCUS_TYPE_ID = '11111111-1111-4111-8111-111111111111';
const ANCESTOR_TYPE_ID = '22222222-2222-4222-8222-222222222222';
const PROP_VERSION_ID = 'p-version';
const PROP_LABEL_ID = 'p-label';
const PROP_TAGS_ID = 'p-tags';

const REGISTRY: NetworkProperty[] = [
  {
    id: PROP_VERSION_ID,
    name: 'версия',
    value_type: 'thought_ref',
    config: { multiple: false },
    description: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: PROP_LABEL_ID,
    name: 'метка',
    value_type: 'text',
    config: null,
    description: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: PROP_TAGS_ID,
    name: 'теги',
    value_type: 'thought_ref',
    config: { multiple: true },
    description: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
];

const TYPES: ThoughtType[] = [
  {
    id: FOCUS_TYPE_ID,
    name: 'Работа',
    parent_id: ANCESTOR_TYPE_ID,
    is_root: false,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    comment_template_md: null,
    version: 1,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    created_by: '00000000-0000-4000-8000-000000000001',
  },
  {
    id: ANCESTOR_TYPE_ID,
    name: 'Версия',
    parent_id: null,
    is_root: true,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    comment_template_md: null,
    version: 1,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    created_by: '00000000-0000-4000-8000-000000000001',
  },
];

const TYPE_PROPS: Record<string, EffectiveTypeProperty[]> = {
  [FOCUS_TYPE_ID]: [
    {
      id: 'tp-version',
      property_id: PROP_VERSION_ID,
      owner_type: 'thought_type',
      owner_id: FOCUS_TYPE_ID,
      key: 'версия',
      value_type: 'thought_ref',
      config: { multiple: false },
      required: false,
      position: 0,
      description: null,
      inherited: false,
      defined_on: FOCUS_TYPE_ID,
      defined_on_name: 'Работа',
      default_value: null,
      overridden_here: false,
      description_overridden: false,
    },
  ],
  [ANCESTOR_TYPE_ID]: [
    {
      id: 'tp-label',
      property_id: PROP_LABEL_ID,
      owner_type: 'thought_type',
      owner_id: ANCESTOR_TYPE_ID,
      key: 'метка',
      value_type: 'text',
      config: null,
      required: false,
      position: 0,
      description: null,
      inherited: false,
      defined_on: ANCESTOR_TYPE_ID,
      defined_on_name: 'Версия',
      default_value: null,
      overridden_here: false,
      description_overridden: false,
    },
    {
      id: 'tp-tags',
      property_id: PROP_TAGS_ID,
      owner_type: 'thought_type',
      owner_id: ANCESTOR_TYPE_ID,
      key: 'теги',
      value_type: 'thought_ref',
      config: { multiple: true },
      required: false,
      position: 1,
      description: null,
      inherited: false,
      defined_on: ANCESTOR_TYPE_ID,
      defined_on_name: 'Версия',
      default_value: null,
      overridden_here: false,
      description_overridden: false,
    },
  ],
};

function installShim(): void {
  (globalThis as any).document = {
    createElement: () => ({ classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, append() {}, appendChild() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; } }),
  };
  (globalThis as any).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: () => undefined,
    innerWidth: 1200,
    innerHeight: 800,
    localStorage: { getItem: () => null, setItem: () => undefined },
  };
  store.update({ networkId: 'n-1', thoughtTypes: TYPES, linkTypes: [] });
}

before(() => {
  installShim();
});

describe('thought-type view editor dialog — wire format & tokens (задача e37f3f04)', () => {
  let module: typeof import('../src/renderer/screens/thought-type/filter-dialog-pure.js');

  before(async () => {
    module = await import('../src/renderer/screens/thought-type/filter-dialog-pure.js');
  });

  it('exports the same length constants the dialog enforces', () => {
    assert.equal(module.VIEW_NAME_MAX, 200);
    assert.equal(module.VIEW_DESCRIPTION_MAX, 1000);
  });

  it('token-picker lists thought-field tokens + each type chain property', () => {
    const chainProps = [
      { type: TYPES[0]!, props: TYPE_PROPS[FOCUS_TYPE_ID]! },
      { type: TYPES[1]!, props: TYPE_PROPS[ANCESTOR_TYPE_ID]! },
    ];
    const tokens = module.buildTokensForField(chainProps, 'thought_ref', 'eq');
    const labels = tokens.map((t) => t.text);
    assert.ok(labels.includes('$thought'), 'thought id token for thought_ref');
    assert.ok(labels.includes('$thought.[версия]'), 'own property token');
    // The `теги` property is thought_ref + multiple: appears, marked listOnly.
    assert.ok(labels.includes('$thought.[теги]'), 'inherited multiple property token');
    // The `метка` property is text, doesn't match thought_ref — the
    // propertyMatches gate excludes it from scalar-op thought_ref values.
    assert.ok(!labels.includes('$thought.[метка]'), 'text property hidden for thought_ref');
    // Multi-valued property token is marked listOnly so the picker dims it.
    const tags = tokens.find((t) => t.text === '$thought.[теги]');
    assert.equal(tags?.listOnly, true);
    const version = tokens.find((t) => t.text === '$thought.[версия]');
    assert.notEqual(version?.listOnly, true);
  });

  it('token-picker global section includes $today/$now for date fields', () => {
    const chainProps = [{ type: TYPES[0]!, props: TYPE_PROPS[FOCUS_TYPE_ID]! }];
    const tokens = module.buildTokensForField(chainProps, 'date', 'eq');
    const labels = tokens.map((t) => t.text);
    assert.ok(labels.includes('$today'));
    assert.ok(labels.includes('$now'));
  });

  it('token-picker special fields: keywords / thought_type / author / editor', () => {
    const chainProps = [
      { type: TYPES[0]!, props: TYPE_PROPS[FOCUS_TYPE_ID]! },
      { type: TYPES[1]!, props: TYPE_PROPS[ANCESTOR_TYPE_ID]! },
    ];
    const keywords = module.buildTokensForSpecialField(chainProps, 'keywords');
    const kwTexts = keywords.map((t) => t.text);
    assert.ok(kwTexts.includes('$thought.title'));
    assert.ok(kwTexts.includes('$thought.synonyms'));
    assert.ok(kwTexts.includes('$thought.[метка]'), 'text property token');
    assert.ok(!kwTexts.includes('$thought.[версия]'), 'thought_ref property hidden for keywords');
    assert.ok(!kwTexts.includes('$thought.[теги]'), 'multiple thought_ref property hidden for keywords');

    const typeTok = module.buildTokensForSpecialField(chainProps, 'thought_type');
    assert.deepEqual(typeTok.map((t) => t.text), ['$thought.type']);

    const author = module.buildTokensForSpecialField(chainProps, 'author');
    const authorTexts = author.map((t) => t.text);
    assert.ok(authorTexts.includes('$thought.author'));
    assert.ok(authorTexts.includes('$user'));
    assert.ok(!authorTexts.includes('$thought.editor'));

    const editor = module.buildTokensForSpecialField(chainProps, 'editor');
    const editorTexts = editor.map((t) => t.text);
    assert.ok(editorTexts.includes('$thought.editor'));
    assert.ok(editorTexts.includes('$user'));
    assert.ok(!editorTexts.includes('$thought.author'));
  });

  it('list operations keep listOnly tokens (scalar ops hide them)', () => {
    const chainProps = [{ type: TYPES[1]!, props: TYPE_PROPS[ANCESTOR_TYPE_ID]! }];
    const tokensScalar = module.buildTokensForField(chainProps, 'thought_ref', 'eq');
    const tagsScalar = tokensScalar.find((t) => t.text === '$thought.[теги]');
    assert.equal(tagsScalar?.listOnly, true);
    const tokensList = module.buildTokensForField(chainProps, 'thought_ref', 'in');
    const tagsList = tokensList.find((t) => t.text === '$thought.[теги]');
    assert.equal(tagsList?.listOnly, true);
  });

  it('wire format: «Работы версии» round-trips a thought_ref condition with $thought.[версия]', () => {
    const state: import('../src/renderer/screens/thought-type/filter-dialog.js').DialogCriteriaState = {
      keywords: '',
      keywordInTitle: true,
      keywordInSynonyms: true,
      keywordInComment: false,
      parentIds: [],
      typeIds: [FOCUS_TYPE_ID],
      linkTypeIds: [],
      properties: [
        {
          propertyId: PROP_VERSION_ID,
          op: 'eq',
          values: ['$thought.[версия]'],
        },
      ],
      hasProperties: null,
      hasComment: null,
      hasAttachments: null,
      hasChronology: null,
      active: null,
      trashed: false,
      authorOp: 'eq',
      authorId: '',
      authorIds: [],
      editorOp: 'eq',
      editorId: '',
      editorIds: [],
      createdAfter: '',
      createdBefore: '',
      updatedAfter: '',
      updatedBefore: '',
      sort: 'created',
      order: 'asc',
    };
    const registry = new Map(REGISTRY.map((p) => [p.id, p]));
    const wire = module.buildWireDefinition(state, registry);
    assert.equal(wire.sort, 'created');
    assert.equal(wire.order, 'asc');
    assert.deepEqual(wire.type_ids, [FOCUS_TYPE_ID]);
    assert.ok(Array.isArray(wire.properties));
    assert.equal(wire.properties!.length, 1);
    assert.equal(wire.properties![0]!.property_id, PROP_VERSION_ID);
    assert.equal(wire.properties![0]!.op, 'eq');
    assert.equal(wire.properties![0]!.value, '$thought.[версия]');
    // The default keyword scope is title+synonyms — the wire omits it.
    assert.equal(wire.keyword_scope, undefined);
  });

  it('wire format: explicit keyword_scope is emitted when it differs from the default', () => {
    const state: import('../src/renderer/screens/thought-type/filter-dialog.js').DialogCriteriaState = {
      keywords: 'foo',
      keywordInTitle: false,
      keywordInSynonyms: true,
      keywordInComment: true,
      parentIds: [],
      typeIds: [],
      linkTypeIds: [],
      properties: [],
      hasProperties: null,
      hasComment: null,
      hasAttachments: null,
      hasChronology: null,
      active: null,
      trashed: false,
      authorOp: 'eq',
      authorId: '',
      authorIds: [],
      editorOp: 'eq',
      editorId: '',
      editorIds: [],
      createdAfter: '',
      createdBefore: '',
      updatedAfter: '',
      updatedBefore: '',
      sort: 'alpha',
      order: 'desc',
    };
    const registry = new Map<string, NetworkProperty>();
    const wire = module.buildWireDefinition(state, registry);
    assert.equal(wire.keywords, 'foo');
    assert.deepEqual(wire.keyword_scope, ['synonyms', 'comment']);
    assert.equal(wire.sort, 'alpha');
    assert.equal(wire.order, 'desc');
  });

  it('wire format: numeric property conditions are typed as numbers', () => {
    const numericPropId = 'p-priority';
    const registry = new Map<string, NetworkProperty>([
      [
        numericPropId,
        {
          id: numericPropId,
          name: 'приоритет',
          value_type: 'number' as PropertyValueType,
          config: null,
          description: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    ]);
    const state: import('../src/renderer/screens/thought-type/filter-dialog.js').DialogCriteriaState = {
      keywords: '',
      keywordInTitle: true,
      keywordInSynonyms: true,
      keywordInComment: false,
      parentIds: [],
      typeIds: [],
      linkTypeIds: [],
      properties: [{ propertyId: numericPropId, op: 'gt', values: ['5'] }],
      hasProperties: null,
      hasComment: null,
      hasAttachments: null,
      hasChronology: null,
      active: null,
      trashed: false,
      authorOp: 'eq',
      authorId: '',
      authorIds: [],
      editorOp: 'eq',
      editorId: '',
      editorIds: [],
      createdAfter: '',
      createdBefore: '',
      updatedAfter: '',
      updatedBefore: '',
      sort: 'created',
      order: 'asc',
    };
    const wire = module.buildWireDefinition(state, registry);
    assert.equal(wire.properties![0]!.op, 'gt');
    assert.equal(wire.properties![0]!.value, 5);
    assert.equal(typeof wire.properties![0]!.value, 'number');
  });

  it('wire format: bool property condition is typed as a boolean', () => {
    const boolPropId = 'p-active';
    const registry = new Map<string, NetworkProperty>([
      [
        boolPropId,
        {
          id: boolPropId,
          name: 'активно',
          value_type: 'bool' as PropertyValueType,
          config: null,
          description: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    ]);
    const state: import('../src/renderer/screens/thought-type/filter-dialog.js').DialogCriteriaState = {
      keywords: '',
      keywordInTitle: true,
      keywordInSynonyms: true,
      keywordInComment: false,
      parentIds: [],
      typeIds: [],
      linkTypeIds: [],
      properties: [{ propertyId: boolPropId, op: 'eq', values: ['true'] }],
      hasProperties: null,
      hasComment: null,
      hasAttachments: null,
      hasChronology: null,
      active: null,
      trashed: false,
      authorOp: 'eq',
      authorId: '',
      authorIds: [],
      editorOp: 'eq',
      editorId: '',
      editorIds: [],
      createdAfter: '',
      createdBefore: '',
      updatedAfter: '',
      updatedBefore: '',
      sort: 'created',
      order: 'asc',
    };
    const wire = module.buildWireDefinition(state, registry);
    assert.equal(wire.properties![0]!.value, true);
  });

  it('wire format: in/not_in operator carries an array of typed values', () => {
    const registry = new Map<string, NetworkProperty>([
      [
        PROP_LABEL_ID,
        {
          id: PROP_LABEL_ID,
          name: 'метка',
          value_type: 'text' as PropertyValueType,
          config: null,
          description: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    ]);
    const state: import('../src/renderer/screens/thought-type/filter-dialog.js').DialogCriteriaState = {
      keywords: '',
      keywordInTitle: true,
      keywordInSynonyms: true,
      keywordInComment: false,
      parentIds: [],
      typeIds: [],
      linkTypeIds: [],
      properties: [
        { propertyId: PROP_LABEL_ID, op: 'in', values: ['a', 'b', 'c'] },
      ],
      hasProperties: null,
      hasComment: null,
      hasAttachments: null,
      hasChronology: null,
      active: null,
      trashed: false,
      authorOp: 'eq',
      authorId: '',
      authorIds: [],
      editorOp: 'eq',
      editorId: '',
      editorIds: [],
      createdAfter: '',
      createdBefore: '',
      updatedAfter: '',
      updatedBefore: '',
      sort: 'created',
      order: 'asc',
    };
    const wire = module.buildWireDefinition(state, registry);
    assert.equal(wire.properties![0]!.op, 'in');
    assert.deepEqual(wire.properties![0]!.value, ['a', 'b', 'c']);
  });

  it('wire format: is_empty/not_empty emit an empty value', () => {
    const registry = new Map<string, NetworkProperty>([
      [
        PROP_LABEL_ID,
        {
          id: PROP_LABEL_ID,
          name: 'метка',
          value_type: 'text' as PropertyValueType,
          config: null,
          description: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    ]);
    const state: import('../src/renderer/screens/thought-type/filter-dialog.js').DialogCriteriaState = {
      keywords: '',
      keywordInTitle: true,
      keywordInSynonyms: true,
      keywordInComment: false,
      parentIds: [],
      typeIds: [],
      linkTypeIds: [],
      properties: [{ propertyId: PROP_LABEL_ID, op: 'is_empty', values: [''] }],
      hasProperties: null,
      hasComment: null,
      hasAttachments: null,
      hasChronology: null,
      active: null,
      trashed: false,
      authorOp: 'eq',
      authorId: '',
      authorIds: [],
      editorOp: 'eq',
      editorId: '',
      editorIds: [],
      createdAfter: '',
      createdBefore: '',
      updatedAfter: '',
      updatedBefore: '',
      sort: 'created',
      order: 'asc',
    };
    const wire = module.buildWireDefinition(state, registry);
    assert.equal(wire.properties![0]!.op, 'is_empty');
    assert.equal(wire.properties![0]!.value, '');
  });

  it('wire format: author/editor filters keep their op when not eq', () => {
    const state: import('../src/renderer/screens/thought-type/filter-dialog.js').DialogCriteriaState = {
      keywords: '',
      keywordInTitle: true,
      keywordInSynonyms: true,
      keywordInComment: false,
      parentIds: [],
      typeIds: [],
      linkTypeIds: [],
      properties: [],
      hasProperties: null,
      hasComment: null,
      hasAttachments: null,
      hasChronology: null,
      active: null,
      trashed: false,
      authorOp: 'in',
      authorId: '',
      authorIds: ['u1', 'u2'],
      editorOp: 'not_empty',
      editorId: '',
      editorIds: [],
      createdAfter: '',
      createdBefore: '',
      updatedAfter: '',
      updatedBefore: '',
      sort: 'created',
      order: 'asc',
    };
    const registry = new Map<string, NetworkProperty>();
    const wire = module.buildWireDefinition(state, registry);
    assert.deepEqual(wire.created_by, ['u1', 'u2']);
    assert.equal(wire.created_by_op, 'in');
    // not_empty emits nothing for updated_by, but the op hint is also omitted.
    assert.equal(wire.updated_by, undefined);
    assert.equal(wire.updated_by_op, undefined);
  });

  it('wire format: date bounds are trimmed and emitted only when non-empty', () => {
    const state: import('../src/renderer/screens/thought-type/filter-dialog.js').DialogCriteriaState = {
      keywords: '',
      keywordInTitle: true,
      keywordInSynonyms: true,
      keywordInComment: false,
      parentIds: [],
      typeIds: [],
      linkTypeIds: [],
      properties: [],
      hasProperties: null,
      hasComment: null,
      hasAttachments: null,
      hasChronology: null,
      active: null,
      trashed: false,
      authorOp: 'eq',
      authorId: '',
      authorIds: [],
      editorOp: 'eq',
      editorId: '',
      editorIds: [],
      createdAfter: '2024-01-01T00:00:00',
      createdBefore: '  ',
      updatedAfter: '',
      updatedBefore: '',
      sort: 'created',
      order: 'asc',
    };
    const registry = new Map<string, NetworkProperty>();
    const wire = module.buildWireDefinition(state, registry);
    assert.equal(wire.created_after, '2024-01-01T00:00:00');
    assert.equal(wire.created_before, undefined);
    assert.equal(wire.updated_after, undefined);
  });

  it('wire format: property conditions referencing an unknown property are dropped', () => {
    const state: import('../src/renderer/screens/thought-type/filter-dialog.js').DialogCriteriaState = {
      keywords: '',
      keywordInTitle: true,
      keywordInSynonyms: true,
      keywordInComment: false,
      parentIds: [],
      typeIds: [],
      linkTypeIds: [],
      properties: [{ propertyId: 'missing', op: 'contains', values: ['x'] }],
      hasProperties: null,
      hasComment: null,
      hasAttachments: null,
      hasChronology: null,
      active: null,
      trashed: false,
      authorOp: 'eq',
      authorId: '',
      authorIds: [],
      editorOp: 'eq',
      editorId: '',
      editorIds: [],
      createdAfter: '',
      createdBefore: '',
      updatedAfter: '',
      updatedBefore: '',
      sort: 'created',
      order: 'asc',
    };
    const registry = new Map<string, NetworkProperty>();
    const wire = module.buildWireDefinition(state, registry);
    assert.equal(wire.properties, undefined);
  });

  it('wire format: «Только актуальные» three-state maps to show_inactive/active (баг 56fdf252)', () => {
    const makeState = (active: boolean | null): import('../src/renderer/screens/thought-type/filter-dialog.js').DialogCriteriaState => ({
      keywords: '',
      keywordInTitle: true,
      keywordInSynonyms: true,
      keywordInComment: false,
      parentIds: [],
      typeIds: [],
      linkTypeIds: [],
      properties: [],
      hasProperties: null,
      hasComment: null,
      hasAttachments: null,
      hasChronology: null,
      active,
      trashed: false,
      authorOp: 'eq',
      authorId: '',
      authorIds: [],
      editorOp: 'eq',
      editorId: '',
      editorIds: [],
      createdAfter: '',
      createdBefore: '',
      updatedAfter: '',
      updatedBefore: '',
      sort: 'created',
      order: 'asc',
    });
    const registry = new Map<string, NetworkProperty>();

    // «не важно» (null) — без фильтра актуальности: показать и актуальные,
    // и неактуальные. `active` не выставляется, `show_inactive = true`.
    const all = module.buildWireDefinition(makeState(null), registry);
    assert.equal(all.active, undefined);
    assert.equal(all.show_inactive, true);

    // «да» (true) — только актуальные.
    const activeOnly = module.buildWireDefinition(makeState(true), registry);
    assert.equal(activeOnly.active, true);
    assert.equal(activeOnly.show_inactive, undefined);

    // «нет» (false) — только неактуальные: `active = false` + неактивные
    // включены в кандидатов.
    const inactiveOnly = module.buildWireDefinition(makeState(false), registry);
    assert.equal(inactiveOnly.active, false);
    assert.equal(inactiveOnly.show_inactive, true);
  });
});
