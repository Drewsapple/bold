import type { FlowDeclaration } from "@/src/services/TransactionFlow";
import type { Address } from "@/src/types";

import { Amount } from "@/src/comps/Amount/Amount";
import { StakePositionSummary } from "@/src/comps/StakePositionSummary/StakePositionSummary";
import { dnum18 } from "@/src/dnum-utils";
import { signPermit } from "@/src/permit";
import { TransactionDetailsRow } from "@/src/screens/TransactionsScreen/TransactionsScreen";
import { TransactionStatus } from "@/src/screens/TransactionsScreen/TransactionStatus";
import { usePrice } from "@/src/services/Prices";
import { getWalletBatchCapabilities } from "@/src/sendCalls-utils";
import { vDnum, vPositionStake } from "@/src/valibot-utils";
import { useAccount } from "@/src/wagmi-utils";
import * as dn from "dnum";
import * as v from "valibot";
import { maxUint256 } from "viem";
import { getBytecode, sendCalls } from "wagmi/actions";
import { createRequestSchema, verifyCallsBatch, verifyTransaction } from "./shared";

const RequestSchema = createRequestSchema(
  "stakeDeposit",
  {
    lqtyAmount: vDnum(),
    stakePosition: vPositionStake(),
    prevStakePosition: v.union([v.null(), vPositionStake()]),
  },
);

export type StakeDepositRequest = v.InferOutput<typeof RequestSchema>;

function buildDeployUserProxyCall(
  Governance: { address: Address; abi: readonly unknown[] },
) {
  return {
    ...Governance,
    functionName: "deployUserProxy" as const,
  };
}

function buildApproveLqtyCall(
  LqtyToken: { address: Address; abi: readonly unknown[] },
  userProxyAddress: Address,
  amount: bigint,
) {
  return {
    ...LqtyToken,
    functionName: "approve" as const,
    args: [userProxyAddress, amount] as const,
  };
}

function buildDepositLqtyCall(
  Governance: { address: Address; abi: readonly unknown[] },
  amount: bigint,
) {
  return {
    ...Governance,
    functionName: "depositLQTY" as const,
    args: [amount] as const,
  };
}

function buildDepositLqtyViaPermitCall(
  Governance: { address: Address; abi: readonly unknown[] },
  amount: bigint,
  permit: {
    owner: Address;
    spender: Address;
    value: bigint;
    deadline: number;
    v: number;
    r: `0x${string}`;
    s: `0x${string}`;
  },
) {
  return {
    ...Governance,
    functionName: "depositLQTYViaPermit" as const,
    args: [amount, permit] as const,
  };
}

export const stakeDeposit: FlowDeclaration<StakeDepositRequest> = {
  title: "Review & Send Transaction",

  Summary({ request }) {
    return (
      <StakePositionSummary
        prevStakePosition={request.prevStakePosition}
        stakePosition={request.stakePosition}
        txPreviewMode
      />
    );
  },

  Details({ request }) {
    const lqtyPrice = usePrice("LQTY");
    return (
      <TransactionDetailsRow
        label="You deposit"
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
    deployUserProxy: {
      name: () => "Initialize Staking",
      Status: TransactionStatus,
      async commit(ctx) {
        return ctx.writeContract(buildDeployUserProxyCall(ctx.contracts.Governance));
      },
      async verify(ctx, hash) {
        await verifyTransaction(ctx.wagmiConfig, hash, ctx.isSafe);
      },
    },

    approve: {
      name: () => "Approve LQTY",
      Status: (props) => {
        const account = useAccount();
        return (
          <TransactionStatus
            {...props}
            // don’t use permit for safe transactions
            approval={account.safeStatus === null ? "all" : "approve-only"}
          />
        );
      },
      async commit(ctx) {
        const userProxyAddress = await ctx.readContract({
          ...ctx.contracts.Governance,
          functionName: "deriveUserProxyAddress",
          args: [ctx.account],
        });

        // permit
        if (ctx.preferredApproveMethod === "permit" && !ctx.isSafe) {
          const { deadline, ...permit } = await signPermit({
            token: ctx.contracts.LqtyToken.address,
            spender: userProxyAddress,
            value: ctx.request.lqtyAmount[0],
            account: ctx.account,
            wagmiConfig: ctx.wagmiConfig,
          });

          return "permit:" + JSON.stringify({
            ...permit,
            deadline: Number(deadline),
            userProxyAddress,
          });
        }

        // approve()
        const amount = ctx.preferredApproveMethod === "approve-infinite"
          ? maxUint256 // infinite approval
          : ctx.request.lqtyAmount[0]; // exact amount
        return ctx.writeContract(buildApproveLqtyCall(
          ctx.contracts.LqtyToken,
          userProxyAddress,
          amount,
        ));
      },
      async verify(ctx, hash) {
        if (!hash.startsWith("permit:")) {
          await verifyTransaction(ctx.wagmiConfig, hash, ctx.isSafe);
        }
      },
    },

    deposit: {
      name: () => "Stake",
      Status: TransactionStatus,
      async commit(ctx) {
        const { Governance } = ctx.contracts;
        const amount = ctx.request.lqtyAmount[0];

        const approveStep = ctx.steps?.find((step) => step.id === "approve");
        const isPermit = approveStep?.artifact?.startsWith("permit:") === true;

        // deposit LQTY via permit
        if (isPermit) {
          const { userProxyAddress, ...permit } = JSON.parse(
            approveStep?.artifact?.replace(/^permit:/, "") ?? "{}",
          );
          return ctx.writeContract(buildDepositLqtyViaPermitCall(
            Governance,
            amount,
            {
              owner: ctx.account,
              spender: userProxyAddress,
              value: amount,
              deadline: permit.deadline,
              v: permit.v,
              r: permit.r,
              s: permit.s,
            },
          ));
        }

        const userProxyAddress = await ctx.readContract({
          ...Governance,
          functionName: "deriveUserProxyAddress",
          args: [ctx.account],
        });

        const lqtyAllowance = await ctx.readContract({
          ...ctx.contracts.LqtyToken,
          functionName: "allowance",
          args: [ctx.account, userProxyAddress],
        });

        if (dn.gt(ctx.request.lqtyAmount, dnum18(lqtyAllowance))) {
          throw new Error("LQTY allowance is not enough");
        }

        // deposit approved LQTY
        return ctx.writeContract(buildDepositLqtyCall(Governance, amount));
      },
      async verify(ctx, hash) {
        await verifyTransaction(ctx.wagmiConfig, hash, ctx.isSafe);
      },
    },

    // Wallet-level batch via EIP-5792 sendCalls
    batchDeposit: {
      name: () => "Stake",
      Status: TransactionStatus,
      async commit(ctx) {
        const { Governance, LqtyToken } = ctx.contracts;
        const calls: ReturnType<
          | typeof buildDeployUserProxyCall
          | typeof buildApproveLqtyCall
          | typeof buildDepositLqtyCall
        >[] = [];

        const userProxyAddress = await ctx.readContract({
          ...Governance,
          functionName: "deriveUserProxyAddress",
          args: [ctx.account],
        });

        const userProxyBytecode = await getBytecode(ctx.wagmiConfig, {
          address: userProxyAddress,
        });

        // deploy proxy if needed
        if (!userProxyBytecode) {
          calls.push(buildDeployUserProxyCall(Governance));
        }

        // check allowance
        const lqtyAllowance = await ctx.readContract({
          ...LqtyToken,
          functionName: "allowance",
          args: [ctx.account, userProxyAddress],
        });

        // approve if needed
        if (dn.gt(ctx.request.lqtyAmount, dnum18(lqtyAllowance))) {
          calls.push(buildApproveLqtyCall(
            LqtyToken,
            userProxyAddress,
            ctx.request.lqtyAmount[0],
          ));
        }

        // deposit LQTY
        calls.push(buildDepositLqtyCall(Governance, ctx.request.lqtyAmount[0]));

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
    const caps = await getWalletBatchCapabilities(ctx.wagmiConfig);

    // If the wallet supports batching, use a single batched step.
    // This combines deployUserProxy (if needed), approve (if needed),
    // and deposit into one wallet-level batch.
    if (caps.supportsBatch) {
      ctx.preferredApproveMethod = "approve-amount";
      return ["batchDeposit"];
    }

    const steps: string[] = [];

    // get the user proxy address
    const userProxyAddress = await ctx.readContract({
      ...ctx.contracts.Governance,
      functionName: "deriveUserProxyAddress",
      args: [ctx.account],
    });

    // check if the user proxy contract exists
    const userProxyBytecode = await getBytecode(ctx.wagmiConfig, {
      address: userProxyAddress,
    });

    // deploy the user proxy (optional, but prevents wallets
    // to show a warning for approving a non-deployed contract)
    if (!userProxyBytecode) {
      steps.push("deployUserProxy");
    }

    // check for allowance
    const lqtyAllowance = await ctx.readContract({
      ...ctx.contracts.LqtyToken,
      functionName: "allowance",
      args: [ctx.account, userProxyAddress],
    });

    // approve needed
    if (dn.gt(ctx.request.lqtyAmount, dnum18(lqtyAllowance))) {
      steps.push("approve");
    }

    // stake
    steps.push("deposit");

    return steps;
  },

  parseRequest(request) {
    return v.parse(RequestSchema, request);
  },
};
