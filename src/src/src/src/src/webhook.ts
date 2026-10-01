import { ethers } from "ethers";
import { CHAINS } from "./chains";
import { ChainName, NewPair } from "./types";
import {
  KVNamespaceLike,
  KVStoreImpl,
} from "./kv";
import { extractInitialHolders } from "./holders";

const PAIR_CREATED_TOPIC = ethers.id(
  "PairCreated(address,address,address,uint256)"
);

const POOL_CREATED_TOPIC = ethers.id(
  "PoolCreated(address,address,uint24,int24,address)"
);

interface AlchemyLog {
  address?: string;
  topics?: string[];
  data?: string;
}

interface AlchemyEvent {
  transaction?: {
    hash?: string;
  };
  block?: {
    number?: string | number;
  };
  data?: {
    logs?: AlchemyLog[];
  };
}

interface AlchemyWebhookPayload {
  webhookId?: string;
  id?: string;
  createdAt?: string;
  type?: string;
  event?: AlchemyEvent;
  blockchain?: {
    network?: string;
  };
}

interface PairEvent {
  token0: string;
  token1: string;
  pair_address: string;
  tx_hash: string;
  block_number: number;
  factory: string;
  isV3: boolean;
}

function normalizeAddress(
  address: string
): string {
  return ethers.getAddress(address);
}

function topicToAddress(
  topic: string
): string {
  return normalizeAddress(
    `0x${topic.slice(-40)}`
  );
}

function detectChain(
  network?: string
): ChainName | null {
  const value =
    (network ?? "").toLowerCase();

  if (
    value.includes("ethereum") ||
    value.includes("eth-mainnet")
  ) {
    return "ethereum";
  }

  if (
    value.includes("bsc") ||
    value.includes("bnb")
  ) {
    return "bsc";
  }

  return null;
}

function getFactoryType(
  chain: ChainName,
  factory: string
): {
  isV3: boolean;
  normalized: string;
} | null {
  const normalized =
    normalizeAddress(factory);

  const factories =
    CHAINS[chain].factories;

  if (
    normalized.toLowerCase() ===
    factories[0].toLowerCase()
  ) {
    return {
      isV3: false,
      normalized,
    };
  }

  if (
    normalized.toLowerCase() ===
    factories[1].toLowerCase()
  ) {
    return {
      isV3: true,
      normalized,
    };
  }

  return null;
}

function parsePairEvent(
  chain: ChainName,
  log: AlchemyLog,
  txHash: string,
  blockNumber: number
): PairEvent | null {
  if (
    !log.address ||
    !log.topics ||
    log.topics.length < 3
  ) {
    return null;
  }

  try {
    const factoryInfo =
      getFactoryType(
        chain,
        log.address
      );

    if (!factoryInfo) {
      return null;
    }

    const topic =
      log.topics[0];

    if (
      !factoryInfo.isV3 &&
      topic !== PAIR_CREATED_TOPIC
    ) {
      return null;
    }

    if (
      factoryInfo.isV3 &&
      topic !== POOL_CREATED_TOPIC
    ) {
      return null;
    }

    const token0 =
      topicToAddress(
        log.topics[1]
      );

    const token1 =
      topicToAddress(
        log.topics[2]
      );

    let pairAddress: string;

    if (!factoryInfo.isV3) {
      /*
       * Uniswap/Pancake V2:
       * PairCreated(
       *   address indexed token0,
       *   address indexed token1,
       *   address indexed pair,
       *   uint256
       * )
       */
      if (log.topics.length < 4) {
        return null;
      }

      pairAddress =
        topicToAddress(
          log.topics[3]
        );
    } else {
      /*
       * Uniswap/Pancake V3:
       * PoolCreated(
       *   address indexed token0,
       *   address indexed token1,
       *   uint24 indexed fee,
       *   int24 indexed tickSpacing,
       *   address pool
       * )
       *
       * The pool address is non-indexed
       * and therefore lives in data.
       */
      if (!log.data) {
        return null;
      }

      const decoded =
        ethers.AbiCoder
          .defaultAbiCoder()
          .decode(
            [
              "address",
              "uint24",
              "int24",
              "address",
            ],
            log.data
          );

      pairAddress =
        normalizeAddress(
          decoded[3]
        );
    }

    return {
      token0,
      token1,
      pair_address: pairAddress,
      tx_hash: txHash,
      block_number: blockNumber,
      factory:
        factoryInfo.normalized,
      isV3:
        factoryInfo.isV3,
    };
  } catch (error) {
    console.warn(
      "Failed to parse factory event:",
      error
    );

    return null;
  }
}

async function getTokenSymbol(
  provider: ethers.JsonRpcProvider,
  token: string
): Promise<string> {
  try {
    const contract =
      new ethers.Contract(
        token,
        [
          "function symbol() view returns (string)",
        ],
        provider
      );

    const symbol =
      await contract.symbol();

    return String(symbol);
  } catch {
    return "UNKNOWN";
  }
}

async function getV2Reserves(
  provider: ethers.JsonRpcProvider,
  pair: string
): Promise<{
  token0_raw: string;
  token1_raw: string;
}> {
  try {
    const contract =
      new ethers.Contract(
        pair,
        [
          "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
        ],
        provider
      );

    const reserves =
      await contract.getReserves();

    return {
      token0_raw:
        reserves[0].toString(),
      token1_raw:
        reserves[1].toString(),
    };
  } catch {
    return {
      token0_raw: "0",
      token1_raw: "0",
    };
  }
}

async function getInitialLiquidity(
  provider: ethers.JsonRpcProvider,
  pair: string,
  isV3: boolean
): Promise<{
  token0_raw: string;
  token1_raw: string;
}> {
  /*
   * V2 pairs expose getReserves().
   *
   * V3 pools use concentrated liquidity and do
   * not expose the V2 reserve interface. We keep
   * the raw fields present and use zero until a
   * V3-specific liquidity reader is added.
   */
  if (isV3) {
    return {
      token0_raw: "0",
      token1_raw: "0",
    };
  }

  return getV2Reserves(
    provider,
    pair
  );
}

async function buildNewPair(
  chain: ChainName,
  event: PairEvent,
  provider: ethers.JsonRpcProvider
): Promise<NewPair | null> {
  const receipt =
    await provider.getTransactionReceipt(
      event.tx_hash
    );

  if (
    !receipt ||
    receipt.status !== 1
  ) {
    return null;
  }

  const code =
    await provider.getCode(
      event.pair_address
    );

  if (
    !code ||
    code === "0x"
  ) {
    return null;
  }

  const [
    symbol0,
    symbol1,
    liquidity,
    holders,
  ] = await Promise.all([
    getTokenSymbol(
      provider,
      event.token0
    ),
    getTokenSymbol(
      provider,
      event.token1
    ),
    getInitialLiquidity(
      provider,
      event.pair_address,
      event.isV3
    ),
    extractInitialHolders({
      tx_hash:
        event.tx_hash,
      chain,
      pair_address:
        event.pair_address,
      token0:
        event.token0,
      token1:
        event.token1,
    }),
  ]);

  return {
    pair_address:
      event.pair_address,

    factory:
      event.factory,

    tokens: [
      {
        address:
          event.token0,
        symbol:
          symbol0,
      },
      {
        address:
          event.token1,
        symbol:
          symbol1,
      },
    ],

    init_liquidity:
      liquidity,

    top_holders:
      holders,

    created_at:
      new Date().toISOString(),

    block_number:
      event.block_number,

    tx_hash:
      event.tx_hash,
  };
}

export async function handleWebhook(
  request: Request,
  kvNamespace: KVNamespaceLike
): Promise<Response> {
  try {
    if (
      request.method !== "POST"
    ) {
      return new Response(
        "OK",
        { status: 200 }
      );
    }

    const payload =
      (await request.json()) as
        AlchemyWebhookPayload;

    const chain =
      detectChain(
        payload.blockchain?.network
      );

    if (!chain) {
      console.warn(
        "Unsupported blockchain network"
      );

      return new Response(
        "OK",
        { status: 200 }
      );
    }

    const txHash =
      payload.event
        ?.transaction?.hash;

    if (!txHash) {
      console.warn(
        "Webhook missing transaction hash"
      );

      return new Response(
        "OK",
        { status: 200 }
      );
    }

    const rawBlock =
      payload.event
        ?.block?.number;

    const blockNumber =
      typeof rawBlock === "string"
        ? Number(rawBlock)
        : typeof rawBlock === "number"
          ? rawBlock
          : 0;

    if (
      !Number.isSafeInteger(
        blockNumber
      ) ||
      blockNumber < 0
    ) {
      console.warn(
        "Webhook contains invalid block number"
      );

      return new Response(
        "OK",
        { status: 200 }
      );
    }

    const logs =
      payload.event
        ?.data?.logs ?? [];

    const pairEvents =
      logs
        .map((log) =>
          parsePairEvent(
            chain,
            log,
            txHash,
            blockNumber
          )
        )
        .filter(
          (
            event
          ): event is PairEvent =>
            event !== null
        );

    if (
      pairEvents.length === 0
    ) {
      return new Response(
        "OK",
        { status: 200 }
      );
    }

    const provider =
      new ethers.JsonRpcProvider(
        CHAINS[chain].rpc_url
      );

    const store =
      new KVStoreImpl(
        kvNamespace
      );

    for (
      const pairEvent of
      pairEvents
    ) {
      try {
        const pairAddress =
          normalizeAddress(
            pairEvent.pair_address
          );

        const key =
          `pair:${chain}:${pairAddress}`;

        if (
          await store.isDuplicate(
            key
          )
        ) {
          continue;
        }

        const pair =
          await buildNewPair(
            chain,
            {
              ...pairEvent,
              pair_address:
                pairAddress,
            },
            provider
          );

        if (!pair) {
          continue;
        }

        await store.write(
          key,
          pair
        );
      } catch (error) {
        console.warn(
          `Failed to process pair ${pairEvent.pair_address}:`,
          error
        );
      }
    }

    return new Response(
      "OK",
      { status: 200 }
    );
  } catch (error) {
    console.warn(
      "Webhook processing error:",
      error
    );

    return new Response(
      "OK",
      { status: 200 }
    );
  }
}
