/**
 * Unit tests for the «Метаданные» formatting helper (задача 04cd9794).
 *
 * The renderer is exercised end-to-end via the Electron build; under Node the
 * DOM-free helpers (formatDateTime) are tested directly. The DOM-coupled
 * buildMetadataBlock / buildMetadataRows / renderAuthorPair live in
 * client/src/renderer/lib/metadata.ts and use the real DOM — that is covered
 * by the manual smoke check (typecheck + Electron dev session).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatDateTime } from '../src/renderer/lib/metadata.js';

describe('formatDateTime', () => {
  it('returns «—» for null / empty input', () => {
    assert.equal(formatDateTime(null), '—');
    assert.equal(formatDateTime(''), '—');
  });

  it('formats unix milliseconds with second precision (yyyy-MM-dd hh:mm:ss)', () => {
    // 2025-01-01T12:34:56Z — anchored UTC; the test asserts the wall-clock
    // shape (YYYY-MM-DD HH:MM:SS) without locking the timezone-dependent
    // hour, since CI machines can run with different default TZs.
    const text = formatDateTime(1_735_734_896_000);
    assert.match(text, /^2025-01-01 \d{2}:\d{2}:\d{2}$/, `unexpected shape: ${text}`);
  });

  it('accepts an ISO string', () => {
    const text = formatDateTime('2025-06-15T09:00:00.000Z');
    assert.match(text, /^\d{4}-06-15 \d{2}:\d{2}:\d{2}$/, `unexpected shape: ${text}`);
  });

  it('accepts a numeric string of milliseconds', () => {
    const text = formatDateTime('1735734896000');
    assert.match(text, /2025-01-01/, 'renders the date part');
    assert.match(text, /\d{2}:\d{2}:\d{2}/, 'renders seconds-precision time');
  });

  it('returns «—» for an unparseable input', () => {
    assert.equal(formatDateTime('not a date'), '—');
  });
});
