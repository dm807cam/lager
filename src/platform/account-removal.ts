import type { DatabaseSync } from 'node:sqlite';
import { LagerError } from '../errors.js';
import type { App, Apps, Instance } from './apps.js';
import type { User, Users } from './users.js';

/** What becomes of the apps and instances of a removed account: they go to `transferTo` (an account id), or to the trash. */
export type OwnedPlan = { transferTo: string } | { delete: true };

/**
 * Removes an account for good. An administrator does this to an account that is already deactivated, never to their own:
 * so nobody is removed while signed in and working, and the last active administrator can never be removed (an active one
 * is refused here, and deactivating the last one is refused by `Users.setDisabled`).
 */
export class AccountRemoval {
  private removedHooks: Array<(userId: string) => void> = [];

  constructor(private db: DatabaseSync, private users: Users, private apps: Apps) {}

  /** Runs after an account is gone for good, for what lives outside the platform database (its private areas in instances). */
  onRemoved(hook: (userId: string) => void): void { this.removedHooks.push(hook); }

  /** The apps the account owns and the instances that belong to it (of its own apps and of other people's). */
  owned(userId: string): { apps: App[]; instances: Instance[] } {
    return { apps: this.apps.listApps(userId), instances: this.apps.listInstancesOwnedBy(userId) };
  }

  /** Throws unless `by` may remove the account `userId` now; returns that account. */
  removable(userId: string, by: User): User {
    if (by.disabled || by.role !== 'admin') throw new LagerError('forbidden', 'Only an administrator can delete accounts.');
    const user = this.users.get(userId);
    if (!user) throw new LagerError('not_found', 'User not found.');
    if (user.id === by.id) throw new LagerError('conflict', 'You cannot delete your own account.', 'delete_self');
    if (!user.disabled) throw new LagerError('conflict', 'Deactivate the account before deleting it.', 'delete_active');
    return user;
  }

  /**
   * Removes the account and every row that points at it, in one transaction: what it owns goes where `plan` says (see
   * `Apps.releaseOwner`), then its sessions (they die with the row), API tokens, OAuth codes and tokens, reset and
   * confirmation links, the invitations it issued, the shares given to it, its group memberships and collaborator entries,
   * its agreements to sign in to instances (they go with the row) and its AI group (a column of the row). Shares and custom domains it set up for others stay and forget who added them.
   * The ids it left as author inside instance databases stay too: they simply no longer resolve to a person.
   *
   * Once that is committed the account is gone, whatever happens next. What follows works on files (moving deleted apps and
   * instances to the trash, the delete hooks, the `onRemoved` hooks) and can fail on its own: every step runs, failures are
   * logged, and `cleanedUp` tells the caller whether all of it went through. A hook may only start its work (the pass over every
   * instance's private area runs in the background and reports in the log); `cleanedUp` then says that it was started.
   */
  remove(userId: string, by: User, plan: OwnedPlan): { cleanedUp: boolean } {
    const user = this.removable(userId, by);
    const cleanUp = this.apps.releaseOwner(user.id, { transferTo: 'transferTo' in plan ? plan.transferTo : undefined, heirId: by.id }, () => {
      const run = (sql: string, ...params: string[]): void => { this.db.prepare(sql).run(...params); };
      run('DELETE FROM api_tokens WHERE user_id = ?', user.id);
      run('DELETE FROM oauth_tokens WHERE user_id = ?', user.id);
      run('DELETE FROM oauth_codes WHERE user_id = ?', user.id);
      run('DELETE FROM account_tokens WHERE user_id = ? OR created_by = ?', user.id, user.id);
      run('DELETE FROM group_members WHERE user_id = ?', user.id);
      run("DELETE FROM grants WHERE principal_type = 'user' AND principal_id = ?", user.id);
      run('UPDATE grants SET created_by = NULL WHERE created_by = ?', user.id);
      run('UPDATE instance_domains SET created_by = NULL WHERE created_by = ?', user.id);
      // Last: the foreign keys refuse this while an app, an instance, a version or a credential still names the account.
      run('DELETE FROM users WHERE id = ?', user.id);
    });
    let cleanedUp = true;
    for (const step of [cleanUp, ...this.removedHooks.map((hook) => () => hook(user.id))]) {
      try {
        step();
      } catch (e) {
        cleanedUp = false;
        console.error(`lager: the account ${user.id} was deleted, but cleaning up after it failed:`, e);
      }
    }
    return { cleanedUp };
  }
}
