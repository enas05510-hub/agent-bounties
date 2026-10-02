import { ethers } from "ethers";

const PAIR_CREATED_TOPIC =
  "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e";

const FACTORIES: Record<string, string> = {
  "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f": "ethereum",
  "0x1f98431c8ad98523631ae4a59f267346ea31f984": "ethereum",
  "0xca143ce32fe78f1f7019d7d551a6402fc5350c73": "bsc",
  "0x0fbcf9fa4f9c56b0f40a671ad40e0805a091865": "bsc",
};

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

type WebhookBlock = {
  number?: number | string;
  logs?: WebhookLog[];
};

type WebhookPayload = {
  event?: {
    data?: {
      block?: WebhookBlock;
    };
    block?: WebhookBlock;
  };
  data?: {
    block?: WebhookBlock;
  };
  block?: WebhookBlock;
};

interface Env {
  PAIRS_KV: KVNamespace;
  ALCHEMY_SIGNING_KEY: string;
}

const RPCS: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  bsc: "https://bsc-rpc.publicnode.com",
};

function jsonResponse(
  body: unknown,
  status = 200
): Response {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "content-type": "application/json",
      },
    }
  );
}

function normalizeAddress(
  value?: string
): string | null {
  if (!value) {
    return null;
  }

  try {
    return ethers.getAddress(value);
  } catch {
    return null;
  }
}

function getBlockAndLogs(
  payload: WebhookPayload
): WebhookBlock | null {
  return (
    payload.event?.data?.block ??
    payload.event?.block ??
    payload.data?.block ??
    payload.block ??
    null
  );
}

function getLogAddress(
  log: WebhookLog
): string | null {
  return normalizeAddress(
    log.account?.address ??
      log.address
  );
}

function getTransactionHash(
  log: WebhookLog
): string | null {
  const hash =
    log.transaction?.hash ??
    log.transactionHash ??
    null;

  if (!hash) {
    return null;
  }

  return hash;
}

type ParsedPair = {
  token0: string;
  token1: string;
  pair: string;
  pairIndex: bigint;
};

function extractPair(
  log: WebhookLog
): ParsedPair | null {
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

  if (!log.data) {
    return null;
  }

  try {
    const token0Raw =
      ethers.dataSlice(
        topics[1],
        12,
        32
      );

    const token1Raw =
      ethers.dataSlice(
        topics[2],
        12,
        32
      );

    const token0 =
      normalizeAddress(token0Raw);

    const token1 =
      normalizeAddress(token1Raw);

    if (!token0 || !token1) {
      return null;
    }

    if (log.data.length < 130) {
      return null;
    }

    const pairRaw =
      ethers.dataSlice(
        log.data,
        12,
        32
      );

    const pair =
      normalizeAddress(pairRaw);

    if (!pair) {
      return null;
    }

    const pairIndexRaw =
      ethers.dataSlice(
        log.data,
        32,
        64
      );

    const pairIndex =
      BigInt(pairIndexRaw);

    return {
      token0,
      token1,
      pair,
      pairIndex,
    };
  } catch {
    return null;
  }
}

async function rpc(
  rpcUrl: string,
  method: string,
  params: unknown[]
): Promise<any> {
  const response =
    await fetch(
      rpcUrl,
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
        }),
      }
    );

  if (!response.ok) {
    throw new Error(
      `RPC HTTP ${response.status}`
    );
  }

  const json =
    await response.json<any>();

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
): Promise<any> {
  return rpcWithRetry(
    rpcUrl,
    "eth_getTransactionReceipt",
    [txHash]
  );
}

async function getCode(
  rpcUrl: string,
  address: string
): Promise<string> {
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
  const holders =
    new Set<string>();

  const logs =
    receipt?.logs ?? [];

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

    if (!tokenAddress) {
      continue;
    }

    const isToken =
      tokenAddress.toLowerCase() ===
        token0.toLowerCase() ||
      tokenAddress.toLowerCase() ===
        token1.toLowerCase();

    if (!isToken) {
      continue;
    }

    let from: string | null = null;
    let to: string | null = null;

    try {
      from =
        normalizeAddress(
          ethers.dataSlice(
            log.topics[1],
            12,
            32
          )
        );

      to =
        normalizeAddress(
          ethers.dataSlice(
            log.topics[2],
            12,
            32
          )
        );
    } catch {
      continue;
    }

    if (
      from &&
      from !== ethers.ZeroAddress &&
      from.toLowerCase() !==
        pair.toLowerCase()
    ) {
      holders.add(from);
    }

    if (
      to &&
      to !== ethers.ZeroAddress &&
      to.toLowerCase() !==
        pair.toLowerCase()
    ) {
      holders.add(to);
    }
  }

  return Array.from(holders);
}

async function pairAlreadyStored(
  env: Env,
  chain: string,
  pairAddress: string
): Promise<boolean> {
  const key =
    `${chain}:${pairAddress.toLowerCase()}`;

  const existing =
    await env.PAIRS_KV.get(key);

  return existing !== null;
}

async function storePair(
  env: Env,
  chain: string,
  pair: ParsedPair,
  txHash: string,
  blockNumber: number,
  holders: string[]
): Promise<void> {
  const key =
    `${chain}:${pair.pair.toLowerCase()}`;

  const value = {
    chain,
    pair: pair.pair,
    token0: pair.token0,
    token1: pair.token1,

    token0_raw: pair.token0,
    token1_raw: pair.token1,

    pair_index:
      pair.pairIndex.toString(),

    tx_hash: txHash,

    block_number:
      blockNumber,

    holders,

    detected_at:
      new Date().toISOString(),
  };

  await env.PAIRS_KV.put(
    key,
    JSON.stringify(value)
  );
}

/**
 * Verify Alchemy's HMAC SHA-256 signature.
 *
 * IMPORTANT:
 * The signature must be calculated over
 * the exact raw request body.
 */
async function verifyAlchemySignature(
  rawBody: string,
  signature: string,
  signingKey: string
): Promise<boolean> {
  if (
    !signature ||
    !signingKey
  ) {
    return false;
  }

  try {
    const encoder =
      new TextEncoder();

    const key =
      await crypto.subtle.importKey(
        "raw",
        encoder.encode(signingKey),
        {
          name: "HMAC",
          hash: "SHA-256",
        },
        false,
        ["sign"]
      );

    const signatureBytes =
      await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(rawBody)
      );

    const calculated =
      Array.from(
        new Uint8Array(
          signatureBytes
        )
      )
        .map(
          (byte) =>
            byte
              .toString(16)
              .padStart(2, "0")
        )
        .join("");

    return calculated ===
      signature.toLowerCase();
  } catch {
    return false;
  }
}

export async function handleWebhook(
  payload: WebhookPayload,
  env: Env
): Promise<Response> {
  const block =
    getBlockAndLogs(payload);

  if (!block) {
    console.log(
      "Webhook received without a block"
    );

    return jsonResponse({
      ok: true,
      processed: 0,
      reason: "no_block",
    });
  }

  const blockNumber =
    Number(block.number ?? 0);

  if (
    !Number.isFinite(blockNumber) ||
    blockNumber <= 0
  ) {
    console.log(
      "Webhook received with invalid block number"
    );

    return jsonResponse({
      ok: true,
      processed: 0,
      reason:
        "invalid_block_number",
    });
  }

  const logs =
    block.logs ?? [];

  let processed = 0;
  let candidates = 0;

  for (const log of logs) {
    const factory =
      getLogAddress(log);

    if (!factory) {
      continue;
    }

    const chain =
      FACTORIES[
        factory.toLowerCase()
      ];

    if (!chain) {
      continue;
    }

    const parsed =
      extractPair(log);

    if (!parsed) {
      continue;
    }

    candidates++;

    const txHash =
      getTransactionHash(log);

    if (!txHash) {
      console.warn(
        "PairCreated candidate has no transaction hash"
      );
      continue;
    }

    const rpcUrl =
      RPCS[chain];

    if (!rpcUrl) {
      continue;
    }

    try {
      const alreadyStored =
        await pairAlreadyStored(
          env,
          chain,
          parsed.pair
        );

      if (alreadyStored) {
        console.log(
          `Pair already stored: ${parsed.pair}`
        );
        continue;
      }
    } catch {
      console.warn(
        "KV deduplication check failed"
      );
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
      console.warn(
        `Receipt lookup failed: ${txHash}`
      );
      continue;
    }

    if (!receipt) {
      console.warn(
        `Receipt not found: ${txHash}`
      );
      continue;
    }

    if (
      receipt.status !== "0x1" &&
      receipt.status !== 1
    ) {
      console.warn(
        `Transaction reverted: ${txHash}`
      );
      continue;
    }

    if (
      receipt.transactionHash &&
      receipt.transactionHash.toLowerCase() !==
        txHash.toLowerCase()
    ) {
      console.warn(
        `Receipt hash mismatch: ${txHash}`
      );
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
      console.warn(
        `Contract code lookup failed: ${parsed.pair}`
      );
      continue;
    }

    if (
      !code ||
      code === "0x" ||
      code.length <= 2
    ) {
      console.warn(
        `Pair has no contract code: ${parsed.pair}`
      );
      continue;
    }

    const holders =
      extractInitialHolders(
        receipt,
        parsed.token0,
        parsed.token1,
        parsed.pair
      );

    const uniqueHolders =
      Array.from(
        new Set(
          holders.map(
            (address) =>
              address.toLowerCase()
          )
        )
      );

    try {
      await storePair(
        env,
        chain,
        parsed,
        txHash,
        blockNumber,
        uniqueHolders
      );

      processed++;

      console.log(
        `Pair stored: ${parsed.pair} | holders: ${uniqueHolders.length}`
      );
    } catch {
      console.warn(
        `KV storage failed: ${parsed.pair}`
      );
      continue;
    }
  }

  console.log(
    `Webhook processed | block=${blockNumber} | candidates=${candidates} | stored=${processed}`
  );

  return jsonResponse({
    ok: true,
    processed,
    candidates,
    block_number:
      blockNumber,
  });
}

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {
    if (
      request.method !== "POST"
    ) {
      return jsonResponse({
        ok: true,
        service:
          "agent-bounties",
      });
    }

    const signingKey =
      env.ALCHEMY_SIGNING_KEY;

    if (!signingKey) {
      console.error(
        "ALCHEMY_SIGNING_KEY is not configured"
      );

      return jsonResponse(
        {
          ok: false,
          error:
            "webhook_security_not_configured",
        },
        500
      );
    }

    const rawBody =
      await request.text();

    const signature =
      request.headers.get(
        "x-alchemy-signature"
      );

    if (
      !signature ||
      !(await verifyAlchemySignature(
        rawBody,
        signature,
        signingKey
      ))
    ) {
      console.warn(
        "Rejected webhook: invalid Alchemy signature"
      );

      return jsonResponse(
        {
          ok: false,
          error:
            "invalid_signature",
        },
        401
      );
    }

    try {
      const payload =
        JSON.parse(
          rawBody
        ) as WebhookPayload;

      return handleWebhook(
        payload,
        env
      );
    } catch {
      console.warn(
        "Webhook contained invalid JSON"
      );

      return jsonResponse(
        {
          ok: false,
          error:
            "invalid_json",
        },
        400
      );
    }
  },

  async scheduled(
    _event: ScheduledEvent,
    _env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    // Intentionally paused.
    // Webhook pipeline is the active ingestion path.
    return;
  },
};
