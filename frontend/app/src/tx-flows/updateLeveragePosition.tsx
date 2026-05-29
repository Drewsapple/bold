import type { LoadingState } from "@/src/screens/TransactionsScreen/TransactionsScreen";
import type { FlowDeclaration } from "@/src/services/TransactionFlow";

import { Amount } from "@/src/comps/Amount/Amount";
import { MAX_UPFRONT_FEE } from "@/src/constants";
import { dnum18, DNUM_0 } from "@/src/dnum-utils";
import { fmtnum } from "@/src/formatting";
import { useSlippageRefund } from "@/src/liquity-leverage";
import { getBranch, getCollToken, usePredictAdjustTroveUpfrontFee } from "@/src/liquity-utils";
import { LoanCard } from "@/src/screens/TransactionsScreen/LoanCard";
import { TransactionDetailsRow } from "@/src/screens/TransactionsScreen/TransactionsScreen";
import { TransactionStatus } from "@/src/screens/TransactionsScreen/TransactionStatus";
import { usePrice } from "@/src/services/Prices";
import { vDnum, vPositionLoanCommited } from "@/src/valibot-utils";
import { css } from "@/styled-system/css";
import { ADDRESS_ZERO, InfoTooltip } from "@liquity2/uikit";
import * as dn from "dnum";
import { match, P } from "ts-pattern";
import * as v from "valibot";
import { maxUint256 } from "viem";
import { sendCalls } from "wagmi/actions";
import { getWalletBatchCapabilities } from "@/src/sendCalls-utils";
import type { BranchId, TroveId } from "../types";
import { createRequestSchema, verifyCallsBatch, verifyTransaction } from "./shared";

const RequestSchema = createRequestSchema(
  "updateLeveragePosition",
  {
    loan: vPositionLoanCommited(),
    prevLoan: vPositionLoanCommited(),
    depositChange: v.nullable(vDnum()),
    debtChange: v.nullable(vDnum()),
    leverageFactorChange: v.tuple([v.nullable(v.number()), v.number()]),

    leverage: v.nullable(
      v.union([
        v.object({
          direction: v.literal("up"),
          flashloanAmount: vDnum(),
          boldAmount: vDnum(),
        }),
        v.object({
          direction: v.literal("down"),
          flashloanAmount: vDnum(),
          minBoldAmount: vDnum(),
        }),
      ]),
    ),
  },
);

export type UpdateLeveragePositionRequest = v.InferOutput<typeof RequestSchema>;

function useUpfrontFeeData(
  branchId: BranchId,
  troveId: TroveId,
  debtChange: dn.Dnum | null,
) {
  const isBorrowing = debtChange && dn.gt(debtChange, DNUM_0);

  const upfrontFee = usePredictAdjustTroveUpfrontFee(
    branchId,
    troveId,
    isBorrowing ? debtChange : DNUM_0,
  );

  return {
    ...upfrontFee,
    data: !upfrontFee.data ? null : {
      debtChangeWithFee: isBorrowing
        ? dn.add(debtChange, upfrontFee.data)
        : debtChange,
      upfrontFee: upfrontFee.data,
    },
  };
}

export const updateLeveragePosition: FlowDeclaration<UpdateLeveragePositionRequest> = {
  title: "Review & Send Transaction",

  Summary({ request }) {
    const { debtChange, loan, prevLoan } = request;

    const upfrontFeeData = useUpfrontFeeData(loan.branchId, loan.troveId, debtChange);
    const loadingState = match(upfrontFeeData)
      .returnType<LoadingState>()
      .with({ status: "error" }, () => "error")
      .with({ status: "pending" }, () => "loading")
      .with({ data: null }, () => "not-found")
      .with({ data: P.nonNullable }, () => "success")
      .otherwise(() => "error");

    const borrowedWithFee = dn.add(
      loan.borrowed,
      upfrontFeeData.data?.upfrontFee ?? dn.from(0, 18),
    );

    return (
      <LoanCard
        leverageMode={true}
        loadingState={loadingState}
        loan={{ ...loan, borrowed: borrowedWithFee }}
        prevLoan={prevLoan}
        onRetry={() => {
          upfrontFeeData.refetch();
        }}
        txPreviewMode
        displayAllDifferences={false}
      />
    );
  },

  Details({ request, account, steps }) {
    const { loan, depositChange, debtChange, leverageFactorChange } = request;

    const branch = getBranch(loan.branchId);
    const collateral = getCollToken(branch.id);

    const collPrice = usePrice(collateral.symbol);
    const upfrontFeeData = useUpfrontFeeData(loan.branchId, loan.troveId, debtChange);
    const slippageRefund = useSlippageRefund(loan.branchId, account, steps);

    const debtChangeWithFee = upfrontFeeData.data?.debtChangeWithFee;

    return (
      <>
        {depositChange !== null && (
          <TransactionDetailsRow
            label="Deposit change"
            value={[
              <Amount
                key="start"
                fallback="…"
                value={depositChange}
                suffix={` ${collateral.name}`}
                format="2diff"
              />,
              <Amount
                key="end"
                fallback="…"
                value={collPrice.data && dn.mul(dn.abs(depositChange), collPrice.data)}
                prefix="$"
              />,
            ]}
          />
        )}
        <TransactionDetailsRow
          label="Multiply change"
          value={[
            <div key="start">
              {leverageFactorChange[0]
                ? (
                  <>
                    {fmtnum(leverageFactorChange[1] - (leverageFactorChange[0]), {
                      digits: 1,
                      signDisplay: "exceptZero",
                    })}x
                  </>
                )
                : <>N/A</>}
            </div>,
            <div key="end">
              {fmtnum(leverageFactorChange[1], 1)}x
            </div>,
          ]}
        />
        <TransactionDetailsRow
          label="Debt change"
          value={[
            <Amount
              key="start"
              fallback="…"
              value={debtChangeWithFee}
              format="2diff"
              suffix=" BOLD"
            />,
            upfrontFeeData.data?.upfrontFee
            && dn.gt(upfrontFeeData.data.upfrontFee, 0)
            && (
              <div
                key="end"
                className={css({
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                })}
              >
                <Amount
                  fallback="…"
                  prefix="Incl. "
                  value={upfrontFeeData.data.upfrontFee}
                  suffix=" BOLD creation fee"
                />
                <InfoTooltip heading="BOLD creation fee">
                  This fee is charged when you open a new loan or increase your debt. It corresponds to 7 days of
                  average interest for the respective collateral asset.
                </InfoTooltip>
              </div>
            ),
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
                  Excess collateral was needed to create the desired exposure and accommodate for slippage. This is the
                  left over amount that has been refunded to your wallet.
                </InfoTooltip>
              </div>
            }
            value={[
              <Amount
                key="start"
                value={slippageRefund.data}
                suffix={` ${collateral.name === "ETH" ? "WETH" : collateral.name}`}
                format="4z"
              />,
              collPrice.data && (
                <Amount
                  key="end"
                  fallback="…"
                  value={dn.mul(slippageRefund.data, collPrice.data)}
                  prefix="$"
                />
              ),
            ]}
          />
        )}
      </>
    );
  },

  steps: {
    approveLst: {
      name: ({ request }) => {
        const token = getCollToken(request.loan.branchId);
        return `Approve ${token?.name ?? ""}`;
      },
      Status: (props) => (
        <TransactionStatus
          {...props}
          approval="approve-only"
        />
      ),
      async commit(ctx) {
        return ctx.writeContract(await buildApproveLstCall(
          ctx.request,
          ctx.preferredApproveMethod,
        ));
      },
      async verify(ctx, hash) {
        await verifyTransaction(ctx.wagmiConfig, hash, ctx.isSafe);
      },
    },

    increaseDeposit: {
      name: () => "Deposit",
      Status: TransactionStatus,

      async commit(ctx) {
        return ctx.writeContract(await buildDepositCall(ctx.request));
      },

      async verify(ctx, hash) {
        await verifyTransaction(ctx.wagmiConfig, hash, ctx.isSafe);
      },
    },

    decreaseDeposit: {
      name: () => "Withdraw",
      Status: TransactionStatus,

      async commit(ctx) {
        return ctx.writeContract(await buildWithdrawCall(ctx.request));
      },

      async verify(ctx, hash) {
        await verifyTransaction(ctx.wagmiConfig, hash, ctx.isSafe);
      },
    },

    leverUpTrove: {
      name: () => "Multiply",
      Status: TransactionStatus,

      async commit(ctx) {
        return ctx.writeContract(await buildLeverUpCall(ctx.request));
      },

      async verify(ctx, hash) {
        await verifyTransaction(ctx.wagmiConfig, hash, ctx.isSafe);
      },
    },

    leverDownTrove: {
      name: () => "Multiply",
      Status: TransactionStatus,

      async commit(ctx) {
        return ctx.writeContract(await buildLeverDownCall(ctx.request));
      },

      async verify(ctx, hash) {
        await verifyTransaction(ctx.wagmiConfig, hash, ctx.isSafe);
      },
    },

    batchUpdateLeverage: {
      name: ({ request }) => {
        if (request.leverage) return "Multiply";
        if (request.depositChange && dn.gt(request.depositChange, 0)) return "Deposit";
        if (request.depositChange && dn.lt(request.depositChange, 0)) return "Withdraw";
        return "Update Position";
      },
      Status: TransactionStatus,

      async commit({ request, preferredApproveMethod, account, wagmiConfig, readContract }) {
        const { depositChange, leverage, loan } = request;
        const branch = getBranch(loan.branchId);

        const calls: ReturnType<
          | typeof buildApproveLstCall
          | typeof buildDepositCall
          | typeof buildWithdrawCall
          | typeof buildLeverUpCall
          | typeof buildLeverDownCall
        >[] = [];

        // approval for non-ETH collateral deposits
        if (branch.symbol !== "ETH" && depositChange && dn.gt(depositChange, 0)) {
          const { LeverageLSTZapper, CollToken } = branch.contracts;
          const allowance = dnum18(
            await readContract({
              ...CollToken,
              functionName: "allowance",
              args: [account ?? ADDRESS_ZERO, LeverageLSTZapper.address],
            }),
          );

          if (dn.lt(allowance, depositChange)) {
            calls.push(buildApproveLstCall(request, preferredApproveMethod));
          }
        }

        if (leverage?.direction === "down") {
          calls.push(buildLeverDownCall(request));
        }

        if (depositChange) {
          if (dn.gt(depositChange, 0)) {
            calls.push(buildDepositCall(request));
          } else {
            calls.push(buildWithdrawCall(request));
          }
        }

        if (leverage?.direction === "up") {
          calls.push(buildLeverUpCall(request));
        }

        return (await sendCalls(wagmiConfig, {
          account,
          calls: calls.map((call) => ({ ...call, to: call.address })),
        })).id;
      },

      async verify(ctx, hash) {
        await verifyCallsBatch(ctx.wagmiConfig, hash);
      },
    },
  },

  async getSteps(ctx) {
    const caps = await getWalletBatchCapabilities(ctx.wagmiConfig);
    if (caps.supportsBatch) {
      ctx.preferredApproveMethod = "approve-amount";
      return ["batchUpdateLeverage"];
    }

    const { depositChange, leverage, loan } = ctx.request;

    const steps: string[] = [];
    const branch = getBranch(loan.branchId);

    // only check approval for non-ETH collaterals
    if (branch.symbol !== "ETH" && depositChange && dn.gt(depositChange, 0)) {
      const { LeverageLSTZapper, CollToken } = branch.contracts;
      const allowance = dnum18(
        await ctx.readContract({
          ...CollToken,
          functionName: "allowance",
          args: [ctx.account ?? ADDRESS_ZERO, LeverageLSTZapper.address],
        }),
      );

      if (dn.lt(allowance, depositChange)) {
        steps.push("approveLst");
      }
    }

    if (leverage?.direction === "down") {
      steps.push("leverDownTrove");
    }

    if (depositChange) {
      steps.push(dn.gt(depositChange, 0) ? "increaseDeposit" : "decreaseDeposit");
    }

    if (leverage?.direction === "up") {
      steps.push("leverUpTrove");
    }

    return steps;
  },

  parseRequest(request) {
    return v.parse(RequestSchema, request);
  },
};

function buildApproveLstCall(
  request: UpdateLeveragePositionRequest,
  preferredApproveMethod: "permit" | "approve-amount" | "approve-infinite",
) {
  const branch = getBranch(request.loan.branchId);
  const Zapper = branch.contracts.LeverageLSTZapper;

  if (!request.depositChange) {
    throw new Error("buildApproveLstCall: depositChange is required");
  }

  return {
    ...branch.contracts.CollToken,
    functionName: "approve" as const,
    args: [
      Zapper.address,
      preferredApproveMethod === "approve-infinite"
        ? maxUint256
        : request.depositChange[0],
    ] as const,
  };
}

function buildDepositCall(request: UpdateLeveragePositionRequest) {
  if (!request.depositChange) {
    throw new Error("buildDepositCall: depositChange is required");
  }

  const branch = getBranch(request.loan.branchId);

  if (branch.symbol === "ETH") {
    return {
      ...branch.contracts.LeverageWETHZapper,
      functionName: "addCollWithRawETH" as const,
      args: [BigInt(request.loan.troveId)] as const,
      value: request.depositChange[0],
    };
  }

  return {
    ...branch.contracts.LeverageLSTZapper,
    functionName: "addColl" as const,
    args: [BigInt(request.loan.troveId), request.depositChange[0]] as const,
  };
}

function buildWithdrawCall(request: UpdateLeveragePositionRequest) {
  if (!request.depositChange) {
    throw new Error("buildWithdrawCall: depositChange is required");
  }

  const branch = getBranch(request.loan.branchId);
  const args = [BigInt(request.loan.troveId), request.depositChange[0] * -1n] as const;

  if (branch.symbol === "ETH") {
    return {
      ...branch.contracts.LeverageWETHZapper,
      functionName: "withdrawCollToRawETH" as const,
      args,
    };
  }

  return {
    ...branch.contracts.LeverageLSTZapper,
    functionName: "withdrawColl" as const,
    args,
  };
}

function buildLeverUpCall(request: UpdateLeveragePositionRequest) {
  if (request.leverage?.direction !== "up") {
    throw new Error("buildLeverUpCall: leverage direction must be up");
  }

  const branch = getBranch(request.loan.branchId);
  const args = [{
    troveId: BigInt(request.loan.troveId),
    flashLoanAmount: dn.from(request.leverage.flashloanAmount, 18)[0],
    boldAmount: dn.from(request.leverage.boldAmount, 18)[0],
    maxUpfrontFee: MAX_UPFRONT_FEE,
  }] as const;

  if (branch.symbol === "ETH") {
    return {
      ...branch.contracts.LeverageWETHZapper,
      functionName: "leverUpTrove" as const,
      args,
    };
  }

  return {
    ...branch.contracts.LeverageLSTZapper,
    functionName: "leverUpTrove" as const,
    args,
  };
}

function buildLeverDownCall(request: UpdateLeveragePositionRequest) {
  if (request.leverage?.direction !== "down") {
    throw new Error("buildLeverDownCall: leverage direction must be down");
  }

  const branch = getBranch(request.loan.branchId);
  const args = [{
    troveId: BigInt(request.loan.troveId),
    flashLoanAmount: dn.from(request.leverage.flashloanAmount, 18)[0],
    minBoldAmount: dn.from(request.leverage.minBoldAmount)[0],
  }] as const;

  if (branch.symbol === "ETH") {
    return {
      ...branch.contracts.LeverageWETHZapper,
      functionName: "leverDownTrove" as const,
      args,
    };
  }

  return {
    ...branch.contracts.LeverageLSTZapper,
    functionName: "leverDownTrove" as const,
    args,
  };
}
