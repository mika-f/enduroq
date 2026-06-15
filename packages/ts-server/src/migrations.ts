import crypto from "node:crypto";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import type pino from "pino";

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

interface MigrationRow extends RowDataPacket {
  version: number;
}

interface LockRow extends RowDataPacket {
  acquired: number | null;
}

export interface MigrationOptions {
  readonly databaseName: string;
  readonly lockTimeoutInSec: number;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "create_jobs",
    statements: [
      `
        CREATE TABLE IF NOT EXISTS jobs (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          url VARCHAR(1024) NOT NULL,
          payload JSON NOT NULL,
          status ENUM (
            'queued',
            'dispatching',
            'running',
            'succeeded',
            'failed'
          ) NOT NULL DEFAULT 'queued',
          attempt INT UNSIGNED NOT NULL DEFAULT 0,
          max_retries INT UNSIGNED NOT NULL DEFAULT 3,
          run_after DATETIME (3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          lease_token CHAR(36) NULL,
          lease_expires_at DATETIME (3) NULL,
          worker_url VARCHAR(1024) NULL,
          result JSON NULL,
          last_error TEXT NULL,
          created_at DATETIME (3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME (3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          KEY idx_dequeue (status, name, run_after),
          KEY idx_reaper (status, lease_expires_at)
        ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4
      `,
    ],
  },
];

export const migrateDatabase = async (
  pool: Pool,
  logger: pino.Logger,
  options: MigrationOptions,
): Promise<void> => {
  const log = logger.child({ module: "migrations" });
  const conn = await pool.getConnection();
  const lockName = migrationLockName(options.databaseName);

  try {
    await acquireMigrationLock(conn, lockName, options.lockTimeoutInSec);
    await ensureMigrationsTable(conn);

    const [rows] = await conn.query<MigrationRow[]>(
      "SELECT version FROM enduroq_schema_migrations ORDER BY version",
    );
    const latestKnownVersion = MIGRATIONS.at(-1)?.version ?? 0;
    const unknownVersions = rows
      .map((row) => row.version)
      .filter((version) => version > latestKnownVersion);

    if (unknownVersions.length > 0) {
      throw new Error(
        `Database has migrations newer than this server supports: ${unknownVersions.join(", ")}`,
      );
    }

    const applied = new Set(rows.map((row) => row.version));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }

      log.info(
        { version: migration.version, name: migration.name },
        "applying database migration",
      );

      for (const statement of migration.statements) {
        await conn.query(statement);
      }

      await conn.query<ResultSetHeader>(
        `
          INSERT INTO enduroq_schema_migrations (version, name)
          VALUES (?, ?)
        `,
        [migration.version, migration.name],
      );

      log.info(
        { version: migration.version, name: migration.name },
        "database migration applied",
      );
    }
  } finally {
    await releaseMigrationLock(conn, lockName, log);
    conn.release();
  }
};

const ensureMigrationsTable = async (conn: PoolConnection): Promise<void> => {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS enduroq_schema_migrations (
      version INT UNSIGNED NOT NULL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at DATETIME (3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4
  `);
};

const acquireMigrationLock = async (
  conn: PoolConnection,
  lockName: string,
  timeoutInSec: number,
): Promise<void> => {
  const [rows] = await conn.query<LockRow[]>(
    "SELECT GET_LOCK(?, ?) AS acquired",
    [lockName, timeoutInSec],
  );
  const acquired = rows[0]?.acquired;

  if (acquired !== 1) {
    throw new Error(
      `Timed out waiting for database migration lock (${lockName}) after ${timeoutInSec}s`,
    );
  }
};

const releaseMigrationLock = async (
  conn: PoolConnection,
  lockName: string,
  logger: pino.Logger,
): Promise<void> => {
  try {
    await conn.query("SELECT RELEASE_LOCK(?)", [lockName]);
  } catch (err) {
    logger.warn({ err }, "failed to release database migration lock");
  }
};

const migrationLockName = (databaseName: string): string => {
  const digest = crypto.createHash("sha1").update(databaseName).digest("hex");
  return `enduroq:migrate:${digest}`;
};
