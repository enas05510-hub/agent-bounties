```ts
import { ethers } from "ethers";

import { CHAINS } from "./chains";

import {
  ChainName,
  NewPair,
} from "./types";

import {
  KVNamespaceLike,
  KVStoreImpl,
} from "./kv";

import {
  extractInitialHolders,
} from "./holders";

const V2_FACTORY_INTERFACE =
  new ethers.Interface([
    "event PairCreated(address indexed token0,address indexed token1,address pair,uint256)",
  ]);

const V3_FACTORY_INTERFACE =
  new ethers.Interface([
    "event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)",
  ]);

const PAIR_CREATED_TOPIC =
  ethers.id(
    "PairCreated(address,address,address,uint256)"
  );

const POOL_CREATED_TOPIC =
  ethers.id(
    "PoolCreated(address,address,uint24,int24,address)"
  );

interface AlchemyLog {
  address?: string;
  topics?: string[];
  data?: string;

  transaction?: {
    hash?: string;
  };
}

interface AlchemyBlock {
  number?: string | number;
  logs?: AlchemyLog[];
}

interface AlchemyEvent {
  data?: {
    block?: AlchemyBlock;
  };

  blockchain?: {
    network?: string;
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
  try {
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
  } catch {
    return null;
  }
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
    log.topics.length === 0
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

    const iface =
      factoryInfo.isV3
        ? V3_FACTORY_INTERFACE
        : V2_FACTORY_INTERFACE;

    const parsed =
      iface.parseLog({
        topics: log.topics,
        data: log.data ?? "0x",
      });

    if (!parsed) {
      return null;
    }

    const token0 =
      normalizeAddress(
        String(parsed.args[0])
      );

    const token1 =
      normalizeAddress(
        String(parsed.args[1])
      );

    const pairAddress =
      factoryInfo.isV3
        ? normalizeAddress(
            String(parsed.args[4])
          )
        : normalizeAddress(
            String(parsed.args[2])
          );

    if (
      pairAddress ===
      ethers.ZeroAddress
    ) {
      return null;
    }

    if (
      token0 === ethers.ZeroAddress ||
      token1 === ethers.ZeroAddress
    ) {
      return null;
    }

    return {
      token0,
      token1,
      pair_address: pairAddress,
      tx_hash: txHash,
      block_number: blockNumber,
      factory: factoryInfo.normalized,
      isV3: factoryInfo.isV3,
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

    return String(
      await contract.symbol()
    );
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
  try {
    const receipt =
      await provider.getTransactionReceipt(
        event.tx_hash
      );

    if (
      !receipt ||
      rece
```
