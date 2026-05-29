import type { FlowDeclaration } from "@/src/services/TransactionFlow";

import { LeverageLSTZapper } from "@/src/abi/LeverageLSTZapper";
import { LeverageWETHZapper } from "@/src/abi/LeverageWETHZapper";
import { Amount } from "@/src/comps/Amount/Amount";
import { ETH_GAS_COMPENSATION } from "@/src/constants";
import { LEGACY_CHECK } from "@/src/env";
import { fmtnum } from "@/src/formatting";
import { TransactionDetailsRow } from "@/src/screens/TransactionsScreen/TransactionsScreen";
import { TransactionStatus } from "@/src/screens/TransactionsScreen/TransactionStatus";
import { usePrice } from "@/src/services/Prices";
import { vBranchId, vDnum, vTroveId } from "@/src/valibot-utils";
import * as dn from "dnum";
import * as v from "valibot";
import { erc20Abi, maxUint256 } from "viem";
import { sendCalls } from "wagmi/actions";
import { getWalletBatchCapabilities } from "@/src/sendCalls-utils";
import { createRequestSchema, verifyCallsBatch, verifyTransaction } from "./shared";

const RequestSchema = createRequestSchema(
  "legacyCloseLoanPosition",
  {
    trove: v.object({
      branchId: vBranchId(),
      troveId: vTroveId(),
      deposit: vDnum(),
      borrowed: vDnum(),
    }),
  },
);

export type LegacyCloseLoanPositionRequest = v.InferOutput<typeof RequestSchema>;

function getLegacyBranch(branchId: number) {
  const branch = LEGACY_CHECK?.BRANCHES[branchId];
  if (!branch) {
    throw new Error(`Invalid branch ID: ${branchId}`);
  }
  return branch;
}

export const legacyCloseLoanPosition: FlowDeclaration<LegacyCloseLoanPositionRequest> = {
  title: "Close Legacy Loan Position",
  Summary: null,

  Details({ request }) {
    const { trove } = request;
    const branch = getLegacyBranch(trove.branchId);
    const collPrice = usePrice(branch.symbol);

    if (!collPrice.data) {
      return null;
    }

    return (
      <>
        {dn.gt(trove.borrowed, 0) && (
          <TransactionDetailsRow
            label="You repay"
            value={[
              <Amount
                key="start"
                value={trove.borrowed}
                suffix=" BOLD"
              />,
            ]}
          />
        )}
        <TransactionDetailsRow
          label="You reclaim the collateral"
          value={[
            <Amount
              key="start"
              value={trove.deposit}
              suffix={` ${branch.symbol}`}
            />,
          ]}
        />
        <TransactionDetailsRow
          label="You reclaim the gas compensation deposit"
          value={[
            <div
              key="start"
              title={`${fmtnum(ETH_GAS_COMPENSATION, "full")} ETH`}
            >
              {fmtnum(ETH_GAS_COMPENSATION, 4)} ETH
            </div>,
          ]}
        />
      </>
    );
  },

  steps: {
    approveBold: {
      name: () => "Approve BOLD",
      Status: (props) => (
        <TransactionStatus
          {...props}
          approval="approve-only"
        />
      ),
      async commit(ctx) {
        return ctx.writeContract(buildApproveBoldCall(
          ctx.request,
          ctx.preferredApproveMethod,
        ));
      },
      async verify(ctx, hash) {
        await verifyTransaction(ctx.wagmiConfig, hash, ctx.isSafe);
      },
    },

    // Close a loan position, repaying with BOLD or with the collateral
    closeLoanPosition: {
      name: () => "Close loan",
      Status: TransactionStatus,

      async commit(ctx) {
        return ctx.writeContract(buildCloseTroveCall(ctx.request));
      },

      async verify(ctx, hash) {
        await verifyTransaction(ctx.wagmiConfig, hash, ctx.isSafe);
      },
    },

    batchApproveAndClose: {
      name: () => "Close loan",
      Status: TransactionStatus,

      async commit(ctx) {
        const calls = [
          buildApproveBoldCall(ctx.request, ctx.preferredApproveMethod),
          buildCloseTroveCall(ctx.request),
        ];

        return (await sendCalls(ctx.wagmiConfig, {
          account: ctx.account,
          calls: calls.map((call) => ({ ...call, to: call.address })),
        })).id;
      },

      async verify(ctx, hash) {
        await verifyCallsBatch(ctx.wagmiConfig, hash);
      },
    },
  },

  async getSteps(ctx) {
    const { trove } = ctx.request;
    const branch = getLegacyBranch(trove.branchId);

    if (!LEGACY_CHECK?.BOLD_TOKEN) {
      throw new Error("BOLD token address not available");
    }

    const caps = await getWalletBatchCapabilities(ctx.wagmiConfig);
    if (caps.supportsBatch) {
      ctx.preferredApproveMethod = "approve-amount";
      return ["batchApproveAndClose"];
    }

    const isBoldApproved = !dn.gt(trove.borrowed, [
      (await ctx.readContract({
        abi: erc20Abi,
        address: LEGACY_CHECK.BOLD_TOKEN,
        functionName: "allowance",
        args: [ctx.account, branch.LEVERAGE_ZAPPER],
      })) ?? 0n,
      18,
    ]);

    const steps: string[] = [];

    if (!isBoldApproved) {
      steps.push("approveBold");
    }

    steps.push("closeLoanPosition");

    return steps;
  },

  parseRequest(request) {
    return v.parse(RequestSchema, request);
  },
};

function buildApproveBoldCall(
  request: LegacyCloseLoanPositionRequest,
  preferredApproveMethod: "permit" | "approve-amount" | "approve-infinite",
) {
  const { trove } = request;
  const { LEVERAGE_ZAPPER } = getLegacyBranch(trove.branchId);

  if (!LEGACY_CHECK?.BOLD_TOKEN) {
    throw new Error("BOLD token address not available");
  }

  return {
    abi: erc20Abi,
    address: LEGACY_CHECK.BOLD_TOKEN,
    functionName: "approve" as const,
    args: [
      LEVERAGE_ZAPPER,
      preferredApproveMethod === "approve-infinite"
        ? maxUint256 // infinite approval
        : dn.mul(trove.borrowed, 1.1)[0], // exact amount (TODO: better estimate)
    ] as const,
  };
}

function buildCloseTroveCall(request: LegacyCloseLoanPositionRequest) {
  const { trove } = request;
  const branch = getLegacyBranch(trove.branchId);
  const { LEVERAGE_ZAPPER } = branch;

  return {
    abi: branch.symbol === "ETH" ? LeverageWETHZapper : LeverageLSTZapper,
    address: LEVERAGE_ZAPPER,
    functionName: "closeTroveToRawETH" as const,
    args: [BigInt(trove.troveId)] as const,
  };
}
