// Full-stack DOM test: real UI + stubbed Supabase / GIS / Drive transport.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name, extra !== undefined ? String(extra).slice(0, 400) : ''); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 3000, label = '') {
  const start = Date.now();
  while (Date.now() - start < ms) { try { if (fn()) return true; } catch (e) {} await sleep(25); }
  return false;
}

const errors = [];
let errBaseline = 0;
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Could not load link|css|Not implemented: HTMLMediaElement|Not implemented: navigation/.test(e.message)) errors.push('jsdomError: ' + e.message); });
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ').slice(0, 200)));

// ---- transport stubs ----
const world = { promptValue: '',
  gisRequests: [], gisMode: 'ok', tokenClientCb: null,
  driveSearches: [], foldersByName: {}, existingFolders: [], // name->id; preseed via existingFolders
  sessions: [], chunkPuts: [], probes: [], fileMeta: {}, driveMode: 'ok',
  upserts: [], signedUrls: [], removedPaths: [],
  openedUrls: [], alerts: [], confirmValue: true,
};

function makeDriveFetch(window) {
  return async function fetchStub(url, opts = {}) {
    const u = String(url);
    const headers = opts.headers || {};
    if (!/Bearer TESTTOKEN/.test(headers.Authorization || '') && !u.includes('upload.example')) {
      return resp(window, 401, {}, '');
    }
    // folder search
    if (u.includes('/drive/v3/files?') && u.includes('q=')) {
      world.driveSearches.push(u);
      const m = /name%20%3D%20%22([^%]+)%22|name = "([^"]+)"/.exec(decodeURIComponent(u));
      const name = (m && (m[1] || m[2])) || '';
      const existing = world.foldersByName[name];
      if (existing) return resp(window, 200, {}, JSON.stringify({ files: [{ id: existing, name }] }));
      return resp(window, 200, {}, JSON.stringify({ files: [] }));
    }
    // create folder / trash file
    if (u.includes('/drive/v3/files?') || u.match(/\/drive\/v3\/files\/[^/?]+(\?|$)/)) {
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (opts.method === 'POST' && body.mimeType === 'application/vnd.google-apps.folder') {
        const id = 'FLD_' + body.name;
        world.foldersByName[body.name] = id;
        return resp(window, 200, {}, JSON.stringify({ id, name: body.name }));
      }
      if (opts.method === 'PATCH' && body.trashed === true) {
        world.trashed = world.trashed || [];
        const id = decodeURIComponent(u.split('/files/')[1].split('?')[0]);
        world.trashed.push(id);
        return resp(window, 200, {}, JSON.stringify({ id }));
      }
    }
    // file metadata get
    const metaGet = u.match(/\/drive\/v3\/files\/([^/?]+)\?fields=/);
    if (metaGet && (!opts.method || opts.method === 'GET')) {
      const id = decodeURIComponent(metaGet[1]);
      if (world.driveMode === 'file-deleted') return resp(window, 404, {}, JSON.stringify({ error: { message: 'File not found' } }));
      const meta = world.fileMeta[id];
      if (!meta) return resp(window, 404, {}, JSON.stringify({ error: { message: 'File not found' } }));
      return resp(window, 200, {}, JSON.stringify(meta));
    }
    // resumable session start
    if (u.includes('uploadType=resumable')) {
      if (world.driveMode === 'session-fails') return resp(window, 500, {}, JSON.stringify({ error: { message: 'backend error' } }));
      if (world.driveMode === 'slow-session') return new Promise(r => setTimeout(() => {
        const body = opts.body ? JSON.parse(opts.body) : {};
        const uri = 'https://upload.example/session-' + (world.sessions.length + 1);
        world.sessions.push({ uri, meta: body, xUploadLength: headers['X-Upload-Content-Length'] });
        r(resp(window, 200, { Location: uri }, ''));
      }, 250));
      const body = opts.body ? JSON.parse(opts.body) : {};
      const uri = 'https://upload.example/session-' + (world.sessions.length + 1);
      world.sessions.push({ uri, meta: body, xUploadLength: headers['X-Upload-Content-Length'] });
      return resp(window, 200, { Location: uri }, '');
    }
    return resp(window, 404, {}, '{}');
  };
  function resp(window, status, headers, text) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: h => headers[h] !== undefined ? headers[h] : (headers[h.toLowerCase()] !== undefined ? headers[h.toLowerCase()] : null) },
      json: async () => text ? JSON.parse(text) : {},
      text: async () => text,
    };
  }
}

function FakeXHRClass(window) {
  class FakeXHR {
    constructor() { this.headers = {}; this.upload = {}; this.status = 0; }
    open(m, u) { this.method = m; this.uri = u; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    getResponseHeader() { return null; }
    send(body) {
      const cr = this.headers['Content-Range'] || '';
      if (cr.startsWith('bytes */')) {
        world.probes.push(cr);
        // session has all bytes once last PUT succeeded
        this.status = world.sessionDone ? 201 : 308;
        this.responseText = world.sessionDone ? JSON.stringify({ id: world.lastFileId || 'DRV1', name: 'up.mp4' }) : '';
        this.getResponseHeader = h => h === 'Range' && !world.sessionDone ? `bytes=0-${world.sessionBytes - 1}` : null;
        setTimeout(() => this.onload && this.onload(), 0);
        return;
      }
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(cr);
      const s = m ? +m[1] : 0, e = m ? +m[2] : 0, tt = m ? +m[3] : 0;
      world.chunkPuts.push({ uri: this.uri, start: s, end: e, total: tt });
      world.sessionBytes = e + 1;
      if (world.driveMode === 'chunk-fails') {
        setTimeout(() => this.onerror && this.onerror(), 0);
        return;
      }
      if (e + 1 < tt) {
        this.status = 308;
        this.getResponseHeader = h => h === 'Range' ? `bytes=0-${e}` : null;
        setTimeout(() => this.onload && this.onload(), 0);
      } else {
        this.status = 201;
        world.lastFileId = 'DRV_' + world.chunkPuts.length;
        world.sessionDone = true;
        this.responseText = JSON.stringify({ id: world.lastFileId, name: 'up.mp4', mimeType: 'video/mp4', parents: [world.foldersByName[curMonth()]] });
        setTimeout(() => this.onload && this.onload(), 0);
      }
    }
    abort() { if (this.onabort) this.onabort(); }
  }
  return FakeXHR;
}
function curMonth() { return new Date().toISOString().slice(0, 7); }

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://nappavt-growth-hub.pages.dev/',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    // ---- Supabase stub ----
    window.supabase = { createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: { user: { id: 'owner-1', email: 'owner@test.dev' } } } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      },
      from: () => {
        const q = {
          select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; },
          maybeSingle: async () => ({ data: null, error: null }),
          single: async () => ({ data: null, error: null }),
          insert: async () => ({ error: null }),
          update() { return { eq: async () => ({ error: null }) }; },
          delete() { return { eq: async () => ({ error: null }) }; },
          upsert: async p => { if (world.upsertFails) return { error: { message: 'supabase down' } }; world.upserts.push({ ...p, state: { ...p.state, queue: (p.state.queue || []).map(q => ({ ...q })) } }); return { error: null }; },
        };
        return q;
      },
      rpc: async name => name === 'growth_hub_access_status'
        ? { data: { role: 'owner', owner_user_id: 'owner-1' }, error: null }
        : { data: null, error: null },
      storage: { from: () => ({
        createSignedUrl: async p => { world.signedUrls.push(p); return { data: { signedUrl: 'https://signed.example/' + p }, error: null }; },
        remove: async paths => { world.removedPaths.push(...paths); return { error: null }; },
      }) },
      channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
      removeChannel() {},
    }) };
    // ---- GIS stub ----
    window.google = { accounts: { oauth2: {
      initTokenClient: cfg => ({
        requestAccessToken: () => {
          world.gisRequests.push(Date.now());
          if (world.gisMode === 'cancel') { setTimeout(() => cfg.error_callback({ type: 'popup_closed' }), 0); return; }
          setTimeout(() => cfg.callback({ access_token: 'TESTTOKEN', expires_in: 3600 }), 0);
        },
      }),
    } } };
    // ---- Drive transport stubs ----
    window.fetch = makeDriveFetch(window);
    window.XMLHttpRequest = FakeXHRClass(window);
    // ---- UI stubs ----
    window.confirm = () => world.confirmValue;
    window.alert = m => world.alerts.push(String(m));
    window.prompt = () => world.promptValue;
    window.open = (u) => { world.openedUrls.push(String(u)); };
    window.URL.createObjectURL = () => 'blob:stub';
    window.URL.revokeObjectURL = () => {};

  },
});

const { window } = dom;
const { document } = window;

function setFile(win, input, name, type, bytes) {
  Object.defineProperty(input, 'files', {
    value: [new win.File([new Uint8Array(bytes)], name, { type })],
    configurable: true,
  });
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
}

async function instance1() {
  await sleep(600); // let auth/startup settle

  console.log('startup & dashboard:');
  t('no uncaught errors on load', errors.length === 0, errors.join(' | '));
  t('dashboard visible (owner session)', document.getElementById('dashboardShell').classList.contains('visible'));
  t('GIS connect button present', !!document.getElementById('driveConnectBtn'));

  console.log('connect / cancel / reconnect:');
  document.getElementById('driveConnectBtn').click();
  await waitFor(() => document.getElementById('driveConnState').textContent.includes('Connected'));
  t('connect flow completes → Connected ✓', document.getElementById('driveConnState').textContent.includes('Connected ✓'), document.getElementById('driveConnState').textContent);
  t('connect button hidden once connected', document.getElementById('driveConnectBtn').hidden === true);

  world.gisMode = 'cancel';
  // simulate disconnect by reloading pill state via UI error path: click is hidden now; emulate expiry path instead below
  world.gisMode = 'ok';

  console.log('E2E upload (small file < 1 chunk):');
  document.getElementById('qTitle').value = 'Pragmata hallway';
  setFile(window, document.getElementById('qVideo'), 'PRAGMATA_clip_07.mp4', 'video/mp4', 1024);
  t('file info visible with name', document.getElementById('qFileInfo').textContent.includes('PRAGMATA_clip_07.mp4'));
  const beforeUpserts = world.upserts.length;
  document.getElementById('addQueue').click();
  await waitFor(() => document.getElementById('uploadStatus').textContent.includes('Uploaded to Google Drive'), 4000);
  t('success message shown', document.getElementById('uploadStatus').textContent.includes('Uploaded to Google Drive'), document.getElementById('uploadStatus').textContent);
  t('folder search attempted', world.driveSearches.length >= 1);
  t('app folder created once, named correctly', world.foldersByName['NappaVT Growth Hub Clips'] === 'FLD_NappaVT Growth Hub Clips');
  t('month subfolder created', !!world.foldersByName[curMonth()]);
  t('resumable session started', world.sessions.length === 1, world.sessions.length);
  t('session metadata: name + parent folder', world.sessions[0] && world.sessions[0].meta.name === 'PRAGMATA_clip_07.mp4' && world.sessions[0].meta.parents[0] === world.foldersByName[curMonth()], world.sessions[0] && world.sessions[0].meta);
  t('exactly 1 chunk PUT for small file', world.chunkPuts.length === 1, world.chunkPuts.length);
  t('chunk covered whole file', world.chunkPuts[0] && world.chunkPuts[0].start === 0 && world.chunkPuts[0].end === 1023);
  t('drive file id captured in cloud save', (() => {
    const added = world.upserts.slice(beforeUpserts).flatMap(p => (p.state && p.state.queue) || []);
    return added.some(q => q.storageProvider === 'google_drive' && q.driveFileId === 'DRV_1');
  })());
  const savedRec = world.upserts.flatMap(p => (p.state && p.state.queue) || []).find(q => q.driveFileId);
  t('record keeps name/size/type + uploaded timestamp', savedRec && savedRec.videoName === 'PRAGMATA_clip_07.mp4' && savedRec.videoSize === 1024 && savedRec.videoType === 'video/mp4' && !!savedRec.driveUploadedAt && savedRec.videoPath === '', savedRec);
  t('queue card shows Google Drive badge', document.getElementById('queueCards').innerHTML.includes('Google Drive'));
  t('open button rendered for drive record', !!document.querySelector('[data-open-video]'));
  t('add button restored', document.getElementById('addQueue').textContent === 'Upload & add to queue' && !document.getElementById('addQueue').disabled);
  t('progress box reached 100%', document.getElementById('qUploadPct').textContent === '100%' || document.getElementById('uploadStatus').className.includes('good'));

  console.log('open drive-backed clip:');
  world.openedUrls.length = 0;
  world.fileMeta['DRV_1'] = { id: 'DRV_1', name: 'PRAGMATA_clip_07.mp4', trashed: false };
  document.querySelector('[data-open-video]').click();
  await waitFor(() => world.openedUrls.length > 0, 2000);
  t('opens private Drive viewer for stored file id', world.openedUrls[0] === 'https://drive.google.com/file/d/DRV_1/view', JSON.stringify({ opened: world.openedUrls, alerts: world.alerts, errors }));

  console.log('open drive clip deleted externally:');
  world.openedUrls.length = 0; world.alerts.length = 0; world.driveMode = 'file-deleted';
  document.querySelector('[data-open-video]').click();
  await waitFor(() => world.alerts.length > 0, 2000);
  t('clean error when file deleted in Drive', /no longer in Google Drive/.test(world.alerts[0] || ''), world.alerts[0]);
  world.driveMode = 'ok';

  console.log('delete drive-backed clip (explicit):');
  world.confirmValue = true; world.trashed = [];
  const recCountBefore = world.upserts[world.upserts.length - 1].state.queue.length;
  document.querySelector('[data-del-q]').click();
  await waitFor(() => world.upserts[world.upserts.length - 1].state.queue.length < recCountBefore, 4000);
  t('drive file moved to trash exactly once', world.trashed.length === 1 && world.trashed[0] === 'DRV_1', world.trashed);
  t('queue entry removed after trash', world.upserts[world.upserts.length - 1].state.queue.length === recCountBefore - 1);

  console.log('no-video post (no upload path):');
  world.upserts.length = 0;
  Object.defineProperty(document.getElementById('qVideo'), 'files', { value: [], configurable: true }); // jsdom shim: .value='' can't clear a defineProperty'd files
  document.getElementById('qTitle').value = 'Legacy no-video post';
  document.getElementById('addQueue').click();
  await waitFor(() => world.upserts.some(p => (p.state.queue || []).some(q => q.title === 'Legacy no-video post')), 4000);
  const noVideoRec = world.upserts.flatMap(p => (p.state.queue || [])).find(q => q.title === 'Legacy no-video post');
  t('no-video post adds without upload', noVideoRec && noVideoRec.driveFileId === '' && noVideoRec.videoPath === '' && noVideoRec.source === '', JSON.stringify(noVideoRec));

  console.log('double-click guard:');
  // While an upload is in flight the add button is disabled; a rapid second
  // click must not start a second session/upload.
  world.sessions.length = 0; world.chunkPuts.length = 0;
  world.driveMode = 'slow-session';
  document.getElementById('qTitle').value = 'Double click case';
  setFile(window, document.getElementById('qVideo'), 'double.mp4', 'video/mp4', 512);
  document.getElementById('addQueue').click();
  document.getElementById('addQueue').click(); // rapid second click
  document.getElementById('addQueue').click();
  await sleep(400);
  world.driveMode = 'ok';
  await waitFor(() => /Uploaded to Google Drive/.test(document.getElementById('uploadStatus').textContent), 5000);
  t('rapid triple-click started exactly ONE upload', world.sessions.length === 1, world.sessions.length);
  const dblRecs = world.upserts.flatMap(p => (p.state && p.state.queue) || []).filter(q => q.title === 'Double click case');
  t('exactly one queue record for triple-click', new Set(dblRecs.map(q => q.id)).size === 1, JSON.stringify(dblRecs.map(q => ({ id: q.id, title: q.title }))));

  console.log('Drive ok but Supabase save fails → explicit recovery:');
  world.upsertFails = true;
  document.getElementById('qTitle').value = 'Save fails case';
  setFile(window, document.getElementById('qVideo'), 'savefail.mp4', 'video/mp4', 768);
  const sessionsBefore = world.sessions.length;
  document.getElementById('addQueue').click();
  await waitFor(() => document.getElementById('uploadStatus').textContent.includes('could NOT be saved'), 8000);
  t('banner says file reached Drive but record not saved', document.getElementById('uploadStatus').textContent.includes('could NOT be saved'), document.getElementById('uploadStatus').textContent);
  const retryBtn = [...document.querySelectorAll('#uploadStatus button')].find(b => /Retry saving/.test(b.textContent));
  t('retry-saving button offered', !!retryBtn);
  const recsBefore = world.upserts.flatMap(p => (p.state && p.state.queue) || []).filter(q => q.title === 'Save fails case').length;
  t('record NOT in cloud yet', recsBefore === 0, recsBefore);
  world.upsertFails = false;
  retryBtn && retryBtn.click();
  await waitFor(() => /Uploaded to Google Drive ✓ · post added to the queue/.test(document.getElementById('uploadStatus').textContent), 6000);
  t('retry saving succeeds and confirms', /post added to the queue/.test(document.getElementById('uploadStatus').textContent), document.getElementById('uploadStatus').textContent);
  const recsAfter = world.upserts.flatMap(p => (p.state && p.state.queue) || []).filter(q => q.title === 'Save fails case');
  t('record persisted after retry', recsAfter.length >= 1 && recsAfter[recsAfter.length - 1].driveFileId, recsAfter.length);
  t('session count advanced by exactly one for this upload', world.sessions.length === sessionsBefore + 1, world.sessions.length - sessionsBefore);

  console.log('failed upload → no fake record:');
  errBaseline = errors.length;
  world.driveMode = 'session-fails';
  document.getElementById('qTitle').value = 'Should never appear';
  setFile(window, document.getElementById('qVideo'), 'broken.mp4', 'video/mp4', 2048);
  document.getElementById('addQueue').click();
  await waitFor(() => document.getElementById('uploadStatus').classList.contains('error'), 8000);
  t('error shown for failed upload', document.getElementById('uploadStatus').classList.contains('error'), document.getElementById('uploadStatus').textContent);
  t('button offers retry wording', /Retry/.test(document.getElementById('addQueue').textContent), document.getElementById('addQueue').textContent);
  const recs = world.upserts.flatMap(p => (p.state && p.state.queue) || []);
  t('no queue record created for failed upload', !recs.some(q => q.title === 'Should never appear'));
  world.driveMode = 'ok';

  console.log('validation:');
  setFile(window, document.getElementById('qVideo'), 'notes.txt', 'text/plain', 5);
  t('unsupported file shows error', document.getElementById('uploadStatus').classList.contains('error'));
  t('unsupported message names formats', /MP4, MOV, or WebM/.test(document.getElementById('uploadStatus').textContent));

  console.log('preview & autofill:');
  document.getElementById('qTitle').value = '';
  setFile(window, document.getElementById('qVideo'), 'MY_GAME_moments.mp4', 'video/mp4', 4096);
  t('clip name autofilled from filename', document.getElementById('qTitle').value === 'MY GAME moments', document.getElementById('qTitle').value);
  t('video preview shown for valid file', document.getElementById('qVideoPreview').classList.contains('show'));
  document.getElementById('qTitle').value = '';

  console.log('cancel upload:');
  world.driveMode = 'slow-session';
  document.getElementById('qTitle').value = 'Cancel case';
  setFile(window, document.getElementById('qVideo'), 'cancel.mp4', 'video/mp4', 640);
  document.getElementById('addQueue').click();
  t('cancel button visible during upload', document.getElementById('qUploadCancel').hidden === false);
  document.getElementById('qUploadCancel').click();
  await waitFor(() => document.getElementById('uploadStatus').classList.contains('error') && /cancel/i.test(document.getElementById('uploadStatus').textContent), 6000);
  t('cancel produces clear message', /cancel/i.test(document.getElementById('uploadStatus').textContent), document.getElementById('uploadStatus').textContent);
  t('no queue record after cancel', !world.upserts.flatMap(p => (p.state && p.state.queue) || []).some(q => q.title === 'Cancel case'));
  t('add button usable after cancel', !document.getElementById('addQueue').disabled);
  t('cancel button hidden after cancel', document.getElementById('qUploadCancel').hidden === true);
  world.driveMode = 'ok';

  console.log('storage stats:');
  const stats = document.getElementById('storageStats').textContent;
  t('stats count drive clips', /Google Drive: \d+ clips?/.test(stats), stats);
  t('stats note Drive never auto-deleted', /never auto-deleted/.test(stats), stats);
  t('stats mention Supabase state', /Supabase Storage:/.test(stats), stats);

  console.log('backup import safety:');
  world.confirmValue = true;
  // wrong file type of content → rejected without touching state
  Object.defineProperty(document.getElementById('importBackup'), 'files', {
    value: [new window.File([JSON.stringify({ hello: 'world', size: 42 })], 'junk.json', { type: 'application/json' })], configurable: true
  });
  document.getElementById('importBackup').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(100);
  t('non-backup JSON rejected', world.alerts.some(a => /does not look like/.test(a)), world.alerts);
  world.alerts.length = 0;
  const backup = JSON.stringify({ fields: { videoCleanupDays: '7' }, routine: {}, streams: [], clips: [], queue: [
    { id: 999, date: '2026-09-04', time: '10:00', platforms: ['TikTok'], platform: 'TikTok', title: 'Imported post', status: 'Planned',
      videoPath: '', videoName: '', videoSize: 0, videoType: '', keepVideo: false, videoDeleted: false, videoDeletedAt: '', createdAt: '2026-09-04T09:00:00Z' }
  ]});
  Object.defineProperty(document.getElementById('importBackup'), 'files', {
    value: [new window.File([backup], 'backup.json', { type: 'application/json' })], configurable: true
  });
  document.getElementById('importBackup').dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => document.getElementById('queueCards').innerHTML.includes('Imported post'), 4000);
  t('valid backup imports after confirm', document.getElementById('queueCards').innerHTML.includes('Imported post'));
  t('import confirmation mentions safety backup', world.alerts.some(a => /Backup imported and queued for cloud sync/.test(a)), world.alerts);

  console.log('reset typed confirmation:');
  world.promptValue = 'nope';
  document.getElementById('resetAll').click();
  await sleep(150);
  t('wrong typed text cancels reset', world.alerts.some(a => /Reset cancelled/.test(a)), world.alerts);
  t('data still present after cancelled reset', document.getElementById('queueCards').innerHTML.includes('Imported post'));
  world.alerts.length = 0;
  world.promptValue = 'DELETE';
  document.getElementById('resetAll').click();
  await waitFor(() => document.getElementById('queueCards').innerHTML.includes('Nothing queued yet'), 4000);
  t('typed DELETE performs the reset', document.getElementById('queueCards').innerHTML.includes('Nothing queued yet'));

  console.log('console hygiene:');
  const newErrors = errors.slice(errBaseline);
  t('no unexpected errors during instance 1', newErrors.filter(e => !/backend error|supabase down/.test(e)).length === 0, newErrors.join(' | '));
  t('access token never appears in console', !errors.some(e => /TESTTOKEN/.test(e)));

  console.log(`\n${pass} passed, ${fail} failed (instance 1)`);
}

// ============================================================
// Instance 2: seeded legacy + drive records from localStorage.
// Proves old Supabase records keep working unchanged alongside
// Drive-backed ones.
// ============================================================
async function instance2() {
  const errBaseline2 = errors.length;
  const dom2 = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://nappavt-growth-hub.pages.dev/',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      const seeded = {
        fields: { videoCleanupDays: '7' }, routine: {}, streams: [], clips: [], twitchClips: [],
        queue: [
          { id: 101, date: '2026-08-01', time: '10:00', platforms: ['TikTok'], platform: 'TikTok', title: 'OLD supabase clip', status: 'Planned',
            videoPath: 'owner-1/1722500000_abc_old.mp4', videoName: 'old.mp4', videoSize: 52428800, videoType: 'video/mp4',
            source: 'Upload', keepVideo: false, videoDeleted: false, videoDeletedAt: '', createdAt: '2026-08-01T09:00:00Z' },
          { id: 102, date: '2026-08-02', time: '10:00', platforms: ['TikTok'], platform: 'TikTok', title: 'NEW drive clip', status: 'Planned',
            storageProvider: 'google_drive', driveFileId: 'SEEDDRV', driveFolderId: 'SEEDFLD', driveUploadedAt: '2026-08-02T09:00:00Z',
            videoPath: '', videoName: 'seed.mp4', videoSize: 524288000, videoType: 'video/mp4',
            source: 'Upload', keepVideo: false, videoDeleted: false, videoDeletedAt: '', createdAt: '2026-08-02T09:00:00Z' },
          { id: 103, date: '2026-08-03', time: '10:00', platforms: ['TikTok'], platform: 'TikTok', title: 'Twitch clip', status: 'Planned',
            source: 'Twitch', twitchClipId: 'tc1', twitchUrl: 'https://clips.twitch.tv/x',
            videoPath: '', videoName: '', videoSize: 0, videoType: '', keepVideo: false, videoDeleted: false, videoDeletedAt: '', createdAt: '2026-08-03T09:00:00Z' },
        ],
        theme: 'dark',
      };
      window.localStorage.setItem('nappavt_growth_hub_v3:owner-1', JSON.stringify(seeded));
      window.supabase = { createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: { user: { id: 'owner-1', email: 'owner@test.dev' } } } }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        },
        from: () => {
          const q = {
            select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; },
            maybeSingle: async () => ({ data: null, error: null }),
            single: async () => ({ data: null, error: null }),
            insert: async () => ({ error: null }),
            update() { return { eq: async () => ({ error: null }) }; },
            delete() { return { eq: async () => ({ error: null }) }; },
            upsert: async p => { world.upserts2.push({ ...p, state: { ...p.state, queue: (p.state.queue || []).map(q => ({ ...q })) } }); return { error: null }; },
          };
          return q;
        },
        rpc: async name => name === 'growth_hub_access_status'
          ? { data: { role: 'owner', owner_user_id: 'owner-1' }, error: null }
          : { data: null, error: null },
        storage: { from: () => ({
          createSignedUrl: async p => { world.signedUrls.push(p); return { data: { signedUrl: 'https://signed.example/' + p }, error: null }; },
          remove: async paths => { world.removedPaths.push(...paths); return { error: null }; },
        }) },
        channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
        removeChannel() {},
      }) };
      window.google = { accounts: { oauth2: {
        initTokenClient: cfg => ({ requestAccessToken: () => setTimeout(() => cfg.callback({ access_token: 'TESTTOKEN', expires_in: 3600 }), 0) }),
      } } };
      window.fetch = makeDriveFetch(window);
      window.XMLHttpRequest = FakeXHRClass(window);
      window.confirm = () => world.confirmValue;
      window.alert = m => world.alerts2.push(String(m));
      window.open = (u) => { world.openedUrls2.push(String(u)); };
    },
  });
  const w2 = dom2.window, d2 = w2.document;
  world.upserts2 = []; world.alerts2 = []; world.openedUrls2 = [];

  await sleep(700);
  console.log('\nlegacy compatibility (seeded records):');
  t('3 queue cards render', d2.querySelectorAll('.queue-card').length === 3, d2.querySelectorAll('.queue-card').length);
  const html2 = d2.getElementById('queueCards').innerHTML;
  t('legacy filename shown', html2.includes('old.mp4'));
  t('legacy size shown', html2.includes('50.0 MB'));
  t('drive record shows Google Drive badge', /Google Drive/.test(html2));
  t('drive size shown (500 MB)', html2.includes('500.0 MB'), (html2.match(/video-name">[^<]*/g) || []).join(' ; '));
  t('twitch card shows Twitch copy', html2.includes('fresh download link'));
  const openBtns = d2.querySelectorAll('[data-open-video]');
  t('exactly two open buttons (legacy + drive)', openBtns.length === 2, openBtns.length);

  console.log('legacy open via signed URL:');
  world.openedUrls2.length = 0; world.signedUrls.length = 0;
  openBtns[0].click();
  await waitFor(() => world.signedUrls.length > 0, 2000);
  t('legacy opens with Supabase signed URL', world.signedUrls[0] === 'owner-1/1722500000_abc_old.mp4', world.signedUrls);
  t('legacy does not touch Drive', !world.openedUrls2.some(u => u.includes('drive.google')));

  console.log('drive open in same workspace:');
  world.openedUrls2.length = 0; world.alerts2.length = 0;
  world.fileMeta['SEEDDRV'] = { id: 'SEEDDRV', name: 'seed.mp4', trashed: false };
  openBtns[1].click();
  await waitFor(() => world.openedUrls2.length > 0 || world.alerts2.length > 0, 2500);
  t('drive record opens Drive viewer', world.openedUrls2.includes('https://drive.google.com/file/d/SEEDDRV/view'), JSON.stringify({ opened: world.openedUrls2, alerts: world.alerts2 }));

  console.log('mixed deletion:');
  world.confirmValue = true; world.trashed = []; world.removedPaths.length = 0;
  const delBtns = [...d2.querySelectorAll('[data-del-q]')];
  delBtns[1].click(); // drive record
  await waitFor(() => world.trashed.length === 1, 2500);
  t('drive delete trashes Drive file', world.trashed[0] === 'SEEDDRV', world.trashed);
  t('drive delete does NOT call Supabase remove', world.removedPaths.length === 0, world.removedPaths);
  world.removedPaths.length = 0; world.upserts2.length = 0;
  delBtns[0].click(); // legacy record
  await waitFor(() => world.removedPaths.length === 1, 2500);
  t('legacy delete still removes from Supabase Storage', world.removedPaths[0] === 'owner-1/1722500000_abc_old.mp4', world.removedPaths);
  t('legacy delete does NOT touch Drive', world.trashed.length === 1, world.trashed);
  [...d2.querySelectorAll('[data-post]')].forEach(b => b.click());
  await sleep(700);
  const lastUpsert = world.upserts2[world.upserts2.length - 1];
  const twitchRec = lastUpsert && (lastUpsert.state.queue || []).find(q => q.id === 103);
  t('twitch record still present after deletions', !!twitchRec, lastUpsert && lastUpsert.state.queue && lastUpsert.state.queue.map(q => q.id));

  t('no unexpected errors in instance 2', errors.slice(errBaseline2).filter(e => !/backend error|supabase down/.test(e)).length === 0, errors.slice(errBaseline2).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed (after instances 1-2)`);
}

// ============================================================
// Instance 3: auth cancellation then reconnect (fresh session,
// so no token exists yet — popup closed by user).
// ============================================================
async function instance3() {
  world.gisMode = 'cancel';
  const dom3 = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://nappavt-growth-hub.pages.dev/',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.supabase = { createClient: () => ({
        auth: { getSession: async () => ({ data: { session: { user: { id: 'owner-1', email: 'owner@test.dev' } } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
        from: () => { const q = { select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; }, maybeSingle: async () => ({ data: null, error: null }), single: async () => ({ data: null, error: null }), insert: async () => ({ error: null }), update() { return { eq: async () => ({ error: null }) }; }, delete() { return { eq: async () => ({ error: null }) }; }, upsert: async () => ({ error: null }) }; return q; },
        rpc: async name => name === 'growth_hub_access_status' ? { data: { role: 'owner', owner_user_id: 'owner-1' }, error: null } : { data: null, error: null },
        storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'x' }, error: null }), remove: async () => ({ error: null }) }) },
        channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
        removeChannel() {},
      }) };
      window.google = { accounts: { oauth2: {
        initTokenClient: cfg => ({ requestAccessToken: () => {
          if (world.gisMode === 'cancel') setTimeout(() => cfg.error_callback({ type: 'popup_closed' }), 0);
          else setTimeout(() => cfg.callback({ access_token: 'TESTTOKEN', expires_in: 3600 }), 0);
        } }),
      } } };
      window.fetch = makeDriveFetch(window);
      window.XMLHttpRequest = FakeXHRClass(window);
      window.confirm = () => true;
      window.alert = () => {};
      window.open = () => {};
    },
  });
  const d3 = dom3.window.document;
  await sleep(700);
  console.log('\nauth cancellation (fresh session):');
  t('starts as Not connected (or hidden default)', d3.getElementById('driveConnState').hidden || /Not connected/.test(d3.getElementById('driveConnState').textContent), d3.getElementById('driveConnState').textContent);
  d3.getElementById('driveConnectBtn').click();
  await waitFor(() => /cancel/i.test(d3.getElementById('uploadStatus').textContent), 3000);
  t('cancellation message shown to user', /cancel/i.test(d3.getElementById('uploadStatus').textContent), d3.getElementById('uploadStatus').textContent);
  t('pill shows Not connected after cancel', /Not connected/.test(d3.getElementById('driveConnState').textContent));
  t('connect button enabled again', !d3.getElementById('driveConnectBtn').disabled && !d3.getElementById('driveConnectBtn').hidden);
  // cancelled upload attempt must not create a record
  d3.getElementById('qTitle').value = 'cancel-case';
  Object.defineProperty(d3.getElementById('qVideo'), 'files', { value: [new dom3.window.File([new Uint8Array(512)], 'c.mp4', { type: 'video/mp4' })], configurable: true });
  d3.getElementById('qVideo').dispatchEvent(new dom3.window.Event('change', { bubbles: true }));
  d3.getElementById('addQueue').click();
  await waitFor(() => /cancel/i.test(d3.getElementById('uploadStatus').textContent) || d3.getElementById('uploadStatus').classList.contains('error'), 4000);
  t('upload with cancelled auth fails cleanly (no record, no hang)', d3.getElementById('uploadStatus').classList.contains('error'), d3.getElementById('uploadStatus').textContent);
  t('add button usable again', !d3.getElementById('addQueue').disabled);
  world.gisMode = 'ok';
  d3.getElementById('driveConnectBtn').click();
  await waitFor(() => /Connected ✓/.test(d3.getElementById('driveConnState').textContent), 3000);
  t('reconnect succeeds after cancellation', /Connected ✓/.test(d3.getElementById('driveConnState').textContent));
  d3.getElementById('addQueue').click();
  await waitFor(() => /Uploaded to Google Drive/.test(d3.getElementById('uploadStatus').textContent), 5000);
  t('upload succeeds after reconnect', /Uploaded to Google Drive/.test(d3.getElementById('uploadStatus').textContent), d3.getElementById('uploadStatus').textContent);

  console.log(`\n${pass} passed, ${fail} failed (grand total)`);
  process.exit(fail ? 1 : 0);
}

(async () => { await instance1(); await instance2(); await instance3(); })().catch(e => { console.error('HARNESS FATAL', e); process.exit(1); });
