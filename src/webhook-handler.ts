import { ethers } from "ethers";

import {
  ChainName,
  NewPair,
} from "./types";

import {
  pairKey,
  KVStoreImpl,
} from "./kv";

import {
  extractInitialHoldersFromReceipt,
} from "./holders";

/*
 * IMPORTANT:
 * Calculate the topic at runtime instead of manually
 * copying the 32-byte event hash.
 */
const PAIR_CREATED_TOPIC = ethers.id(
  "PairCreated(address,address,address,uint256)"
);

/*
 * IMPORTANT:
 * All keys are lowercase because lookup uses
 * factory.toLowerCase().
 *
 * The values MUST be ChainName, not generic string,
 * because RPCS and pairKey expect ChainName.
 */
const FACTORY_CHAINS: Record<string, ChainName> = {
  ["0x5c69bEe701ef814a2b6a3edd4b1652cb9cc5aa6f".toLowerCase()]:
    "ethereum",

  ["0x1f98431c8ad98523631ae4a59f267346ea31f984".toLowerCase()]:
    "ethereum",

  ["0xca143ce32fe78f1f7019d7d551a6402fc5350c73".toLowerCase()]:
    "bsc",

  ["0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865".toLowerCase()]:
    "bsc",
};

const RPCS: Record<ChainName, string> = {
  ethereum:
    "https://ethereum-rpc.publicnode.com",

  bsc:
    "https://bsc-rpc.publicnode.com",
};

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

export interface WebhookEnv {
  PAIRS_KV: KVNamespace;

  ALCHEMY_SIGNING_KEY?: string;
}

function jsonResponse(
  body: unknown,
  status = 200
): Response {
  return new Response(
    JSON.stringify(body),
    {
      status,

      headers: {
        "content-type":
          "application/json",
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
  return (
    log.transaction?.hash ??
    log.transactionHash ??
    null
  );
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

  /*
   * PairCreated has:
   *
   * topics[0] = event signature
   * topics[1] = token0
   * topics[2] = token1
   *
   * data[0:32]  = pair
   * data[32:64] = allPairsLength
   */
  if (topics.length < 3) {
    return null;
  }

  if (
    typeof topics[0] !== "string" ||
    topics[0].toLowerCase() !==
      PAIR_CREATED_TOPIC.toLowerCase()
  ) {
    return null;
  }

  if (
    typeof topics[1] !== "string" ||
    typeof topics[2] !== "string"
  ) {
    return null;
  }

  if (
    !ethers.isHexString(topics[1], 32) ||
    !ethers.isHexString(topics[2], 32)
  ) {
    return null;
  }

  if (
    typeof log.data !== "string" ||
    !ethers.isHexString(log.data)
  ) {
    return null;
  }

  /*
   * 0x + 64 bytes = 130 characters.
   *
   * PairCreated data contains exactly two ABI words:
   * pair + allPairsLength.
   */
  if (log.data.length < 130) {
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

    if (
      !ethers.isHexString(
        pairIndexRaw
      )
    ) {
      return null;
    }

    return {
      token0,

      token1,

      pair,

      pairIndex:
        BigInt(pairIndexRaw),
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
    [
      address,
      "latest",
    ]
  );
}

async function getTokenSymbol(
  rpcUrl: string,
  token: string
): Promise<string> {
  try {
    const data =
      ethers
        .id("symbol()")
        .slice(0, 10);

    const result =
      await rpcWithRetry(
        rpcUrl,
        "eth_call",
        [
          {
            to: token,
            data,
          },
          "latest",
        ]
      );

    if (
      typeof result !== "string" ||
      result === "0x"
    ) {
      return "UNKNOWN";
    }

    /*
     * Standard ERC20 string.
     */
    try {
      return ethers
        .AbiCoder
        .defaultAbiCoder()
        .decode(
          ["string"],
          result
        )[0]
        .toString();
    } catch {
      /*
       * bytes32 fallback.
       */
      try {
        const bytes32 =
          ethers
            .AbiCoder
            .defaultAbiCoder()
            .decode(
              ["bytes32"],
              result
            )[0];

        return ethers
          .decodeBytes32String(
            bytes32
          );
      } catch {
        return "UNKNOWN";
      }
    }
  } catch {
    return "UNKNOWN";
  }
}

async function getV2Reserves(
  rpcUrl: string,
  pair: string
): Promise<{
  token0_raw: string;
  token1_raw: string;
}> {
  try {
    const selector =
      ethers
        .id("getReserves()")
        .slice(0, 10);

    const result =
      await rpcWithRetry(
        rpcUrl,
        "eth_call",
        [
          {
            to: pair,
            data: selector,
          },
          "latest",
        ]
      );

    if (
      typeof result !== "string" ||
      result === "0x"
    ) {
      return {
        token0_raw: "0",
        token1_raw: "0",
      };
    }

    const decoded =
      ethers
        .AbiCoder
        .defaultAbiCoder()
        .decode(
          [
            "uint112",
            "uint112",
            "uint32",
          ],
          result
        );

    return {
      token0_raw:
        decoded[0].toString(),

      token1_raw:
        decoded[1].toString(),
    };
  } catch {
    return {
      token0_raw: "0",
      token1_raw: "0",
    };
  }
}

async function verifyAlchemySignature(
  rawBody: string,
  signature: string,
  signingKey: string
): Promise<boolean> {
  if (
    !rawBody ||
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

        encoder.encode(
          signingKey
        ),

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

        encoder.encode(
          rawBody
        )
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
              .padStart(
                2,
                "0"
              )
        )
        .join("");

    return (
      calculated.toLowerCase() ===
      signature.toLowerCase()
    );
  } catch {
    return false;
  }
}

export async function handleWebhook(
  payload: WebhookPayload,
  env: WebhookEnv
): Promise<Response> {
  const block =
    getBlockAndLogs(payload);

  if (!block) {
    return jsonResponse(
      {
        ok: true,
        processed: 0,
        reason: "no_block",
      },
      200
    );
  }

  const blockNumber =
    Number(
      block.number ?? 0
    );

  if (
    !Number.isFinite(
      blockNumber
    ) ||
    blockNumber <= 0
  ) {
    return jsonResponse(
      {
        ok: false,

        processed: 0,

        reason:
          "invalid_block_number",
      },

      400
    );
  }

  const logs =
    block.logs ?? [];

  let processed = 0;

  let candidates = 0;

  const store =
    new KVStoreImpl(
      env.PAIRS_KV
    );

  for (const log of logs) {
    const factory =
      getLogAddress(log);

    if (!factory) {
      continue;
    }

    /*
     * Factory lookup is intentionally
     * lowercase.
     */
    const chain =
      FACTORY_CHAINS[
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
      console.warn(
        `No RPC configured for chain: ${chain}`
      );

      continue;
    }

    const key =
      pairKey(
        chain,
        parsed.pair
      );

    /*
     * KV deduplication.
     */
    try {
      if (
        await store.isDuplicate(
          key
        )
      ) {
        continue;
      }
    } catch (error) {
      console.warn(
        `KV deduplication failed for ${key}:`,
        error
      );

      continue;
    }

    try {
      /*
       * 1. Verify transaction receipt.
       */
      const receipt =
        await getReceipt(
          rpcUrl,
          txHash
        );

      if (!receipt) {
        console.warn(
          `Receipt not found: ${txHash}`
        );

        continue;
      }

      /*
       * 2. Transaction must have succeeded.
       */
      if (
        receipt.status !==
          "0x1" &&
        receipt.status !== 1
      ) {
        console.warn(
          `Transaction reverted: ${txHash}`
        );

        continue;
      }

      /*
       * 3. Protect against mismatched receipt.
       */
      if (
        receipt.transactionHash &&
        receipt.transactionHash
          .toLowerCase() !==
          txHash.toLowerCase()
      ) {
        console.warn(
          `Receipt hash mismatch: ${txHash}`
        );

        continue;
      }

      /*
       * 4. Pair address must actually contain contract code.
       */
      const code =
        await getCode(
          rpcUrl,
          parsed.pair
        );

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

      /*
       * 5. Fetch token metadata and V2 reserves.
       */
      const [
        symbol0,
        symbol1,
        liquidity,
      ] =
        await Promise.all([
          getTokenSymbol(
            rpcUrl,
            parsed.token0
          ),

          getTokenSymbol(
            rpcUrl,
            parsed.token1
          ),

          getV2Reserves(
            rpcUrl,
            parsed.pair
          ),
        ]);

      /*
       * 6. Extract initial holders from
       * the creation transaction receipt.
       */
      const holders =
        extractInitialHoldersFromReceipt(
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

      /*
       * 7. Build canonical NewPair object.
       */
      const pair: NewPair = {
        pair_address:
          ethers.getAddress(
            parsed.pair
          ),

        factory:
          ethers.getAddress(
            factory
          ),

        tokens: [
          {
            address:
              ethers.getAddress(
                parsed.token0
              ),

            symbol:
              symbol0,
          },

          {
            address:
              ethers.getAddress(
                parsed.token1
              ),

            symbol:
              symbol1,
          },
        ],

        init_liquidity:
          liquidity,

        top_holders:
          uniqueHolders,

        created_at:
          new Date().toISOString(),

        block_number:
          blockNumber,

        tx_hash:
          txHash,
      };

      /*
       * 8. Persist pair.
       */
      await store.write(
        key,
        pair
      );

      processed++;

      console.log(
        `Pair stored: ${key} | holders=${uniqueHolders.length}`
      );
    } catch (error) {
      console.warn(
        `Failed processing pair ${parsed.pair}:`,
        error
      );
    }
  }

  return jsonResponse({
    ok: true,

    processed,

    candidates,

    block_number:
      blockNumber,
  });
}

export async function handleSignedWebhook(
  request: Request,
  env: WebhookEnv
): Promise<Response> {
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

  let payload:
    WebhookPayload;

  try {
    payload =
      JSON.parse(
        rawBody
      ) as WebhookPayload;
  } catch {
    return jsonResponse(
      {
        ok: false,

        error:
          "invalid_json",
      },

      400
    );
  }

  return handleWebhook(
    payload,

    env
  );
}
