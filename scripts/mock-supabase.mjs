// Dev-only: a tiny stand-in for the Supabase REST API, serving a realistic
// Growth Hub dataset on 127.0.0.1 so the migration scripts can be rehearsed
// end-to-end without touching the real project:
//
//   node scripts/mock-supabase.mjs &          # serves on :59876
//   SUPABASE_URL=http://127.0.0.1:59876 SUPABASE_SERVICE_ROLE_KEY=rehearsal \
//     node scripts/export-supabase.mjs
//
// The dataset models: one owner + one advisor, a dashboard_state blob with
// realistic queue/streams/analytics fields, invites/members/notes rows and
// two fake legacy clips in the "clips" bucket.

import { createServer } from 'node:http';

const OWNER = '11111111-2222-4333-8444-555555555555';
const ADVISOR = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const state = {
  fields: { weekFocus: 'RE2 marathon clips', videoCleanupDays: '7' },
  routine: { 1: true, 3: true },
  queue: [
    { id: 42, date: '2026-09-06', time: '18:00', platforms: ['YouTube Shorts'], title: 'RE2 jumpscare reel', status: 'Posted', storageProvider: 'google_drive', driveFileId: 'DRV_FAKE_1', videoPath: '', videoName: 're2.mp4', videoSize: 12582912, postedAt: '2026-09-06T19:00:00Z', socialAnalytics: { youtube: { views: 4132, likes: 210 } } },
    { id: 43, date: '2026-09-04', time: '18:00', platforms: ['TikTok'], title: 'OLD legacy clip', status: 'Planned', videoPath: `${OWNER}/1722500000_abc_old.mp4`, videoName: 'old.mp4', videoSize: 52428800, videoType: 'video/mp4', source: 'Upload', createdAt: '2026-09-04T09:00:00Z' },
  ],
  clips: [], streams: [
    { id: 's1', date: '2026-09-05', title: 'RE2 first playthrough part 4', game: 'Resident Evil 2', peakViewers: 76, avgViewers: 51, newFollowers: 12, durationMin: 223 },
  ],
  twitchClips: [{ id: 'tc-1', title: 'LEON NOOO', url: 'https://clips.twitch.tv/fake', createdAt: '2026-09-05T22:10:00Z' }],
  twitchStatus: { connected: true, login: 'nappavt', lastSyncAt: '2026-09-06T20:00:00Z' },
  streamTrackingStatus: {}, streamAudienceHistory: {}, liveStreamSession: null, streamLastReport: null,
  twitchHistoryStatus: {}, twitchHistoryImportRequested: false,
  socialConnections: { youtube: { connected: true, channelTitle: 'NappaVT' } },
  socialVideos: { youtube: [], tiktok: [], instagram: [] },
  socialSyncStatus: { lastSyncAt: '2026-09-06T20:00:00Z' }, socialRefreshRequested: false,
  theme: 'dark',
};

const clips = [
  { key: `${OWNER}/1722500000_abc_old.mp4`, size: 2048, mimetype: 'video/mp4', bytes: Buffer.alloc(2048, 7) },
  { key: `${OWNER}/1722600000_def_second.mp4`, size: 1024, mimetype: 'video/mp4', bytes: Buffer.alloc(1024, 11) },
];

const tableRows = {
  dashboard_state: [
    { user_id: OWNER, state, updated_at: '2026-09-06T20:04:11.123456+00:00' },
  ],
  growth_hub_invites: [
    { token: 'abc123def456abc123def456abc123def456abc123def456aaaa', owner_user_id: OWNER, email_hint: 'advisor@example.com', expires_at: '2026-09-18T10:00:00+00:00', claimed_by_user_id: ADVISOR, claimed_at: '2026-09-07T10:05:00+00:00', created_at: '2026-09-07T10:00:00+00:00' },
  ],
  growth_hub_members: [
    { owner_user_id: OWNER, user_id: ADVISOR, email: 'advisor@example.com', role: 'advisor', created_at: '2026-09-07T10:05:00+00:00' },
  ],
  growth_hub_advisor_notes: [
    { id: 'note-0001-0000-4000-8000-000000000001', owner_user_id: OWNER, author_user_id: ADVISOR, author_email: 'advisor@example.com', target_type: 'stream', target_ref: 'RE2 marathon', body: 'Peak chat energy around 21:40 — clip that segment.', created_at: '2026-09-07T11:00:00+00:00', resolved_at: null },
  ],
};

const authUsers = [
  { id: OWNER, email: 'owner@example.com', created_at: '2026-08-01T08:00:00Z' },
  { id: ADVISOR, email: 'advisor@example.com', created_at: '2026-09-07T10:05:00Z' },
];

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, obj, headers = {}) => {
    const body = obj === undefined ? '' : JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', ...headers });
    res.end(body);
  };
  if (!req.headers.apikey || !req.headers.authorization) return send(401, { message: 'missing key (mock)' });

  const mRest = /^\/rest\/v1\/([a-z_]+)/.exec(u.pathname);
  if (mRest && tableRows[mRest[1]]) return send(200, tableRows[mRest[1]]);
  if (u.pathname === '/auth/v1/admin/users') return send(200, { users: authUsers });
  if (u.pathname === '/storage/v1/object/list/clips' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    return req.on('end', () => {
      const { prefix = '' } = JSON.parse(body || '{}');
      if (!prefix) {
        // root level: one folder per owner
        return send(200, [{ id: null, name: OWNER, updated_at: '2026-08-01T00:00:00Z' }]);
      }
      const items = clips
        .filter(c => c.key.startsWith(prefix + '/'))
        .map(c => ({ id: c.key, name: c.key.slice(prefix.length + 1), updated_at: '2026-08-05T00:00:00Z', metadata: { size: c.size, mimetype: c.mimetype } }));
      return send(200, items);
    });
  }
  const mObj = /^\/storage\/v1\/object\/clips\/(.+)$/.exec(u.pathname);
  if (mObj) {
    const key = decodeURIComponent(mObj[1]);
    const clip = clips.find(c => c.key === key);
    if (!clip) return send(404, { message: 'not found (mock)' });
    res.writeHead(200, { 'content-type': clip.mimetype, 'content-length': clip.size });
    return res.end(clip.bytes);
  }
  return send(404, { message: 'mock: unknown route ' + u.pathname });
});

const port = Number(process.env.MOCK_PORT || 59876);
server.listen(port, '127.0.0.1', () => console.log(`mock supabase on http://127.0.0.1:${port}`));
