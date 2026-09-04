// Large-file simulation: 250 MB File through the REAL gdriveUploadFile code
// path (real Blob slicing) against a stubbed transport. Verifies chunk count,
// 256 KiB alignment, progress behavior, and completion.
const fs = require('fs');
const vm = require('vm');
const { File } = require('node:buffer');

const html = fs.readFileSync('index.html', 'utf8');
const main = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])[0];
const start = main.indexOf('/* ==========================================================\n   GOOGLE DRIVE CLIP STORAGE');
const end = main.indexOf("document.getElementById('addQueue').addEventListener");
const moduleSrc = main.slice(start, end);

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('  ok -', n); } else { fail++; console.log('  FAIL -', n, e !== undefined ? e : ''); } };

const puts = [];
class FakeXHR {
  constructor() { this.headers = {}; this.upload = {}; this.status = 0; }
  open(m, u) { this.method = m; this.uri = u; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  getResponseHeader() { return null; }
  send(blob) {
    const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(this.headers['Content-Range']);
    const s = +m[1], e = +m[2], tt = +m[3];
    if (!m || blob.size !== e - s + 1) { setImmediate(() => this.onerror()); return; }
    puts.push({ start: s, end: e, total: tt, blobSize: blob.size });
    if (e + 1 < tt) { this.status = 308; this.getResponseHeader = h => h === 'Range' ? `bytes=0-${e}` : null; }
    else { this.status = 201; this.responseText = JSON.stringify({ id: 'BIG1', name: 'PRAGMATA_clip_07.mp4', size: tt }); }
    if (this.upload.onprogress) this.upload.onprogress({ loaded: Math.floor(blob.size / 2) });
    if (this.upload.onprogress) this.upload.onprogress({ loaded: blob.size });
    setImmediate(() => this.onload());
  }
  abort() { if (this.onabort) this.onabort(); }
}

const sb = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, Number, String, URLSearchParams, encodeURIComponent,
  fetch: async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('uploadType=resumable')) {
      return { ok: true, status: 200, headers: { get: h => h === 'Location' ? 'https://upload.example/big-session' : null }, json: async () => ({}), text: async () => '' };
    }
    return { status: 308, ok: false, headers: { get: h => h === 'Range' ? 'bytes=0-0' : null }, json: async () => ({}) };
  },
  document: { getElementById: () => null },
  window: { addEventListener: () => {} },
  XMLHttpRequest: FakeXHR,
  formatBytes: n => Math.round(Number(n) || 0),
  currentUser: { id: 'u' }, CLIP_BUCKET: 'clips', isOwner: () => true,
  selectedTwitchClip: () => null, writeCloudStateNow: async () => ({ ok: true }),
  updateDriveConnUI: () => {}, alert: () => {}, showUploadStatus: () => {}, clearUploadStatus: () => {},
  __p: [], __s: [],
};
sb.gdriveSleep = () => new Promise(r => setImmediate(r));
vm.createContext(sb);
vm.runInContext(moduleSrc, sb);
vm.runInContext(`
  gdriveEnsureToken = async () => 'tok';
  gdriveEnsureFolders = async () => ({ rootId: 'R', monthId: 'M' });
`, sb);

(async () => {
  const MB = 1024 * 1024;
  const total = 250 * MB;
  console.log('allocating 250 MB File...');
  sb.__f = new File([new Uint8Array(total)], 'PRAGMATA_clip_07.mp4', { type: 'video/mp4' });

  const t0 = Date.now();
  const result = await vm.runInContext(`gdriveUploadFile(__f,{onProgress:(l,t,p)=>__p.push([l,t,p]),onStatusLine:m=>__s.push(m)})`, sb);
  const dt = ((Date.now() - t0) / 1000).toFixed(2);

  const expectedChunks = Math.ceil(total / (8 * MB));
  t('upload returned Drive file id', result && result.id === 'BIG1', result);
  t(`250 MB uploaded in ${expectedChunks} chunks of 8 MiB`, puts.length === expectedChunks, puts.length);
  t('all non-final chunks exactly 8 MiB', puts.slice(0, -1).every(p => p.blobSize === 8 * MB));
  t('final chunk is the remainder', puts[puts.length - 1].blobSize === total - (expectedChunks - 1) * 8 * MB, puts[puts.length - 1].blobSize);
  t('chunks contiguous and complete', puts.every((p, i) => p.start === (i === 0 ? 0 : puts[i - 1].end + 1)) && puts[puts.length - 1].end === total - 1);
  t('all non-final chunks aligned to 256 KiB', puts.slice(0, -1).every(p => p.start % (256 * 1024) === 0 && p.blobSize % (256 * 1024) === 0));
  t('progress monotonic non-decreasing', sb.__p.every((v, i) => i === 0 || v[0] >= sb.__p[i - 1][0]));
  t('progress reached exactly total in done phase', sb.__p.some(([l, tt, p]) => p === 'done' && l === total && tt === total));
  t('progress never exceeded total', sb.__p.every(([l]) => l <= total));
  t('no error statuses reported', sb.__s.every(m => !/error|fail/i.test(m)), sb.__s.slice(0, 3));
  console.log(`  (simulated ${total / MB} MB in ${puts.length} PUTs, ${dt}s wall time incl. allocation)`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
