import type { FlowDeclaration, FlowParams } from "@/src/services/TransactionFlow";
import type { Address } from "@/src/types";

import { Governance } from "@/src/abi/Governance";
import { Amount } from "@/src/comps/Amount/Amount";
import { LEGACY_CHECK } from "@/src/env";
import { TransactionDetailsRow } from "@/src/screens/TransactionsScreen/TransactionsScreen";
import { TransactionStatus } from "@/src/screens/TransactionsScreen/TransactionStatus";
import { usePrice } from "@/src/services/Prices";
import { getWalletBatchCapabilities } from "@/src/sendCalls-utils";
import { vAddress, vDnum } from "@/src/valibot-utils";
import * as dn from "dnum";
import * as v from "valibot";
import { sendCalls } from "wagmi/actions";
import { readContracts } from "wagmi/actions";
import { createRequestSchema, verifyCallsBatch, verifyTransaction } from "./shared";

const RequestSchema = createRequestSchema(
  "legacyUnstakeAll",
  {
    lqtyAmount: vDnum(),
  },
);

export type LegacyUnstakeAllRequest = v.InferOutput<typeof RequestSchema>;

async function getLegacyUnstakeContext(ctx: FlowParams<LegacyUnstakeAllRequest>) {
  if (!LEGACY_CHECK) {
    throw new Error("LEGACY_CHECK is not defined");
  }

  const initiativesFromSnapshotResult = await fetch(LEGACY_CHECK.INITIATIVES_SNAPSHOT_URL).catch((err) => {
    console.error("Error fetching initiatives from snapshot.");
    console.error("LEGACY_CHECK.INITIATIVES_SNAPSHOT_URL:", LEGACY_CHECK?.INITIATIVES_SNAPSHOT_URL);
    throw err;
  });

  const initiativesFromSnapshot = v.parse(
    v.array(vAddress()),
    await initiativesFromSnapshotResult.json(),
  );

  const lqtyAllocatedByUser = await readContracts(ctx.wagmiConfig, {
    contracts: initiativesFromSnapshot.map((initiative) => {
      if (!LEGACY_CHECK) {
        throw new Error("LEGACY_CHECK is not defined");
      }
      return {
        abi: Governance,
        address: LEGACY_CHECK.GOVERNANCE,
        functionName: "lqtyAllocatedByUserToInitiative",
        args: [ctx.account, initiative],
      } as const;
    }),
    allowFailure: false,
  });

  const allocatedInitiatives = lqtyAllocatedByUser
    .map((allocation, index) => {
      const [voteLQTY, _, vetoLQTY] = allocation;
      const initiative = initiativesFromSnapshot[index];
      if (!initiative) {
        throw new Error("initiative missing");
      }
      return voteLQTY > 0n || vetoLQTY > 0n ? initiative : null;
    })
    .filter((initiative): initiative is Address => initiative !== null);

  return { allocatedInitiatives };
}

function buildResetVotesCall(allocatedInitiatives: Address[]) {
  if (!LEGACY_CHECK) {
    throw new Error("LEGACY_CHECK is not defined");
  }
  return {
    abi: Governance,
    address: LEGACY_CHECK.GOVERNANCE,
    functionName: "resetAllocations" as const,
    args: [allocatedInitiatives, true] as const,
  };
}

function buildWithdrawCall(lqtyAmount: bigint) {
  if (!LEGACY_CHECK) {
    throw new Error("LEGACY_CHECK is not defined");
  }
  return {
    abi: Governance,
    address: LEGACY_CHECK.GOVERNANCE,
    functionName: "withdrawLQTY" as const,
    args: [lqtyAmount] as const,
  };
}

export const legacyUnstakeAll: FlowDeclaration<LegacyUnstakeAllRequest> = {
  title: "Withdraw from Legacy Stake",
  Summary: null,

  Details({ request }) {
    const lqtyPrice = usePrice("LQTY");
    return (
      <TransactionDetailsRow
        label="You withdraw"
        value={[
          <Amount
            key="start"
            suffix=" LQTY"
            value={request.lqtyAmount}
          />,
          <Amount
            key="end"
            prefix="$"
            value={lqtyPrice.data && dn.mul(request.lqtyAmount, lqtyPrice.data)}
          />,
        ]}
      />
    );
  },

  steps: {
    batchUnstake: {
      name: () => "Unstake",
      Status: TransactionStatus,
      async commit(ctx) {
        const { allocatedInitiatives } = await getLegacyUnstakeContext(ctx);

        const calls: ReturnType<typeof buildResetVotesCall | typeof buildWithdrawCall>[] = [];

        if (allocatedInitiatives.length > 0) {
          calls.push(buildResetVotesCall(allocatedInitiatives));
        }

        calls.push(buildWithdrawCall(ctx.request.lqtyAmount[0]));

        return (await sendCalls(ctx.wagmiConfig, {
          account: ctx.account,
          calls: calls.map((call) => ({ ...call, to: call.address })),
        })).id;
      },
      async verify(ctx, hash) {
        await verifyCallsBatch(ctx.wagmiConfig, hash);
      },
    },

    resetVotes: {
      name: () => "Reset votes",
      Status: TransactionStatus,
      async commit(ctx) {
        const { allocatedInitiatives } = await getLegacyUnstakeContext(ctx);

        if (allocatedInitiatives.length === 0) {
          throw new Error("No voting allocations to reset.");
        }

        return ctx.writeContract(buildResetVotesCall(allocatedInitiatives));
      },
      async verify(ctx, hash) {
        await verifyTransaction(ctx.wagmiConfig, hash, ctx.isSafe);
      },
    },

    withdraw: {
      name: () => "Withdraw",
      Status: TransactionStatus,
      async commit(ctx) {
        return ctx.writeContract(buildWithdrawCall(ctx.request.lqtyAmount[0]));
      },
      async verify(ctx, hash) {
        await verifyTransaction(ctx.wagmiConfig, hash, ctx.isSafe);
      },
    },
  },

  async getSteps(ctx) {
    const caps = await getWalletBatchCapabilities(ctx.wagmiConfig);

    if (caps.supportsBatch) {
      return ["batchUnstake"];
    }

    const { allocatedInitiatives } = await getLegacyUnstakeContext(ctx);

    const steps: string[] = [];
    if (allocatedInitiatives.length > 0) {
      steps.push("resetVotes");
    }
    steps.push("withdraw");
    return steps;
  },

  parseRequest(request) {
    return v.parse(RequestSchema, request);
  },
};
