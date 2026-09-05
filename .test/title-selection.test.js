// Regression coverage for the generated-title lifecycle. This deliberately
// evaluates the shipped Nappa Pack functions rather than a duplicate model.
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('index.html', 'utf8');
const main = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])[0];
const start = main.indexOf('const NAPPA_STOP_WORDS');
const end = main.indexOf('function renderQueue');
if (start < 0 || end < start) throw new Error('Nappa Pack source bounds not found');
const source = main.slice(start, end);

let pass = 0;
const t = (name, condition, extra) => {
  if (!condition) throw new Error(`${name}${extra === undefined ? '' : `: ${extra}`}`);
  pass++;
};

function makeHarness() {
  const dom = new JSDOM('<div id="twitchStatusCopy"></div><div id="twitchConnectNote"></div><div id="twitchClipGrid"></div>', {
    url: 'https://nappavt-growth-hub.pages.dev/',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const copied = [];
  let promptValue = null;
  const state = {
    twitchStatus: { connected: true, login: 'NappaVT', rangeDays: 30 },
    twitchClips: [{
      id: 'clip-special-1',
      title: 'I said “NO, NO!” and that is somehow my problem 😭',
      gameName: 'Resident Evil 2',
      vodTitle: 'The housewife has entered the crime scene',
      createdAt: '2026-09-05T10:00:00.000Z',
      duration: 23.4,
      viewCount: 321,
      url: 'https://clips.twitch.tv/example',
      thumbnailUrl: '',
      packageUserContext: 'I doubted the teammate and they immediately clutched it.',
    }],
    queue: [], streams: [],
  };
  const context = {
    console, Date, Math, JSON, Promise, Number, String, Set, Map, Intl,
    setTimeout, clearTimeout, URL, CSS: window.CSS || { escape: value => String(value) },
    window,
    document: window.document,
    navigator: { clipboard: { writeText: async value => copied.push(value) } },
    state,
    selectedTwitchClipId: '',
    writeLocalState: () => {},
    scheduleCloudSave: () => {},
    persistClipPackagePrefs: () => {},
    showPage: () => {},
    clearUploadStatus: () => {},
    resetLocalFileUploadUI: () => {},
    updateImportedClipBox: () => {},
    alert: () => {},
    prompt: () => promptValue,
    APP_TIME_ZONE: 'Europe/Amsterdam',
    formatTwitchDate: value => new Date(value).toISOString(),
    esc: value => String(value ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])),
    num: value => Number.isFinite(Number(value)) ? Number(value) : 0,
    fmt: value => Math.round(Number(value) || 0).toLocaleString(),
    metricAvailable: value => value !== undefined && value !== null && value !== '' && !(typeof value === 'number' && Number.isNaN(value)),
    metricNumber: (value, formatter = value => context.num(value).toFixed(0)) => context.metricAvailable(value) ? formatter(value) : 'Unavailable',
    metricCount: (value, prefix = '') => context.metricAvailable(value) ? prefix + context.fmt(value) : 'Unavailable',
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, window, state, copied, setPrompt(value) { promptValue = value; } };
}

function getPack(h) {
  return vm.runInContext('buildNappaPackage(state.twitchClips[0])', h.context);
}
function render(h) {
  vm.runInContext('renderTwitchClips()', h.context);
  return [...h.window.document.querySelectorAll('[data-pack-select-id]')];
}

(async () => {
  const h = makeHarness();
  const initial = getPack(h);
  t('generated options exist', initial.options.length >= 4);
  t('every generated option has a stable unique complete-title ID',
    initial.options.every(o => /^nappa-title-/.test(o.id) && o.kind === 'complete' && o.isPrefix === false) &&
    new Set(initial.options.map(o => o.id)).size === initial.options.length);
  t('prefix collection is separate and empty', Array.isArray(initial.prefixes) && initial.prefixes.length === 0);

  // 1 + 2. Every title can be selected through the actual rendered button;
  // dispatching on the button is equivalent to clicking either its text or
  // its background because the whole title card is one button target.
  let buttons = render(h);
  for (const button of buttons) {
    button.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    const selected = h.state.twitchClips[0];
    t(`selects exact option ${button.dataset.packSelectId}`,
      selected.packageSelectedTitleId === button.dataset.packSelectId &&
      selected.packageSelectedTitle === button.querySelector('.nappa-title-copy').textContent);
  }
  t('one and only one card is visibly selected after repeated clicks',
    h.window.document.querySelectorAll('.nappa-title-option.selected').length === 1);

  // 3. Copying uses the selected stable ID, not an array index or prefix.
  buttons = render(h);
  const selectedButton = buttons.at(-1);
  selectedButton.click();
  const expectedTitle = selectedButton.querySelector('.nappa-title-copy').textContent;
  await vm.runInContext(`copyNappaField('clip-special-1','title',null)`, h.context);
  t('copy uses the exact selected complete title', h.copied.at(-1) === expectedTitle, h.copied.at(-1));

  // 4 + 5. Filtering and sorting are view operations: they can hide or
  // reorder the selected card without changing its stable identity.
  const selectedBeforeViewChange = h.state.twitchClips[0].packageSelectedTitleId;
  const currentOptions = getPack(h).options;
  const selectedOption = currentOptions.find(option => option.id === selectedBeforeViewChange);
  const alternateAngle = currentOptions.find(option => option.angle !== selectedOption.angle)?.angle;
  if (alternateAngle) {
    const filter = h.window.document.querySelector('[data-pack-filter]');
    filter.value = alternateAngle;
    filter.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    t('filtering keeps the exact selected title in state', h.state.twitchClips[0].packageSelectedTitleId === selectedBeforeViewChange);
    t('hidden selected title is explicitly reported instead of silently replaced', Boolean(h.window.document.querySelector('.nappa-title-filter-note')));
    filter.value = 'all';
    filter.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  }
  const sort = h.window.document.querySelector('[data-pack-sort]');
  sort.value = 'az';
  sort.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  t('sorting keeps the exact selected title in state', h.state.twitchClips[0].packageSelectedTitleId === selectedBeforeViewChange);
  sort.value = 'recommended';
  sort.dispatchEvent(new h.window.Event('change', { bubbles: true }));

  // 6. Editing one title leaves all other generated options unchanged.
  const beforeIds = getPack(h).options.map(o => o.id);
  const beforeOtherTitles = getPack(h).options.filter(o => o.id !== selectedButton.dataset.packSelectId).map(o => o.title);
  h.setPrompt('Edited “NO, NO!” title 😭');
  vm.runInContext(`editNappaTitle('clip-special-1',${JSON.stringify(selectedButton.dataset.packSelectId)})`, h.context);
  const edited = getPack(h);
  t('edited title remains selected by stable ID', edited.selectedTitleId === selectedButton.dataset.packSelectId && edited.selectedTitle === 'Edited “NO, NO!” title 😭');
  t('editing does not change neighbouring titles or IDs',
    edited.options.map(o => o.id).join('|') === beforeIds.join('|') &&
    edited.options.filter(o => o.id !== selectedButton.dataset.packSelectId).map(o => o.title).join('|') === beforeOtherTitles.join('|'));

  // 5. Regeneration keeps the selected complete title when it is still in
  // the regenerated set; it never falls back to a prefix/index.
  vm.runInContext("changeNappaPackage('clip-special-1','new')", h.context);
  const regenerated = getPack(h);
  t('regeneration preserves selection by stable ID', regenerated.selectedTitleId === selectedButton.dataset.packSelectId && regenerated.hasSelection);

  // 6. Sorting/rotation does not change the selected title.
  const beforeSortId = regenerated.selectedTitleId;
  vm.runInContext("changeNappaPackage('clip-special-1','short')", h.context);
  t('mode rotation preserves selected ID', getPack(h).selectedTitleId === beforeSortId);

  // 7. Reload simulation: only persisted fields are used to restore state.
  const persisted = JSON.parse(JSON.stringify(h.state.twitchClips[0]));
  h.state.twitchClips[0] = persisted;
  t('reload restores exact selected title', getPack(h).selectedTitleId === beforeSortId && getPack(h).selectedTitle === persisted.packageSelectedTitle);

  // 8. The real Twitch merge keeps a newer local title selection when remote
  // bot metadata arrives without, or with stale, package fields.
  const mergeStart = main.indexOf('const NAPPA_PACKAGE_FIELDS');
  const mergeEnd = main.indexOf('function mergeBotStreamFields');
  const mergeContext = { console, JSON, Date, Map, Set, Number, String, cloneJson: value => JSON.parse(JSON.stringify(value)) };
  vm.createContext(mergeContext);
  vm.runInContext(main.slice(mergeStart, mergeEnd), mergeContext);
  const merged = vm.runInContext(`mergeTwitchClipRecord(
    ${JSON.stringify(persisted)},
    ${JSON.stringify({ id: persisted.id, title: 'new bot metadata', packageSelectedTitle: 'STALE PREFIX', packageSelectedTitleId: 'stale', packageLastUsedAt: '2020-01-01T00:00:00Z' })}
  )`, mergeContext);
  t('stale Supabase/bot sync cannot overwrite newer local selection',
    merged.packageSelectedTitle === persisted.packageSelectedTitle && merged.packageSelectedTitleId === persisted.packageSelectedTitleId);

  // 9. Rapid selection ends on the last exact option, regardless of render
  // cycles between each click.
  buttons = render(h);
  for (const button of buttons) button.click();
  const lastId = buttons.at(-1).dataset.packSelectId;
  t('rapid sequential selection ends on the last title', h.state.twitchClips[0].packageSelectedTitleId === lastId);

  // 10. Emoji, punctuation, apostrophes and repeated text remain in the
  // displayed/copyable title while identity stays ID-based.
  const special = getPack(h).options.find(o => /NO, NO|😭|'/i.test(o.title));
  t('special-character title is preserved as a complete title', !!special && special.title.length > 0);
  if (special) {
    vm.runInContext(`selectNappaTitle('clip-special-1',${JSON.stringify(special.id)})`, h.context);
    await vm.runInContext(`copyNappaField('clip-special-1','title',null)`, h.context);
    t('special-character title copies exactly', h.copied.at(-1) === special.title, `${h.copied.at(-1)} !== ${special.title}`);
  }

  console.log(`${pass} title-selection regression assertions passed`);
})().catch(error => { console.error(error.stack || error); process.exit(1); });
