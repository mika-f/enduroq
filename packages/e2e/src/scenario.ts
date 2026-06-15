import { execSync } from "node:child_process";

const QUEUE = process.env.QUEUE_URL ?? "http://localhost:7225";
const WORKER = process.env.WORKER_URL ?? "http://worker:8080";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Status {
  status: string;
  attempt: number;
  last_error: string | null;
}

async function enqueue(
  worker: string,
  data: unknown,
  extra: { maxRetries?: number } = {},
): Promise<number> {
  const res = await fetch(`${QUEUE}/jobs/default`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: worker, data, max_retries: extra.maxRetries }),
  });
  if (!res.ok) throw new Error(`enqueue failed: ${res.status}`);
  const j = (await res.json()) as { id: number };
  return j.id;
}

async function getStatus(id: number): Promise<Status> {
  const res = await fetch(`${QUEUE}/jobs/${id}`);
  if (!res.ok) throw new Error(`status failed: ${res.status}`);
  return (await res.json()) as Status;
}

/** target が true になるまでポーリングし、状態が変わるたびに表示する */
async function waitFor(
  id: number,
  target: (s: string) => boolean,
  timeoutMs: number,
): Promise<Status> {
  const start = Date.now();
  let last = "";
  for (;;) {
    const s = await getStatus(id);
    const line = `${s.status} (attempt=${s.attempt})`;
    if (line !== last) {
      console.log(
        `   job#${id}: ${line}${s.last_error ? ` err="${s.last_error}"` : ""}`,
      );
      last = line;
    }
    if (target(s.status)) return s;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for job#${id} (last=${s.status})`);
    }
    await sleep(1000);
  }
}

function compose(args: string): void {
  console.log(`   $ docker compose ${args}`);
  execSync(`docker compose ${args}`, { stdio: "inherit" });
}

async function scenarioHappy(): Promise<void> {
  console.log("\n=== Scenario A: 長時間ジョブの正常系 (12s) ===");
  const id = await enqueue(`${WORKER}/workers/send_email`, {
    seconds: 12,
    label: "happy",
  });
  const s = await waitFor(
    id,
    (x) => x === "succeeded" || x === "failed",
    90_000,
  );
  console.log(
    s.status === "succeeded"
      ? `   => OK: attempt=${s.attempt} で成功`
      : `   => NG: ${s.status}`,
  );
}

async function scenarioKill(): Promise<void> {
  console.log(
    "\n=== Scenario B: 実行中に worker を強制 kill → lease 失効 → reaper 再投入 → 再実行 ===",
  );
  const id = await enqueue(
    `${WORKER}/workers/send_email`,
    { seconds: 25, label: "kill" },
    { maxRetries: 10 },
  );
  await waitFor(id, (x) => x === "running", 30_000);
  console.log("   running を確認。6 秒処理させてから kill します");
  await sleep(6000);
  compose("kill worker"); // SIGKILL: heartbeat も result も出ないクラッシュを再現
  console.log("   kill 完了。lease 失効 → reaper による再投入を待ちます");
  await waitFor(id, (x) => x === "queued" || x === "dispatching", 40_000);
  console.log("   再投入を確認。worker を再起動します");
  compose("up -d worker");
  const s = await waitFor(
    id,
    (x) => x === "succeeded" || x === "failed",
    120_000,
  );
  console.log(
    s.status === "succeeded"
      ? `   => OK: attempt=${s.attempt}（>1）で最終的に成功`
      : `   => NG: ${s.status} err="${s.last_error}"`,
  );
}

async function scenarioPermanent(): Promise<void> {
  console.log(
    "\n=== Scenario C: 恒久エラー (PermanentError) → リトライせず failed ===",
  );
  const id = await enqueue(`${WORKER}/workers/transcode`, { permanent: true });
  const s = await waitFor(
    id,
    (x) => x === "failed" || x === "succeeded",
    30_000,
  );
  console.log(
    s.status === "failed"
      ? `   => OK: attempt=${s.attempt} で failed（再投入なし）err="${s.last_error}"`
      : `   => NG: ${s.status}`,
  );
}

async function scenarioSync(): Promise<void> {
  console.log(
    "\n=== Scenario D: 短時間ジョブを sync モードで実行（200 + 結果を同期で確定） ===",
  );
  const id = await enqueue(`${WORKER}/workers/notify`, { message: "hi" });
  const s = await waitFor(
    id,
    (x) => x === "succeeded" || x === "failed",
    30_000,
  );
  console.log(
    s.status === "succeeded"
      ? `   => OK: attempt=${s.attempt} で succeeded（result コールバック無しで確定）`
      : `   => NG: ${s.status}`,
  );
}

async function main(): Promise<void> {
  console.log(`queue = ${QUEUE}, worker = ${WORKER}`);
  await scenarioHappy();
  await scenarioSync();
  await scenarioKill();
  await scenarioPermanent();
  console.log("\n全シナリオ完了");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
