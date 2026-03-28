import type { FlowDeclaration, FlowStepDeclaration } from "@/src/services/TransactionFlow";

import { Amount } from "@/src/comps/Amount/Amount";
import { ETH_GAS_COMPENSATION } from "@/src/constants";
import { dnum18 } from "@/src/dnum-utils";
import { fmtnum } from "@/src/formatting";
import { subgraphIndicator } from "@/src/indicators/subgraph-indicator";
import { useDelegateDisplayName } from "@/src/liquity-delegate";
import {
  getBranch,
  getCollToken,
  getTroveOperationHints,
  useInterestBatchDelegate,
  usePredictOpenTroveUpfrontFee,
} from "@/src/liquity-utils";
import { getPrefixedTroveId } from "@/src/liquity-utils";
import { AccountButton } from "@/src/screens/TransactionsScreen/AccountButton";
import { LoanCard } from "@/src/screens/TransactionsScreen/LoanCard";
import { TransactionDetailsRow } from "@/src/screens/TransactionsScreen/TransactionsScreen";
import { TransactionStatus } from "@/src/screens/TransactionsScreen/TransactionStatus";
import { usePrice } from "@/src/services/Prices";
import { addPrefixedTroveIdsToStoredState } from "@/src/services/StoredState";
import { getIndexedTroveById } from "@/src/subgraph";
import { TroveId } from "@/src/types";
import { sleep } from "@/src/utils";
import { vAddress, vBranchId, vDnum } from "@/src/valibot-utils";
import { css } from "@/styled-system/css";
import { ADDRESS_ZERO, InfoTooltip } from "@liquity2/uikit";
import * as dn from "dnum";
import * as v from "valibot";
import { decodeEventLog, encodeEventTopics, erc20Abi, maxUint256, parseEventLogs } from "viem";
import {
  getBalance,
  getCapabilities,
  GetCapabilitiesErrorType,
  readContract,
  sendCalls,
  waitForCallsStatus,
} from "wagmi/actions";
import { CONTRACT_WETH } from "../env";
import { createRequestSchema, verifyTransaction, withOwnerIndexRetry } from "./shared";

const RequestSchema = createRequestSchema(
  "openBorrowPosition",
  {
    branchId: vBranchId(),
    owner: vAddress(),
    ownerIndex: v.number(),
    collAmount: vDnum(),
    boldAmount: vDnum(),
    annualInterestRate: vDnum(),
    maxUpfrontFee: vDnum(),
    interestRateDelegate: v.union([v.null(), vAddress()]),
  },
);

export type OpenBorrowPositionRequest = v.InferOutput<typeof RequestSchema>;

const approveLstCall = async (ctx: Parameters<FlowStepDeclaration<OpenBorrowPositionRequest>["commit"]>[0]) => {
  const branch = getBranch(ctx.request.branchId);
  const { LeverageLSTZapper, CollToken } = branch.contracts;

  return {
    ...CollToken,
    functionName: "approve",
    args: [
      LeverageLSTZapper.address,
      ctx.preferredApproveMethod === "approve-infinite"
        ? maxUint256 // infinite approval
        : ctx.request.collAmount[0], // exact amount
    ],
  } as const;
};

const openTroveLstCall = async (
  ctx: Parameters<FlowStepDeclaration<OpenBorrowPositionRequest>["commit"]>[0],
  ownerIndex: number,
) => {
  const { upperHint, lowerHint } = await getTroveOperationHints({
    wagmiConfig: ctx.wagmiConfig,
    contracts: ctx.contracts,
    branchId: ctx.request.branchId,
    interestRate: ctx.request.annualInterestRate[0],
  });

  const branch = getBranch(ctx.request.branchId);
  return {
    ...branch.contracts.LeverageLSTZapper,
    functionName: "openTroveWithRawETH" as const,
    args: [{
      owner: ctx.request.owner,
      ownerIndex: BigInt(ownerIndex),
      collAmount: ctx.request.collAmount[0],
      boldAmount: ctx.request.boldAmount[0],
      upperHint,
      lowerHint,
      annualInterestRate: ctx.request.interestRateDelegate
        ? 0n
        : ctx.request.annualInterestRate[0],
      batchManager: ctx.request.interestRateDelegate
        ? ctx.request.interestRateDelegate
        : ADDRESS_ZERO,
      maxUpfrontFee: ctx.request.maxUpfrontFee[0],
      addManager: ADDRESS_ZERO,
      removeManager: ADDRESS_ZERO,
      receiver: ADDRESS_ZERO,
    }],
    value: ETH_GAS_COMPENSATION[0],
  } as const;
};

const openTroveEthCall = async (
  ctx: Parameters<FlowStepDeclaration<OpenBorrowPositionRequest>["commit"]>[0],
  ownerIndex: number,
) => {
  const { upperHint, lowerHint } = await getTroveOperationHints({
    wagmiConfig: ctx.wagmiConfig,
    contracts: ctx.contracts,
    branchId: ctx.request.branchId,
    interestRate: ctx.request.annualInterestRate[0],
  });

  const branch = getBranch(ctx.request.branchId);
  return {
    ...branch.contracts.LeverageWETHZapper,
    functionName: "openTroveWithRawETH" as const,
    args: [{
      owner: ctx.request.owner,
      ownerIndex: BigInt(ownerIndex),
      collAmount: 0n,
      boldAmount: ctx.request.boldAmount[0],
      upperHint,
      lowerHint,
      annualInterestRate: ctx.request.interestRateDelegate
        ? 0n
        : ctx.request.annualInterestRate[0],
      batchManager: ctx.request.interestRateDelegate
        ? ctx.request.interestRateDelegate
        : ADDRESS_ZERO,
      maxUpfrontFee: ctx.request.maxUpfrontFee[0],
      addManager: ADDRESS_ZERO,
      removeManager: ADDRESS_ZERO,
      receiver: ADDRESS_ZERO,
    }],
    value: ctx.request.collAmount[0] + ETH_GAS_COMPENSATION[0],
  } as const;
};

export const openBorrowPosition: FlowDeclaration<OpenBorrowPositionRequest> = {
  title: "Review & Send Transaction",

  Summary({ request }) {
    const upfrontFee = usePredictOpenTroveUpfrontFee(
      request.branchId,
      request.boldAmount,
      request.interestRateDelegate ?? request.annualInterestRate,
    );

    const boldAmountWithFee = upfrontFee.data && dn.add(
      request.boldAmount,
      upfrontFee.data,
    );

    return (
      <LoanCard
        leverageMode={false}
        loadingState="success"
        loan={{
          type: "borrow",
          status: "active",
          troveId: null,
          borrower: request.owner,
          batchManager: request.interestRateDelegate,
          borrowed: boldAmountWithFee ?? dnum18(0),
          branchId: request.branchId,
          deposit: request.collAmount,
          interestRate: request.annualInterestRate,
        }}
        onRetry={() => {}}
        txPreviewMode
      />
    );
  },

  Details({ request }) {
    const collateral = getCollToken(request.branchId);
    const collPrice = usePrice(collateral.symbol);

    const upfrontFee = usePredictOpenTroveUpfrontFee(
      request.branchId,
      request.boldAmount,
      request.interestRateDelegate ?? request.annualInterestRate,
    );

    const boldAmountWithFee = upfrontFee.data && dn.add(
      request.boldAmount,
      upfrontFee.data,
    );

    const { branchId, interestRateDelegate, boldAmount } = request;
    const delegate = useInterestBatchDelegate(branchId, interestRateDelegate);
    const delegateDisplayName = useDelegateDisplayName(interestRateDelegate);
    const yearlyBoldInterest = dn.mul(
      boldAmount,
      dn.add(request.annualInterestRate, delegate.data?.fee ?? 0),
    );

    return collateral && (
      <>
        <TransactionDetailsRow
          label="Collateral"
          value={[
            `${fmtnum(request.collAmount)} ${collateral.name}`,
            <Amount
              key="end"
              fallback="…"
              prefix="$"
              value={collPrice.data && dn.mul(request.collAmount, collPrice.data)}
            />,
          ]}
        />
        <TransactionDetailsRow
          label="Loan"
          value={[
            <Amount
              key="start"
              fallback="…"
              value={boldAmountWithFee}
              suffix=" BOLD"
            />,
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
                value={upfrontFee.data}
                suffix=" BOLD creation fee"
              />
              <InfoTooltip heading="BOLD creation fee">
                This fee is charged when you open a new loan or increase your debt. It corresponds to 7 days of average
                interest for the respective collateral asset.
              </InfoTooltip>
            </div>,
          ]}
        />
        {request.interestRateDelegate
          ? (
            <TransactionDetailsRow
              label="Interest rate delegate"
              value={[
                <AccountButton
                  key="start"
                  address={request.interestRateDelegate}
                  displayName={delegateDisplayName}
                />,
                <div key="end">
                  {delegate.isLoading
                    ? "Loading…"
                    : (
                      <>
                        <Amount
                          value={request.annualInterestRate}
                          format="pct2z"
                          percentage
                        />{" "}
                        <Amount
                          percentage
                          format="pct2"
                          prefix="+ "
                          suffix="% delegate fee"
                          fallback="…"
                          value={delegate.data?.fee}
                        />
                        <br />
                        <Amount
                          format="2z"
                          prefix="~"
                          suffix=" BOLD per year"
                          value={yearlyBoldInterest}
                        />
                      </>
                    )}
                </div>,
              ]}
            />
          )
          : (
            <TransactionDetailsRow
              label="Interest rate"
              value={[
                <Amount
                  key="start"
                  value={request.annualInterestRate}
                  percentage
                />,
                <Amount
                  key="end"
                  fallback="…"
                  value={boldAmountWithFee && dn.mul(
                    boldAmountWithFee,
                    request.annualInterestRate,
                  )}
                  suffix=" BOLD per year"
                />,
              ]}
            />
          )}
        <TransactionDetailsRow
          label="Refundable gas deposit"
          value={[
            <div
              key="start"
              title={`${fmtnum(ETH_GAS_COMPENSATION, "full")} ETH`}
            >
              {fmtnum(ETH_GAS_COMPENSATION, 4)} ETH
            </div>,
            "Only used in case of liquidation",
          ]}
        />
      </>
    );
  },

  steps: {
    // Approve LST
    approveLst: {
      name: (ctx) => {
        const branch = getBranch(ctx.request.branchId);
        return `Approve ${branch.symbol}`;
      },
      Status: (props) => (
        <TransactionStatus
          {...props}
          approval="approve-only"
        />
      ),
      async commit(ctx) {
        return ctx.writeContract(await approveLstCall(ctx));
      },
      async verify(ctx, hash) {
        await verifyTransaction(ctx.wagmiConfig, hash, ctx.isSafe);
      },
    },

    // LeverageLSTZapper mode
    openTroveLst: {
      name: () => "Open Position",
      Status: TransactionStatus,

      async commit(ctx) {
        return withOwnerIndexRetry(
          ctx.request.ownerIndex,
          async (ownerIndex) => ctx.writeContract(await openTroveLstCall(ctx, ownerIndex)),
        );
      },

      async verify(ctx, hash) {
        const receipt = await verifyTransaction(ctx.wagmiConfig, hash, ctx.isSafe);

        // extract trove ID from logs
        const branch = getBranch(ctx.request.branchId);
        const [troveOperation] = parseEventLogs({
          abi: branch.contracts.TroveManager.abi,
          logs: receipt.logs,
          eventName: "TroveOperation",
        });

        if (!troveOperation?.args?._troveId) {
          throw new Error("Failed to extract trove ID from transaction");
        }
        const troveId: TroveId = `0x${troveOperation.args._troveId.toString(16)}`;
        const prefixedTroveId = getPrefixedTroveId(branch.branchId, troveId);

        addPrefixedTroveIdsToStoredState(ctx.storedState, [prefixedTroveId]);

        const subgraphIsDown = subgraphIndicator.hasError();
        if (!subgraphIsDown) {
          // wait for the trove to appear in the subgraph
          while (true) {
            const trove = await getIndexedTroveById(branch.branchId, troveId);
            if (trove !== null) break;
            await sleep(1000);
          }
        }
      },
    },

    // LeverageWETHZapper mode
    openTroveEth: {
      name: () => "Open Position",
      Status: TransactionStatus,

      async commit(ctx) {
        return withOwnerIndexRetry(
          ctx.request.ownerIndex,
          async (ownerIndex) => ctx.writeContract(await openTroveEthCall(ctx, ownerIndex)),
        );
      },

      async verify(...args) {
        // same verification as openTroveLst
        return openBorrowPosition.steps.openTroveLst?.verify(...args);
      },
    },

    // batchApproveAndOpenTroveLst mode
    batchApproveAndOpenTroveLst: {
      name: () => "Open Position",
      Status: TransactionStatus,

      async commit(ctx) {
        const approveCallPromise = approveLstCall(ctx);
        const ethBalancePromise = getBalance(ctx.wagmiConfig, { address: ctx.account });
        const wethBalancePromise = readContract(ctx.wagmiConfig, {
          address: CONTRACT_WETH,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [ctx.account],
        });
        return withOwnerIndexRetry(ctx.request.ownerIndex, async (ownerIndex) => {
          const openTroveCallPromise = openTroveLstCall(ctx, ownerIndex);

          const [approveCall, openTroveCall, ethBalance, wethBalance] = await Promise.all([
            approveCallPromise,
            openTroveCallPromise,
            ethBalancePromise,
            wethBalancePromise,
          ]);

          if (ethBalance.value < openTroveCall.value) {
            if (wethBalance + ethBalance.value < openTroveCall.value) {
              throw new Error("Insufficient balance to cover collateral and gas compensation");
            } else {
              // if user has enough balance in WETH, but not in ETH, we can unwrap WETH to ETH before opening the trove
              return (await sendCalls(ctx.wagmiConfig, {
                account: ctx.account,
                calls: [
                  { ...approveCall, to: approveCall.address },
                  {
                    to: CONTRACT_WETH,
                    abi: [
                      {
                        "constant": false,
                        "inputs": [{ "name": "wad", "type": "uint256" }],
                        "name": "withdraw",
                        "outputs": [],
                        "payable": false,
                        "stateMutability": "nonpayable",
                        "type": "function",
                      } as const,
                    ] as const,
                    functionName: "withdraw",
                    args: [openTroveCall.value - ethBalance.value],
                  },
                  { ...openTroveCall, to: openTroveCall.address },
                ],
              })).id;
            }
          }

          return (await sendCalls(ctx.wagmiConfig, {
            account: ctx.account,
            calls: [{ ...approveCall, to: approveCall.address }, { ...openTroveCall, to: openTroveCall.address }],
          })).id;
        });
      },

      async verify(ctx, hash) {
        const { status, receipts } = await waitForCallsStatus(ctx.wagmiConfig, { id: hash });

        if (status !== "success" || !receipts) {
          throw new Error("Transaction failed");
        }

        // extract trove ID from logs
        const branch = getBranch(ctx.request.branchId);

        const troveOperationLog = receipts.map((r) => r.logs).flat().find((log) =>
          log.topics[0]
            === encodeEventTopics({ abi: branch.contracts.TroveManager.abi, eventName: "TroveOperation" })[0]
        );

        if (!troveOperationLog) {
          throw new Error("TroveOperation event not found in transaction logs");
        }

        const troveOperation = decodeEventLog({
          abi: branch.contracts.TroveManager.abi,
          topics: troveOperationLog.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
          data: troveOperationLog.data,
        }) satisfies { eventName: "TroveOperation"; args: { _troveId: bigint } };

        if (!troveOperation?.args?._troveId) {
          throw new Error("Failed to extract trove ID from transaction");
        }
        const troveId: TroveId = `0x${troveOperation.args._troveId.toString(16)}`;
        const prefixedTroveId = getPrefixedTroveId(branch.branchId, troveId);

        addPrefixedTroveIdsToStoredState(ctx.storedState, [prefixedTroveId]);

        const subgraphIsDown = subgraphIndicator.hasError();
        if (!subgraphIsDown) {
          // wait for the trove to appear in the subgraph
          while (true) {
            const trove = await getIndexedTroveById(branch.branchId, troveId);
            if (trove !== null) break;
            await sleep(1000);
          }
        }
      },
    },

    // batchOpenTroveEth mode - includes WETH->ETH swap if needed
    batchOpenTroveEth: {
      name: () => "Open Position",
      Status: TransactionStatus,

      async commit(ctx) {
        const ethBalancePromise = getBalance(ctx.wagmiConfig, { address: ctx.account });
        const wethBalancePromise = readContract(ctx.wagmiConfig, {
          address: CONTRACT_WETH,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [ctx.account],
        });
        return withOwnerIndexRetry(ctx.request.ownerIndex, async (ownerIndex) => {
          const openTroveCallPromise = openTroveEthCall(ctx, ownerIndex);

          const [openTroveCall, ethBalance, wethBalance] = await Promise.all([
            openTroveCallPromise,
            ethBalancePromise,
            wethBalancePromise,
          ]);

          if (ethBalance.value < openTroveCall.value) {
            if (wethBalance + ethBalance.value < openTroveCall.value) {
              throw new Error("Insufficient balance to cover collateral and gas compensation");
            } else {
              // If user has enough balance in WETH, but not in ETH, unwrap WETH to ETH before opening the trove
              return (await sendCalls(ctx.wagmiConfig, {
                account: ctx.account,
                calls: [
                  {
                    to: CONTRACT_WETH,
                    abi: [
                      {
                        "constant": false,
                        "inputs": [{ "name": "wad", "type": "uint256" }],
                        "name": "withdraw",
                        "outputs": [],
                        "payable": false,
                        "stateMutability": "nonpayable",
                        "type": "function",
                      } as const,
                    ] as const,
                    functionName: "withdraw",
                    args: [openTroveCall.value - ethBalance.value],
                  },
                  { ...openTroveCall, to: openTroveCall.address, value: openTroveCall.value },
                ],
              })).id;
            }
          }

          // User has enough ETH, just open the trove directly
          return ctx.writeContract(openTroveCall);
        });
      },

      async verify(ctx, hash) {
        const { status, receipts } = await waitForCallsStatus(ctx.wagmiConfig, { id: hash });

        if (status !== "success" || !receipts) {
          throw new Error("Transaction failed");
        }

        // extract trove ID from logs
        const branch = getBranch(ctx.request.branchId);

        const troveOperationLog = receipts.map((r) => r.logs).flat().find((log) =>
          log.topics[0]
            === encodeEventTopics({ abi: branch.contracts.TroveManager.abi, eventName: "TroveOperation" })[0]
        );

        if (!troveOperationLog) {
          throw new Error("TroveOperation event not found in transaction logs");
        }

        const troveOperation = decodeEventLog({
          abi: branch.contracts.TroveManager.abi,
          topics: troveOperationLog.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
          data: troveOperationLog.data,
        }) satisfies { eventName: "TroveOperation"; args: { _troveId: bigint } };

        if (!troveOperation?.args?._troveId) {
          throw new Error("Failed to extract trove ID from transaction");
        }
        const troveId: TroveId = `0x${troveOperation.args._troveId.toString(16)}`;
        const prefixedTroveId = getPrefixedTroveId(branch.branchId, troveId);

        addPrefixedTroveIdsToStoredState(ctx.storedState, [prefixedTroveId]);

        const subgraphIsDown = subgraphIndicator.hasError();
        if (!subgraphIsDown) {
          // wait for the trove to appear in the subgraph
          while (true) {
            const trove = await getIndexedTroveById(branch.branchId, troveId);
            if (trove !== null) break;
            await sleep(1000);
          }
        }
      },
    },
  },

  async getSteps(ctx) {
    const branch = getBranch(ctx.request.branchId);

    const capabilitiesPromise = getCapabilities(ctx.wagmiConfig)
      .then((capabilities) => ({
        success: true,
        capabilities,
        error: null,
      } as const))
      .catch((error: GetCapabilitiesErrorType) => ({ success: false, capabilities: null, error } as const));

    // ETH doesn't need approval
    if (branch.symbol === "ETH") {
      const totalEthNeeded = ctx.request.collAmount[0] + ETH_GAS_COMPENSATION[0];
      const cap = await capabilitiesPromise;
      if (cap.success) {
        const atomicStatus = (ctx.wagmiConfig.state.chainId in cap.capabilities)
          ? cap.capabilities[ctx.wagmiConfig.state.chainId]?.atomic?.status
          : undefined;
        const canBatch = atomicStatus === "supported" || atomicStatus === "ready";
        // Check if we need to batch a WETH->ETH conversion before opening trove
        // Note: In the future, we should also check for auxiliaryFunds capability to allow
        // users to JIT add ETH inside their wallet when needed
        if (canBatch) {
          const ethBalance = await getBalance(ctx.wagmiConfig, { address: ctx.account });
          if (ethBalance.value < totalEthNeeded) {
            return ["batchOpenTroveEth"];
          }
        }
      }
      return ["openTroveEth"];
    }

    // Check if approval is needed
    const allowance = await readContract(ctx.wagmiConfig, {
      ...branch.contracts.CollToken,
      functionName: "allowance",
      args: [ctx.account, branch.contracts.LeverageLSTZapper.address],
    });

    const steps: string[] = [];

    const cap = await capabilitiesPromise;
    if (cap.success) {
      const atomicStatus = (ctx.wagmiConfig.state.chainId in cap.capabilities)
        ? cap.capabilities[ctx.wagmiConfig.state.chainId]?.atomic?.status
        : undefined;
      const canBatch = atomicStatus === "supported" || atomicStatus === "ready";
      if (canBatch) {
        ctx.preferredApproveMethod = "approve-amount";
        // early return steps with atomic approval and trove opening
        steps.push("batchApproveAndOpenTroveLst");
        return steps;
      }
    }

    if (allowance < ctx.request.collAmount[0]) {
      steps.push("approveLst");
    }

    steps.push("openTroveLst");
    return steps;
  },

  parseRequest(request) {
    return v.parse(RequestSchema, request);
  },
};
