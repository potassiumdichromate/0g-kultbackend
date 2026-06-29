export * from "./auth.dto";
export * from "./profile.dto";
export * from "./leaderboard.dto";
// Round 4: per-game save schemas (ZeroDashSaveDataSchema, WarzoneSaveDataSchema) moved out of
// this shared package and into each game's own service (services/games/*/src/save-schema.ts).
// A game's save shape is exactly the one thing that's inherently game-specific — owning it in
// a shared file meant adding game #101 required editing shared code. See
// architecture/00-platform-vision.md.
