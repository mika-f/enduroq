import { cancelJob, getJob } from "@/lib/enduroq";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const parseId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export async function GET(_req: Request, { params }: Context) {
  const { id } = await params;
  const jobId = parseId(id);
  if (jobId === null) {
    return Response.json({ error: "invalid job id" }, { status: 400 });
  }

  const { status, body } = await getJob(jobId);
  return Response.json(body, { status });
}

export async function DELETE(_req: Request, { params }: Context) {
  const { id } = await params;
  const jobId = parseId(id);
  if (jobId === null) {
    return Response.json({ error: "invalid job id" }, { status: 400 });
  }

  const { status, body } = await cancelJob(jobId);
  return Response.json(body, { status });
}
