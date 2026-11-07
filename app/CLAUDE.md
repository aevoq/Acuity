# Offline navigation for blind and low vision travellers (hackathon app)

A **webpage** (no native mobile app): walking and bus navigation that keeps
working with no signal. Demoed in Chrome on a laptop with a simulated walk; it
also runs in a phone's browser with real GPS. The full PRD is the team's Claude
doc "PRD: Offline-first navigation for blind and low vision travellers".

## Principles (when a feature conflicts with one, the principle wins)

1. **Never say "safe to cross".** Report what is detected ("the signal looks green"), with confidence. The person decides.
2. **Abstain rather than invent.** Every spoken fact comes from the area pack or a sensor, never a model's imagination. Poor GPS or missing data → say so.
3. **Offline is the default, online is a bonus.** Every P0 feature works with "Wi-Fi off". Online features go through `src/net/online.ts` and say when they are unavailable.
4. **The person stays in control.** Nothing irreversible without confirmation (no auto-calls, no auto-SMS).
5. **Alongside the cane and dog, not instead.** Prompts are short; audio never masks traffic.
6. **Screen-reader native.** Keyboard reachable, 48 px targets, every spoken prompt also goes to the live region. Never speak over a screen reader.
7. **Personal by profile.** Route type, speech rate, verbosity, sounds come from the profile (toolkit).
8. **Privacy.** Location stays in the browser. Camera frames leave only on a button press, online.

## Team rules

- **Only edit files in your own folders.** Ask before touching someone else's.
- **Never change `src/contracts.ts` without telling the other two.** Adding an optional field is usually fine; renaming/removing is not.
- Explain the approach before writing code. Readable and explicit over clever.
- One branch per person; merge to `main` at checkpoints.

| Area | Folders |
|---|---|
| Foundation, map, offline/online wiring, UI | `src/contracts.ts`, `src/app` (incl. `src/app/ui`), `src/net`, `src/pack`, `src/geo`, `src/mapview`, `src/position`, `scripts/pack`, `scripts/fonts`, `public/sw.js` |
| Navigation and simulated walk | `src/nav`, `src/sim`, `src/places` |
| Voice, agent, toolkit | `src/voice`, `src/agent`, `src/toolkit` |
| Camera and vision | `src/vision`, `skills/` |

## How it fits together

- **Area pack** (`public/packs/ucl-east.json`, ~5.7 MB): built once online by `npm run pack` (Overpass/OpenStreetMap, 2 km around Marshgate, UCL East). Walking graph (nodes, edges with length/name/roadClass/steps/lit/crossing), places, benches, bus stops. Committed, so the demo never needs venue Wi-Fi.
- **`loadPack()`** (`src/pack/pack.ts`) returns a `PackIndex`: `node`, `edge`, `edgesAt`, `otherEnd`, `edgeLine`, `nearestNode`, `placesNear`, `ageDays`. Use it instead of scanning arrays.
- **Geometry** (`src/geo/geo.ts`): `distance`, `bearing`, `turnAngle`, `clockPosition`, `destination`, `makeProjection`, `distanceToPolyline`, `pointAlong`.
- **Positions**: navigation only reads a `PositionSource` (contracts). `src/position/gps.ts` is real GPS; `src/sim` will be the simulated walk. Same interface.
- **Connectivity** (`src/net`): `connectivity.mode()` is `'offline'` when the browser is offline **or** the on-screen "Wi-Fi off (demo)" switch is on. `useNetworkMode()` for React. **All network calls go through `onlineFetch()`**, which refuses when offline, times out after 8 s, and returns `{ ok: false, reason }` instead of throwing.
- **Service worker** (`public/sw.js`): caches the page, built assets and the pack. Registered in production builds only, so test offline with `npm run build && npm run preview`. `npm run dev` on localhost also works with Wi-Fi off, since it needs no internet.
- **UI (the Claude Design redesign)**: a full-screen map with floating cards, one stage at a time: `explore` (You are here + 4 asks) → answer → `results` (numbered pins) → `place` (route summary, Start walking, Steps, route-type chips; for a bus stop: Next buses and Ride a bus) → `nav` (green next-instruction banner + walking card) → `arrived`; and `ride` (bus countdown). The right column has online/offline, zoom, re-centre, settings and SOS. The shell is `src/app/App.tsx`; the cards are in `src/app/ui/` (`Cards.tsx`, `Walk.tsx`, `Controls.tsx`, `Dialogs.tsx`, `model.ts`) with the design's values in `ui.css`. Keep to the design's colours, sizes and copy.
- **Map** (`src/mapview/MapCanvas.tsx`): a port of the design's renderer onto `PackIndex`. Camera `{x, y, mpp}` in metres (y south). Road casings by class, street labels, POI dots and crossings appear by zoom; the route has its walked part greyed. Numbered pins are real buttons. Keyboard: arrows pan, +/- zoom. Imperative handle: `flyTo`, `fitPoints`, `zoomBy`. Standard and High-contrast palettes.
- **Settings** (`src/app/settings.ts`, gear button): map style, text size (the design's `uiZoom`, applied with CSS `zoom` and `--ui-zoom`), speak prompts, speech rate, **I use a screen reader** (no speech; the live region carries everything), use real GPS. Saved in localStorage, guarded.
- **Fonts are bundled, so they work offline**: Atkinson Hyperlegible from `@fontsource`, and a 10 KB subset of Material Symbols Rounded in `src/assets/fonts/`. **Using a new icon?** Add its name to `ICONS` in `scripts/fonts/fetch-icons.mjs` and run it, or the icon shows as a word.
- **Accessibility rules the shell keeps**: focus moves to the new card's heading on every stage change; the live region re-announces repeated text; Help and Settings are native `<dialog>` with `showModal()`; route types are real radios; on narrow screens the cards stop above the right column, so SOS is never covered.
- **Router** (`src/nav/router.ts`, `costs.ts`): A* over the walking graph, a few ms per route. `router.route(from, to, profile, name)` returns a `Route` with waypoints and a one-sentence `tradeOff` against the shortest route. `router.walkingDistance(a, b)`. Profile costs are in `costs.ts` (PRD F3 values, all multipliers ≥ 1 so the A* heuristic stays valid). `crossingAt()` counts each real crossing once.
- **Instructions** (`src/nav/instructions.ts`): turns from bearing changes (only where 3+ ways meet, or a sharp bend), crossings with signals/tactile/kerb from OSM tags, benches on the rest-stops profile, start and arrival. Street and landmark names come from the pack only.
- **Guidance** (`src/nav/guidance.ts`): subscribes to a `PositionSource`, speaks each waypoint at its trigger radius, reassurance every N m (quiet when a waypoint is under 60 m away), off-route after 3 readings > 25 m, poor GPS when accuracy > 30 m. `nextStep()` and `lastPrompt()` back the F4 "what next" and "repeat" intents.
- **Simulated walk** (`src/sim/simWalk.ts`): a `PositionSource` walking the route at 1.4 m/s × speed with GPS jitter; demo hooks `setSidestep(m)` and `setAccuracy(m)` trigger the off-route and poor-GPS prompts.
- **Place search** (`src/places/search.ts`): `findPlaces(index, router, from, query)` matches name, brand or everyday kind words ("chemist", "loo", "coffee"), ranked by walking distance.
- **Speech for now** (`src/app/speakFallback.ts`): plain `speechSynthesis`. `src/voice` replaces it (same `SpeakRequest`).
- **Tool layer** (`src/places/tools.ts`, ADR-004): `createTools({ index, router })` → `nearest`, `aroundMe`, `leftRight`, `whereAmI`, `nearestBusStop`, each returning a `ToolResult` whose `say` is built from pack data. Clock positions when heading is known, compass words when not; a poor-GPS caveat when accuracy > 30 m. `TOOL_DECLARATIONS` is the same set as Gemini function declarations.
- **Running an intent** (`src/app/runIntent.ts`): one switch from `Intent` to tool. Buttons, the offline matcher and Gemini all go through it.
- **Offline matcher, placeholder** (`src/app/quickMatch.ts`): regex rules → `Intent`, so the Ask box works with Wi-Fi off. `src/agent`'s matcher replaces it.
- **Transit** (`src/transit`): the pack holds TfL bus stops (letter, "towards", lines) and every line's ordered stops both ways, plus a frequency **estimated** from live arrival gaps at build time (TfL's bus timetable endpoint is empty), flagged `frequencySource: 'estimated-from-arrivals'`. `busArrivals()` is live via `onlineFetch` to TfL (no key), else `frequencySentence()` says "usually every N to M minutes; not live". `createBusRide()` (F8) counts stops down from any `PositionSource`: click per stop passed, "your stop is next, ring the bell" one stop early, then "this is your stop".
- **Gemini** (`server/gemini.ts`, `api/gemini.ts`, `src/net/gemini.ts`): the key lives only in `app/.env` (`GEMINI_API_KEY` = the hackathon team token; optional `GEMINI_BASE_URL`, default the event proxy `https://ai4a11y.lovable.app/api/public/gemini`; optional `GEMINI_MODEL`, default `gemini-3.8-flash`; see `.env.example`). `POST /api/gemini` is served by a Vite plugin in dev/preview and by `api/gemini.ts` on Vercel, with the same handler. Client: `callGemini()` (through `onlineFetch`) and `geminiPickTool(utterance)` → `Intent` via function calling. Gemini picks the tool; it never writes the answer.
- **Help** (SOS, `HelpDialog` in `src/app/ui/Dialogs.tsx`, F6): `tel:999` and `sms:` with the location. Opens the phone's own screen; nothing is sent automatically.

## Toolkit

The AI for Accessibility Toolkit is the parent folder (`../toolkit`). Checked against its code:
- `createToolkit({ kv })` runs in the browser; `kv` (get/set/getAll per area) is the only required port: back it with localStorage.
- Its `tools/validators/` are **not** text filters. The "never say safe to cross" validator (ADR-013) is our own code.
- A toolkit `SKILL.md` is a recipe of registry adapter ids, not a free-form prompt. Keep our prompts as plain files.
- The Controller grammar handles settings ("slower speech", "undo", "help"), not our navigation intents.
- `deriveControllerPresentation(model)` (controller/presentation.js) is useful: voice vs text, verbosity, never speak over a screen reader.

## Commands

```bash
npm install
npm run dev          # http://localhost:5173
npm run typecheck
npm run build && npm run preview   # production build with the service worker, http://localhost:4173
npm run pack         # rebuild the area pack from OpenStreetMap (online); --radius, --lat, --lng, --from-cache
npm run check:nav    # Node smoke test: search, every route profile, a replayed walk through guidance
```
