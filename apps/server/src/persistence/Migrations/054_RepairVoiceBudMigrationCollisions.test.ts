import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { describe } from "vite-plus/test";

import { runMigrations } from "../Migrations.ts";
import repair from "./054_RepairVoiceBudMigrationCollisions.ts";

describe("054_RepairVoiceBudMigrationCollisions", () => {
  for (const lastForkMigration of [41, 42]) {
    it.effect(`repairs a VoiceBud database last migrated to ${lastForkMigration}`, () =>
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
        if (lastForkMigration === 42) {
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (42, 'RepairProjectionThreadsPinned')
          `;
        }
        yield* runMigrations({ toMigrationInclusive: 53 });
        const authBefore = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
        assert.ok(authBefore.some((column) => column.name === "client_surface"));

        const executed = yield* runMigrations({ toMigrationInclusive: 54 });
        assert.deepStrictEqual(executed, [[54, "ProjectionThreadsAutoSettleDisabledAt"]]);
        const authColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
        for (const name of ["client_surface", "client_app_version"]) {
          assert.strictEqual(authColumns.filter((column) => column.name === name).length, 1);
        }
        const threadColumns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_threads)`;
        for (const name of ["pinned_at", "linked_pull_request_json", "active_order_key"]) {
          assert.strictEqual(threadColumns.filter((column) => column.name === name).length, 1);
        }
        const history = yield* sql<{ readonly name: string }>`
          SELECT name FROM effect_sql_migrations WHERE migration_id = 41
        `;
        assert.deepStrictEqual(history, [{ name: "BackfillProjectionThreadLatestTurn" }]);
        assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
  }

  it.effect("is idempotent on a fresh upstream schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* runMigrations({ toMigrationInclusive: 54 });
      const before = yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`;
      yield* repair;
      const after = yield* sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`;
      assert.deepStrictEqual(after, before);
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
