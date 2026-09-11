// Growth Hub backend — entry point.
//
//   HOST/PORT + DB_* + OWNER_* + BOT_SYNC_TOKEN + … (see .env.example)
//   node server/index.mjs
//
// Boot order: optional auto-migrations → owner provisioning → static app +
// /api routes on one origin → scheduler → graceful shutdown.

import http from 'node:http';
import { config, assertSafeConfig, redactedConfigSummary } from './config.mjs';
import { log, describeError } from './log.mjs';
import { runUp } from './migrate.mjs';
import { closePool } from './db.mjs';
import { provisionOwnerIfNeeded } from './auth.mjs';
import { startScheduler } from './scheduler.mjs';
import { ensureStorageRoot } from './storage.mjs';
import {
  matchRoute, methodNotAllowed, notFound, handleRouteError, badOrigin, sendJson,
} from './http.mjs';
import { serveStatic } from './static.mjs';
import { routes as userRoutes } from './routes/user.mjs';
import { routes as stateRoutes } from './routes/state.mjs';
import { routes as memberRoutes } from './routes/members.mjs';
import { routes as notesRoutes } from './routes/notes.mjs';
import { routes as clipRoutes } from './routes/clips.mjs';
import { routes as botRoutes } from './routes/bot.mjs';

const ALL_ROUTES = [
  ...userRoutes,
  ...stateRoutes,
  ...memberRoutes,
  ...notesRoutes,
  ...clipRoutes,
  ...botRoutes,
];

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    // API: same-origin guard on mutations (CSRF hardening for cookie auth).
    if (pathname.startsWith('/api/')) {
      if (MUTATING.has(req.method) && badOrigin(req, config.appOrigin)) {
        return sendJson(res, { error: 'bad_origin' }, { status: 403 });
      }
      const hit = matchRoute(ALL_ROUTES, req.method, pathname);
      if (!hit) return notFound(res);
      if (hit.methodNotAllowed) return methodNotAllowed(res);
      try {
        return await hit.route.handler({ req, res, params: hit.params, url });
      } catch (err) {
        return handleRouteError(res, err, `api ${req.method} ${pathname}`);
      }
    }

    // Everything else: allowlisted static files only.
    if (req.method === 'GET' || req.method === 'HEAD') {
      const served = await serveStatic(req, res, pathname === '' ? '/' : pathname);
      if (served) return;
      return notFound(res);
    }
    return methodNotAllowed(res);
  } catch (err) {
    return handleRouteError(res, err, 'http');
  }
});

// Basic hardening: request ceiling & socket hygiene.
server.requestTimeout = 300_000;      // slow clip uploads allowed
server.headersTimeout = 30_000;
server.keepAliveTimeout = 75_000;
server.maxRequestsPerSocket = 0;

async function main() {
  for (const problem of assertSafeConfig()) log.warn('config:', problem);
  log.info('startup config:', JSON.stringify(redactedConfigSummary()));

  if (config.autoMigrate) {
    await runUp({ quiet: false });
  }
  await ensureStorageRoot();
  await provisionOwnerIfNeeded();

  server.listen(config.port, config.host, () => {
    log.info(`listening on http://${config.host}:${config.port}`);
    startScheduler();
  });
}

async function shutdown(signal) {
  log.info(`shutdown (${signal}) — draining…`);
  server.closeIdleConnections?.();
  server.close(async () => {
    try { await closePool(); } catch { /* ignore */ }
    process.exit(0);
  });
  // Hard exit if drain stalls (uploads in flight etc.)
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch(err => {
  log.error('fatal boot failure:', describeError(err));
  process.exit(1);
});
