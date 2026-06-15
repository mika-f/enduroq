import { listJobs } from "@/lib/enduroq";
import { JOB_STATUSES, type JobStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);

  const queue = url.searchParams.get("queue") ?? undefined;

  const rawStatus = url.searchParams.get("status") ?? undefined;
  if (rawStatus && !JOB_STATUSES.includes(rawStatus as JobStatus)) {
    return Response.json({ error: "invalid status" }, { status: 400 });
  }

  const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
  const offset = url.searchParams.has("offset")
    ? Number(url.searchParams.get("offset"))
    : undefined;

  const { status, body } = await listJobs({
    queue,
    status: rawStatus as JobStatus | undefined,
    limit,
    offset,
  });

  return Response.json(body, { status });
}
