import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openPlatformDb } from '../src/platform/db.js';
import { Settings } from '../src/platform/settings.js';

describe('Settings', () => {
  it('defaults and persistence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-settings-'));
    let db = openPlatformDb(dir);
    let s = new Settings(db, { registration: 'invite' });
    expect(s.registration).toBe('invite');
    expect(s.maxInstancesPerUser).toBe(20);
    s.setRegistration('open');
    s.setMaxInstancesPerUser(5);
    expect(s.registration).toBe('open');
    db.close();

    db = openPlatformDb(dir);
    s = new Settings(db, { registration: 'closed' });
    expect(s.registration).toBe('open');
    expect(s.maxInstancesPerUser).toBe(5);
    for (const n of [0, 1001, 1.5, NaN]) {
      expect(() => s.setMaxInstancesPerUser(n)).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    }
    expect(() => s.setRegistration('bogus' as never)).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    s.setMaxInstancesPerUser(1000);
    expect(s.maxInstancesPerUser).toBe(1000);
    db.close();
  });
});
