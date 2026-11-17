# Architecture & Adding Champions

This project separates **champion configuration** (single source of truth in `src/shared/champions/`) from **game engine primitives** (server simulation, 3D rig/VFX rendering, audio, and HUD).

## Codebase Layout

- `src/shared/` — Runtime code & types shared by **both** server and browser client:
  - `types.ts` — WebSocket protocol messages, snapshots, events, `ChampionId`
  - `constants.ts` — Arena geometry (`PIT_RADIUS`, `LINE_BUFFER`), `TICK_RATE`, `SUMMONER_SPELLS`
  - `champions/types.ts` — Strongly-typed `ChampionConfig` schema
  - `champions/<id>.ts` — Individual champion definitions (`drmundo.ts`, `chogath.ts`)
  - `champions/index.ts` — `CHAMPION_REGISTRY` and `CHAMPION_LIST`
- `src/server/` — Authoritative 60 Hz simulation, actions (`linear_projectile`, `delayed_ground_aoe`), bot AI, persistence, and Express/WS server
- `src/client/` — Three.js scene, config-driven `ChampionRig` + `proceduralRigs.ts`, VFX & skillshot indicators, audio engine, HUD, and network client
- `src/tests/` — Automated registry asset validation, simulation unit tests, and live WebSocket E2E tests

## How to Add a New Champion

For champions whose Q uses an existing ability archetype (`linear_projectile` or `delayed_ground_aoe`):

1. **Add assets** under `public/assets/`:
   - Icons (`circle`, `square`, `passive`, `q`, `w`, `e`, `r`)
   - 3D model `.glb` (or add a procedural preset in `src/client/proceduralRigs.ts`) and optional projectile `.obj` + texture
   - Optional `.ogg` voice/SFX files (if omitted, `synthProfile` provides WebAudio fallback)
2. **Create `src/shared/champions/<id>.ts`** exporting a `ChampionConfig` object (use `drmundo.ts` or `chogath.ts` as a template).
3. **Register the champion**:
   - Add `'<id>'` to `ChampionId` in `src/shared/types.ts`
   - Import and add `<id>` to `CHAMPION_REGISTRY` in `src/shared/champions/index.ts`
4. **Verify**:
   ```bash
   npm run typecheck
   npm test
   ```
   `npm test` automatically builds server + client bundles, verifies every icon/model/audio path in `CHAMPION_REGISTRY` exists on disk, and runs simulation + live WebSocket multiplayer tests.

## Adding a Brand-New Ability Archetype (e.g., Lee Sin Q2 Dash)

When a champion introduces a new mechanic not yet covered by `linear_projectile` or `delayed_ground_aoe`:
1. Add the new union variant to `QAbilityConfig` in `src/shared/champions/types.ts`.
2. Handle it in `releasePendingCast` / `stepRoomSimulation` in `src/server/simulation.ts` (and `castPrimaryAbility` in `src/server/actions.ts` if targeting differs).
3. Add its indicator/VFX branch in `src/client/vfx.ts`.
4. Add a simulation + WS test in `src/tests/`.
