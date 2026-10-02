import { ethers } from "ethers";

const PAIR_CREATED_TOPIC =
  "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e";

const FACTORIES = new Set([
  "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f", // Uniswap V2
  "0x1f98431c8ad98523631ae4a59f267346ea31f984", // Uniswap V3
  "0xca143ce32fe78f1f7019d7d551a6402fc5350c73", // Pancake V2
  "0x0fbcf9fa4f9c56b0f40a671ad40e0805a091865", // Pancake V3
]);

const TRANSFER_TOPIC = ethers.id(
  "Transfer(address,address,uint256)"
);

type WebhookLog = {
  data?: string;
  topics?: string[];
  account?: {
    address?: string;
  };
  address?: string;
  transaction?: {
    hash?: string;
  };
  transactionHash?: string;
};

type WebhookPayload = {
  event?: {
    data?: {
      block?: {
        number?: number | string;
        logs?: WebhookLog[];
      };
    };
  };

  data?: {
    block?: {
      number?: number | string;
      logs?: WebhookLog[];
    };
  };

  block?: {
    number?: number | string;
    logs?: WebhookLog[];
  };
};

type Env = {
  PAIRS_KV: KVNamespace;
};

const RPCS: Record<string, string> = {
  ethereum:
    "https://eth.llamarpc.com",
  bsc:
    "https://bsc-dataseed.binance.org",
};

function normalizeAddress(value?: string): string | null {
  if (!value) return null;

  try {
    return ethers.getAddress(value);
  } catch {
    return null;
  }
}

function getBlockAndLogs(payload: WebhookPayload) {
  return (
    payload.event?.data?.block ??
    payload.data?.block ??
    payload.block ??
    null
  );
}

function getLogAddress(log: WebhookLog): string | null {
  return normalizeAddress(
    log.account?.address ??
      log.address
  );
}

function getTransactionHash(log: WebhookLog): string | null {
  return (
    log.transaction?.hash ??
    log.transactionHash ??
    null
  );
}

function extractV2Pair(
  log: WebhookLog
): {
  token0: string;
  token1: string;
  pair: string;
} | null {
  const topics = log.topics ?? [];

  if (topics.length < 3) {
    return null;
  }

  if (
    topics[0]?.toLowerCase() !==
    PAIR_CREATED_TOPIC.toLowerCase()
  ) {
    return null;
  }

  const token0 = normalizeAddress(
    ethers.getAddress(
      ethers.dataSlice(topics[1], 12)
    )
  );

  const token1 = normalizeAddress(
    ethers.getAddress(
      ethers.dataSlice(topics[2], 12)
    )
  );

  if (!token0 || !token1) {
    return null;
  }

  let pair: string | null = null;

  if (log.data && log.data.length >= 66) {
    try {
      pair = normalizeAddress(
        ethers.getAddress(
          ethers.dataSlice(log.data, 0, 32).slice(0, 20)
        )
      );
    } catch {
      pair = null;
    }
  }

  if (!pair && topics.length >= 4) {
    try {
      pair = normalizeAddress(
        ethers.getAddress(
          ethers.dataSlice(topics[3], 12)
        )
      );
    } catch {
      pair = null;
    }
  }

  if (!pair) {
    return null;
  }

  return {
    token0,
    token1,
    pair,
  };
}

async function rpc(
  rpcUrl: string,
  method: string,
  params: unknown[]
): Promise<any> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `RPC HTTP ${response.status}`
    );
  }

  const json = await response.json<any>();

  if (json.error) {
    throw new Error(
      json.error.message ??
        "RPC request failed"
    );
  }

  return json.result;
}

async function rpcWithRetry(
  rpcUrl: string,
  method: string,
  params: unknown[]
): Promise<any> {
  try {
    return await rpc(
      rpcUrl,
      method,
      params
    );
  } catch {
    return await rpc(
      rpcUrl,
      method,
      params
    );
  }
}

async function getReceipt(
  rpcUrl: string,
  txHash: string
) {
  return rpcWithRetry(
    rpcUrl,
    "eth_getTransactionReceipt",
    [txHash]
  );
}

async function getCode(
  rpcUrl: string,
  address: string
) {
  return rpcWithRetry(
    rpcUrl,
    "eth_getCode",
    [address, "latest"]
  );
}

function extractInitialHolders(
  receipt: any,
  token0: string,
  token1: string,
  pair: string
): string[] {
  const holders = new Set<string>();

  const logs = receipt?.logs ?? [];

  for (const log of logs) {
    if (
      !Array.isArray(log.topics) ||
      log.topics.length < 3
    ) {
      continue;
    }

    if (
      log.topics[0]?.toLowerCase() !==
      TRANSFER_TOPIC.toLowerCase()
    ) {
      continue;
    }

    const tokenAddress =
      normalizeAddress(log.address);

    if (
      tokenAddress?.toLowerCase() !==
        token0.toLowerCase() &&
      tokenAddress?.toLowerCase() !==
        token1.toLowerCase()
    ) {
      continue;
    }

    const from = normalizeAddress(
      ethers.getAddress(
        ethers.dataSlice(log.topics[1], 12)
      )
    );

    const to = normalizeAddress(
      ethers.getAddress(
        ethers.dataSlice(log.topics[2], 12)
      )
    );

    if (
      from &&
      from !== ethers.ZeroAddress &&
      from.toLowerCase() !== pair.toLowerCase()
    ) {
      holders.add(from);
    }

    if (
      to &&
      to !== ethers.ZeroAddress &&
      to.toLowerCase() !== pair.toLowerCase()
    ) {
      holders.add(to);
    }
  }

  return [...holders];
}

async function storePair(
  env: Env,
  chain: string,
  pair: {
    token0: string;
    token1: string;
    pair: string;
  },
  txHash: string | null,
  blockNumber: number,
  holders: string[]
) {
  const key =
    `${chain}:${pair.pair.toLowerCase()}`;

  const value = {
    chain,
    pair: pair.pair,
    token0: pair.token0,
    token1: pair.token1,
    token0_raw: pair.token0,
    token1_raw: pair.token1,
    tx_hash: txHash,
    block_number: blockNumber,
    holders,
    detected_at: new Date().toISOString(),
  };

  await env.PAIRS_KV.put(
    key,
    JSON.stringify(value)
  );
}

export async function handleWebhook(
  payload: WebhookPayload,
  env: Env
): Promise<Response> {
  const block = getBlockAndLogs(payload);

  if (!block) {
    return new Response(
      JSON.stringify({
        ok: true,
        processed: 0,
        reason: "no_block",
      }),
      {
        headers: {
          "content-type":
            "application/json",
        },
      }
    );
  }

  const blockNumber = Number(
    block.number ?? 0
  );

  const logs = block.logs ?? [];

  let processed = 0;

  for (const log of logs) {
    const factory =
      getLogAddress(log);

    if (
      !factory ||
      !FACTORIES.has(
        factory.toLowerCase()
      )
    ) {
      continue;
    }

    const parsed =
      extractV2Pair(log);

    if (!parsed) {
      continue;
    }

    const txHash =
      getTransactionHash(log);

    if (!txHash) {
      continue;
    }

    const isBscFactory =
      factory.toLowerCase() ===
        "0xca143ce32fe78f1f7019d7d551a6402fc5350c73" ||
      factory.toLowerCase() ===
        "0x0fbcf9fa4f9c56b0f40a671ad40e0805a091865";

    const chain =
      isBscFactory
        ? "bsc"
        : "ethereum";

    const rpcUrl =
      RPCS[chain];

    if (!rpcUrl) {
      continue;
    }

    const key =
      `${chain}:${parsed.pair.toLowerCase()}`;

    const existing =
      await env.PAIRS_KV.get(key);

    if (existing) {
      continue;
    }

    let receipt: any;

    try {
      receipt =
        await getReceipt(
          rpcUrl,
          txHash
        );
    } catch {
      continue;
    }

    if (!receipt) {
      continue;
    }

    if (
      receipt.status !== "0x1" &&
      receipt.status !== 1 &&
      receipt.status !== "1"
    ) {
      continue;
    }

    let code: string;

    try {
      code =
        await getCode(
          rpcUrl,
          parsed.pair
        );
    } catch {
      continue;
    }

    if (
      !code ||
      code === "0x"
    ) {
      continue;
    }

    const holders =
      extractInitialHolders(
        receipt,
        parsed.token0,
        parsed.token1,
        parsed.pair
      );

    try {
      await storePair(
        env,
        chain,
        parsed,
        txHash,
        blockNumber,
        holders
      );

      processed++;
    } catch {
      continue;
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      processed,
      block: blockNumber,
    }),
    {
      status: 200,
      headers: {
        "content-type":
          "application/json",
      },
    }
  );
}
