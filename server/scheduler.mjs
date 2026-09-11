// Background scheduler — housekeeping only. Single-writer via a MariaDB
// advisory lock, so several backend instances can be online without running
// jobs in parallel. Jobs are idempotent and cheap.
//
// Integration syncing (Twitch/YouTube/social) intentionally does NOT live
// here: the Nappa Bot on Craftnode owns external API traffic and pushes
// results to /api/bot/state. The dashboard never polls external APIs.

import { config } from './config.mjs';
import { withAdvisoryLock, exec, isoToDb, nowIso } from './db.mjs';
import { purgeExpiredSessions } from './auth.mjs';
import { log, describeError } from './log.mjs';

const LOCK_NAME = 'growth-hub-scheduler';

async function housekeeping() {
  const sessions = await purgeExpiredSessions();
  // Retire invites that expired (or were claimed) more than 30 days ago — the
  // table otherwise grows forever with dead tokens.
  const cutoff = isoToDb(new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());
  const invites = await exec(
    'DELETE FROM growth_hub_invites WHERE expires_at < ? AND claimed_at IS NOT NULL',
    [cutoff],
  );
  return { sessions, invites: invites.affectedRows };
}

export function startScheduler() {
  if (!config.scheduler) {
    log.info('scheduler disabled (ENABLE_SCHEDULER=0)');
    return () => {};
  }
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const ran = await withAdvisoryLock(LOCK_NAME, async () => {
        const result = await housekeeping();
        if (result.sessions || result.invites) {
          log.info('scheduler housekeeping:', JSON.stringify(result));
        }
      });
      if (!ran) { /* another instance holds the lock — by design */ }
    } catch (err) {
      log.error('scheduler tick failed:', describeError(err));
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(tick, config.schedulerIntervalMs);
  timer.unref();
  // First run shortly after boot (init settle time).
  const initial = setTimeout(tick, 30 * 1000);
  initial.unref();
  log.info('scheduler started: housekeeping every', Math.round(config.schedulerIntervalMs / 60000), 'min');
  return () => { clearInterval(timer); clearTimeout(initial); };
}
