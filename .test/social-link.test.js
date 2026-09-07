// Manual social-link regression tests.
//
// Bug being locked in: "manually linking a video to track the stats is not
// working, especially for YouTube links." Manual links were stored verbatim
// (never validated or canonicalized) and gave zero feedback, so pasting most
// real-world YouTube URL shapes (youtu.be, /shorts/, /embed/, /live/,
// music/mobile hosts, share-sheet tracking params) ended in a silent
// "linked but stats never appear" state.
//
// The dashboard now canonicalizes every manual link to one predictable URL
// before saving it, rejects junk with a clear message, unlinks on blank, and
// renders "waiting for Nappa Bot stats" until socialAnalytics arrives.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const main = scripts[0];

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name, extra !== undefined ? String(extra).slice(0, 600) : ''); }
}

const CANON = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const ID = 'dQw4w9WgXcQ';

// ---------- A. static wiring checks on the shipped HTML ----------
{
  console.log('static wiring:');
  const start = main.indexOf('MANUAL SOCIAL LINK FIX');
  const end = main.indexOf('END MANUAL SOCIAL LINK FIX HELPERS');
  t('manual-link helper block exists', start > 0 && end > start);
  t('block markers unique', main.indexOf('MANUAL SOCIAL LINK FIX', start + 1) === -1 || true); // informational
  const countStart = main.split('MANUAL SOCIAL LINK FIX — canonical URLs').length - 1;
  const countEnd = main.split('END MANUAL SOCIAL LINK FIX HELPERS').length - 1;
  t('start marker appears exactly once', countStart === 1, countStart);
  t('end marker appears exactly once', countEnd === 1, countEnd);

  // Old buggy storage line (raw paste stored straight into the queue record)
  // must be gone; every write path now goes through setManualSocialLink.
  t('no direct raw assignment to manualSocialLinks[platform] remains',
    !/manualSocialLinks\[platform\]\s*=\s*(url|raw)/.test(main));

  // promptSocialLink now validates + canonicalizes + explains accepted forms.
  t('promptSocialLink uses canonicalSocialLinkUrl',
    /function promptSocialLink[\s\S]{0,900}canonicalSocialLinkUrl\(platform,value\)/.test(main));
  t('promptSocialLink rejects junk without saving',
    /if\(!url\)\{[\s\S]{0,240}Nothing was changed/.test(main));
  t('blank paste removes the manual link',
    /Leave blank to remove the current manual link/.test(main) &&
    /removeManualSocialLink\(q,platform\)/.test(main));
  t('queue cards render manual-link waiting state via queueSocialTrackingHTML',
    /\$\{queueSocialTrackingHTML\(q\)\}/.test(main));
  t('performance cards use state-aware link buttons',
    main.includes('socialLinkButtonHTML(q,') || main.includes("socialLinkButtonHTML(q,'"));
  t('performance platform shows waiting state when a link is stored',
    /Waiting for Nappa Bot stats/.test(main));
  t('saved-link toast mentions the next Nappa Bot refresh',
    /link saved — Nappa Bot will fetch its stats on the next refresh/.test(main));
}

// ---------- B. runtime checks on the pure helper block ----------
function sliceHelpers() {
  const start = main.indexOf('/* ==========================================================================\n   MANUAL SOCIAL LINK FIX');
  if (start < 0) return '';
  const promptAt = main.indexOf('function promptSocialLink(queueId,platform){', start);
  const end = promptAt > start ? promptAt : main.indexOf('\nfunction renderContentPerformance(){', start);
  return main.slice(start, end < start ? main.length : end);
}

function makeSandbox(overrides) {
  const records = {};
  const box = {
    console,
    queue: null,
    promptReturn: '',
    lastPrompt: '',
    toasts: [],
    saved: 0,
    records,
    esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    metricNumber: v => (v == null || v === '' ? '0' : String(v)),
    socialPlatformRecord: (q, p) => records[p] || null,
    state: { queue: [] },
    prompt: (msg, def) => { box.lastPrompt = String(msg); box.lastDefault = def; return box.promptReturn; },
    notifyUser: (m, type) => box.toasts.push(String(m)),
    save: () => { box.saved++; },
    renderQueue: () => {},
    renderContentPerformance: () => {},
  };
  if (overrides) Object.assign(box, overrides);
  return box;
}

function freshCtx() {
  const code = sliceHelpers();
  const box = makeSandbox();
  vm.createContext(box);
  vm.runInContext(code, box);
  return box;
}

function canonical(box, platform, raw) {
  return vm.runInContext(`canonicalSocialLinkUrl(${JSON.stringify(platform)}, ${JSON.stringify(raw)})`, box);
}

{
  console.log('YouTube canonicalization (all common paste forms):');
  const box = freshCtx();
  const forms = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL9tY0BWXOZFuFEGuDA2emcrUe3cJgxwCj&index=2',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=2m30s',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=AbCdefGhiJk',
    'https://youtu.be/dQw4w9WgXcQ?t=42',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ?feature=share',
    'https://www.youtube.com/v/dQw4w9WgXcQ',
    'https://youtube-nocookie.com/embed/dQw4w9WgXcQ',
    '<https://www.youtube.com/watch?v=dQw4w9WgXcQ>',
    'dQw4w9WgXcQ'
  ];
  forms.forEach(f => {
    const r = canonical(box, 'youtube', f);
    t(`youtube accepts: ${f}`, r.url === CANON && !r.error, r);
  });
}

{
  console.log('YouTube rejection (foreign hosts / junk):');
  const box = freshCtx();
  const bad = [
    'https://evil.example/watch?v=dQw4w9WgXcQ',
    'https://notyoutube.com/shorts/dQw4w9WgXcQ',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://myyoutu.be/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=tooshort',
    'https://youtu.be/tooShort', // shorter than 11 chars
    'https://www.youtube.com/feed/subscriptions',
    'this is definitely not a youtube url',
    'https://www.youtube.com/watch?v=1234567890123' // too long
  ];
  bad.forEach(f => {
    const r = canonical(box, 'youtube', f);
    t(`youtube rejects: ${f}`, !r.url && !!r.error, r);
  });
  t('youtube error message lists accepted forms', /watch\?v=…/.test(canonical(box, 'youtube', 'garbage').error));
}

{
  console.log('TikTok + Instagram canonicalization:');
  const box = freshCtx();
  const pairs = [
    ['tiktok', 'https://www.tiktok.com/@nappavt/video/7123456789012345678?is_from_webapp=1&sender_device=pc',
      'https://www.tiktok.com/@nappavt/video/7123456789012345678'],
    ['tiktok', 'https://vm.tiktok.com/ZMabcDeFg/', 'https://vm.tiktok.com/ZMabcDeFg/'],
    ['tiktok', 'https://www.tiktok.com/video/7123456789012345678', 'https://www.tiktok.com/video/7123456789012345678'],
    ['instagram', 'https://www.instagram.com/reel/CxAbCdEfGhI/?igsh=MTNsa2ZwbzNs', 'https://www.instagram.com/reel/CxAbCdEfGhI'],
    ['instagram', 'https://www.instagram.com/p/CxAbCdEfGhI/', 'https://www.instagram.com/p/CxAbCdEfGhI'],
    ['instagram', 'https://instagram.com/reels/CxAbCdEfGhI', 'https://www.instagram.com/reel/CxAbCdEfGhI']
  ];
  pairs.forEach(([p, input, want]) => {
    const r = canonical(box, p, input);
    t(`${p} accepts and canonicalizes: ${input}`, r.url === want && !r.error, r);
  });
  const badTt = [
    ['tiktok', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['tiktok', 'https://www.tiktok.com/@nappavt/photo/7123456789012345678'],
    ['instagram', 'https://www.instagram.com/stories/nappavt/1234567890123456789/'],
    ['instagram', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ']
  ];
  badTt.forEach(([p, input]) => {
    const r = canonical(box, p, input);
    t(`${p} rejects: ${input}`, !r.url && !!r.error, r);
  });
}

{
  console.log('set/get/remove manual links + fallback + requested-at stamp:');
  const box = freshCtx();
  const q = { id: 7, status: 'Posted' };
  box.q = q;
  vm.runInContext(`setManualSocialLink(q, 'youtube', 'https://youtu.be/dQw4w9WgXcQ?si=abc')`, box);
  t('stores canonical youtube watch URL', q.manualSocialLinks.youtube === CANON, q.manualSocialLinks);
  t('records manualLinkRequestedAt timestamp', !!q.manualLinkRequestedAt.youtube, q.manualLinkRequestedAt);
  t('getManualSocialLink returns stored value', vm.runInContext(`getManualSocialLink(q, 'youtube')`, box) === CANON);
  // Legacy/unparseable URLs survive as a fallback (never drop user data).
  vm.runInContext(`setManualSocialLink(q, 'instagram', 'https://ig.me/whatever')`, box);
  t('unparseable legacy link kept as raw fallback', q.manualSocialLinks.instagram === 'https://ig.me/whatever', q.manualSocialLinks);
  vm.runInContext(`removeManualSocialLink(q, 'youtube')`, box);
  t('blank removes the platform key', !('youtube' in q.manualSocialLinks), q.manualSocialLinks);
  t('blank removes its requested-at stamp', !('youtube' in (q.manualLinkRequestedAt || {})), q.manualLinkRequestedAt);
  vm.runInContext(`removeManualSocialLink(q, 'instagram')`, box);
  t('clearing the last platform removes the whole links object', !q.manualSocialLinks, q);
}

{
  console.log('link state + queue note rendering:');
  const box = freshCtx();
  const q = { id: 7, status: 'Posted' };
  box.q = q;
  vm.runInContext(`setManualSocialLink(q, 'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')`, box);
  t('state is "waiting" before stats arrive', vm.runInContext(`manualSocialLinkState(q, 'youtube')`, box) === 'waiting');
  box.records.youtube = { views: 1234, likes: 56 };
  t('state becomes "tracked" once socialAnalytics exists', vm.runInContext(`manualSocialLinkState(q, 'youtube')`, box) === 'tracked');
  box.records.youtube = null;
  const waiting = vm.runInContext(`queueSocialTrackingHTML(q)`, box);
  t('queue note advertises waiting state', /waiting for Nappa Bot stats/.test(waiting), waiting);
  t('queue note links the stored URL', waiting.includes(CANON), waiting);
  box.records.youtube = { views: 4321, likes: 77 };
  const tracked = vm.runInContext(`queueSocialTrackingHTML(q)`, box);
  t('queue note shows automatic stats once tracked', /Automatic post analytics/.test(tracked) && tracked.includes('4321') && !tracked.includes('waiting'), tracked);
  box.records.youtube = null; // fresh post with no record and no link
  const q2 = { id: 9 };
  box.q = q2;
  const empty = vm.runInContext(`queueSocialTrackingHTML(q)`, box);
  t('queue note empty when nothing is linked/tracked', empty === '', empty);
}

{
  console.log('promptSocialLink end-to-end (valid paste, junk, blank):');
  const code = sliceHelpers() + main.slice(
    main.indexOf('function promptSocialLink(queueId,platform){', main.indexOf('END MANUAL SOCIAL LINK FIX HELPERS')),
    main.indexOf('function renderContentPerformance(){', main.indexOf('function promptSocialLink(queueId,platform){'))
  );
  const box = makeSandbox();
  box.state = { queue: [{ id: 42, status: 'Posted', title: 'My clip' }] };
  vm.createContext(box);
  vm.runInContext(code, box);

  box.promptReturn = 'https://youtu.be/dQw4w9WgXcQ?si=trackingParam';
  vm.runInContext(`promptSocialLink('42', 'youtube')`, box);
  const linked = box.state.queue[0].manualSocialLinks && box.state.queue[0].manualSocialLinks.youtube;
  t('valid paste is saved canonical', linked === CANON, linked);
  t('toast announces saved link', box.toasts.some(m => /link saved/.test(m)), box.toasts);
  t('refresh requested after linking', box.state.socialRefreshRequested === true);
  // Open the dialog a second time: it must show the currently linked URL.
  box.toasts = [];
  vm.runInContext(`promptSocialLink('42', 'youtube')`, box);
  t('prompt prefilled with current link on next call', /Currently linked:\nhttps:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ/.test(box.lastPrompt), box.lastPrompt);
  t('re-saving the same link keeps it canonical', box.state.queue[0].manualSocialLinks.youtube === CANON);

  box.toasts = [];
  box.promptReturn = 'this is junk, definitely not a url';
  vm.runInContext(`promptSocialLink('42', 'youtube')`, box);
  t('junk paste does not overwrite the saved link', box.state.queue[0].manualSocialLinks.youtube === CANON);
  t('junk paste surfaces an error toast', box.toasts.length === 1 && /does not look like a YouTube/.test(box.toasts[0]), box.toasts);

  box.toasts = [];
  box.promptReturn = '   ';
  vm.runInContext(`promptSocialLink('42', 'youtube')`, box);
  const cleared = box.state.queue[0];
  t('blank paste unlinks (key removed)', !cleared.manualSocialLinks || !('youtube' in cleared.manualSocialLinks), cleared);
  t('blank paste announces removal', box.toasts.some(m => /removed/.test(m)), box.toasts);
}

console.log(`\n${pass} assertions passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
