import type { Config as WagmiConfig } from "wagmi";
import { getCapabilities } from "wagmi/actions";

/** Re-export the full capabilities map (chainId → capabilities). */
export type WalletCapabilities = Awaited<ReturnType<typeof getCapabilities>>;

/**
 * Fetch the wallet's EIP-5792 capabilities and extract batch-related helpers.
 *
 * Returns the full capabilities object so callers can inspect whatever they
 * need (paymaster support, auxiliary funds, etc.) in addition to batching.
 */
export async function getWalletBatchCapabilities(wagmiConfig: WagmiConfig) {
  try {
    const capabilities = await getCapabilities(wagmiConfig);
    const chainId = wagmiConfig.state.chainId;
    const chainCapabilities = chainId in capabilities
      ? capabilities[chainId as keyof typeof capabilities]
      : undefined;

    const atomicStatus = chainCapabilities && "atomic" in chainCapabilities
      ? (chainCapabilities as { atomic?: { status: "supported" | "ready" | "unsupported" } }).atomic?.status
      : undefined;
    const supportsAtomicBatch = atomicStatus === "supported" || atomicStatus === "ready";

    // If the wallet returned capabilities for this chain we treat it as
    // supporting batching in some form (even if only non-atomically).
    // Callers that need strict atomicity can use `supportsAtomicBatch`.
    const supportsBatch = chainCapabilities !== undefined;

    return {
      /** Raw capabilities map returned by the wallet. */
      capabilities,
      /** Capabilities filtered to the current chain. */
      chainCapabilities,
      /** True if the wallet supports *atomic* batching on this chain. */
      supportsAtomicBatch,
      /**
       * True if the wallet supports batching in any form on this chain.
       *
       * A chain being present in the capabilities map means the wallet
       * supports `sendCalls` there, even if it does not advertise the
       * `atomic` capability. Callers that need strict atomicity should
       * use `supportsAtomicBatch` or `walletSupportsSendCalls(config,
       * { requireAtomic: true })`.
       */
      supportsBatch,
    };
  } catch {
    return {
      capabilities: null,
      chainCapabilities: undefined,
      supportsAtomicBatch: false,
      supportsBatch: false,
    };
  }
}

/**
 * Quick boolean check for whether the wallet can use `sendCalls` (EIP-5792).
 *
 * @param requireAtomic - If `true`, only return `true` when the wallet
 *   explicitly advertises atomic batch support. Defaults to `false`, so
 *   any kind of batching counts.
 */
export async function walletSupportsSendCalls(
  wagmiConfig: WagmiConfig,
  options?: { requireAtomic?: boolean },
): Promise<boolean> {
  const { supportsAtomicBatch, supportsBatch } = await getWalletBatchCapabilities(wagmiConfig);
  return options?.requireAtomic ? supportsAtomicBatch : supportsBatch;
}
