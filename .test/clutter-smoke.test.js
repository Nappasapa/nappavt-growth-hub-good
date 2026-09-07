// Clutter-cleanup smoke test: exercises the decluttered Overview + sidebar
// against the REAL index.html with jsdom (same harness pattern as dom.test.js).
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
async function waitFor(fn, ms = 4000) {
  const st = Date.now(); while (Date.now() - st < ms) { try { if (fn()) return true; } catch (e) {} await sleep(20); }
  return false;
}
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Could not load link|css|Not implemented|Could not parse CSS/.test(e.message)) errors.push('jsdomError: ' + e.message); });
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ').slice(0, 200)));

function makeSb(world) {
  return { createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { user: { id: 'owner-1', email: 'owner@test.dev' } } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from: () => {
      const q = {
        select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; },
        maybeSingle: async () => {
          // First fetch of dashboard_state returns the seed queue; then empties.
          if (!world.stateReturned) { world.stateReturned = true; return { data: { state: world.seedState, updated_at: '2026-09-07T00:00:00Z' }, error: null }; }
          return { data: null, error: null };
        },
        single: async () => ({ data: null, error: null }),
        insert: async () => ({ error: null }),
        update() { return { eq: async () => ({ error: null }) }; },
        delete() { return { eq: async () => ({ error: null }) }; },
        upsert: async () => ({ error: null }),
      }; return q;
    },
    rpc: async name => name === 'growth_hub_access_status' ? { data: { role: world.role || 'owner', owner_user_id: 'owner-1' }, error: null } : { data: null, error: null },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'x' }, error: null }), remove: async () => ({ error: null }) }) },
    channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
    removeChannel() {},
  }) };
}

const seedState = {
  fields: {},
  routine: { 0: true },
  queue: [
    { id: 1, status: 'Posted', title: 'Posted A', postTitle: 'Posted A', date: '2026-09-05', platforms: ['YouTube Shorts'], postedAt: '2026-09-05T10:00:00Z', socialAnalytics: { youtube: { views: 1200, likes: 40, matchedBy: 'manual' } } },
    { id: 2, status: 'Ready', title: 'Upcoming B', postTitle: 'Upcoming B', date: '2026-09-10', time: '18:30', platforms: ['TikTok'], createdAt: '2026-09-04T00:00:00Z' },
    { id: 3, status: 'Idea', title: 'Upcoming C', postTitle: 'Upcoming C', date: '2026-09-12', time: '19:00', platforms: ['YouTube'], createdAt: '2026-09-04T00:00:00Z' },
  ],
  clips: [], streams: [], twitchClips: [],
  socialConnections: {}, socialVideos: { youtube: [], tiktok: [], instagram: [] }, socialSyncStatus: {}, socialRefreshRequested: false,
  theme: 'dark',
};

async function boot(empty, role) {
  const world = { stateReturned: false, role: role || 'owner', seedState: empty ? { fields: {}, routine: {}, queue: [], clips: [], streams: [], twitchClips: [], socialConnections: {}, socialVideos: { youtube: [], tiktok: [], instagram: [] }, socialSyncStatus: {}, socialRefreshRequested: false, theme: 'dark' } : seedState };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://nappavt-growth-hub.pages.dev/', pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.supabase = makeSb(world);
      window.google = { accounts: { oauth2: { initTokenClient: () => {} } } };
      window.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
      window.XMLHttpRequest = class { open() {} setRequestHeader() {} send() {} abort() {} };
      window.confirm = () => true; window.alert = () => {};
      window.open = () => {}; window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = function () {};
    },
  });
  await sleep(900);
  return dom.window;
}

(async () => {
  const emptyW = await boot(true);
  const ed = emptyW.document;
  console.log('empty-workspace boot:');
  t('empty state renders without errors', errors.slice(0).length === 0, errors.slice(0, 2));
  t('upcoming shows empty-state guidance', /Nothing scheduled yet/.test(ed.getElementById('dashUpcomingList').textContent), ed.getElementById('dashUpcomingList').textContent.slice(0, 80));
  t('recent shows empty-state guidance', /No posted clips yet/.test(ed.getElementById('dashRecentList').textContent), ed.getElementById('dashRecentList').textContent.slice(0, 80));
  t('folds render metrics + progress at 0', ed.getElementById('kStreams').textContent === '0' && /0%/.test(ed.getElementById('progressPct').textContent));

  const w = await boot(false);
  const d = w.document;
  const errBaseline = errors.length;

  console.log('boot + Overview structure:');
  const shell = d.getElementById('dashboardShell');
  t('dashboard shell visible', shell && shell.classList.contains('visible'));
  t('owner mode set', /Owner/.test(d.getElementById('roleText')?.textContent || ''));
  t('no uncaught errors at boot', errors.slice(errBaseline).length === 0, errors.slice(errBaseline).join(' | '));

  t('primary sidebar pages visible', ['dashboard', 'twitchclips', 'queue', 'contentperformance', 'streams', 'analytics', 'settings']
    .every(p => { const b = d.querySelector(`.nav button[data-page="${p}"]`); return b && b.style.display !== 'none'; }));
  t('secondary pages in the hidden shelf group', ['streamlibrary', 'clips', 'feedback', 'ideas']
    .every(p => !!d.querySelector(`#hiddenPagesShelf button[data-page="${p}"]`)));

  // Overview content lists populated
  t('Upcoming posts list rendered', /Upcoming B/.test(d.getElementById('dashUpcomingList').textContent), d.getElementById('dashUpcomingList').textContent);
  t('Upcoming sorted by date (C after B)', d.getElementById('dashUpcomingList').textContent.indexOf('Upcoming B') < d.getElementById('dashUpcomingList').textContent.indexOf('Upcoming C'));
  t('Recent performance list rendered', /Posted A/.test(d.getElementById('dashRecentList').textContent), d.getElementById('dashRecentList').textContent);
  t('recent shows tracked views', /1,200|1200/.test(d.getElementById('dashRecentList').textContent), d.getElementById('dashRecentList').textContent);
  t('metrics present inside momentum fold', !!d.getElementById('kStreams') && !!d.getElementById('progressPct'));
  t('folds start collapsed (details not open)', !d.getElementById('dashPlanFold').open && !d.getElementById('dashMomentumFold').open && !d.getElementById('dashHealthFold').open, [d.getElementById('dashPlanFold').open, d.getElementById('dashMomentumFold').open, d.getElementById('dashHealthFold').open]);

  // Interaction: expand the plan fold (checklist + quick actions inside)
  d.getElementById('dashPlanFold').open = true;
  t('fold contains quick actions + routine + focus fields', d.getElementById('dashPlanFold').textContent.includes('Queue post') && d.getElementById('dashPlanFold').querySelector('#routineList') && d.getElementById('dashPlanFold').querySelector('[data-field="weekFocus"]'));

  // Desktop "More" expander
  const moreToggle = d.getElementById('moreToggle');
  const moreItems = d.getElementById('moreItemsGroup');
  t('more toggle present + collapsed by default', !!moreToggle && moreItems.hidden === true);
  moreToggle.click();
  await sleep(50);
  t('more expander reveals secondary pages', moreItems.hidden === false && !!moreItems.querySelector('button[data-page="streamlibrary"]'), moreItems.hidden);
  // navigate to a More page from the revealed group
  const clipsBtn = moreItems.querySelector('button[data-page="clips"]');
  clipsBtn.click();
  await sleep(100);
  t('clicking a More page opens that page', d.getElementById('clips').classList.contains('active'));
  t('More group stays expanded when active page is hidden', moreItems.hidden === false);
  moreToggle.click();
  await sleep(50);
  t('More expander collapses again', moreItems.hidden === true);
  t('page still active after collapse', d.getElementById('clips').classList.contains('active'));

  // Overview still renders after re-renderAll passes
  t('no errors after interaction', errors.slice(errBaseline).length === 0, errors.slice(errBaseline).join(' | '));

  // Advisor role: allowed pages visible, secondary pages only via their More,
  // restricted pages never reachable through the nav.
  const aw = await boot(false, 'advisor');
  const ad = aw.document;
  await sleep(100);
  console.log('advisor mode:');
  t('advisor role applied', /Advisor/.test(ad.getElementById('roleText')?.textContent || ''));
  const vis = p => { const b = ad.querySelector(`.nav button[data-page="${p}"]`); return b && b.style.display !== 'none'; };
  t('advisor allowed primaries visible', vis('dashboard') && vis('twitchclips') && vis('contentperformance') && vis('streams') && vis('analytics'));
  t('advisor restricted primaries hidden', !vis('queue') && !vis('settings'));
  t('advisor gets More expander with allowed pages', !!ad.getElementById('moreToggle') && ad.getElementById('moreNavGroup').hidden === false);
  ad.getElementById('moreToggle').click();
  await sleep(50);
  t('advisor More shows streamlibrary + feedback only', vis('streamlibrary') && vis('feedback') && !vis('clips') && !vis('ideas'), [vis('streamlibrary'), vis('feedback'), vis('clips'), vis('ideas')]);
  ad.querySelector(`#moreItemsGroup button[data-page="feedback"]`).click();
  await sleep(80);
  t('advisor can open feedback page via More', ad.getElementById('feedback').classList.contains('active'));

  console.log(`\n${pass} assertions passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS FATAL', e); process.exit(1); });
