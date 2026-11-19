/** Instances looked at before the pass lets everything else that waits on the event loop run. */
export const PURGE_INSTANCES_PER_TURN = 10;

/**
 * Removes the private areas of deleted accounts from every instance, in the background. Each instance has a database file of its
 * own that must be opened, so with many instances one pass takes seconds: it runs after the administrator's request was answered,
 * a few instances per turn of the event loop, and an area larger than one call removes is continued until nothing is left.
 *
 * Nothing about a pass is stored. `stop` (at shutdown) ends it between two calls; what it had not reached stays, and a restart
 * does not take it up again. Running a pass twice is harmless.
 */
export class PrivatePurge {
  private stopped = false;
  private passes = new Set<Promise<void>>();

  /**
   * `purge` removes up to `limit` documents of the account's private area from one instance and returns how many went
   * (`InstanceData.purgePrivateArea`).
   */
  constructor(
    private purge: (instanceId: string, userId: string) => number, private limit: number,
    private log: Pick<Console, 'log' | 'error'> = console,
  ) {}

  /** Starts a pass over `instanceIds` for the deleted account; returns at once. */
  start(userId: string, instanceIds: string[]): void {
    const pass = this.run(userId, instanceIds).finally(() => { this.passes.delete(pass); });
    this.passes.add(pass);
  }

  /** Resolves when no pass is running any more (finished or stopped). */
  async idle(): Promise<void> {
    while (this.passes.size > 0) await Promise.all(this.passes);
  }

  /** No further database is touched after this; for shutdown, before the databases close. */
  stop(): void { this.stopped = true; }

  private async run(userId: string, instanceIds: string[]): Promise<void> {
    const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
    let documents = 0;
    let failed = 0;
    let firstError: unknown;
    try {
      // Not before the request that deleted the account has been answered.
      await turn();
      for (let i = 0; i < instanceIds.length; i++) {
        if (i > 0 && i % PURGE_INSTANCES_PER_TURN === 0) await turn();
        try {
          for (;;) {
            if (this.stopped) {
              this.log.log(`lager: removing the private data of the deleted account ${userId} from other instances was interrupted by the shutdown after ${i} of ${instanceIds.length} instances. It is not continued after a restart.`);
              return;
            }
            const removed = this.purge(instanceIds[i], userId);
            documents += removed;
            if (removed < this.limit) break;
            await turn();
          }
        } catch (e) {
          failed += 1;
          firstError ??= e;
        }
      }
    } catch (e) {
      failed += 1;
      firstError ??= e;
    }
    if (failed > 0) {
      this.log.error(`lager: removing the private data of the deleted account ${userId} failed in ${failed} of ${instanceIds.length} instances (${documents} documents were removed elsewhere). The first error:`, firstError);
    } else {
      this.log.log(`lager: removed the private data of the deleted account ${userId} from other instances: ${documents} documents in ${instanceIds.length} instances.`);
    }
  }
}
