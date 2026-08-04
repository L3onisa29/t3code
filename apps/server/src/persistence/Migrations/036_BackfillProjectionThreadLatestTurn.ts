import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET latest_turn_id = (
      SELECT turns.turn_id
      FROM projection_turns AS turns
      WHERE turns.thread_id = projection_threads.thread_id
        AND turns.turn_id IS NOT NULL
      ORDER BY turns.requested_at DESC, turns.row_id DESC
      LIMIT 1
    )
    WHERE projection_threads.latest_turn_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM projection_turns AS turns
        WHERE turns.thread_id = projection_threads.thread_id
          AND turns.turn_id IS NOT NULL
      )
  `;
});
