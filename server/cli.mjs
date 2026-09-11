// Admin CLI (runs on the host, never over HTTP):
//   node server/cli.mjs db:check
//   node server/cli.mjs user:create            (uses OWNER_EMAIL / OWNER_PASSWORD env, or args)
//   node server/cli.mjs user:password [email]  (rotates password, env OWNER_PASSWORD or arg)
//   node server/cli.mjs user:list
//
// Prefer environment variables so passwords don't end up in shell history:
//   OWNER_EMAIL=me@example.com OWNER_PASSWORD='…' npm run user:create

import { config } from './config.mjs';
import { runUp } from './migrate.mjs';
import { query, closePool, pingDb } from './db.mjs';
import { createUser, setUserPassword, findUserByEmail, hashPassword } from './auth.mjs';
import { maskEmail, describeError } from './log.mjs';

const cmd = process.argv[2] || '';
const arg1 = process.argv[3] || '';
const arg2 = process.argv[4] || '';

async function main() {
  switch (cmd) {
    case 'db:check': {
      const ok = await pingDb().catch(() => false);
      const rows = ok ? await query('SELECT COUNT(*) AS users, (SELECT COUNT(*) FROM dashboard_state) AS states, (SELECT COUNT(*) FROM sessions) AS sessions FROM users') : [];
      console.log(JSON.stringify({
        db: ok ? 'reachable' : 'unreachable',
        name: config.db.name,
        host: `${config.db.host}:${config.db.port}`,
        ...(rows[0] ? { users: rows[0].users, states: rows[0].states, sessions: rows[0].sessions } : {}),
      }, null, 2));
      process.exit(ok ? 0 : 1);
    }

    case 'user:create': {
      const email = (arg1 || config.ownerEmail || '').toLowerCase();
      const password = arg2 || config.ownerPassword || '';
      if (!email || !email.includes('@')) {
        console.error('usage: user:create <email> <password>  (or set OWNER_EMAIL / OWNER_PASSWORD)');
        process.exit(1);
      }
      if (password.length < 8) {
        console.error('password must be at least 8 characters');
        process.exit(1);
      }
      await runUp({ quiet: true }).catch(() => {});
      const existing = await findUserByEmail(email);
      if (existing) {
        console.error(`a user with that email already exists (${maskEmail(existing.email)}) — use user:password to rotate`);
        process.exit(1);
      }
      const user = await createUser(email, password);
      console.log(`created user ${maskEmail(user.email)} (id ${user.id}) — they become the owner on first login unless OWNER_EMAIL overrides`);
      break;
    }

    case 'user:password': {
      const email = (arg1 || config.ownerEmail || '').toLowerCase();
      const password = arg2 || config.ownerPassword || '';
      if (!email || !email.includes('@')) {
        console.error('usage: user:password <email> <new-password>');
        process.exit(1);
      }
      if (password.length < 8) {
        console.error('password must be at least 8 characters');
        process.exit(1);
      }
      const user = await findUserByEmail(email);
      if (!user) {
        console.error(`no user found for ${maskEmail(email)}`);
        process.exit(1);
      }
      await setUserPassword(user.id, password);
      console.log(`password rotated for ${maskEmail(email)} — all their sessions were signed out`);
      break;
    }

    case 'user:list': {
      const rows = await query('SELECT id, email, (password_hash IS NOT NULL) AS has_password, created_at, last_seen_at FROM users ORDER BY created_at');
      for (const r of rows) {
        console.log(`${r.id}  ${maskEmail(r.email)}  password:${r.has_password ? 'yes' : 'no'}  created:${r.created_at}  lastSeen:${r.last_seen_at || '-'}`);
      }
      break;
    }

    default:
      console.error('usage: node server/cli.mjs <db:check|user:create|user:password|user:list>');
      process.exit(1);
  }
  await closePool();
}

// referenced for linters: hashing happens inside createUser/setUserPassword.
void hashPassword;

main().catch(err => {
  console.error('CLI failed:', describeError(err));
  process.exit(1);
});
