export type FeeOverrides = {
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

function bump(value: bigint, bps: bigint, minAdd: bigint): bigint {
  return value + (value * bps) / 10_000n + minAdd;
}

export async function getSafeFeeOverrides(publicClient: {
  estimateFeesPerGas: () => Promise<any>;
}): Promise<FeeOverrides> {
  const fees = await publicClient.estimateFeesPerGas();

  const maxFeePerGas =
    typeof fees?.maxFeePerGas === "bigint" ? fees.maxFeePerGas : undefined;
  const maxPriorityFeePerGas =
    typeof fees?.maxPriorityFeePerGas === "bigint" ? fees.maxPriorityFeePerGas : undefined;
  const gasPrice = typeof fees?.gasPrice === "bigint" ? fees.gasPrice : undefined;

  if (maxFeePerGas !== undefined) {
    return {
      maxFeePerGas: bump(maxFeePerGas, 2000n, 1_000_000n),
      maxPriorityFeePerGas:
        maxPriorityFeePerGas !== undefined
          ? bump(maxPriorityFeePerGas, 1500n, 10_000n)
          : undefined,
    };
  }

  if (gasPrice !== undefined) {
    return { gasPrice: bump(gasPrice, 2000n, 1_000_000n) };
  }

  return {};
}
