import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!columns.some((column) => column.name === "owner_thread_id")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN owner_thread_id TEXT
    `;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_projects_owner_thread_id
    ON projection_projects (owner_thread_id)
    WHERE deleted_at IS NULL AND owner_thread_id IS NOT NULL
  `;
});
