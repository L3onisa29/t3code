import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vite-plus/test";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import migrateAutoSettleDisabledAt from "./057_ProjectionThreadsAutoSettleDisabledAt.ts";

describe("057_ProjectionThreadsAutoSettleDisabledAt", () => {
  it.effect("creates the column on a fresh database and runs migrations only once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* runMigrations(), migrationManifest);
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.strictEqual(
        columns.filter(({ name }) => name === "auto_settle_disabled_at").length,
        1,
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  for (const source of ["voicebud-56", "upstream-54"] as const) {
    it.effect(`preserves threads and migration history when upgrading ${source}`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        if (source === "voicebud-56") {
          yield* runMigrations({ toMigrationInclusive: 56 });
          const columns = yield* sql<{
            readonly name: string;
          }>`PRAGMA table_info(projection_threads)`;
          assert.ok(!columns.some(({ name }) => name === "auto_settle_disabled_at"));
        } else {
          yield* runMigrations({ toMigrationInclusive: 53 });
          yield* migrateAutoSettleDisabledAt;
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (54, 'ProjectionThreadsAutoSettleDisabledAt')
          `;
        }
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            latest_turn_id, created_at, updated_at
          ) VALUES (
            'thread-1', 'project-1', 'Existing thread',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'selected', ${now}, ${now}
          )
        `;
        if (source === "upstream-54") {
          yield* sql`UPDATE projection_threads SET auto_settle_disabled_at = ${now} WHERE thread_id = 'thread-1'`;
        }
        const historyBefore = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const threadsBefore =
          yield* sql`SELECT thread_id, title, latest_turn_id, created_at, updated_at FROM projection_threads`;

        const executed = yield* runMigrations();
        assert.deepStrictEqual(
          executed,
          migrationManifest.filter(([id]) => id > (source === "voicebud-56" ? 56 : 54)),
        );
        assert.deepStrictEqual(
          yield* sql`SELECT thread_id, title, latest_turn_id, created_at, updated_at FROM projection_threads`,
          threadsBefore,
        );
        assert.deepStrictEqual(yield* sql`SELECT auto_settle_disabled_at FROM projection_threads`, [
          { auto_settle_disabled_at: source === "voicebud-56" ? null : now },
        ]);
        const historyAfter = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(historyAfter.slice(0, historyBefore.length), historyBefore);

        yield* sql`UPDATE projection_threads SET auto_settle_disabled_at = ${now} WHERE thread_id = 'thread-1'`;
        const threadsAfter = yield* sql`SELECT * FROM projection_threads`;
        const schemaAfter =
          yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`;
        yield* migrateAutoSettleDisabledAt;
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* sql`SELECT * FROM projection_threads`, threadsAfter);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          historyAfter,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`,
          schemaAfter,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
  }
});
