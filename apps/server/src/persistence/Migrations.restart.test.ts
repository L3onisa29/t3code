// @effect-diagnostics nodeBuiltinImport:off - This test kills its own child during a real SQLite migration transaction.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

it.effect.each([
  [59, "059_McpAppModelContext", "mcp_app_model_context"],
  [60, "060_ThreadSnapshotWindowIndexes", "orchestration_v2_projection_nodes_live_idx"],
  [61, "061_PullRequestReviewGuides", "pull_request_review_guides"],
] as const)(
  "retries migration %s after process loss and preserves the VoiceBud ledger",
  ([id, module, artifact]) =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-migration-restart-"));
      const filename = NodePath.join(directory, "statev2.sqlite");
      const migrate = (throughId?: number) =>
        runMigrations({ toMigrationInclusive: throughId }).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename })),
        );
      try {
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 54 });
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES
            (55, 'RepairVoiceBudUpstreamMigrationCollisions'),
            (56, 'RepairVoiceBudFilesViewedCollision'),
            (57, 'ProjectionThreadsAutoSettleDisabledAt')`;
          yield* sql`CREATE TABLE restart_marker (text TEXT NOT NULL)`;
          yield* sql`INSERT INTO restart_marker VALUES ('preserved across process loss')`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
        yield* migrate(id - 1);
        const before = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
        const history = before
          .prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id")
          .all();
        before.close();

        const child = NodeChildProcess.spawn(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `import * as Effect from 'effect/Effect';
           import * as SqlClient from 'effect/sql/SqlClient';
           import * as NodeSqliteClient from '@t3tools/shared/nodeSqliteClient';
           import migration from ${JSON.stringify(new URL(`./Migrations/${module}.ts`, import.meta.url).href)};
           await Effect.runPromise(Effect.gen(function* () {
             const sql = yield* SqlClient.SqlClient;
             yield* sql\`PRAGMA journal_mode = WAL\`;
             yield* sql.withTransaction(migration.pipe(
               Effect.andThen(Effect.sync(() => process.send('migration-started'))),
               Effect.andThen(Effect.never),
             ));
           }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ${JSON.stringify(filename)} }))));`,
          ],
          {
            cwd: NodeURL.fileURLToPath(new URL("../../", import.meta.url)),
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
        let stderr = "";
        child.stderr?.on("data", (chunk) => {
          stderr += chunk;
        });
        try {
          yield* Effect.tryPromise(
            () =>
              new Promise<void>((resolve, reject) => {
                let started = false;
                child.once("error", reject);
                child.once("message", (message) => {
                  if (message !== "migration-started") {
                    reject(new Error("Unexpected migration milestone"));
                    return;
                  }
                  started = true;
                  child.kill("SIGKILL");
                });
                child.once("exit", (code, signal) => {
                  if (started && signal === "SIGKILL") resolve();
                  else
                    reject(
                      new Error(
                        `Migration child exited before interruption: ${code}, ${signal}, ${stderr}`,
                      ),
                    );
                });
              }),
          );
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }

        const interrupted = new NodeSqlite.DatabaseSync(filename);
        try {
          assert.equal(
            interrupted
              .prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = ?")
              .get(artifact)?.count,
            0,
          );
          assert.deepEqual(
            interrupted.prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id").all(),
            history,
          );
        } finally {
          interrupted.close();
        }
        yield* migrate();
        assert.deepEqual(yield* migrate(), []);
        const reopened = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
        try {
          assert.equal(reopened.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
          assert.equal(
            reopened
              .prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = ?")
              .get(artifact)?.count,
            1,
          );
          assert.deepEqual(reopened.prepare("SELECT text FROM restart_marker").all(), [
            { text: "preserved across process loss" },
          ]);
          assert.deepEqual(
            reopened
              .prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id")
              .all()
              .slice(0, history.length),
            history,
          );
          assert.equal(
            reopened.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()?.id,
            migrationManifest.at(-1)?.[0],
          );
        } finally {
          reopened.close();
        }
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
);
