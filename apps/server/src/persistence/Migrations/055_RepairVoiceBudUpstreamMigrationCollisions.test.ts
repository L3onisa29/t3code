import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { describe } from "vite-plus/test";

import { runMigrations } from "../Migrations.ts";
import repair from "./055_RepairVoiceBudUpstreamMigrationCollisions.ts";

describe("055_RepairVoiceBudUpstreamMigrationCollisions", () => {
  it.effect("repairs a VoiceBud database already migrated through 54", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (36, 'BackfillProjectionThreadLatestTurn')
      `;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (41, 'BackfillProjectionThreadLatestTurn')
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (42, 'RepairProjectionThreadsPinned')
      `;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (50, 'BackfillProjectionThreadLatestTurn')
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (51, 'RepairVoiceBudMigrationCollisions')
      `;
      yield* runMigrations({ toMigrationInclusive: 54 });

      const tablesBefore = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_thread_pull_requests'
      `;
      assert.deepStrictEqual(tablesBefore, [{ name: "projection_thread_pull_requests" }]);
      const messagesBefore = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      assert.ok(messagesBefore.some((column) => column.name === "context_json"));

      const executed = yield* runMigrations({ toMigrationInclusive: 55 });
      assert.deepStrictEqual(executed, [[55, "OrchestrationV2"]]);
      const tablesAfter = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_thread_pull_requests'
      `;
      assert.deepStrictEqual(tablesAfter, [{ name: "projection_thread_pull_requests" }]);
      const messagesAfter = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      assert.strictEqual(
        messagesAfter.filter((column) => column.name === "context_json").length,
        1,
      );
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("is idempotent on a fresh upstream schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* runMigrations({ toMigrationInclusive: 55 });
      const before = yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`;
      yield* repair;
      const after = yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`;
      assert.deepStrictEqual(after, before);
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
