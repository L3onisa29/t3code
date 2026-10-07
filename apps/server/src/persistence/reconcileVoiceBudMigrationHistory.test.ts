import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "./Migrations.ts";

describe("VoiceBud upgrade recovery", () => {
  it.effect("rolls back a failed reconciliation and safely retries without rewriting history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'RepairVoiceBudUpstreamMigrationCollisions'), (56, 'RepairVoiceBudFilesViewedCollision'), (57, 'ProjectionThreadsAutoSettleDisabledAt')`;
      yield* sql`CREATE TABLE orchestration_v2_command_receipts (marker TEXT)`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const schema = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepEqual(yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`, schema);
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
      yield* sql`DROP TABLE orchestration_v2_command_receipts`;
      yield* runMigrations();
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(
        (yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`).slice(
          0,
          history.length,
        ),
        history,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("completes a partially present webhook schema without dropping existing tokens", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (56, 'RepairVoiceBudFilesViewedCollision'), (57, 'ProjectionThreadsAutoSettleDisabledAt')`;
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN webhook_token TEXT`;
      yield* sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode, created_by, creation_source, created_at, updated_at, last_run_status, run_count, webhook_token) VALUES ('task-test', 'Existing task', 'prompt', 0, '{}', 'project', '{}', '{}', 'full-access', 'default', 'user', 'manual', '2026-10-06T12:00:00.000Z', '2026-10-06T12:00:00.000Z', 'idle', 0, 'existing-token')`;
      yield* runMigrations();
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
      assert.equal(columns.filter((column) => column.name === "webhook_token").length, 1);
      assert.equal(columns.filter((column) => column.name === "webhook_secret").length, 1);
      assert.deepEqual(
        yield* sql`SELECT task_id, webhook_token, webhook_secret FROM scheduled_tasks`,
        [{ task_id: "task-test", webhook_token: "existing-token", webhook_secret: null }],
      );
      assert.deepEqual(yield* sql`SELECT * FROM scheduled_task_webhook_deliveries`, []);
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
