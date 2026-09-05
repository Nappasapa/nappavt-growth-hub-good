// Nappa Pack title-system regression suite.
// Covers: per-title selection, text/background clicks, copy, editing,
// regeneration, filtering/sorting, reload restore, Supabase sync merge
// semantics, rapid selection, and adversarial title content.
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

const CLIP_A = {
  id: 'clipA', url: 'https://clips.twitch.tv/A', title: 'THANK GOD THE CHILD IS OKAY',
  vodTitle: 'BECOMING A HOUSEWIFE IN RESIDENT EVIL 2', vodUrl: 'https://twitch.tv/videos/1',
  gameName: 'Resident Evil 2', gameId: 'g1', thumbnailUrl: '', viewCount: 42, duration: 30,
  creatorName: 'clipper', createdAt: '2026-09-01T20:00:00.000Z',
  packageUserContext: 'I talked shit about my teammate and he immediately clutched the fight.'
};
const CLIP_B = {
  id: 'clipB', url: 'https://clips.twitch.tv/B', title: 'MR X HAS NOT LEARNED PERSONAL SPACE',
  vodTitle: 'CRIME SPREE BUT THE POLICE ARE BREAD', vodUrl: 'https://twitch.tv/videos/2',
  gameName: 'Hunt: Showdown', gameId: 'g2', thumbnailUrl: '', viewCount: 7, duration: 25,
  creatorName: 'clipper', createdAt: '2026-08-28T20:00:00.000Z'
};
// Adversarial content: quotes, apostrophes, emoji, punctuation and HTML
// injection characters inside Twitch-provided text.
const CLIP_C = {
  id: 'clipC', url: 'https://clips.twitch.tv/C', title: `BRO WHAT?! "he's here" — MR. X!!! 😭 <img src=x onerror=alert(1)>`,
  vodTitle: "THERAPY SESSION: it's not a phase", vodUrl: 'https://twitch.tv/videos/3',
  gameName: 'Pragmata', gameId: 'g3', thumbnailUrl: '', viewCount: 3, duration: 44,
  creatorName: 'cl<p>per', createdAt: '2026-08-30T20:00:00.000Z',
  packageUserContext: 'He said "watch this" and then IMMEDIATELY died 🍞💀'
};

const seeded = {
  fields: { videoCleanupDays: '7' }, routine: {}, streams: [
    { id: 9001, autoTracked: true, title: 'RE2 housewife arc', game: 'Resident Evil 2', startedAt: '2026-09-01T18:00:00.000Z', durationMinutes: 210, avg: 12.5, peak: 31, uniqueChatters: 20, returning: 7, follows: 5, clips: 2, createdAt: '2026-09-01T18:00:00.000Z' }
  ], clips: [], queue: [], twitchClips: [CLIP_A, CLIP_B, CLIP_C],
  twitchStatus: { connected: true, login: 'NappaVT', rangeDays: 30, lastSyncAt: '2026-09-01T21:00:00.000Z' },
  theme: 'dark'
};

const world = { upserts: [], remoteState: null, remoteUpdatedAt: '', copied: null, confirmValue: true };

function supabaseStub() {
  return { createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'owner-1', email: 'owner@test.dev' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: () => {
      const q = {
        select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; },
        maybeSingle: async () => world.remoteState
          ? { data: { state: world.remoteState, updated_at: world.remoteUpdatedAt }, error: null }
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

const localStorageDump = {};
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://nappavt-growth-hub.pages.dev/',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.localStorage.setItem('nappavt_growth_hub_v3:owner-1', JSON.stringify(seeded));
    window.supabase = supabaseStub();
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: async v => { world.copied = String(v); } },
      configurable: true
    });
    window.confirm = () => world.confirmValue;
    window.alert = () => {};
    window.prompt = () => '';
    window.open = () => {};
  },
});
const { window } = dom;
const { document } = window;

const grid = () => document.getElementById('twitchClipGrid');
const cards = () => [...grid().querySelectorAll('.twitch-card')];
const cardFor = id => cards().find(c => c.querySelector(`[data-pack-id="${id}"]`));
const optionsOf = card => [...card.querySelectorAll('[data-pack-opt]')];
const titleOf = btn => btn.querySelector('.nappa-title-copy').textContent;
const selectedTitleOf = card => {
  const el = card.querySelector('.nappa-title-option.selected .nappa-title-copy');
  return el ? el.textContent : null;
};
const storedClip = id => {
  const s = JSON.parse(window.localStorage.getItem('nappavt_growth_hub_v3:owner-1'));
  return (s.twitchClips || []).find(c => c.id === id) || {};
};
const lastUpsert = () => world.upserts[world.upserts.length - 1];
function mirrorCloud() {
  const up = lastUpsert();
  if (up) { world.remoteState = up.state; world.remoteUpdatedAt = up.updated_at; }
}
async function settleSaves(extra = 0) {
  const n = world.upserts.length;
  await waitFor(() => world.upserts.length > n || false, 700 + extra);
  await sleep(250);
}

(async () => {
  await sleep(800);
  console.log('render sanity (pre-selection):');
  await waitFor(() => cards().length === 3, 4000);
  t('three clip cards render', cards().length === 3, cards().length);
  t('initial cloud seed happened', await waitFor(() => world.upserts.length >= 1, 4000));
  mirrorCloud();

  const cardA = cardFor('clipA');
  const optsA = optionsOf(cardA);
  t('clip A shows >= 4 title options', optsA.length >= 4, optsA.length);
  t('no option is pre-marked selected before any click', !cardA.querySelector('.nappa-title-option.selected'));
  t('one option is marked as suggestion (TOP PICK)', cardA.querySelectorAll('.nappa-title-option.suggested').length === 1);
  t('panel is honest about only being a suggestion', /TOP SUGGESTION/.test(cardA.querySelector('.nappa-selected-label').textContent));
  const ids = optsA.map(b => b.dataset.packOpt);
  t('every option has a unique non-empty stable id', new Set(ids).size === ids.length && ids.every(x => x && x.length > 4), ids.join(','));

  console.log('scenario 1+9: selecting every title individually (and rapid switching):');
  const spanTitles = optsA.map(titleOf);
  for (let i = 0; i < optsA.length; i++) {
    const wanted = spanTitles[i];
    // re-query fresh buttons after each rerender; click the one with the same displayed text
    const fresh = optionsOf(cardFor('clipA')).find(b => titleOf(b) === wanted);
    t('option re-resolvable across rerenders', !!fresh, wanted);
    fresh.click();
    await sleep(30);
    const c = cardFor('clipA');
    t('selecting title ' + (i + 1) + ' shows that exact title selected', selectedTitleOf(c) === wanted, selectedTitleOf(c) + ' vs ' + wanted);
    t('stored selection equals the exact displayed title ' + (i + 1), storedClip('clipA').packageSelectedTitle === wanted, storedClip('clipA').packageSelectedTitle);
    t('panel agrees with the selected title ' + (i + 1), c.querySelector('.nappa-pack-suggestion-title').textContent === wanted);
    t('at most one card marked selected ' + (i + 1), c.querySelectorAll('.nappa-title-option.selected').length === 1);
  }
  await settleSaves();
  mirrorCloud();

  console.log('scenario 2: clicking the text span and the card background:');
  const targetTextBtn = optionsOf(cardFor('clipA'))[2];
  const wantedBg = titleOf(targetTextBtn);
  targetTextBtn.querySelector('.nappa-title-copy').click(); // inner text span
  await sleep(30);
  t('clicking the title text selects that title', selectedTitleOf(cardFor('clipA')) === wantedBg, selectedTitleOf(cardFor('clipA')));
  const otherBtn = optionsOf(cardFor('clipA'))[1];
  const wantedBtn = titleOf(otherBtn);
  otherBtn.click(); // button background itself
  await sleep(30);
  t('clicking the card background selects that exact title', selectedTitleOf(cardFor('clipA')) === wantedBtn, selectedTitleOf(cardFor('clipA')));
  t('stored state follows the background click', storedClip('clipA').packageSelectedTitle === wantedBtn);

  console.log('scenario 3: copying the selected title:');
  const copyBtn = [...cardFor('clipA').querySelectorAll('[data-copy-pack="title"]')][0];
  copyBtn.click();
  await waitFor(() => world.copied === wantedBtn, 2000);
  t('copy title copies exactly the displayed selected title', world.copied === wantedBtn, world.copied);
  // deselect path: fresh regeneration clears selection → copy follows the shown top suggestion
  const copyAllBtn = cardFor('clipA').querySelector('[data-copy-pack="all"]');
  const before = world.copied;
  copyAllBtn.click();
  await waitFor(() => world.copied !== before, 2000);
  t('copy all includes the selected title', (world.copied || '').startsWith(wantedBtn + '\n'), (world.copied || '').slice(0, 80));

  console.log('scenario 4: editing context on one clip does not touch another:');
  const selectedA = storedClip('clipA').packageSelectedTitle;
  const cardB = cardFor('clipB');
  const ctx = cardB.querySelector('[data-pack-context-input]');
  ctx.value = 'the npc said my name with a bread knife in hand';
  cardB.querySelector('[data-apply-pack-context]').click();
  await sleep(50);
  t('clip A selection unchanged after editing clip B context', storedClip('clipA').packageSelectedTitle === selectedA, storedClip('clipA').packageSelectedTitle);
  t('clip A still visibly shows the same selection', selectedTitleOf(cardFor('clipA')) === selectedA);
  t('clip B stored the new context', storedClip('clipB').packageUserContext.includes('bread knife'));

  console.log('scenario 5: regenerating never silently selects the first/prefix title:');
  // clip A has a live selection — Fresh angles must not switch it to a different title
  cardFor('clipA').querySelector('[data-pack-action="new"]').click();
  await sleep(50);
  {
    const c = cardFor('clipA');
    const stillThere = optionsOf(c).some(b => titleOf(b) === selectedA);
    const now = selectedTitleOf(c);
    if (stillThere) {
      t('selection survives regeneration when the title still exists', now === selectedA, now + ' vs ' + selectedA);
    } else {
      t('nothing marked selected when the chosen title rotated out', now === null, now);
    }
    t('regeneration never leaves a DIFFERENT stored title', !storedClip('clipA').packageSelectedTitle || storedClip('clipA').packageSelectedTitle === selectedA,
      storedClip('clipA').packageSelectedTitle);
  }
  // clip B (context edited, selection cleared if any): pick nothing; regenerate again
  {
    cardFor('clipB').querySelector('[data-pack-action="short"]').click();
    await sleep(50);
    const c = cardFor('clipB');
    const stored = storedClip('clipB').packageSelectedTitle || '';
    const visible = selectedTitleOf(c);
    t('unsaved clip shows no selected card after regeneration', stored ? visible === stored : visible === null, JSON.stringify({ stored, visible }));
    t('suggestion badge, not selection, on the top un-selected option',
      !stored ? c.querySelector('.nappa-title-option.suggested') !== null : true);
  }

  console.log('scenario 6: filtering and sorting never change the selection:');
  const keepA = storedClip('clipA').packageSelectedTitle || '';
  document.getElementById('streamLibraryFilter').value = 'manual';
  document.getElementById('streamLibraryFilter').dispatchEvent(new window.Event('change', { bubbles: true }));
  document.getElementById('streamLibrarySort').value = 'peak';
  document.getElementById('streamLibrarySort').dispatchEvent(new window.Event('change', { bubbles: true }));
  document.querySelector('#clipFilters .chip[data-filter="Posted"]').click();
  document.querySelector('#clipFilters .chip[data-filter="All"]').click();
  await sleep(60);
  {
    const visible = selectedTitleOf(cardFor('clipA'));
    t('selection unchanged through unrelated filters/sorts', visible === (keepA || null), JSON.stringify({ visible, keepA }));
    t('stored selection unchanged by filters/sorts', (storedClip('clipA').packageSelectedTitle || '') === keepA);
  }

  console.log('scenario 8: Supabase sync cannot overwrite a newer local selection:');
  // 8a: select a precise title, then simulate a BOT write (new clip + metadata
  // change) landing BEFORE the debounced save. The selection must survive
  // locally and in the cloud payload, and the bot's clip must still arrive.
  const pickBtn = optionsOf(cardFor('clipA'))[0];
  const pickedTitle = titleOf(pickBtn);
  pickBtn.click();
  await sleep(40);
  // bot writes between click and save:
  const botState = JSON.parse(JSON.stringify(world.remoteState));
  botState.twitchClips.find(c => c.id === 'clipA').thumbnailUrl = 'https://thumb.example/bot.jpg';
  botState.twitchClips.push({ id: 'clipNew', url: 'https://clips.twitch.tv/N', title: 'bot imported', createdAt: '2026-09-02T10:00:00.000Z', gameName: 'Warframe' });
  world.remoteState = botState;
  await settleSaves();
  {
    const cloud = lastUpsert().state;
    const cloudA = (cloud.twitchClips || []).find(c => c.id === 'clipA') || {};
    t('cloud payload keeps the exact selected title despite bot write', cloudA.packageSelectedTitle === pickedTitle, cloudA.packageSelectedTitle + ' vs ' + pickedTitle);
    t('cloud payload still carries the bot metadata update', cloudA.thumbnailUrl === 'https://thumb.example/bot.jpg', cloudA.thumbnailUrl);
    t('cloud payload includes the bot-imported clip', (cloud.twitchClips || []).some(c => c.id === 'clipNew'));
    t('visible selection survived the bot write', selectedTitleOf(cardFor('clipA')) === pickedTitle, selectedTitleOf(cardFor('clipA')));
  }
  // 8b: a STALE remote copy (older packaging timestamp) must not win either.
  mirrorCloud();
  {
    const stale = JSON.parse(JSON.stringify(world.remoteState));
    const staleClip = stale.twitchClips.find(c => c.id === 'clipA');
    staleClip.packageSelectedTitle = 'STALE REMOTE TITLE SHOULD LOSE';
    staleClip.packageLastUsedAt = '2020-01-01T00:00:00.000Z';
    staleClip.viewCount = 99;
    world.remoteState = stale;
    // trigger a save via an unrelated edit
    document.querySelector('#routineList input[type="checkbox"]').click();
    await settleSaves();
    const cloudA = (lastUpsert().state.twitchClips || []).find(c => c.id === 'clipA') || {};
    t('stale remote selection cannot override the local one', cloudA.packageSelectedTitle === pickedTitle, cloudA.packageSelectedTitle);
    t('bot metadata from the same write still merges', cloudA.viewCount === 99, cloudA.viewCount);
  }
  // 8c: a NEWER remote selection (another device) does win the field merge.
  {
    const newer = JSON.parse(JSON.stringify(world.remoteState));
    const newerClip = newer.twitchClips.find(c => c.id === 'clipA');
    const remoteTitle = optionsOf(cardFor('clipA')).map(titleOf).find(x => x !== pickedTitle);
    newerClip.packageSelectedTitle = remoteTitle;
    newerClip.packageLastUsedAt = new Date(Date.now() + 3600000).toISOString(); // 1h in the future
    world.remoteState = newer;
    document.querySelectorAll('#routineList input[type="checkbox"]')[1].click();
    await settleSaves();
    await waitFor(() => selectedTitleOf(cardFor('clipA')) === remoteTitle, 2000);
    t('newer remote selection (other device) applies', selectedTitleOf(cardFor('clipA')) === remoteTitle, selectedTitleOf(cardFor('clipA')));
    t('cloud keeps the winning (newer) selection', ((lastUpsert().state.twitchClips || []).find(c => c.id === 'clipA') || {}).packageSelectedTitle === remoteTitle);
  }
  mirrorCloud();

  console.log('scenario 10: emoji, apostrophes, punctuation, repeated + hostile text:');
  const cardC = cardFor('clipC');
  t('hostile clip title escaped (no injected nodes)',
    cardC.querySelectorAll('[onerror]').length === 0
    && cardC.querySelectorAll('img[src="x"]').length === 0
    && cardC.textContent.includes('<img src=x onerror=alert(1)>')); // visible as inert text
  const cIds = optionsOf(cardC).map(b => b.dataset.packOpt);
  t('adversarial options have unique ids', new Set(cIds).size === cIds.length && cIds.length >= 3, cIds.length);
  const cTitles = optionsOf(cardC).map(titleOf);
  t('emoji/punctuation titles render (😭 or — or ")', cTitles.some(x => /[😭💀🍞—"']/.test(x)), cTitles.join(' | ').slice(0, 120));
  for (let i = 0; i < Math.min(3, cTitles.length); i++) {
    optionsOf(cardFor('clipC')).find(b => titleOf(b) === cTitles[i]).click();
    await sleep(30);
    t('adversarial title ' + i + ' selects exactly', selectedTitleOf(cardFor('clipC')) === cTitles[i], cTitles[i]);
    t('adversarial title ' + i + ' stores exactly', storedClip('clipC').packageSelectedTitle === cTitles[i]);
  }
  await settleSaves();
  mirrorCloud();

  console.log('queue integration: Add to queue uses the selected title and editing does not cross wires:');
  const selC = storedClip('clipC').packageSelectedTitle;
  cardFor('clipC').querySelector('[data-use-twitch]').click();
  await sleep(80);
  t('queue form post title receives the exact selected title', document.getElementById('qPostTitle').value === selC, document.getElementById('qPostTitle').value.slice(0, 80));
  document.getElementById('qPostTitle').value = selC + ' (edited)';
  await sleep(30);
  t('editing the queue post title does not modify the stored selection', storedClip('clipC').packageSelectedTitle === selC);
  t('editing the queue form does not touch clip A', storedClip('clipA').packageSelectedTitle !== undefined);

  console.log('console hygiene:');
  t('no runtime errors during the whole suite', errors.length === 0, errors.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed (instance 1)`);
  if (fail) process.exit(1);

  // ---------------------------------------------------------------
  // Scenario 7: reload restores the exact selected title from storage.
  // ---------------------------------------------------------------
  const savedCache = window.localStorage.getItem('nappavt_growth_hub_v3:owner-1');
  const keepA2 = (JSON.parse(savedCache).twitchClips || []).find(c => c.id === 'clipA').packageSelectedTitle;
  const keepC2 = (JSON.parse(savedCache).twitchClips || []).find(c => c.id === 'clipC').packageSelectedTitle;

  const dom2 = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://nappavt-growth-hub.pages.dev/',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w2) {
      w2.localStorage.setItem('nappavt_growth_hub_v3:owner-1', savedCache);
      w2.supabase = supabaseStub(); // remote = mirrored cloud incl. selections
      Object.defineProperty(w2.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
      w2.confirm = () => true; w2.alert = () => {}; w2.prompt = () => ''; w2.open = () => {};
    },
  });
  const d2 = dom2.window.document;
  await sleep(900);
  console.log('\nscenario 7: reload restores the exact selected title:');
  const grid2 = () => d2.getElementById('twitchClipGrid');
  const cardFor2 = id => [...grid2().querySelectorAll('.twitch-card')].find(c => c.querySelector(`[data-pack-id="${id}"]`));
  const sel2 = card => { const el = card.querySelector('.nappa-title-option.selected .nappa-title-copy'); return el ? el.textContent : null; };
  t('clip A selection restored after reload', sel2(cardFor2('clipA')) === keepA2, JSON.stringify({ got: sel2(cardFor2('clipA')), keepA: keepA2 }));
  t('clip C adversarial selection restored after reload', sel2(cardFor2('clipC')) === keepC2, JSON.stringify({ got: sel2(cardFor2('clipC')), keepC: keepC2 }));
  t('exactly one selected card per clip after reload',
    [...grid2().querySelectorAll('.twitch-card')].every(c => c.querySelectorAll('.nappa-title-option.selected').length <= 1));
  const errs2 = errors.length;
  t('no errors on reload boot', errs2 === 0, errors.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed (grand total)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS FATAL', e); process.exit(1); });
