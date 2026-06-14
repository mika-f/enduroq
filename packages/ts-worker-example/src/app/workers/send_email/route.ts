import { client, HEARTBEAT_MS, LEASE_EXTEND_SEC, worker } from "@/lib/enduroq";
import { DispatchPayload, JOB_ID_HEADER } from "@enduroq/enduroq-worker";
import { headers } from "next/headers";
import { after } from "next/server";

const sleep = async (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

type SendEmailJobPayload = DispatchPayload<{
  label?: string;
  seconds?: number;
}>;

export async function POST(req: Request) {
  const header = await headers();
  const jobId = Number(header.get(JOB_ID_HEADER) ?? "0");
  if (!jobId) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const payload = await req
    .json()
    .then((w) => w as unknown as SendEmailJobPayload);

  after(async () => {
    const ac = new AbortController();
    const job = await worker.acquire(jobId, payload, ac, {
      heartbeatIntervalMs: HEARTBEAT_MS,
      leaseExtendSeconds: LEASE_EXTEND_SEC,
    });
    try {
      const total = payload.data.seconds ?? 10;
      console.log(
        `[worker] start  job=${jobId} seconds=${total} label=${payload.data.label ?? ""}`,
      );
      for (let i = 0; i < total; i += 1) {
        await sleep(1000);
        console.log(`[worker] tick   job=${jobId} ${i + 1}/${total}`);
      }
      console.log(`[worker] done   job=${jobId} `);

      await client.result(payload.callback, jobId, {
        lease_token: payload.lease_token,
        status: "success",
        output: {},
      });
    } catch {
      await client.result(payload.callback, jobId, {
        lease_token: payload.lease_token,
        status: "failure",
        retryable: true,
        error: "",
      });
    } finally {
      job.stop();
    }
  });

  return Response.json({ ok: true }, { status: 202 });
}
