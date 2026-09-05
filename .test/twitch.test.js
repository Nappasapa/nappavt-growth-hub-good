// Twitch regression suite — protects the working Twitch integration:
// live status, EventSub display, clip discovery/refresh, history import,
// analytics display, duplicate prevention, auth-expiry display.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name, extra !== undefined ? String(extra).slice(0, 500) : ''); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) { try { if (fn()) return true; } catch (e) {} await sleep(25); }
  return false;
}

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Could not load link|css|Not implemented/.test(e.message)) errors.push('jsdomError: ' + e.message); });
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ').slice(0, 200)));

const seeded = {
  fields: { videoCleanupDays: '7' }, routine: {}, streams: [
    { id: 'st-live', autoTracked: true, title: 'RE2 hardcore', game: 'Resident Evil 2', startedAt: '2026-09-03T18:00:00.000Z', durationMinutes: 240, avg: 18.2, peak: 44, uniqueChatters: 33, returning: 12, newChatters: 9, follows: 7, clips: 3, clipViews: 900, chatMessages: 2200, createdAt: '2026-09-03T18:00:00.000Z' },
    { id: 'st-hist', historicalImport: true, title: 'Old Wukong VOD', game: 'Black Myth: Wukong', startedAt: '2026-07-10T18:00:00.000Z', durationMinutes: 300, vodViews: 1200, clips: 2, clipViews: 300, vodUrl: 'https://twitch.tv/videos/99', createdAt: '2026-07-10T18:00:00.000Z' },
    { id: 'st-man', autoTracked: false, title: '', game: 'Warframe', date: '2026-08-15', hours: 2.5, avg: 9, peak: 15, follows: 2, returning: 4, clips: 1, createdAt: '2026-08-15T00:00:00.000Z' }
  ], clips: [], queue: [], twitchClips: [
    { id: 'tw1', url: 'https://clips.twitch.tv/One', title: 'hallway jumpscare', gameName: 'Resident Evil 2', vodTitle: 'RE2 stream', createdAt: '2026-09-03T19:00:00.000Z', viewCount: 120, duration: 28 },
    { id: 'tw2', url: 'https://clips.twitch.tv/Two', title: 'wukong phase two panic', gameName: 'Black Myth: Wukong', vodTitle: 'wukong', createdAt: '2026-07-10T19:30:00.000Z', viewCount: 40, duration: 33 }
  ],
  twitchStatus: { connected: true, login: 'NappaVT', rangeDays: 30, lastSyncAt: '2026-09-03T22:00:00.000Z' },
  streamTrackingStatus: { active: true, eventsubConnected: true, missingScopes: [] },
  liveStreamSession: {
    startedAt: new Date(Date.now() - 5400000).toISOString(), title: 'LIVE: housewife arc', game: 'Resident Evil 2',
    currentViewers: 26, peakViewers: 41, messageCount: 812, follows: 3, bits: 250, subs: 2, resubs: 1, giftedSubs: 1,
    channelPointRedeems: 5, activeChatters: { a: 1, b: 1, c: 1 }, samples: [{ viewers: 20, messages: 10 }, { viewers: 26, messages: 14 }]
  },
  twitchHistoryStatus: { lastSyncAt: '2026-09-02T08:00:00.000Z', availableVods: 6 },
  theme: 'dark'
};

const world = { upserts: [], remoteState: null, confirmValue: true };

function supabaseStub(role = 'owner') {
  return { createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'owner-1', email: 'owner@test.dev' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: () => {
      const q = {
        select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; },
        maybeSingle: async () => world.remoteState
          ? { data: { state: world.remoteState, updated_at: '2026-09-03T23:00:00.000Z' }, error: null }
          : { data: null, error: null },
        single: async () => ({ data: null, error: null }),
        insert: async () => ({ error: null }),
        update() { return { eq: async () => ({ error: null }) }; },
        delete() { return { eq: async () => ({ error: null }) }; },
        upsert: async p => { world.upserts.push(JSON.parse(JSON.stringify(p))); return { error: null }; },
      };
      return q;
    },
    rpc: async name => name === 'growth_hub_access_status'
      ? { data: { role: 'owner', owner_user_id: 'owner-1' }, error: null }
      : { data: null, error: null },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'x' }, error: null }), remove: async () => ({ error: null }) }) },
    channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
    removeChannel() {},
  }) };
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://nappavt-growth-hub.pages.dev/',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.localStorage.setItem('nappavt_growth_hub_v3:owner-1', JSON.stringify(seeded));
    window.supabase = supabaseStub();
    window.confirm = () => world.confirmValue;
    window.alert = () => {};
    window.prompt = () => '';
    window.open = () => {};
  },
});
const { window } = dom;
const { document } = window;

(async () => {
  await sleep(900);
  await waitFor(() => world.upserts.length >= 1, 4000);

  console.log('live status & EventSub:');
  t('live badge shows LIVE', document.getElementById('streamLiveBadge').textContent === 'LIVE', document.getElementById('streamLiveBadge').textContent);
  t('EventSub connected copy shown', /EventSub connected/.test(document.getElementById('streamTrackingCopy').textContent), document.getElementById('streamTrackingCopy').textContent);
  const liveHtml = document.getElementById('liveStreamDetails').innerHTML;
  t('live session title rendered', liveHtml.includes('LIVE: housewife arc'));
  t('live KPIs rendered (viewers/peak/bits)', liveHtml.includes('26') && liveHtml.includes('41') && liveHtml.includes('250'), liveHtml.slice(0, 200));
  t('latest report points at the auto-tracked stream', document.getElementById('latestStreamSummary').innerHTML.includes('RE2 hardcore'));
  t('openLatestStreamReport enabled', document.getElementById('openLatestStreamReport').disabled === false);
  document.getElementById('openLatestStreamReport').click();
  await sleep(80);
  t('report modal opens with telemetry', document.getElementById('streamReportModal').classList.contains('open'));
  const reportHtml = document.getElementById('streamReportBody').innerHTML;
  t('report shows avg/peak/chatters', reportHtml.includes('18.2') && reportHtml.includes('44') && reportHtml.includes('33'), reportHtml.slice(0, 300));
  t('report shows clips from the stream window (real Twitch data)', reportHtml.includes('Clips from this stream') && reportHtml.includes('hallway jumpscare'));
  document.querySelector('[data-close-stream-report]').click();

  console.log('Twitch clips discovery & status bar:');
  t('status shows connected username', /Connected as NappaVT/.test(document.getElementById('twitchStatusCopy').textContent), document.getElementById('twitchStatusCopy').textContent);
  t('connect note hidden when connected', document.getElementById('twitchConnectNote').style.display === 'none');
  t('two twitch clip cards render', document.querySelectorAll('#twitchClipGrid .twitch-card').length === 2);
  t('clip links preserved', !!document.querySelector('#twitchClipGrid a[href="https://clips.twitch.tv/One"]'));

  console.log('refresh request: honest pending + duplicate protection:');
  const refreshBtn = document.getElementById('requestTwitchRefresh');
  t('refresh starts enabled', refreshBtn.disabled === false);
  refreshBtn.click();
  await sleep(100);
  t('click disables the button while pending', document.getElementById('requestTwitchRefresh').disabled === true);
  t('pending copy shows in status bar', /refresh requested/.test(document.getElementById('twitchStatusCopy').textContent), document.getElementById('twitchStatusCopy').textContent);
  const n0 = world.upserts.length;
  document.getElementById('requestTwitchRefresh').click(); // must no-op
  await sleep(700);
  t('second click during pending is a no-op', world.upserts.length <= n0 + 1, world.upserts.length - n0);
  // bot completes the sync (lastSyncAt moves past the request)
  const st = JSON.parse(JSON.stringify(world.upserts[world.upserts.length - 1].state));
  world.remoteState = st;
  t('requestedAt flag persisted to cloud', Boolean(world.upserts[world.upserts.length - 1].state.twitchRefreshRequestedAt));

  console.log('history import & stream library:');
  t('history status line shows VOD count', /6 currently available VOD/.test(document.getElementById('twitchHistoryStatus').textContent), document.getElementById('twitchHistoryStatus').textContent);
  t('all 3 library cards render', document.querySelectorAll('#streamLibraryCards .stream-library-card').length === 3);
  t('historical card shows VOD metrics', document.getElementById('streamLibraryCards').innerHTML.includes('VOD views'));
  t('manual card shows Follows + Clips metrics', document.getElementById('streamLibraryCards').innerHTML.includes('Returning') && document.getElementById('streamLibraryCards').innerHTML.includes('Clips'));
  // sort interaction (render-only)
  document.getElementById('streamLibrarySort').value = 'peak';
  document.getElementById('streamLibrarySort').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(40);
  const firstCardTitle = document.querySelector('#streamLibraryCards .stream-library-card .stream-library-title');
  t('sort by peak puts 44-peak stream first', firstCardTitle.textContent.includes('RE2 hardcore'), firstCardTitle.textContent);
  document.getElementById('streamLibraryFilter').value = 'historical';
  document.getElementById('streamLibraryFilter').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(40);
  t('filter shows only historical VODs', document.querySelectorAll('#streamLibraryCards .stream-library-card').length === 1, document.querySelectorAll('#streamLibraryCards .stream-library-card').length);
  document.getElementById('streamLibraryFilter').value = 'all';
  document.getElementById('streamLibraryFilter').dispatchEvent(new window.Event('change', { bubbles: true }));
  // historical report opens
  document.querySelector('#streamLibraryCards [data-open-stream-report="st-hist"]').click();
  await sleep(60);
  t('historical report explains unavailable telemetry', /cannot reconstruct old average\/peak/.test(document.getElementById('streamReportBody').textContent));
  t('historical metrics show VOD views only, avg marked unavailable', /not historically available/.test(document.getElementById('streamReportBody').textContent));
  document.querySelector('[data-close-stream-report]').click();

  console.log('duplicate prevention in clip merge:');
  // First save with remote containing the clips twice-merged → no duplicates.
  {
    const remote = JSON.parse(JSON.stringify(world.upserts[world.upserts.length - 1].state));
    remote.twitchClips[0].viewCount = 999; // bot stat update
    world.remoteState = remote;
    document.querySelector('#routineList input[type="checkbox"]').click(); // trigger save
    await waitFor(() => world.upserts[world.upserts.length - 1].state.twitchClips.some(c => c.viewCount === 999), 3000);
    const clips = world.upserts[world.upserts.length - 1].state.twitchClips;
    const ids = clips.map(c => c.id);
    t('no duplicate twitch clips after merge saves', new Set(ids).size === ids.length, ids.join(','));
    t('bot stat update merged in', clips.find(c => c.id === 'tw1').viewCount === 999);
  }

  console.log('auth-expiry display:');
  {
    const expired = JSON.parse(JSON.stringify(world.upserts[world.upserts.length - 1].state));
    expired.twitchStatus = { connected: false, error: 'Twitch authorization expired — reconnect from Discord.' };
    world.remoteState = expired;
    // force a full cloud refresh through the module path used by the poll by
    // clearing the updated_at marker via a fresh save cycle
    await sleep(50);
    // Simulate the poll applying remote state: owner is clean after save, so
    // emulating remote application through another save merge is enough for twitchStatus.
    document.querySelectorAll('#routineList input[type="checkbox"]')[2].click();
    await waitFor(() => /authorization expired/.test(document.getElementById('twitchStatusCopy').textContent), 3000);
    t('expired twitch auth surfaces instead of looking connected', /authorization expired/.test(document.getElementById('twitchStatusCopy').textContent), document.getElementById('twitchStatusCopy').textContent);
    t('connect note reappears on expiry', document.getElementById('twitchConnectNote').style.display !== 'none');
  }

  console.log('manual stream delete confirm:');
  world.confirmValue = false;
  document.querySelector('[data-del-stream="st-man"]').click();
  await sleep(60);
  t('cancel keeps the manual entry', document.querySelectorAll('#streamLibraryCards .stream-library-card').length === 3);
  world.confirmValue = true;
  document.querySelector('[data-del-stream="st-man"]').click();
  await sleep(100);
  t('confirm deletes the manual entry', document.querySelectorAll('#streamLibraryCards .stream-library-card').length === 2, document.querySelectorAll('#streamLibraryCards .stream-library-card').length);

  console.log('connection health card:');
  const health = document.getElementById('connectionHealth').innerHTML;
  t('health card lists Supabase', health.includes('Supabase cloud'));
  t('health card lists Nappa Bot with real check-in time', health.includes('Nappa Bot') && /Last bot data/.test(health));
  t('health card lists Twitch / Drive / socials', health.includes('Twitch') && health.includes('Google Drive') && health.includes('YouTube') && health.includes('TikTok') && health.includes('Instagram'));
  t('health card shows twitch expiry as actionable', /authorization expired/i.test(health) && /twitchclips_connect/.test(health), health.slice(0, 400));

  console.log('console hygiene:');
  t('no runtime errors during twitch suite', errors.length === 0, errors.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS FATAL', e); process.exit(1); });
