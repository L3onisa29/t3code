import * as Effect from "effect/Effect";
import backfillLatestTurn from "./053_BackfillProjectionThreadLatestTurn.ts";
import filesViewed from "./053_PullRequestFilesViewed.ts";

// VoiceBud recorded a latest-turn backfill at 53, while upstream assigned 53
// to viewed files. Databases already at 53–55 skip that slot, so replay both
// idempotent changes here and retain their original migration history.
export default Effect.gen(function* () {
  yield* filesViewed;
  yield* backfillLatestTurn;
});
