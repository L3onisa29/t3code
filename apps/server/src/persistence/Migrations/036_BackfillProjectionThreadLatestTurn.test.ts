import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_BackfillProjectionThreadLatestTurn", (it) => {
  it.effect("restores missing latest turns without replacing existing references", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES
          (
            'thread-missing-latest',
            'project-1',
            'Missing latest turn',
            '{"instanceId":"codex","model":"gpt-5"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-08-04T08:00:00.000Z',
            '2026-08-04T10:00:00.000Z',
            NULL,
            '2026-08-04T09:00:00.000Z',
            0,
            0,
            0,
            NULL
          ),
          (
            'thread-existing-latest',
            'project-1',
            'Existing latest turn',
            '{"instanceId":"codex","model":"gpt-5"}',
            'full-access',
            'default',
            NULL,
            NULL,
            'turn-existing',
            '2026-08-04T08:00:00.000Z',
            '2026-08-04T10:00:00.000Z',
            NULL,
            '2026-08-04T09:00:00.000Z',
            0,
            0,
            0,
            NULL
          ),
          (
            'thread-without-turns',
            'project-1',
            'No turns',
            '{"instanceId":"codex","model":"gpt-5"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-08-04T08:00:00.000Z',
            '2026-08-04T10:00:00.000Z',
            NULL,
            NULL,
            0,
            0,
            0,
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json,
          source_proposed_plan_thread_id,
          source_proposed_plan_id
        )
        VALUES
          (
            'thread-missing-latest',
            'turn-older',
            NULL,
            NULL,
            'completed',
            '2026-08-04T08:30:00.000Z',
            '2026-08-04T08:30:00.000Z',
            '2026-08-04T08:40:00.000Z',
            1,
            'refs/t3/checkpoints/older',
            'ready',
            '[]',
            NULL,
            NULL
          ),
          (
            'thread-missing-latest',
            'turn-newer',
            NULL,
            NULL,
            'completed',
            '2026-08-04T09:30:00.000Z',
            '2026-08-04T09:30:00.000Z',
            '2026-08-04T09:40:00.000Z',
            2,
            'refs/t3/checkpoints/newer',
            'ready',
            '[]',
            NULL,
            NULL
          ),
          (
            'thread-existing-latest',
            'turn-existing',
            NULL,
            NULL,
            'completed',
            '2026-08-04T08:30:00.000Z',
            '2026-08-04T08:30:00.000Z',
            '2026-08-04T08:40:00.000Z',
            1,
            'refs/t3/checkpoints/existing',
            'ready',
            '[]',
            NULL,
            NULL
          ),
          (
            'thread-existing-latest',
            'turn-later-but-not-selected',
            NULL,
            NULL,
            'completed',
            '2026-08-04T09:30:00.000Z',
            '2026-08-04T09:30:00.000Z',
            '2026-08-04T09:40:00.000Z',
            2,
            'refs/t3/checkpoints/later',
            'ready',
            '[]',
            NULL,
            NULL
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const threads = yield* sql<{
        readonly threadId: string;
        readonly latestTurnId: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          latest_turn_id AS "latestTurnId"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(threads, [
        { threadId: "thread-existing-latest", latestTurnId: "turn-existing" },
        { threadId: "thread-missing-latest", latestTurnId: "turn-newer" },
        { threadId: "thread-without-turns", latestTurnId: null },
      ]);
    }),
  );
});
