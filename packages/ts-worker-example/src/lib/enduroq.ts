import { CallbackClient, Worker } from "@enduroq/enduroq-worker";

// configurations
export const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 4000);
export const LEASE_EXTEND_SEC = Number(process.env.LEASE_EXTEND_SEC ?? 15);

// app
export const client = new CallbackClient(fetch);
export const worker = new Worker(client);
