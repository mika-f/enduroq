CREATE TABLE
  IF NOT EXISTS jobs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    url VARCHAR(1024) NOT NULL,
    payload JSON NOT NULL,
    status ENUM (
      'queued',
      'dispatching',
      'running',
      'succeeded',
      'failed',
      'cancelled'
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
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE
  IF NOT EXISTS enduroq_schema_migrations (
    version INT UNSIGNED NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    applied_at DATETIME (3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

INSERT IGNORE INTO enduroq_schema_migrations (version, name)
VALUES
  (1, 'create_jobs'),
  (2, 'add_cancelled_status');