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
| Foundation, map, offline/online wiring | `src/contracts.ts`, `src/app`, `src/net`, `src/pack`, `src/geo`, `src/mapview`, `src/position`, `scripts/pack`, `public/sw.js` |
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
- **Map** (`src/mapview/MapView.tsx`): SVG drawn from the pack, no tiles. Props: `index`, `route`, `position`, `highlights`.

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
```
