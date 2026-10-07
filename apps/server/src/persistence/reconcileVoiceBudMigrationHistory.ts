import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";

import Pinned from "./Migrations/036_ProjectionThreadsPinned.ts";
import ClientConnection from "./Migrations/041_AuthSessionClientConnection.ts";
import LinkedPullRequest from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import PullRequests from "./Migrations/050_ProjectionThreadPullRequests.ts";
import MessageContext from "./Migrations/051_ProjectionThreadMessageContext.ts";
import FilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettle from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";
import RemoveIndexes from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import Webhooks from "./Migrations/057_ScheduledTaskWebhooks.ts";

// Fork builds occupied upstream IDs with repairs. Keep the original ledger and
// apply the skipped schemas before the normal migrator reaches their dependents.
export const reconcileVoiceBudMigrationHistory = Effect.fn("reconcileVoiceBudMigrationHistory")(
  function* (throughId = Infinity) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables =
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
        if (tables.length === 0) return;
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations`;
        const fork = history.some(
          (row) =>
            row.name === "BackfillProjectionThreadLatestTurn" ||
            row.name === "RepairProjectionThreadsPinned" ||
            row.name.startsWith("RepairVoiceBud") ||
            (row.migration_id === 57 && row.name === "ProjectionThreadsAutoSettleDisabledAt"),
        );
        if (!fork) return;
        const latest = Math.max(...history.map((row) => row.migration_id));
        const skipped = Math.min(latest, throughId);
        if (skipped >= 36) yield* Pinned;
        if (skipped >= 41) yield* ClientConnection;
        if (skipped >= 42) yield* LinkedPullRequest;
        if (skipped >= 50) yield* PullRequests;
        if (skipped >= 51) yield* MessageContext;
        if (skipped >= 53) yield* FilesViewed;
        if (skipped >= 54) yield* AutoSettle;
        if (skipped >= 55) {
          const v2 =
            yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_events'`;
          if (v2.length === 0) yield* OrchestrationV2;
        }
        if (skipped >= 56) yield* RemoveIndexes;
        if (skipped >= 57) yield* Webhooks;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new Migrator.MigrationError({
              kind: "Failed",
              message: "Failed to reconcile VoiceBud migration schemas.",
              cause,
            }),
        ),
      ),
    );
  },
);
