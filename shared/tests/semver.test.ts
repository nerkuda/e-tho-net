/**
 * Unit tests for `shared/src/semver.ts` — the single semver parsing, precedence
 * comparison and minor-window compatibility range used by `@etn/server` and
 * `@etn/client`.
 *
 * Inputs are the project's real release versions (0.14.1, 0.15.0, 0.15.1, the
 * next release line 0.16.0) plus the prereleases named in the compatibility
 * requirement: `0.15.1-rc.1` belongs to the 0.15.x window, `0.16.0-rc.1` does
 * not, because compatibility is defined by the (major, minor) pair.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compareSemver, compatibilityRangeFor, parseSemver, satisfiesRange } from '../src/semver.js';

describe('parseSemver', () => {
  it('parses a release version', () => {
    assert.deepEqual(parseSemver('0.15.1'), {
      major: 0,
      minor: 15,
      patch: 1,
      prerelease: [],
    });
  });

  it('parses a prerelease version into identifiers', () => {
    assert.deepEqual(parseSemver('0.15.1-rc.1'), {
      major: 0,
      minor: 15,
      patch: 1,
      prerelease: ['rc', '1'],
    });
    assert.deepEqual(parseSemver('1.0.0-alpha-2.hotfix.7')?.prerelease, ['alpha-2', 'hotfix', '7']);
  });

  it('accepts leading zeros and normalises them numerically', () => {
    assert.deepEqual(parseSemver('00.015.001'), {
      major: 0,
      minor: 15,
      patch: 1,
      prerelease: [],
    });
  });

  it('accepts build metadata but keeps it out of the parsed shape', () => {
    assert.deepEqual(parseSemver('0.15.1+build.7'), {
      major: 0,
      minor: 15,
      patch: 1,
      prerelease: [],
    });
    assert.deepEqual(parseSemver('0.15.1-rc.1+build.7')?.prerelease, ['rc', '1']);
  });

  it('returns null for malformed versions', () => {
    const malformed = [
      '',
      ' ',
      '0.15',
      '0.15.0.0',
      'v0.15.0',
      'V0.15.0',
      'garbage',
      '0.15.x',
      '>=0.15.0 <0.16.0',
      '0.15.0-',
      '0.15.0-rc..1',
      '0.15.0+',
      '-0.15.0',
      '0.15.0 ',
      ' 0.15.0',
      '9007199254740992.0.0',
    ];
    for (const input of malformed) {
      assert.equal(parseSemver(input), null, JSON.stringify(input));
    }
  });

  it('returns null for non-string values from JSON or headers', () => {
    assert.equal(parseSemver(undefined), null);
    assert.equal(parseSemver(null), null);
  });
});

describe('compareSemver', () => {
  it('orders numeric components numerically, not lexicographically', () => {
    assert.equal(compareSemver('0.9.0', '0.10.0'), -1);
    assert.equal(compareSemver('0.10.0', '0.9.0'), 1);
    assert.equal(compareSemver('0.15.2', '0.15.10'), -1);
    assert.equal(compareSemver('0.15.1', '0.15.1'), 0);
  });

  it('ignores build metadata in precedence', () => {
    assert.equal(compareSemver('0.15.1', '0.15.1+build.7'), 0);
    assert.equal(compareSemver('0.15.1+abc', '0.15.1+xyz'), 0);
  });

  it('ranks a release above its prereleases', () => {
    assert.equal(compareSemver('0.15.1-rc.1', '0.15.1'), -1);
    assert.equal(compareSemver('0.15.1', '0.15.1-rc.1'), 1);
  });

  it('compares numeric prerelease identifiers numerically', () => {
    assert.equal(compareSemver('0.15.1-rc.2', '0.15.1-rc.10'), -1);
    assert.equal(compareSemver('0.15.1-rc.010', '0.15.1-rc.2'), 1);
  });

  it('ranks numeric prerelease identifiers below alphanumeric ones', () => {
    assert.equal(compareSemver('0.15.0-1', '0.15.0-alpha'), -1);
    assert.equal(compareSemver('0.15.0-alpha', '0.15.0-1'), 1);
  });

  it('ranks a longer prerelease above its prefix', () => {
    assert.equal(compareSemver('0.15.0-alpha', '0.15.0-alpha.1'), -1);
    assert.equal(compareSemver('0.15.0-alpha.1', '0.15.0-alpha'), 1);
  });

  it('compares alphanumeric identifiers in ASCII order, not by locale', () => {
    assert.equal(compareSemver('0.15.0-RC.1', '0.15.0-rc.1'), -1);
  });

  it('returns null when either side is not a version', () => {
    assert.equal(compareSemver('0.15.1', 'garbage'), null);
    assert.equal(compareSemver('', '0.15.1'), null);
    assert.equal(compareSemver(undefined, '0.15.1'), null);
  });
});

describe('compatibilityRangeFor', () => {
  it('builds the minor window from the server version', () => {
    assert.equal(compatibilityRangeFor('0.15.1'), '>=0.15.0 <0.16.0');
    assert.equal(compatibilityRangeFor('0.14.1'), '>=0.14.0 <0.15.0');
  });

  it('uses only major and minor — patch, prerelease and build are dropped', () => {
    assert.equal(compatibilityRangeFor('0.15.1-rc.1'), '>=0.15.0 <0.16.0');
    assert.equal(compatibilityRangeFor('0.15.0+build.9'), '>=0.15.0 <0.16.0');
  });

  it('increments the minor numerically', () => {
    assert.equal(compatibilityRangeFor('1.99.3'), '>=1.99.0 <1.100.0');
    assert.equal(compatibilityRangeFor('2.0.0'), '>=2.0.0 <2.1.0');
  });

  it('returns null for an invalid version instead of a default range', () => {
    assert.equal(compatibilityRangeFor(''), null);
    assert.equal(compatibilityRangeFor('v0.15.0'), null);
    assert.equal(compatibilityRangeFor(undefined), null);
  });
});

describe('satisfiesRange — minor window', () => {
  const range = '>=0.15.0 <0.16.0';

  it('accepts the lower boundary and later patches of the same minor', () => {
    assert.equal(satisfiesRange('0.15.0', range), true);
    assert.equal(satisfiesRange('0.15.1', range), true);
    assert.equal(satisfiesRange('0.15.99', range), true);
  });

  it('accepts a prerelease of the same minor', () => {
    assert.equal(satisfiesRange('0.15.1-rc.1', range), true);
  });

  it('rejects a prerelease of the next minor — the pair is compared, not the string', () => {
    assert.equal(satisfiesRange('0.16.0-rc.1', range), false);
  });

  it('rejects versions outside the window', () => {
    assert.equal(satisfiesRange('0.14.9', range), false);
    assert.equal(satisfiesRange('0.14.99', range), false);
    assert.equal(satisfiesRange('0.16.0', range), false);
    assert.equal(satisfiesRange('1.0.0-rc.1', range), false);
  });

  it('rejects a prerelease older than the lower boundary', () => {
    assert.equal(satisfiesRange('0.15.0-rc.1', range), false);
  });

  it('accepts only the two-bound range grammar', () => {
    assert.equal(satisfiesRange('0.15.1', '>=0.15.0'), false);
    assert.equal(satisfiesRange('0.15.1', '>=0.15.0 <=0.16.0'), false);
    assert.equal(satisfiesRange('0.15.1', '0.15.1'), false);
    assert.equal(satisfiesRange('0.15.1', '>=0.15 <0.16.0'), false);
    assert.equal(satisfiesRange('0.15.1', '>= 0.15.0 < 0.16.0'), false);
  });

  it('the upper bound is exclusive by pair — a non-boundary upper matches nothing', () => {
    // The window is defined by the upper bound's major.minor, so `0.15.4` as an
    // upper bound still closes the whole 0.15 line: the pair never becomes less.
    assert.equal(satisfiesRange('0.15.0', '>=0.15.0 <0.15.4'), false);
    assert.equal(satisfiesRange('0.15.3', '>=0.15.0 <0.15.4'), false);
  });

  it('returns false for garbage on either side without throwing', () => {
    assert.equal(satisfiesRange('', range), false);
    assert.equal(satisfiesRange('0.15', range), false);
    assert.equal(satisfiesRange('v0.15.1', range), false);
    assert.equal(satisfiesRange(undefined, range), false);
    assert.equal(satisfiesRange('0.15.1', ''), false);
    assert.equal(satisfiesRange('0.15.1', 'garbage'), false);
    assert.equal(satisfiesRange('0.15.1', undefined), false);
  });
});

describe('compatibility window invariants', () => {
  const versions = ['0.15.0', '0.15.1', '0.15.99', '0.15.1-rc.1', '1.0.0', '1.99.3'];

  it('every valid version satisfies the range generated from itself', () => {
    for (const version of versions) {
      const range = compatibilityRangeFor(version);
      assert.ok(range !== null, `range for ${version}`);
      assert.equal(satisfiesRange(version, range), true, `${version} in ${range}`);
    }
  });

  it('a prerelease of the next minor never satisfies the generated range', () => {
    for (const version of versions) {
      const range = compatibilityRangeFor(version);
      const parsed = parseSemver(version);
      assert.ok(range !== null, `range for ${version}`);
      assert.ok(parsed !== null, `parse ${version}`);
      const nextMinorPrerelease = `${parsed.major}.${parsed.minor + 1}.0-rc.1`;
      assert.equal(
        satisfiesRange(nextMinorPrerelease, range),
        false,
        `${nextMinorPrerelease} must be outside ${range}`,
      );
    }
  });

  it('adjacent minors are never mutually compatible', () => {
    const current = compatibilityRangeFor('0.15.1');
    const previous = compatibilityRangeFor('0.14.1');
    assert.ok(current !== null);
    assert.ok(previous !== null);
    assert.equal(satisfiesRange('0.14.1', current), false);
    assert.equal(satisfiesRange('0.15.1', previous), false);
    assert.equal(satisfiesRange('0.16.0', current), false);
    assert.equal(satisfiesRange('0.15.1', compatibilityRangeFor('0.16.0') ?? ''), false);
  });
});
