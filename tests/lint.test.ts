import { describe, expect, it } from 'vitest';
import { lintArtifact } from '../src/platform/lint.js';

describe('lintArtifact', () => {
  it('warns on browser storage', () => {
    expect(lintArtifact('<script>localStorage.setItem("a","b")</script>')).toHaveLength(1);
    expect(lintArtifact('<script>sessionStorage.x; indexedDB.open("d")</script>')).toHaveLength(2);
    expect(lintArtifact('<p>no storage</p>')).toEqual([]);
  });
});
