# Dashboard declutter — Overview & sidebar

Task: "get rid of all the clutter in the dashboard but keep the functionality."
Scope confirmed with the owner: the **Overview (home) page plus the main
sidebar navigation**. Nothing is deleted — panels and pages that left the top
surface stay reachable behind collapsed expanders / the More control.

## Overview page (content-first)

The page now leads with content instead of stats, plan and telemetry:

- **Glance strip** (`#overviewSnapshot`) — unchanged quick look at live state.
- **Upcoming posts** (`#dashUpcomingList`) — next scheduled queue entries
  (shares the queue page's sort), with platform chips and tracked social views.
  "Open queue" button jumps straight to the queue.
- **Recent performance** (`#dashRecentList`) — most recently posted clips with
  tracked social views; "Open performance" jumps to the performance page.
- **Collapsed expanders at the bottom** (nothing removed, only tucked away):
  - *Plan, routine & quick actions* (`#dashPlanFold`) — quick-add buttons
    (+ Queue post / + Prep clip / Check stats / Log stream), this-week focus +
    thing-I'm-testing fields, `#nextActions`, and the pre-stream checklist
    (`#routineList` + Reset).
  - *Momentum & activity* (`#dashMomentumFold`) — 30-day progress bar/%, the six
    stream/clip metric tiles, and the published-by-format chart.
  - *Integration health* (`#dashHealthFold`) — bot/Twitch/social connection
    status (`#integrationHealth` + last-sync chip).

All element IDs used by the existing JS are preserved in the new layout
(verified by an id-audit + jsdom smoke suite), so `renderDashboard`,
`renderNext`, `renderRoutine`, `renderIntegrationHealth`, data-field bindings
and the reset listener keep working unchanged. New overview rows are generated
by `renderDashUpcoming()` / `renderDashRecent()` (called at the end of
`renderDashboard`).

## Sidebar navigation (7 visible + More)

- **Visible pages:** Overview, Twitch clips, Publishing queue, Performance,
  Streams, Analytics, Settings — regrouped into Workspace / Content /
  Streaming / Analyze / System.
- **"More…" expander** (desktop, ≥901 px) — reveals a second nav group with
  Clip manager, Stream library, Advisor feedback and Ideas & notes. The four
  buttons are not duplicated; they physically move from a hidden canonical
  shelf (`#hiddenPagesShelf`) into `#moreItemsGroup` when opened.
- **Mobile** keeps the existing bottom-sheet "More": its primary-page set now
  matches the new 7 visible pages (shared `SIDEBAR_PRIMARY_PAGES` constant),
  and it discovers the four secondary pages via the shelf.
- **Role logic preserved:** `applyWorkspaceRoleUI()` still drives every nav
  button's visibility by role (owner vs Advisor). Advisors get the More
  expander too, containing only their allowed secondary pages
  (Stream library, Advisor feedback). Owners see all four.
- **Reachability:** `showPage()` auto-expands the More group when a secondary
  page is opened from anywhere (Ctrl-K palette, glance chips, quick actions),
  so the active item is always visible. Nothing was deleted: all 11 page
  sections remain in the document.

## Verification

- `.test/clutter-smoke.test.js` — new jsdom suite (owner + advisor + empty
  workspace boots) asserting structure, role visibility, fold behavior, More
  expander open/close/navigate, and no uncaught errors. Picked up by
  `npm --prefix .test test`.
- Full battery green: inline JS syntax, `npm --prefix .test test`
  (10 suites), Python reference tests (39), social-link node suite (72),
  `git diff --check`.
