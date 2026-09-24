import * as Effect from "effect/Effect";
import threadPullRequests from "./050_ProjectionThreadPullRequests.ts";
import threadMessageContext from "./051_ProjectionThreadMessageContext.ts";

// VoiceBud preview builds used IDs 50 and 51 before upstream assigned them to
// these migrations. Reapply both idempotently without rewriting migration history.
export default Effect.gen(function* () {
  yield* threadPullRequests;
  yield* threadMessageContext;
});
