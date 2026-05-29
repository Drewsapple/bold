import type { FlowDeclaration } from "@/src/services/TransactionFlow";

import { Amount } from "@/src/comps/Amount/Amount";
import { ETH_GAS_COMPENSATION } from "@/src/constants";
import type { Contracts } from "@/src/contracts";
import { fmtnum } from "@/src/formatting";
import { subgraphIndicator } from "@/src/indicators/subgraph-indicator";
import { getBranch, getCollToken } from "@/src/liquity-utils";
import { LoanCard } from "@/src/screens/TransactionsScreen/LoanCard";
import { TransactionDetailsRow } from "@/src/screens/TransactionsScreen/TransactionsScreen";
import { TransactionStatus } from "@/src/screens/TransactionsScreen/TransactionStatus";
import { getIndexedTroveById } from "@/src/subgraph";
import { sleep } from "@/src/utils";
import { vDnum, vPositionLoanCommited } from "@/src/valibot-utils";
import { css } from "@/styled-system/css";
import { InfoTooltip } from "@liquity2/uikit";
import * as dn from "dnum";
import * as v from "valibot";
import { maxUint256 } from "viem";
import { readContract, readContracts, sendCalls } from "wagmi/actions";
import { getWalletBatchCapabilities } from "@/src/sendCalls-utils";
import { useSlippageRefund } from "../liquity-leverage";
import { createRequestSchema, verifyCallsBatch, verifyTransaction } from "./shared";

const RequestSchema = createRequestSchema(
  "closeLoanPosition",
  {
    loan: vPositionLoanCommited(),
    repayWithCollateral: v.optional(
      v.object({
        flashLoanAmount: vDnum(),
      }),
    ),
  },
);

export type CloseLoanPositionRequest = v.InferOutput<typeof RequestSchema>;

export const closeLoanPosition: FlowDeclaration<CloseLoanPositionRequest> = {
  title: "Review & Send Transaction",

  Summary({ request }) {
    return (
      <LoanCard
        leverageMode={false}
        loadingState="success"
        loan={null}
        prevLoan={request.loan}
        onRetry={() => {}}
        txPreviewMode
        displayAllDifferences={false}
      />
    );
  },

  Details({ request, account, steps }) {
    const { loan, repayWithCollateral } = request;
    const collateral = getCollToken(loan.branchId);
    const slippageRefund = useSlippageRefund(loan.branchId, account, steps, !!repayWithCollateral);

    const amountToRepay = repayWithCollateral
      ? repayWithCollateral.flashLoanAmount
      : loan.borrowed;

    const collToReclaim = repayWithCollateral
      ? dn.sub(loan.deposit, amountToRepay)
      : loan.deposit;

    return (
      <>
        {dn.gt(amountToRepay, 0) && (
          <TransactionDetailsRow
            label={repayWithCollateral ? "You repay from your loan" : "You repay"}
            value={[
              <Amount
                key="start"
                value={amountToRepay}
                suffix={` ${repayWithCollateral ? collateral.name : "BOLD"}`}
              />,
            ]}
          />
        )}
        <TransactionDetailsRow
          label="You reclaim"
          value={[
            <Amount
              key="start"
              value={collToReclaim}
              suffix={` ${collateral.name}`}
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
        {slippageRefund.data && (
          <TransactionDetailsRow
            label={
              <div
                className={css({
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                })}
              >
                Slippage refund
                <InfoTooltip heading="Slippage refund">
                  Excess BOLD was acquired to repay your debt and accommodate for slippage. This is the left over amount
                  that has been refunded to your wallet.
                </InfoTooltip>
              </div>
            }
            value={[
              <Amount
                key="start"
                value={slippageRefund.data}
                suffix=" BOLD"
                format="2z"
              />,
            ]}
          />
        )}
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
        const { loan } = ctx.request;
        const branch = getBranch(loan.branchId);
        const { entireDebt } = await readContract(ctx.wagmiConfig, {
          ...branch.contracts.TroveManager,
          functionName: "getLatestTroveData",
          args: [BigInt(loan.troveId)],
        });

        return ctx.writeContract(buildApproveBoldCall(
          ctx.request,
          ctx.contracts,
          ctx.preferredApproveMethod,
          entireDebt,
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

        const subgraphIsDown = subgraphIndicator.hasError();
        if (!subgraphIsDown) {
          // wait for the trove to be seen as closed in the subgraph
          while (true) {
            const trove = await getIndexedTroveById(
              ctx.request.loan.branchId,
              ctx.request.loan.troveId,
            );
            if (trove?.status === "closed") break;
            await sleep(1000);
          }
        }
      },
    },

    batchApproveAndClose: {
      name: () => "Close loan",
      Status: TransactionStatus,

      async commit(ctx) {
        const { loan } = ctx.request;
        const branch = getBranch(loan.branchId);

        const { entireDebt } = await readContract(ctx.wagmiConfig, {
          ...branch.contracts.TroveManager,
          functionName: "getLatestTroveData",
          args: [BigInt(loan.troveId)],
        });

        const calls = [
          buildApproveBoldCall(ctx.request, ctx.contracts, ctx.preferredApproveMethod, entireDebt),
          buildCloseTroveCall(ctx.request),
        ];

        return (await sendCalls(ctx.wagmiConfig, {
          account: ctx.account,
          calls: calls.map((call) => ({ ...call, to: call.address })),
        })).id;
      },

      async verify(ctx, hash) {
        await verifyCallsBatch(ctx.wagmiConfig, hash);

        const subgraphIsDown = subgraphIndicator.hasError();
        if (!subgraphIsDown) {
          while (true) {
            const trove = await getIndexedTroveById(
              ctx.request.loan.branchId,
              ctx.request.loan.troveId,
            );
            if (trove?.status === "closed") break;
            await sleep(1000);
          }
        }
      },
    },
  },

  async getSteps(ctx) {
    const { loan, repayWithCollateral } = ctx.request;
    const branch = getBranch(loan.branchId);

    const Zapper = branch.symbol === "ETH"
      ? branch.contracts.LeverageWETHZapper
      : branch.contracts.LeverageLSTZapper;

    const [{ entireDebt }, boldAllowance] = await readContracts(ctx.wagmiConfig, {
      contracts: [{
        ...branch.contracts.TroveManager,
        functionName: "getLatestTroveData",
        args: [BigInt(loan.troveId)],
      }, {
        ...ctx.contracts.BoldToken,
        functionName: "allowance",
        args: [ctx.account, Zapper.address],
      }],
      allowFailure: false,
    });

    const isBoldApproved = repayWithCollateral || (entireDebt <= boldAllowance);

    const steps: string[] = [];

    const caps = await getWalletBatchCapabilities(ctx.wagmiConfig);
    if (caps.supportsBatch && !repayWithCollateral) {
      ctx.preferredApproveMethod = "approve-amount";
      return ["batchApproveAndClose"];
    }

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
  request: CloseLoanPositionRequest,
  contracts: Contracts,
  preferredApproveMethod: "permit" | "approve-amount" | "approve-infinite",
  entireDebt: bigint,
) {
  const branch = getBranch(request.loan.branchId);
  const Zapper = branch.symbol === "ETH"
    ? branch.contracts.LeverageWETHZapper
    : branch.contracts.LeverageLSTZapper;

  return {
    ...contracts.BoldToken,
    functionName: "approve" as const,
    args: [
      Zapper.address,
      preferredApproveMethod === "approve-infinite"
        ? maxUint256 // infinite approval
        : dn.mul([entireDebt, 18], 1.1)[0], // exact amount (TODO: better estimate)
    ] as const,
  };
}

function buildCloseTroveCall(request: CloseLoanPositionRequest) {
  const { loan, repayWithCollateral } = request;
  const deposit = dn.from(loan.deposit, 18)[0];
  const branch = getBranch(loan.branchId);

  if (!repayWithCollateral) {
    const Zapper = branch.symbol === "ETH"
      ? branch.contracts.LeverageWETHZapper
      : branch.contracts.LeverageLSTZapper;

    return {
      ...Zapper,
      functionName: "closeTroveToRawETH" as const,
      args: [BigInt(loan.troveId)] as const,
    };
  }

  const closeFlashLoanAmount = dn.from(repayWithCollateral.flashLoanAmount, 18)[0];

  if (branch.symbol === "ETH") {
    return {
      ...branch.contracts.LeverageWETHZapper,
      functionName: "closeTroveFromCollateral" as const,
      args: [BigInt(loan.troveId), closeFlashLoanAmount, deposit - closeFlashLoanAmount] as const,
    };
  }

  return {
    ...branch.contracts.LeverageLSTZapper,
    functionName: "closeTroveFromCollateral" as const,
    args: [BigInt(loan.troveId), closeFlashLoanAmount, deposit - closeFlashLoanAmount] as const,
  };
}
