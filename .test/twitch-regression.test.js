// Focused regressions for the Twitch/EventSub and historical reporting UI.
// These tests evaluate the shipped functions, not a duplicate implementation.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('index.html', 'utf8');
const main = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1])[0];

function elementMarkup(ids) {
  return ids.map(id => id === 'openLatestStreamReport'
    ? `<button id="${id}"></button>`
    : `<div id="${id}"></div>`).join('');
}

function makeContext() {
  const ids = [
    'streamLiveBadge', 'streamTrackingCopy', 'liveStreamDetails',
    'latestStreamSummary', 'openLatestStreamReport', 'streamAvgTrend',
    'streamRetentionTrend', 'bestStreamCategory', 'bestStreamCategoryCopy',
    'bestStreamHour', 'bestStreamHourCopy', 'knownCommunityCount',
    'streamLibraryCards', 'twitchHistoryStatus', 'integrationHealth',
    'healthLastSync',
  ];
  const dom = new JSDOM(elementMarkup(ids), {
    url: 'https://nappavt-growth-hub.pages.dev/',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const context = {
    console, Date, Math, JSON, Promise, Number, String, Set, Map, Intl,
    window, document: window.document, APP_TIME_ZONE: 'Europe/Amsterdam',
    currentUser: { id: 'owner' }, sb: {}, workspaceOwnerId: 'owner',
    cloudLoadFallback: false, lastRemoteUpdatedAt: '2026-09-05T10:00:00Z',
    state: {
      liveStreamSession: null, streamTrackingStatus: {}, streams: [],
      streamAudienceHistory: {}, queue: [], twitchHistoryStatus: {},
      twitchStatus: { connected: false }, socialConnections: {}, socialSyncStatus: {},
    },
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char])),
    num: value => Number.isFinite(Number(value)) ? Number(value) : 0,
    fmt: value => Math.round(Number(value) || 0).toLocaleString(),
    sum: (rows, selector) => rows.reduce((total, row) => total + (Number(selector(row)) || 0), 0),
    chart: () => {}, save: () => {}, confirm: () => true,
    youtubeConnectionState: value => value && value.connected ? 'connected' : 'not',
    formatTwitchDate: value => new Date(value).toISOString(),
  };
  vm.createContext(context);
  const streamStart = main.indexOf('function streamDateLabel');
  const streamEnd = main.indexOf('function openStreamReport');
  assert.ok(streamStart >= 0 && streamEnd > streamStart, 'stream source bounds found');
  vm.runInContext(main.slice(streamStart, streamEnd), context);
  const healthStart = main.indexOf('function integrationHealthItem');
  const healthEnd = main.indexOf('function socialPlatformRecord');
  assert.ok(healthStart >= 0 && healthEnd > healthStart, 'health source bounds found');
  vm.runInContext(main.slice(healthStart, healthEnd), context);
  return { context, window };
}

test('live detection and EventSub states stay truthful', () => {
  const h = makeContext();
  h.context.state.liveStreamSession = {
    title: 'NappaVT live', game: 'Resident Evil 2', startedAt: '2026-09-05T10:00:00Z',
    currentViewers: 120, peakViewers: 180,
    activeChatters: { one: true, two: true }, messageCount: 42, follows: 3,
    samples: [{ viewers: 100 }, { viewers: 140 }],
  };
  h.context.state.streamTrackingStatus = { active: true, eventsubConnected: true };
  vm.runInContext('renderStreams()', h.context);
  assert.equal(h.window.document.querySelector('#streamLiveBadge').textContent, 'LIVE');
  assert.match(h.window.document.querySelector('#streamTrackingCopy').textContent, /EventSub connected/);
  assert.match(h.window.document.querySelector('#liveStreamDetails').textContent, /120\.0/);
  assert.match(h.window.document.querySelector('#liveStreamDetails').textContent, /Unavailable/);

  h.context.state.streamTrackingStatus = { active: true, eventsubConnected: false, missingScopes: ['chat:read'] };
  vm.runInContext('renderStreams()', h.context);
  assert.match(h.window.document.querySelector('#streamTrackingCopy').textContent, /re-authori[sz]ation|unlock full/i);

  h.context.state.liveStreamSession = null;
  h.context.state.streamTrackingStatus = { eventsubConnected: true };
  vm.runInContext('renderStreams()', h.context);
  assert.equal(h.window.document.querySelector('#streamLiveBadge').textContent, 'Offline');
  assert.match(h.window.document.querySelector('#liveStreamDetails').textContent, /offline/i);
});

test('historical Twitch rows do not fabricate unavailable analytics', () => {
  const h = makeContext();
  h.context.state.streams = [{
    id: 'historical-1', historicalImport: true, title: 'Old VOD', game: 'Resident Evil 2',
    date: '2025-01-01', vodViews: 321, clips: null, clipViews: undefined,
  }];
  vm.runInContext('renderStreamLibrary()', h.context);
  const text = h.window.document.querySelector('#streamLibraryCards').textContent;
  assert.match(text, /321/);
  assert.match(text, /Unavailable/);
  assert.match(text, /Historical VOD/);
});

test('integration health distinguishes verified Twitch and worker status', () => {
  const h = makeContext();
  h.context.state.twitchStatus = { connected: true, login: 'NappaVT', lastSyncAt: '2026-09-05T10:00:00Z' };
  h.context.state.socialSyncStatus = { lastSyncAt: '2026-09-05T10:01:00Z' };
  vm.runInContext('renderIntegrationHealth()', h.context);
  const text = h.window.document.querySelector('#integrationHealth').textContent;
  assert.match(text, /Nappa Bot \/ Craftnode/);
  assert.match(text, /Twitch/);
  assert.match(text, /Connected/);
  assert.match(h.window.document.querySelector('#healthLastSync').textContent, /Last verified/);
});
