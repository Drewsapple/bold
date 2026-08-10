import type { Config as WagmiConfig } from "wagmi";

import { beforeEach, describe, expect, test, vi } from "vitest";
import { getCapabilities } from "wagmi/actions";
import { getWalletBatchCapabilities, walletSupportsSendCalls } from "./sendCalls-utils";

vi.mock("wagmi/actions", () => ({
  getCapabilities: vi.fn(),
}));

const wagmiConfig = {
  state: { chainId: 1 },
} as WagmiConfig;

const mockGetCapabilities = vi.mocked(getCapabilities);

beforeEach(() => {
  mockGetCapabilities.mockReset();
});

describe("getWalletBatchCapabilities", () => {
  test.each(["supported", "ready"] as const)(
    "recognizes atomic status %s",
    async (status) => {
      const capabilities = { 1: { atomic: { status } } };
      mockGetCapabilities.mockResolvedValue(capabilities as never);

      await expect(getWalletBatchCapabilities(wagmiConfig)).resolves.toEqual({
        capabilities,
        chainCapabilities: capabilities[1],
        supportsAtomicBatch: true,
        supportsBatch: true,
      });
    },
  );

  test("allows non-atomic batching when the wallet returns chain capabilities", async () => {
    mockGetCapabilities.mockResolvedValue({ 1: { paymasterService: {} } } as never);

    await expect(walletSupportsSendCalls(wagmiConfig)).resolves.toBe(true);
    await expect(
      walletSupportsSendCalls(wagmiConfig, { requireAtomic: true }),
    ).resolves.toBe(false);
  });

  test("does not use capabilities returned for a different chain", async () => {
    mockGetCapabilities.mockResolvedValue({ 2: { atomic: { status: "supported" } } } as never);

    await expect(getWalletBatchCapabilities(wagmiConfig)).resolves.toMatchObject({
      chainCapabilities: undefined,
      supportsAtomicBatch: false,
      supportsBatch: false,
    });
  });

  test("falls back when the wallet does not implement getCapabilities", async () => {
    mockGetCapabilities.mockRejectedValue(new Error("Unsupported method"));

    await expect(getWalletBatchCapabilities(wagmiConfig)).resolves.toEqual({
      capabilities: null,
      chainCapabilities: undefined,
      supportsAtomicBatch: false,
      supportsBatch: false,
    });
  });
});
