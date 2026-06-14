import { DispatchPayload, JOB_ID_HEADER } from "@enduroq/enduroq-worker";
import { headers } from "next/headers";

const sleep = async (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

type NotifyJobPayload = DispatchPayload<{
  message?: string;
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
    .then((w) => w as unknown as NotifyJobPayload);

  await sleep(300);
  console.log(
    `[worker] sync   job=${jobId} notify="${payload.data.message ?? ""}"`,
  );

  return Response.json({ status: "success" }, { status: 200 });
}
