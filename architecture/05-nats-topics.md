# NATS Topic Design

See [00-platform-vision.md](./00-platform-vision.md) — NATS is what lets platform services own cross-game capabilities without knowing any specific game exists.

## Subject naming convention

```
game.<gameKey>.<event>        e.g. game.warzone.mission_completed, game.zerodash.game_saved
platform.<domain>.<event>     e.g. platform.user.xp_gained, platform.reward.granted
```

`<gameKey>` matches `Game.key` in Postgres (`zerodash`, `warzone`, ...). `<event>` is always lowercase snake_case. This convention is what lets a single wildcard subscription (`game.*.*`) cover every current and future game without a consumer needing to enumerate game keys — adding game #101 means a new per-game service (or, for a game not ready to leave its own backend, a new `sync-service` entry) publishing to `game.<newkey>.*`, with zero changes to any existing consumer's subscription. `save-service`, `verification-service`, and each per-game service (`services/games/*`, Round 4) are all just more participants on the same two streams — `save_requested`/`save_completed`/`save_validated`/`mission_completed` are `game.<gameKey>.*` subjects exactly like `game_saved`, and `xp_gained`/`profile.updated`/`user.login` are `platform.<domain>.*` subjects exactly like `achievement.unlocked`. See [04-event-flow.md](./04-event-flow.md) for the full, current catalogue.

## Why JetStream, not core NATS

Core NATS pub/sub is at-most-once and fire-and-forget: if `achievement-service` is mid-deploy when a `MISSION_COMPLETED` fires, that event is gone and a player silently doesn't get credit. JetStream gives:
- **Persistence** — events are stored in a stream, not just relayed to whoever happens to be listening.
- **Durable consumers** — each service gets its own named consumer with an ack cursor; a restart resumes exactly where it left off instead of replaying everything or missing the gap.
- **Replay** — analytics-service (or a new service added later) can replay history from the start of the stream.

The cost is some extra ops surface (stream/consumer management) — acceptable once events drive real economic outcomes (rewards, achievements).

## Streams

| Stream | Subjects | Retention | Notes |
|---|---|---|---|
| `GAME_EVENTS` | `game.*.*` | Limits-based (e.g. 30 days or size cap) | All game-originated events |
| `PLATFORM_EVENTS` | `platform.*.*` | Limits-based | All platform-originated events |

Both streams are created idempotently at service startup via `createPlatformNatsClient` in `shared/utils/src/nats-client.ts` (`jsm.streams.add` if `jsm.streams.info` throws) — no separate provisioning step required for local dev or the skeleton services.

## Consumers

**Accurate as of this audit, not aspirational:** every service today subscribes via an ephemeral core subscription (`nc.subscribe`) layered on top of the JetStream-backed streams above — not a named durable consumer. This still gets persistence and replay-from-stream for free (JetStream stores the messages regardless of who's listening), but **not** the "resume exactly where it left off after a restart" guarantee a real durable consumer would give; a service that's down when a message arrives and comes back up later will not automatically receive it via this subscription style. Promoting each service to an explicit durable `js.consumers.get`/pull consumer with manual ack is the first hardening step before production traffic (see [08-migration-roadmap.md](./08-migration-roadmap.md)) — tracked as a known gap, not silently assumed to already be the safer thing it sounds like.

## Local inspection

With `docker compose up`, NATS exposes its monitoring port at `localhost:8222` (`/varz`, `/jsz?streams=true` for stream/consumer state) and the standard client port at `localhost:4222`.
