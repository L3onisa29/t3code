import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { describe } from "vite-plus/test";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import repair from "./056_RepairVoiceBudFilesViewedCollision.ts";

describe("056_RepairVoiceBudFilesViewedCollision", () => {
  it.effect("creates a fresh schema with unique migration IDs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(
        new Set(migrationManifest.map(([id]) => id)).size,
        migrationManifest.length,
      );
      assert.deepStrictEqual(yield* runMigrations(), migrationManifest);
      assert.deepStrictEqual(yield* sql`SELECT * FROM pull_request_files_viewed`, []);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  for (const source of [
    "upstream-53",
    "voicebud-53",
    "voicebud-54",
    "voicebud-55",
    "voicebud-56",
    "voicebud-57",
    "legacy-50",
    "legacy-51",
  ] as const) {
    it.effect(`preserves data and history when upgrading ${source}`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        if (source.startsWith("legacy")) {
          yield* runMigrations({ toMigrationInclusive: 49 });
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (50, 'BackfillProjectionThreadLatestTurn')`;
          if (source === "legacy-51") {
            yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (51, 'RepairVoiceBudMigrationCollisions')`;
          }
        } else if (source === "upstream-53") {
          yield* runMigrations({ toMigrationInclusive: 53 });
          yield* sql`
            INSERT INTO pull_request_files_viewed
              (provider, host, repository, number, viewer, path, revision, viewed_at)
            VALUES ('azure', 'dev.azure.com', 'org/project/repo', 7, 'reader', 'src/main.ts', 'abc', '2026-09-24T12:00:00.000Z')
          `;
        } else {
          yield* runMigrations({ toMigrationInclusive: 52 });
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (53, 'BackfillProjectionThreadLatestTurn')`;
          const last = Number(source.split("-")[1]);
          for (const [id, name] of [
            [54, "RepairVoiceBudMigrationCollisions"],
            [55, "RepairVoiceBudUpstreamMigrationCollisions"],
            [56, "RepairVoiceBudFilesViewedCollision"],
            [57, "ProjectionThreadsAutoSettleDisabledAt"],
          ] as const) {
            if (id <= last)
              yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
          }
        }

        yield* sql`
          INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, latest_turn_id, created_at, updated_at)
          VALUES
            ('missing', 'project', 'Missing', '{"instanceId":"codex","model":"gpt-5"}', NULL, '2026-09-24T10:00:00.000Z', '2026-09-24T12:00:00.000Z'),
            ('existing', 'project', 'Existing', '{"instanceId":"codex","model":"gpt-5"}', 'selected', '2026-09-24T10:00:00.000Z', '2026-09-24T12:00:00.000Z')
        `;
        yield* sql`
          INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
          VALUES
            ('missing', 'older', 'completed', '2026-09-24T10:00:00.000Z', '[]'),
            ('missing', 'newer', 'completed', '2026-09-24T11:00:00.000Z', '[]'),
            ('existing', 'selected', 'completed', '2026-09-24T10:00:00.000Z', '[]'),
            ('existing', 'later', 'completed', '2026-09-24T11:00:00.000Z', '[]')
        `;
        const historyBefore = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const turnsBefore = yield* sql`SELECT * FROM projection_turns ORDER BY row_id`;
        const viewedBefore =
          source === "upstream-53" ? yield* sql`SELECT * FROM pull_request_files_viewed` : [];

        const executed = yield* runMigrations();
        assert.deepStrictEqual(
          executed,
          migrationManifest.filter(([id]) => id > Number(historyBefore.at(-1)?.migration_id ?? 0)),
        );
        assert.deepStrictEqual(
          yield* sql`SELECT thread_id, latest_turn_id FROM projection_threads ORDER BY thread_id`,
          [
            { thread_id: "existing", latest_turn_id: "selected" },
            { thread_id: "missing", latest_turn_id: "newer" },
          ],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM projection_turns ORDER BY row_id`,
          turnsBefore,
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM pull_request_files_viewed`, viewedBefore);
        const historyAfter = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(historyAfter.slice(0, historyBefore.length), historyBefore);

        // The skipped V2/webhook slots must be usable, not merely recorded.
        yield* sql`INSERT INTO orchestration_v2_events (event_id, thread_id, event_type, occurred_at, payload_json) VALUES ('event-test', 'missing', 'test', '2026-09-24T12:00:00.000Z', '{}')`;
        const scheduledColumns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(scheduled_tasks)`;
        assert.ok(scheduledColumns.some((column) => column.name === "webhook_token"));
        assert.ok(scheduledColumns.some((column) => column.name === "webhook_secret"));
        const schemaAfter =
          yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`;
        yield* repair;
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(
          yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`,
          schemaAfter,
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM pull_request_files_viewed`, viewedBefore);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          historyAfter,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM projection_turns ORDER BY row_id`,
          turnsBefore,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
  }
});
