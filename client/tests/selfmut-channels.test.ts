/**
 * Own-mutation flag sources (S11, 08-ui-spec.md §2.2).
 *
 * The SERVER suppresses own echoes (04-realtime.md §5: `deliver` drops events
 * with `actor.client_id === conn.clientId`), so a client's own writes NEVER
 * come back over the realtime socket — the earlier attempt to flag them in
 * the WS pool was dead code. The invoke dispatcher therefore flags successful
 * mutating IPC calls with `realtime:selfmut`, and {@link selfMutationNetwork}
 * decides which methods count and extracts the mutated network id.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selfMutationNetwork } from '../src/main/ipc/handlers.js';

describe('selfMutationNetwork (realtime:selfmut flag)', () => {
  it('recognises mutating channels and takes the network id from the first arg', () => {
    const net = '253431e2-780d-466b-879e-6373f73fbad5';
    assert.equal(selfMutationNetwork('thoughts.update', [net, 't1', { title: 'x' }]), net);
    assert.equal(selfMutationNetwork('thoughts.create', [net, { title: 'x' }]), net);
    assert.equal(selfMutationNetwork('comments.create', [net, 'thought', 't1', {}]), net);
    assert.equal(selfMutationNetwork('comments.createMulti', [net, [], {}]), net);
    assert.equal(selfMutationNetwork('properties.set', [net, 'thought', 't1', 'k', 1]), net);
    assert.equal(selfMutationNetwork('links.remove', [net, 'l1', 3]), net);
    assert.equal(selfMutationNetwork('attachments.add', [net, {}]), net);
    assert.equal(selfMutationNetwork('trash.purge', [net]), net);
    assert.equal(selfMutationNetwork('system.importEtnx', [net, 'parent', 'x'.repeat(8)]), net);
  });

  it('ignores reads, local-only channels and non-branchable user state', () => {
    const net = '253431e2-780d-466b-879e-6373f73fbad5';
    // Reads.
    assert.equal(selfMutationNetwork('thoughts.get', [net, 't1']), null);
    assert.equal(selfMutationNetwork('comments.list', [net, 'thought', 't1']), null);
    assert.equal(selfMutationNetwork('layers.diff', [net, 'l1']), null);
    assert.equal(selfMutationNetwork('structures.query', [net, {}]), null);
    // Local-only / user-scoped / non-branchable.
    assert.equal(selfMutationNetwork('tabs.updateState', ['tab1', {}]), null);
    assert.equal(selfMutationNetwork('ui.setState', [net, 'k', 'v']), null);
    assert.equal(selfMutationNetwork('pins.set', [net, []]), null);
    assert.equal(selfMutationNetwork('thoughts.setFocusOrder', [net, 'f', {}]), null);
    assert.equal(selfMutationNetwork('types.createThoughtType', [net, {}]), null);
    assert.equal(selfMutationNetwork('networks.update', [net, {}]), null);
  });

  it('guards a malformed first argument', () => {
    assert.equal(selfMutationNetwork('thoughts.update', []), null);
    assert.equal(selfMutationNetwork('thoughts.update', [null]), null);
    assert.equal(selfMutationNetwork('thoughts.update', [42]), null);
    assert.equal(selfMutationNetwork('thoughts.update', ['']), null);
  });
});
