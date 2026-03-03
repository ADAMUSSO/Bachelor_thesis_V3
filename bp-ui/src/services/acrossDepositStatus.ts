import type { Env } from "../catalog/types";

const BASE: Record<Env, string> = {
  mainnet: "https://app.across.to/api",
  testnet: "https://testnet.across.to/api",
};

type AnyRecord = Record<string, unknown>;

function asText(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function statusText(data: AnyRecord): string {
  return asText(data.status || data.depositStatus || data.currentStatus).toLowerCase();
}

function pickTxRef(data: AnyRecord): string | undefined {
  const refs = [
    data.fillTxHash,
    data.fillTxnRef,
    data.fillTx,
    data.relayTxHash,
    data.destinationTxHash,
  ];

  for (const ref of refs) {
    if (typeof ref === "string" && ref.startsWith("0x")) return ref;
  }

  return undefined;
}

export function isDepositFilled(data: AnyRecord): boolean {
  const status = statusText(data);
  if (status.includes("fill") || status.includes("complete") || status.includes("success")) {
    return true;
  }

  return !!pickTxRef(data);
}

export function isDepositFailed(data: AnyRecord): boolean {
  const status = statusText(data);
  return (
    status.includes("fail") ||
    status.includes("refund") ||
    status.includes("cancel") ||
    status.includes("expire") ||
    status.includes("error")
  );
}

export async function fetchDepositStatus(params: {
  env: Env;
  depositTxnRef: string;
}): Promise<AnyRecord | null> {
  const url = new URL(`${BASE[params.env]}/deposit/status`);
  url.searchParams.set("depositTxnRef", params.depositTxnRef);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (res.status === 404) return null;

  if (!res.ok) {
    throw new Error(`Across /deposit/status failed (${res.status}) ${await res.text().catch(() => "")}`);
  }

  return (await res.json()) as AnyRecord;
}

export async function waitForDepositFill(params: {
  env: Env;
  depositTxnRef: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onPoll?: (status: string) => void;
}): Promise<AnyRecord> {
  const timeoutMs = params.timeoutMs ?? 45 * 60 * 1000;
  const pollIntervalMs = params.pollIntervalMs ?? 15 * 1000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await fetchDepositStatus({
      env: params.env,
      depositTxnRef: params.depositTxnRef,
    });

    if (status) {
      const txt = statusText(status);
      if (params.onPoll) params.onPoll(txt || "pending");

      if (isDepositFilled(status)) return status;
      if (isDepositFailed(status)) {
        throw new Error(`Across deposit failed: ${txt || "unknown status"}`);
      }
    } else if (params.onPoll) {
      params.onPoll("pending");
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("Timed out while waiting for Across deposit fill on destination.");
}
