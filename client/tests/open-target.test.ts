/**
 * Unit tests for the «open externally» target classification (main process).
 * Pure TS — no Electron runtime required. Guards the URL-attachment/property
 * open path: local paths and file:// go to shell.openPath, web and custom
 * registered protocols (obsidian://, …) to shell.openExternal, dangerous
 * schemes are refused with a reason surfaced to the user.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyOpenTarget } from '../src/main/ipc/open-target.js';

/** Narrows the union to the `refused` variant and returns its reason. */
function refuseReason(raw: string): string {
  const res = classifyOpenTarget(raw);
  assert.equal(res.kind, 'refused');
  if (res.kind !== 'refused') throw new Error('expected the refused variant');
  return res.reason;
}

describe('classifyOpenTarget', () => {
  it('classifies web and custom-protocol URLs as external', () => {
    assert.deepEqual(classifyOpenTarget('https://example.com/page?x=1'), {
      kind: 'external',
      url: 'https://example.com/page?x=1',
    });
    assert.deepEqual(classifyOpenTarget('  http://localhost:3000  '), {
      kind: 'external',
      url: 'http://localhost:3000',
    });
    assert.deepEqual(classifyOpenTarget('obsidian://open?vault=myvault'), {
      kind: 'external',
      url: 'obsidian://open?vault=myvault',
    });
    assert.deepEqual(classifyOpenTarget('mailto:someone@example.com'), {
      kind: 'external',
      url: 'mailto:someone@example.com',
    });
  });

  it('classifies Windows/UNC paths as local paths', () => {
    assert.deepEqual(classifyOpenTarget('C:\\docs\\report.pdf'), {
      kind: 'path',
      path: 'C:\\docs\\report.pdf',
    });
    assert.deepEqual(classifyOpenTarget('C:/docs/report.pdf'), {
      kind: 'path',
      path: 'C:/docs/report.pdf',
    });
    // A drive letter without a separator looks like a 1-char scheme — still a path.
    assert.deepEqual(classifyOpenTarget('C:docs\\report.pdf'), {
      kind: 'path',
      path: 'C:docs\\report.pdf',
    });
    assert.deepEqual(classifyOpenTarget('\\\\server\\share\\file.txt'), {
      kind: 'path',
      path: '\\\\server\\share\\file.txt',
    });
    // No scheme at all — treated as a (relative) path, openPath reports errors.
    assert.deepEqual(classifyOpenTarget('docs/report.pdf'), {
      kind: 'path',
      path: 'docs/report.pdf',
    });
  });

  it('decodes file:// URLs into local paths', () => {
    const decoded = classifyOpenTarget('file:///C:/My%20Docs/report.pdf');
    assert.equal(decoded.kind, 'path');
    if (decoded.kind !== 'path') return;
    assert.ok(!decoded.path.includes('%20'), 'percent-encoding is decoded');
    // Exact path spelling is platform-specific; the project targets Windows.
    if (process.platform === 'win32') {
      assert.equal(decoded.path, 'C:\\My Docs\\report.pdf');
      const unc = classifyOpenTarget('file://server/share/file.txt');
      assert.deepEqual(unc, { kind: 'path', path: '\\\\server\\share\\file.txt' });
    }
  });

  it('refuses dangerous schemes and empty input with a reason', () => {
    assert.match(refuseReason('javascript:alert(1)'), /не поддерживается/);
    assert.match(refuseReason('data:text/html,hi'), /не поддерживается/);
    assert.match(refuseReason('vbscript:msgbox'), /не поддерживается/);
    assert.match(refuseReason('blob:https://x'), /не поддерживается/);
    assert.match(refuseReason('   '), /Пустой адрес/);
    // A file URL that cannot decode to a path is refused, not opened.
    if (process.platform === 'win32') {
      assert.match(refuseReason('file:'), /file/);
    }
  });
});
