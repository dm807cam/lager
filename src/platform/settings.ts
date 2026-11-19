import type { DatabaseSync } from 'node:sqlite';
import { LagerError } from '../errors.js';

export type RegistrationMode = 'open' | 'invite' | 'closed';
/** Who may attach custom domains to an instance: administrators only, or also publishers who manage it. */
export type CustomDomainsMode = 'admins' | 'publishers';
const DOMAIN_MODES: readonly CustomDomainsMode[] = ['admins', 'publishers'];
const MODES: readonly RegistrationMode[] = ['open', 'invite', 'closed'];
const DEFAULT_MAX_INSTANCES = 20;
const MAX_INSTANCES_LIMIT = 1000;

/** Instance-wide settings persisted in the `settings` table; `defaults` apply until a value is stored. */
export class Settings {
  constructor(private db: DatabaseSync, private defaults: { registration: RegistrationMode }) {}

  private read(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  private write(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  get registration(): RegistrationMode {
    const v = this.read('registration');
    return MODES.includes(v as RegistrationMode) ? (v as RegistrationMode) : this.defaults.registration;
  }

  setRegistration(mode: RegistrationMode): void {
    if (!MODES.includes(mode)) throw new LagerError('invalid_argument', 'Registration must be open, invite or closed.');
    this.write('registration', mode);
  }

  get maxInstancesPerUser(): number {
    const n = Number(this.read('max_instances_per_user'));
    return Number.isInteger(n) && n >= 1 && n <= MAX_INSTANCES_LIMIT ? n : DEFAULT_MAX_INSTANCES;
  }

  setMaxInstancesPerUser(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > MAX_INSTANCES_LIMIT) {
      throw new LagerError('invalid_argument', `Instance limit must be a whole number from 1 to ${MAX_INSTANCES_LIMIT}.`);
    }
    this.write('max_instances_per_user', String(n));
  }

  get customDomains(): CustomDomainsMode {
    const v = this.read('custom_domains');
    return DOMAIN_MODES.includes(v as CustomDomainsMode) ? (v as CustomDomainsMode) : 'admins';
  }

  setCustomDomains(mode: CustomDomainsMode): void {
    if (!DOMAIN_MODES.includes(mode)) throw new LagerError('invalid_argument', 'Custom domains must be admins or publishers.');
    this.write('custom_domains', mode);
  }
}
