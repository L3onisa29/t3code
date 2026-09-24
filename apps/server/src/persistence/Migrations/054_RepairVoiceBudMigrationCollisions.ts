import * as Effect from "effect/Effect";
import pinnedThreads from "./036_ProjectionThreadsPinned.ts";
import clientConnection from "./041_AuthSessionClientConnection.ts";
import linkedPullRequest from "./042_ProjectionThreadLinkedPullRequest.ts";

// Earlier VoiceBud builds used IDs 36/41 for latest-turn backfills and 42 for
// the pin repair. The migrator skips IDs already recorded, regardless of name.
// Reapply these idempotent upstream migrations after the shared history so both
// fork databases and upstream databases converge without rewriting that history.
export default Effect.gen(function* () {
  yield* pinnedThreads;
  yield* clientConnection;
  yield* linkedPullRequest;
});
