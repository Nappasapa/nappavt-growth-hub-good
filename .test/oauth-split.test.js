// OAuth split regression tests: YouTube and Google Drive must remain TWO
// independent Google connections.
//
// Background: Google rejects a single authorization request combining
//   https://www.googleapis.com/auth/yt-analytics.readonly
//   https://www.googleapis.com/auth/youtube.readonly
//   https://www.googleapis.com/auth/drive.file
// with Error 400 (invalid_request — "scopes that cannot be requested
// together"). This suite locks in the split:
//   1. YOUTUBE CONNECTION (Craftnode backend): youtube.readonly +
//      yt-analytics.readonly only — channel access / analytics.
//   2. GOOGLE DRIVE CONNECTION (browser GIS): drive.file only — clip
//      uploads / resumable uploads / Growth-Hub-created files.
// It also verifies the UI exposes each as CONNECTED / REAUTH REQUIRED /
// NOT CONNECTED with fully independent tokens and auth state.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const main = scripts[0];

const YT = 'https://www.googleapis.com/auth/youtube.readonly';
const YTA = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const DRV = 'https://www.googleapis.com/auth/drive.file';
const COMBINED = YT + ' ' + YTA + ' ' + DRV; // the exact rejected combination

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name, extra !== undefined ? String(extra).slice(0, 500) : ''); }
}

const start = main.indexOf('/* ==========================================================\n   GOOGLE DRIVE CLIP STORAGE');
const end = main.indexOf("document.getElementById('addQueue').addEventListener");
t('drive module bounds found (same markers as drive.test.js)', start >= 0 && end > start, { start, end });
const moduleSrc = start >= 0 && end > start ? main.slice(start, end) : '';

// ---------- A. static scope-string checks on the shipped HTML ----------
{
  console.log('scope declarations:');
  const m = main.match(/const GDRIVE_SCOPES\s*=\s*'([^']*)'/);
  t('GDRIVE_SCOPES declared', !!m);
  t('GDRIVE_SCOPES is exactly drive.file', m && m[1] === DRV, m && m[1]);
  t('GDRIVE_SCOPES contains no YouTube scope', m && !/youtube|yt-analytics/.test(m[1]), m && m[1]);

  t('GOOGLE_YOUTUBE_SCOPES lists youtube.readonly', main.includes(YT));
  t('GOOGLE_YOUTUBE_SCOPES lists yt-analytics.readonly', main.includes(YTA));

  // Every googleapis scope literal in the file must belong to ONE family.
  const lits = [...html.matchAll(/['"]([^'"]*googleapis\.com\/auth\/[^'"]*)['"]/g)].map(x => x[1]);
  t('at least the three known scope literals exist', lits.length >= 3, lits.length);
  const mixed = lits.filter(s => /drive/.test(s) && /youtube|yt-analytics/.test(s));
  t('no single scope literal mixes Drive + YouTube families', mixed.length === 0, mixed);

  // The browser GIS token client must be constructed with the Drive-only
  // scope constant — never with a YouTube scope. (Match the real
  // initTokenClient({ call site, not prose mentions in comments.)
  const clientAt = moduleSrc.indexOf('initTokenClient({');
  const gisBlock = clientAt >= 0 ? moduleSrc.slice(clientAt, clientAt + 400) : '';
  t('GIS token client built with scope:GDRIVE_SCOPES', /scope\s*:\s*GDRIVE_SCOPES/.test(gisBlock), gisBlock.slice(0, 200));
  t('GIS token client block contains no YouTube scope literal',
    !/youtube\.readonly|yt-analytics\.readonly/.test(gisBlock), gisBlock.slice(0, 200));

  const guardFound = /assertSplitGoogleScopes\(\s*'Google Drive connection'\s*,\s*GDRIVE_SCOPES\s*\)/.exec(moduleSrc);
  const guardAt = guardFound ? guardFound.index : -1;
  t('gdriveRequestToken enforces the split BEFORE initTokenClient', guardAt >= 0 && clientAt >= 0 && guardAt < clientAt, { guardAt, clientAt });
}

// ---------- B. runtime checks inside the real Drive module ----------
function makeEl() { return { hidden: false, className: '', textContent: '', disabled: false }; }
function makeSandbox() {
  const els = {
    driveConnState: makeEl(),
    driveConnectBtn: makeEl(),
    youtubeConnectionBadge: makeEl(),
  };
  const store = {};
  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Promise, Number, String, URLSearchParams, encodeURIComponent,
    fetch: () => { throw new Error('fetch not stubbed'); },
    document: { getElementById: id => els[id] || null },
    window: { addEventListener: () => {} },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    XMLHttpRequest: class { constructor() { this.headers = {}; this.upload = {}; } open() {} setRequestHeader() {} getResponseHeader() { return null; } send() {} abort() {} },
    showUploadStatus: () => {}, clearUploadStatus: () => {},
    formatBytes: n => Math.round(Number(n) || 0),
    currentUser: { id: 'u' }, CLIP_BUCKET: 'clips',
    isOwner: () => true, selectedTwitchClip: () => null,
    writeCloudStateNow: async () => ({ ok: true }),
    alert: () => {},
  };
  vm.createContext(sb);
  vm.runInContext(moduleSrc, sb);
  return { sb, els, store };
}

{
  console.log('canonical split map:');
  const sbx = makeSandbox();
  const yt = vm.runInContext('GOOGLE_AUTH_CONNECTIONS.youtube.scopes', sbx.sb);
  const dr = vm.runInContext('GOOGLE_AUTH_CONNECTIONS.drive.scopes', sbx.sb);
  t('youtube entry holds exactly the two YouTube scopes',
    Array.isArray(yt) && yt.length === 2 && yt.includes(YT) && yt.includes(YTA), yt);
  t('youtube entry holds no Drive scope', yt.every(s => !/drive/.test(s)), yt);
  t('drive entry holds exactly [drive.file]',
    Array.isArray(dr) && dr.length === 1 && dr[0] === DRV, dr);
}

{
  console.log('assertSplitGoogleScopes (Error 400 guard):');
  const sbx = makeSandbox();
  const run = expr => vm.runInContext(expr, sbx.sb);
  t('drive.file alone passes', run(`assertSplitGoogleScopes('t','${DRV}')`) === true);
  t('youtube.readonly alone passes', run(`assertSplitGoogleScopes('t','${YT}')`) === true);
  t('yt-analytics.readonly alone passes', run(`assertSplitGoogleScopes('t','${YTA}')`) === true);
  t('two YouTube scopes together pass (backend flow)',
    run(`assertSplitGoogleScopes('t','${YT} ${YTA}')`) === true);
  for (const bad of [COMBINED, `${DRV} ${YT}`, `${YTA} ${DRV}`, `${YT},${DRV}`]) {
    let code = '', msg = '';
    try { run(`assertSplitGoogleScopes('Google Drive connection',${JSON.stringify(bad)})`); }
    catch (e) { code = e.code; msg = e.message; }
    t(`combined scope refused: ${bad.slice(0, 60)}…`, code === 'scope_mix', code);
    if (bad === COMBINED) t('refusal message explains the split', /independent|separate|400/i.test(msg), msg.slice(0, 200));
  }
  t('isDriveOnlyScopes(drive.file)', run(`isDriveOnlyScopes('${DRV}')`) === true);
  t('!isDriveOnlyScopes(youtube)', run(`isDriveOnlyScopes('${YT}')`) === false);
  t('isYouTubeOnlyScopes(youtube pair)', run(`isYouTubeOnlyScopes('${YT} ${YTA}')`) === true);
  t('!isYouTubeOnlyScopes(combined)', run(`isYouTubeOnlyScopes(${JSON.stringify(COMBINED)})`) === false);
}

{
  console.log('youtubeConnectionState (independent YouTube status):');
  const sbx = makeSandbox();
  const st = obj => vm.runInContext(`youtubeConnectionState(${JSON.stringify(obj)})`, sbx.sb);
  t('connected:true → connected', st({ connected: true }) === 'connected');
  t('connected survives an unrelated error field', st({ connected: true, error: 'drive boom' }) === 'connected');
  t('empty record → not', st({}) === 'not');
  t('configured but not connected → reauth', st({ configured: true }) === 'reauth');
  t('expired-token error → reauth', st({ error: 'YouTube authorization expired' }) === 'reauth');
  t('invalid_grant error → reauth', st({ error: 'invalid_grant: Token has been revoked' }) === 'reauth');
  t('plain setup hint → not', st({ error: 'Configure YouTube credentials on Craftnode' }) === 'not');
}

{
  console.log('drive UI states leave YouTube untouched:');
  const sbx = makeSandbox();
  const { sb, els } = sbx;
  els.youtubeConnectionBadge.textContent = 'YOUTUBE-PINNED';
  for (const s of ['connected', 'connecting', 'reauth', 'error', 'not']) {
    vm.runInContext(`updateDriveConnUI(${JSON.stringify(s)})`, sb);
    t(`YouTube badge untouched by drive state '${s}'`,
      els.youtubeConnectionBadge.textContent === 'YOUTUBE-PINNED', els.youtubeConnectionBadge.textContent);
  }
  vm.runInContext(`updateDriveConnUI('connected')`, sb);
  t('drive CONNECTED pill', els.driveConnState.textContent.includes('Connected ✓'), els.driveConnState.textContent);
  t('drive connect button hidden when connected', els.driveConnectBtn.hidden === true);
  vm.runInContext(`updateDriveConnUI('reauth')`, sb);
  t('drive REAUTH pill', /Reauth required/.test(els.driveConnState.textContent), els.driveConnState.textContent);
  t('drive reconnect button offered when reauth',
    els.driveConnectBtn.hidden === false && !els.driveConnectBtn.disabled &&
    els.driveConnectBtn.textContent === 'Reconnect Google Drive', els.driveConnectBtn.textContent);
  vm.runInContext(`updateDriveConnUI('error')`, sb);
  t("legacy 'error' aliases to reauth", /Reauth required/.test(els.driveConnState.textContent));
  vm.runInContext(`updateDriveConnUI('not')`, sb);
  t('drive NOT CONNECTED pill', /Not connected/.test(els.driveConnState.textContent), els.driveConnState.textContent);
  t('drive connect button offered when not connected',
    els.driveConnectBtn.hidden === false && !els.driveConnectBtn.disabled, els.driveConnectBtn.textContent);

  // Token lifecycle is Drive-only: invalidating the Drive token must not
  // demote a connected YouTube record.
  vm.runInContext(`gdriveAccessToken='tok'; gdriveTokenExpiresAt=Date.now()+99999; gdriveInvalidateToken()`, sb);
  const cleared = vm.runInContext(`gdriveAccessToken===''&&gdriveTokenExpiresAt===0`, sb);
  const ytStill = vm.runInContext(`youtubeConnectionState({connected:true})`, sb);
  t('gdriveInvalidateToken clears only the Drive token', cleared === true);
  t('YouTube still connected after Drive token invalidation', ytStill === 'connected');
  t('YouTube badge still pinned after Drive token invalidation',
    els.youtubeConnectionBadge.textContent === 'YOUTUBE-PINNED');
}

{
  console.log('cross-module isolation (static):');
  // Strip comments first: prose may legitimately NAME the other
  // connection ("never combine X with Y") — only executable code must
  // not cross the boundary.
  const codeOnly = src => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\S\r\n])\/\/[^\n]*/gm, '$1');
  // The pure youtubeConnectionState() helper intentionally lives in this
  // module (same extraction harness); Drive AUTH code reaching into
  // YouTube state is what must never happen, so the helper definition
  // itself is excluded from the boundary check.
  const moduleCode = codeOnly(moduleSrc)
    .replace(/function youtubeConnectionState\([\s\S]*?\n\}/, '');
  t('Drive module never reads/writes socialConnections (YouTube state lives outside it)',
    !/socialConnections/.test(moduleCode));
  t('Drive module never touches the YouTube badge',
    !/youtubeConnectionBadge|getElementById\('youtube/i.test(moduleCode));
  const rpAt = main.indexOf('function renderContentPerformance');
  const nextFn = main.indexOf('\nfunction ', rpAt + 10);
  const renderSrc = codeOnly(main.slice(rpAt, nextFn));
  t('YouTube badge rendering never touches Drive state',
    !/gdrive|driveConn|GDRIVE|DRIVE_API|drive\.file/.test(renderSrc));
  t('YouTube badge renders the three required states',
    /CONNECTED/.test(renderSrc) && /REAUTH REQUIRED/.test(renderSrc) && /NOT CONNECTED/.test(renderSrc),
    renderSrc.slice(0, 300));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
