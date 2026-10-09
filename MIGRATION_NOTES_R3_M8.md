# Round 3 · Milestone 8 — Frontend structure and quality

Frontend-only milestone. **No backend code, schema or env changes** (the backend zip is
re-issued unchanged apart from this file). No deploy steps.

Cumulative on top of M1–M6. M7 (verification/hardening) has **not** been done yet;
M8 was run first at your request.

## IMPORTANT: two things you should know first

1. **Regression from M6, fixed.** M6 made the shared `Btn` default to `type="button"`. Six forms
   relied on the old implicit submit, so their main button did **nothing when clicked** (only
   pressing Enter in a text field worked): audit-log *Filter*, warehouse *Register*, *Change
   Password*, *Edit Profile → Save*, transport-provider *Save/Register*, lab *Save/Register*.
   All six now use `type="submit"`. Tests now cover it, including a source-scan test that fails if
   any `<form>` lacks a `type="submit"` control.
2. **A plain `vite build` is misleading.** Since M6, a production build *without* `VITE_API_URL`
   tree-shakes the whole app away (the config-error guard becomes a compile-time constant) and
   emits a ~143 kB stub. The real M6 bundle was **573 kB (146 kB gzip)** with the chunk-size warning.
   Always build with the variable set: `VITE_API_URL=https://api.example.com npx vite build`.

## 1. Big files split (no behaviour change intended)

| File | Before | After |
|---|---|---|
| AdminDashboard.jsx | 1325 | 331 |
| WarehousePage.jsx | 1174 | 211 |
| WarehouseOperatorDashboard.jsx | 897 | 300 |
| SellerDashboard.jsx | 732 | 183 |
| AccountPage.jsx | 660 | 118 |

Modals, panels and tabs now live in `components/{admin,warehouse,warehouse-operator,seller,account}/`
(54 new component files). Tab bodies became components that receive the state they use as props.
`ProtectedRoute` moved out of `App.jsx` to `components/ProtectedRoute.jsx` so it can be tested.

How it was done: moved mechanically by script (declarations were cut and pasted, not rewritten),
then checked with ESLint (`no-undef` catches any missing reference), the build, the existing tests
and a new smoke test that mounts each split page and clicks through every tab.
Small safe edits made along the way: removed unused imports/variables (lint is now warning-free),
and made the admin revenue cards null-safe (`orderSummary?.completed?.…`).

Not split (not asked, or still reasonable size): `BuyerDashboard` (362), `ServicePages` (348),
`TransportProviderDashboard` (426), `TestingAgencyDashboard` (363), `lib/api.js` (1069).

## 2. Tests: 16 → 56 (12 files)

New: login (validation, success → role portal, failure), `ProtectedRoute` (all role rules, no
redirect while the session loads), buyer **Accept counter / Decline / Withdraw** (confirm dialogs,
API calls, error display, button visibility by status), **transport quote** accept/decline/failure/
booked state, public **tracking page** (loading, sparse data, not-booked, error), **admin audit
log** (rows, empty, error, filter), form submit buttons, `Tabs` keyboard behaviour, `Modal`
focus handling, and the five split-page smoke tests.
Helper: `src/test/stubApi.js` stubs every `api*` function so a page can mount without a backend.
New dev dependency: `@testing-library/user-event`.

## 3. Accessibility pass

- **Form labels:** 109 labels are now associated with their controls (`htmlFor` + generated `id`);
  9 group headings that were `<label>`s are now `<div>`s.
- **Clickable divs/spans (≈45):** now keyboard-operable via `lib/a11y.js` `clickable()`
  (role=button, Tab focus, Enter/Space). Admin sidebar items, product thumbnails are real `<button>`s.
- **Tabs:** `role=tablist/tab`, `aria-selected`, roving tabindex, ←/→/Home/End. The warehouse
  `TabBar` duplicate now reuses it.
- **Modals:** focus moves in on open, Tab is trapped inside, Escape closes, focus returns to the
  opener, `aria-labelledby` points at the title.
- **Visible focus ring** everywhere (`:focus-visible` in `index.html`; many inputs set `outline:none`
  inline) and `prefers-reduced-motion` respected.
- **Contrast:** `T.muted` darkened (#6B7280 → #5B6472) and new text-only tokens `goldText`,
  `warnText`, `cyanText`, `tealText` used where those accents were text on light backgrounds.
  Decorative uses and text on dark backgrounds (navbar, footer, hero, admin sidebar) are unchanged.
- `LoadingState` is `role=status`, `ErrorState` is `role=alert`.
- **ESLint now enforces** `jsx-a11y` (alt-text, label association, click/keyboard, aria-role, anchor).

## 4. Responsive + states

- Fixed-column layouts (filter grid, 4-col listing grid, seller messages split, product detail
  split) and the admin sidebar now collapse at narrow widths; 7 admin tables scroll horizontally.
- Ad-hoc "Loading…" text in ~13 places replaced by the shared `LoadingState`.

## 5. Code splitting

Every route except Home is lazy-loaded; auth modals are lazy too.

| | M6 | M8 |
|---|---|---|
| Entry chunk | 573 kB (146 gz) | 231 kB (72 gz) |
| Chunk-size warning | yes | no |
| Largest page chunk | — | AdminDashboard 87 kB (21 gz) |

## Verification (what was actually run)

- Backend: `npx jest` **380 passed (34 suites)**, `npx nest build` OK. (Unchanged code.)
- Frontend: `npm test` **56 passed**, `npm run lint` **0 errors, 0 warnings**,
  `VITE_API_URL=… npx vite build` OK.

## NOT verified — please check

- **Nothing was looked at in a real browser.** Responsive layout, focus ring, modal focus trap and
  tab keyboard behaviour were tested only in jsdom. Please click through each portal on a phone-width
  window and with the keyboard, and ideally try a screen reader once.
- The page split is checked by lint, build and smoke tests, which prove pages mount and tabs render;
  they do **not** exercise every button inside every extracted tab. Do a quick manual pass over
  Admin (all 8 sections), Seller (6 tabs), Warehouse (4 tabs) and the operator dashboard.
- Generated label ids are static strings; if two copies of the same form were ever on screen at
  once their ids would clash (I found none).
- Contrast: only the theme tokens were audited. Hard-coded hex colours (e.g. `#0891B2`, `#B7A05A`
  inline) were not.
- Not done: `role=tabpanel`/`aria-controls` wiring, a skip-to-content link, screen-reader labels
  for icon-only emoji buttons beyond what lint flags, and per-route page titles.
- Sandbox only: the backend integration tests and Docker (M7) remain unrun here.

## Suggested next step

M7 (real-Postgres integration tests, migrations baseline, Docker, strict TypeScript, CI) —
say "go".
