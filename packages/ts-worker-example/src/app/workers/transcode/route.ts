import { client, HEARTBEAT_MS, LEASE_EXTEND_SEC, worker } from "@/lib/enduroq";
import { DispatchPayload, JOB_ID_HEADER } from "@enduroq/enduroq-worker";
import { headers } from "next/headers";
import { after } from "next/server";

type TranscodeJobPayload = DispatchPayload<{
  permanent?: boolean;
}>;

export async function POST(req: Request) {
  const header = await headers();
  const jobId = Number(header.get(JOB_ID_HEADER) ?? "0");
  if (!jobId) {
    console.log(`jod is is undefined`);
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const payload = await req
    .json()
    .then((w) => w as unknown as TranscodeJobPayload);

  after(async () => {
    const ac = new AbortController();
    const job = await worker.acquire(jobId, payload, ac, {
      heartbeatIntervalMs: HEARTBEAT_MS,
      leaseExtendSeconds: LEASE_EXTEND_SEC,
    });

    try {
      if (payload.data.permanent) {
        await client.result(payload.callback, jobId, {
          token: payload.lease_token,
          status: "failure",
          retryable: false,
          error: "",
        });
      } else {
        await client.result(payload.callback, jobId, {
          token: payload.lease_token,
          status: "failure",
          retryable: true,
          error: "",
        });
      }
    } finally {
      job.stop();
    }
  });

  return Response.json({ ok: true }, { status: 200 });
}
