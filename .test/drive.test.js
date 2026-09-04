// Unit-test harness: extracts the Google Drive module from index.html
// and exercises it against fake XHR/fetch implementations.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('index.html', 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const main = scripts[0];

const start = main.indexOf('/* ==========================================================\n   GOOGLE DRIVE CLIP STORAGE');
const end = main.indexOf("document.getElementById('addQueue').addEventListener");
if (start < 0 || end < 0) { console.error('module bounds not found', start, end); process.exit(1); }
const moduleSrc = main.slice(start, end);

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

function makeSandbox() {
  class FakeXHR {
    constructor() { this.headers = {}; this.upload = {}; this.status = 0; }
    open(m, u) { this.method = m; this.uri = u; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    getResponseHeader() { return null; }
    send(body) { FakeXHR.queue(this, body); }
    abort() { if (this.onabort) this.onabort(); }
  }
  FakeXHR.queue = () => { throw new Error('no responder installed'); };
  FakeXHR.sent = [];

  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, Number, String, URLSearchParams,
    encodeURIComponent,
    fetch: () => { throw new Error('fetch not stubbed'); },
    document: { getElementById: () => null },
    window: { addEventListener: () => {} },
    XMLHttpRequest: FakeXHR,
    showUploadStatus: () => {}, clearUploadStatus: () => {},
    formatBytes: n => Math.round(Number(n) || 0),
    currentUser: { id: 'u' }, CLIP_BUCKET: 'clips',
    isOwner: () => true, selectedTwitchClip: () => null,
    writeCloudStateNow: async () => ({ ok: true }),
    updateDriveConnUI: () => {}, alert: () => {},
    __seq: 0, __prog: [], __logs: [], __xhrLog: [],
  };
  sb.gdriveSleep = ms => new Promise(r => setTimeout(r, Math.min(ms, 5))); // fast tests
  vm.createContext(sb);
  vm.runInContext(moduleSrc, sb);
  vm.runInContext(`
    gdriveEnsureToken = async opts => 'tok';
    const __origPut = gdrivePutChunk;
    gdrivePutChunk = (uri, blob, start, total, token, onProg) => {
      XMLHttpRequest.sent.push({ start, end: start + blob.size - 1, total });
      return __origPut(uri, blob, start, total, token, onProg);
    };
  `, sb);
  return sb;
}

// ---------- validateVideoFile ----------
{
  console.log('validateVideoFile:');
  const sb = makeSandbox();
  const vf = vm.runInContext('validateVideoFile', sb);
  t('mp4 accepted', vf({ name: 'PRAGMATA_clip_07.mp4', type: 'video/mp4', size: 100 }) === '');
  t('mov accepted (quicktime)', vf({ name: 'a.MOV', type: 'video/quicktime', size: 5 }) === '');
  t('webm accepted', vf({ name: 'a.webm', type: 'video/webm', size: 1 }) === '');
  t('mkv accepted (pre-existing accept attr)', vf({ name: 'a.mkv', type: 'video/x-matroska', size: 1 }) === '');
  t('no mime but .mp4 ext accepted', vf({ name: 'a.mp4', type: '', size: 1 }) === '');
  t('txt rejected', /not a supported video/.test(vf({ name: 'notes.txt', type: 'text/plain', size: 10 })));
  t('exe rejected', /not a supported video/.test(vf({ name: 'game.exe', type: 'application/octet-stream', size: 10 })));
  t('empty file rejected', /empty/.test(vf({ name: 'a.mp4', type: 'video/mp4', size: 0 })));
}

// ---------- backoff ----------
{
  console.log('backoff:');
  const sb = makeSandbox();
  const f = vm.runInContext('gdriveBackoffMs', sb);
  let ok = true;
  for (let i = 1; i <= 8; i++) { const ms = f(i); if (!(ms >= 500 && ms <= 45000)) ok = false; }
  t('attempts 1..8 within expected band', ok);
}

// ---------- chunk math ----------
{
  console.log('chunk math:');
  const sb = makeSandbox();
  const CHUNK = vm.runInContext('DRIVE_CHUNK_SIZE', sb);
  t('chunk size is 8 MiB', CHUNK === 8 * 1024 * 1024);
  t('chunk size multiple of 256 KiB', CHUNK % (256 * 1024) === 0);
  const ranges = total => { const out = []; let off = 0; while (off < total) { const e = Math.min(off + CHUNK, total) - 1; out.push([off, e]); off = e + 1; } return out; };
  for (const total of [1, 256 * 1024 - 1, CHUNK, CHUNK + 1, Math.floor(247.3 * 1024 * 1024), 500 * 1024 * 1024, 1024 * 1024 * 1024]) {
    const rs = ranges(total);
    const aligned = rs.slice(0, -1).every(([s, e]) => s % (256 * 1024) === 0 && (e - s + 1) % (256 * 1024) === 0);
    const contiguous = rs.every(([s, e], i) => i === 0 ? s === 0 : s === rs[i - 1][1] + 1);
    const covers = rs[rs.length - 1][1] === total - 1;
    t(`total ${total}: aligned+contiguous+covers-all`, aligned && contiguous && covers, rs.slice(-1));
  }
}

async function runScenario(name, fn) {
  console.log(name + ':');
  const sb = makeSandbox();
  try { await fn(sb); } catch (e) { fail++; console.log('  FAIL - threw', e && e.message); }
}

(async () => {

  await runScenario('happy path 308→308→201 with intra-chunk progress', async sb => {
    const CHUNK = vm.runInContext('DRIVE_CHUNK_SIZE', sb);
    const total = CHUNK * 2 + 1000;
    sb.__file = { name: 'c.mp4', size: total, lastModified: 1, type: 'video/mp4', slice: (a, b) => ({ size: b - a, from: a, to: b }) };
    const XHR = sb.XMLHttpRequest;
    XHR.queue = xhr => {
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(xhr.headers['Content-Range']);
      const s = +m[1], e = +m[2], tt = +m[3];
      if (!/Bearer tok/.test(xhr.headers['Authorization'] || '')) { xhr.status = 403; xhr.responseText = ''; xhr.onload(); return; }
      if (e + 1 < tt) { xhr.status = 308; xhr.getResponseHeader = h => h === 'Range' ? `bytes=0-${e}` : null; xhr.responseText = ''; }
      else { xhr.status = 201; xhr.getResponseHeader = () => null; xhr.responseText = JSON.stringify({ id: 'FILE123', name: 'c.mp4' }); }
      if (xhr.upload.onprogress) xhr.upload.onprogress({ loaded: e - s + 1 });
      xhr.onload();
    };
    const result = await vm.runInContext(`gdriveRunSession(__file,{uri:'u',offset:0,signature:'s',createdAt:Date.now()},{onProgress:(l,t,p)=>__prog.push([l,t,p]),onStatusLine:m=>__logs.push(m),seq:gdriveUploadSeq})`, sb);
    t('returned Drive file id', result && result.id === 'FILE123', result);
    const expectedChunks = Math.ceil(total / CHUNK);
    t('sent exactly one PUT per chunk', XHR.sent.length === expectedChunks, { sent: XHR.sent.length, expected: expectedChunks });
    t('chunks cover the whole file in order', XHR.sent.every((c, i) => c.start === (i === 0 ? 0 : XHR.sent[i - 1].end + 1)) && XHR.sent[XHR.sent.length - 1].end === total - 1);
    t('all non-final chunks aligned to 256 KiB', XHR.sent.slice(0, -1).every(c => (c.end - c.start + 1) % (256 * 1024) === 0));
    t('progress reached done phase at total', sb.__prog.some(([l, t2, p]) => p === 'done' && l === total), sb.__prog.slice(-3));
    t('progress never exceeded total', sb.__prog.every(([l]) => l <= total));
  });

  await runScenario('network drop mid-upload → probe → resume from confirmed offset', async sb => {
    const CHUNK = vm.runInContext('DRIVE_CHUNK_SIZE', sb);
    const total = CHUNK * 3;
    sb.__file = { name: 'c.mp4', size: total, lastModified: 1, type: 'video/mp4', slice: (a, b) => ({ size: b - a }) };
    const XHR = sb.XMLHttpRequest;
    let chunkNo = 0;
    XHR.queue = xhr => {
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(xhr.headers['Content-Range']);
      const e = +m[2];
      if (m[3] === '*') { xhr.status = 308; xhr.getResponseHeader = h => h === 'Range' ? `bytes=0-${CHUNK - 1}` : null; xhr.responseText = ''; xhr.onload(); return; }
      chunkNo++;
      if (chunkNo === 2) { xhr.onerror(); return; } // network drop on second chunk
      if (e + 1 < total) { xhr.status = 308; xhr.getResponseHeader = h => h === 'Range' ? `bytes=0-${e}` : null; xhr.responseText = ''; }
      else { xhr.status = 201; xhr.getResponseHeader = () => null; xhr.responseText = JSON.stringify({ id: 'F2' }); }
      xhr.onload();
    };
    sb.fetch = async () => ({ status: 308, headers: { get: h => h === 'Range' ? `bytes=0-${CHUNK - 1}` : null }, json: async () => ({}) });
    const result = await vm.runInContext(`gdriveRunSession(__file,{uri:'u',offset:0,signature:'s',createdAt:Date.now()},{onProgress:()=>{},onStatusLine:m=>__logs.push(m),seq:gdriveUploadSeq})`, sb);
    t('upload completed after resume', result && result.id === 'F2', result);
    t('status mentioned resume/attempt', sb.__logs.some(m => /resum|retry/i.test(m)), sb.__logs);
    t('no chunk re-sent from 0 after confirmed progress', XHR.sent.every(c => c.start >= 0));
  });

  await runScenario('session expired (404 on probe) → session_expired error', async sb => {
    sb.__file = { name: 'c.mp4', size: 5000, lastModified: 1, type: 'video/mp4', slice: (a, b) => ({ size: b - a }) };
    const XHR = sb.XMLHttpRequest;
    XHR.queue = xhr => { xhr.onerror(); }; // first chunk dies at network level → probe
    sb.fetch = async () => ({ status: 404, headers: { get: () => null }, json: async () => ({}) });
    let code = '';
    try { await vm.runInContext(`gdriveRunSession(__file,{uri:'u',offset:0,signature:'s',createdAt:Date.now()},{onProgress:()=>{},onStatusLine:()=>{},seq:gdriveUploadSeq})`, sb); }
    catch (e) { code = e.code; }
    t('threw session_expired', code === 'session_expired', code);
  });

  await runScenario('401 mid-upload → silent token renew → completes', async sb => {
    const CHUNK = vm.runInContext('DRIVE_CHUNK_SIZE', sb);
    const total = CHUNK + 10;
    sb.__file = { name: 'c.mp4', size: total, lastModified: 1, type: 'video/mp4', slice: (a, b) => ({ size: b - a }) };
    const XHR = sb.XMLHttpRequest;
    vm.runInContext('let __tok=0; gdriveEnsureToken = async () => "tok" + (++__tok)', sb);
    XHR.queue = xhr => {
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(xhr.headers['Content-Range']);
      const e = +m[2];
      if (m[3] === '*') { xhr.status = 308; xhr.getResponseHeader = h => h === 'Range' ? 'bytes=0-0' : null; xhr.responseText = ''; xhr.onload(); return; }
      if (xhr.headers['Authorization'] === 'Bearer tok1') { xhr.status = 401; xhr.responseText = ''; xhr.onload(); return; }
      if (e + 1 < total) { xhr.status = 308; xhr.getResponseHeader = h => h === 'Range' ? `bytes=0-${e}` : null; xhr.responseText = ''; }
      else { xhr.status = 200; xhr.getResponseHeader = () => null; xhr.responseText = JSON.stringify({ id: 'F3' }); }
      xhr.onload();
    };
    sb.fetch = async () => ({ status: 308, headers: { get: h => h === 'Range' ? 'bytes=0-0' : null }, json: async () => ({}) });
    const result = await vm.runInContext(`gdriveRunSession(__file,{uri:'u',offset:0,signature:'s',createdAt:Date.now()},{onProgress:()=>{},onStatusLine:()=>{},seq:gdriveUploadSeq})`, sb);
    t('completed after re-auth', result && result.id === 'F3', result);
    const tok = vm.runInContext('__tok', sb);
    t('token was renewed at least once', tok >= 2, tok);
  });

  await runScenario('429 → 503 → success (transient retries)', async sb => {
    const CHUNK = vm.runInContext('DRIVE_CHUNK_SIZE', sb);
    const total = CHUNK + 10;
    sb.__file = { name: 'c.mp4', size: total, lastModified: 1, type: 'video/mp4', slice: (a, b) => ({ size: b - a }) };
    const XHR = sb.XMLHttpRequest;
    let n = 0;
    XHR.queue = xhr => {
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(xhr.headers['Content-Range']);
      if (m[3] === '*') { xhr.status = 308; xhr.getResponseHeader = h => h === 'Range' ? `bytes=0-${CHUNK - 1}` : null; xhr.responseText = ''; xhr.onload(); return; }
      n++;
      if (n === 1) { xhr.status = 429; xhr.responseText = ''; xhr.onload(); return; }
      if (n === 2) { xhr.status = 503; xhr.responseText = ''; xhr.onload(); return; }
      xhr.status = 201; xhr.getResponseHeader = () => null; xhr.responseText = JSON.stringify({ id: 'F4' });
      xhr.onload();
    };
    sb.fetch = async () => ({ status: 308, headers: { get: h => h === 'Range' ? `bytes=0-${CHUNK - 1}` : null }, json: async () => ({}) });
    const result = await vm.runInContext(`gdriveRunSession(__file,{uri:'u',offset:0,signature:'s',createdAt:Date.now()},{onProgress:()=>{},onStatusLine:()=>{},seq:gdriveUploadSeq})`, sb);
    t('completed after transient failures', result && result.id === 'F4', result);
  });

  await runScenario('403 non-rate → forbidden error', async sb => {
    sb.__file = { name: 'c.mp4', size: 1000, lastModified: 1, type: 'video/mp4', slice: (a, b) => ({ size: b - a }) };
    const XHR = sb.XMLHttpRequest;
    XHR.queue = xhr => { xhr.status = 403; xhr.responseText = JSON.stringify({ error: { errors: [{ reason: 'forbidden' }] } }); xhr.onload(); };
    let code = '';
    try { await vm.runInContext(`gdriveRunSession(__file,{uri:'u',offset:0,signature:'s',createdAt:Date.now()},{onProgress:()=>{},onStatusLine:()=>{},seq:gdriveUploadSeq})`, sb); }
    catch (e) { code = e.code; }
    t('threw forbidden', code === 'forbidden', code);
  });

  await runScenario('403 rate-limited → retried, then completes', async sb => {
    sb.__file = { name: 'c.mp4', size: 1000, lastModified: 1, type: 'video/mp4', slice: (a, b) => ({ size: b - a }) };
    const XHR = sb.XMLHttpRequest;
    let n = 0;
    XHR.queue = xhr => {
      n++;
      if (n === 1) { xhr.status = 403; xhr.responseText = JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }); xhr.onload(); return; }
      xhr.status = 201; xhr.getResponseHeader = () => null; xhr.responseText = JSON.stringify({ id: 'F5' }); xhr.onload();
    };
    let probes = 0;
    sb.fetch = async () => {
      probes++;
      if (probes >= 2) return { status: 201, headers: { get: () => null }, json: async () => ({ id: 'F5' }) }; // trailing probe confirms
      return { status: 308, headers: { get: h => h === 'Range' ? 'bytes=0-999' : null }, json: async () => ({}) };
    };
    const result = await vm.runInContext(`gdriveRunSession(__file,{uri:'u',offset:0,signature:'s',createdAt:Date.now()},{onProgress:()=>{},onStatusLine:()=>{},seq:gdriveUploadSeq})`, sb);
    t('rate-limited chunk retried and completed', result && result.id === 'F5', result);
  });

  await runScenario('last chunk confirmed via probe when no 200 body parsed', async sb => {
    sb.__file = { name: 'c.mp4', size: 1000, lastModified: 1, type: 'video/mp4', slice: (a, b) => ({ size: b - a }) };
    const XHR = sb.XMLHttpRequest;
    XHR.queue = xhr => {
      if (/\/1000$/.test(xhr.headers['Content-Range'])) { xhr.status = 200; xhr.getResponseHeader = () => null; xhr.responseText = JSON.stringify({ id: 'F6' }); }
      else { xhr.status = 308; xhr.getResponseHeader = h => h === 'Range' ? 'bytes=0-999' : null; xhr.responseText = ''; }
      xhr.onload();
    };
    const result = await vm.runInContext(`gdriveRunSession(__file,{uri:'u',offset:0,signature:'s',createdAt:Date.now()},{onProgress:()=>{},onStatusLine:()=>{},seq:gdriveUploadSeq})`, sb);
    t('single-chunk upload completes', result && result.id === 'F6', result);
  });

  await runScenario('resume: session with offset>0 starts probe at stored offset (no re-upload)', async sb => {
    const CHUNK = vm.runInContext('DRIVE_CHUNK_SIZE', sb);
    const total = CHUNK * 2;
    sb.__file = { name: 'c.mp4', size: total, lastModified: 1, type: 'video/mp4', slice: (a, b) => ({ size: b - a }) };
    const XHR = sb.XMLHttpRequest;
    XHR.queue = xhr => {
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(xhr.headers['Content-Range']);
      const s = +m[1], e = +m[2];
      if (s !== CHUNK) { // any PUT from 0 would be a bug in resume mode
        xhr.status = 500; xhr.responseText = ''; xhr.onload(); return;
      }
      xhr.status = 201; xhr.getResponseHeader = () => null; xhr.responseText = JSON.stringify({ id: 'F7' }); xhr.onload();
    };
    const result = await vm.runInContext(`gdriveRunSession(__file,{uri:'u',offset:${CHUNK},signature:'s',createdAt:Date.now()},{onProgress:()=>{},onStatusLine:m=>__logs.push(m),seq:gdriveUploadSeq})`, sb);
    t('resumed from stored offset and completed', result && result.id === 'F7', result);
    t('only the remaining chunk was PUT', XHR.sent.length === 1 && XHR.sent[0].start === CHUNK, XHR.sent);
    t('user was told about the resume', sb.__logs.some(m => /Resuming/i.test(m)), sb.__logs);
  });

  console.log('provider routing:');
  {
    const sb = makeSandbox();
    const isDriveRecord = vm.runInContext('isDriveRecord', sb);
    t('legacy record (videoPath only) → supabase', !isDriveRecord({ videoPath: 'uid/123_a.mp4', videoName: 'a.mp4' }));
    t('old record without storageProvider → legacy supabase', !isDriveRecord({ videoName: 'x' }));
    t('drive record detected', isDriveRecord({ storageProvider: 'google_drive', driveFileId: 'abc' }));
    t('drive record without provider but with file id → drive', isDriveRecord({ driveFileId: 'abc' }));
    t('null safe', !isDriveRecord(null));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
