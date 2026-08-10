import type { Config as WagmiConfig } from "wagmi";

import { beforeEach, describe, expect, test, vi } from "vitest";
import { waitForCallsStatus } from "wagmi/actions";
import { getCallBatchLogs, verifyCallsBatch } from "./shared";

vi.mock("wagmi/actions", () => ({
  waitForCallsStatus: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));

vi.mock("@/src/indicators/subgraph-indicator", () => ({
  subgraphIndicator: { hasError: () => true },
}));

vi.mock("@/src/safe-utils", () => ({
  waitForSafeTransaction: vi.fn(),
}));

vi.mock("@/src/subgraph", () => ({
  getIndexedBlockNumber: vi.fn(),
}));

vi.mock("@/src/utils", () => ({
  sleep: vi.fn(),
}));

const wagmiConfig = {} as WagmiConfig;
const mockWaitForCallsStatus = vi.mocked(waitForCallsStatus);

beforeEach(() => {
  mockWaitForCallsStatus.mockReset();
});

describe("verifyCallsBatch", () => {
  test("returns successful batch receipts", async () => {
    const receipts = [{ blockNumber: 10n, logs: [] }];
    mockWaitForCallsStatus.mockResolvedValue({
      status: "success",
      receipts,
    } as never);

    await expect(
      verifyCallsBatch(wagmiConfig, "calls-id", false),
    ).resolves.toBe(receipts);
    expect(mockWaitForCallsStatus).toHaveBeenCalledWith(wagmiConfig, {
      id: "calls-id",
    });
  });

  test.each([
    { status: "failure", receipts: [] },
    { status: "success", receipts: undefined },
  ])("rejects an unsuccessful or incomplete batch: $status", async (result) => {
    mockWaitForCallsStatus.mockResolvedValue(result as never);

    await expect(
      verifyCallsBatch(wagmiConfig, "calls-id", false),
    ).rejects.toThrow("Transaction failed");
  });
});

test("getCallBatchLogs flattens logs from every receipt in call order", () => {
  const first = {
    address: "0x0000000000000000000000000000000000000001" as const,
    data: "0x01" as const,
    topics: ["0xaa" as const],
  };
  const second = {
    address: "0x0000000000000000000000000000000000000002" as const,
    data: "0x02" as const,
    topics: ["0xbb" as const],
  };

  expect(getCallBatchLogs([
    { logs: [first] },
    { logs: [] },
    { logs: [second] },
  ])).toEqual([first, second]);
});
