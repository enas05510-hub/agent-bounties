import { ethers } from "ethers";
import { CHAINS } from "./chains";
import { ChainName, NewPair } from "./types";
import {
  KVNamespaceLike,
  KVStoreImpl,
} from "./kv";
import {
  extractInitialHolders,
  HolderExtractionInput,
} from "./holders";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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
}

function normalizeAddress(address: string): string {
  return ethers.getAddress(address);
}

function topicToAddress(topic: string): string {
  return normalizeAddress(`0x${topic.slice(-40)}`);
}

function detectChain(network?: string): ChainName | null {
  const value = (network ?? "").toLowerCase();

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

function parsePairEvent(
  log: AlchemyLog,
  txHash: string,
  blockNumber: number
): PairEvent | null {
  if (!log.address || !log.topics || log.topics.length < 3) {
    return null;
  }

  const topic = log.topics[0];

  if (
    topic !== PAIR_CREATED_TOPIC &&
    topic !== POOL_CREATED_TOPIC
  ) {
    return null;
  }

  try {
    const token0 = topicToAddress(log.topics[1]);
    const token1 = topicToAddress(log.topics[2]);

    let pairAddress: string;

    if (topic === PAIR_CREATED_TOPIC) {
      if (log.topics.length >= 4) {
        pairAddress = topicToAddress(log.topics[3]);
      } else {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "uint256"],
          log.data ?? "0x"
        );

        pairAddress = normalizeAddress(decoded[0]);
      }
    } else {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["address", "uint24", "int24", "address"],
        log.data ?? "0x"
      );

      pairAddress = normalizeAddress(decoded[3]);
    }

    return {
      token0,
      token1,
      pair_address: pairAddress,
      tx_hash: txHash,
      block_number: blockNumber,
      factory: normalizeAddress(log.address),
    };
  } catch {
    return null;
  }
}

async function rpcCall<T>(
  provider: ethers.JsonRpcProvider,
  method: string,
  params: unknown[]
): Promise<T> {
  return provider.send(method, params);
}

async function getTokenSymbol(
  provider: ethers.JsonRpcProvider,
  token: string
): Promise<string> {
  try {
    const contract = new ethers.Contract(
      token,
      ["function symbol() view returns (string)"],
      provider
    );

    const symbol = await contract.symbol();
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
    const contract = new ethers.Contract(
      pair,
      [
        "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
      ],
      provider
    );

    const reserves = await contract.getReserves();

    return {
      token0_raw: reserves[0].toString(),
      token1_raw: reserves[1].toString(),
    };
  } catch {
    return {
      token0_raw: "0",
      token1_raw: "0",
    };
  }
}

async function buildNewPair(
  chain: ChainName,
  event: PairEvent,
  provider: ethers.JsonRpcProvider
): Promise<NewPair | null> {
  const receipt = await provider.getTransactionReceipt(
    event.tx_hash
  );

  if (!receipt || receipt.status !== 1) {
    return null;
  }

  const code = await provider.getCode(event.pair_address);

  if (!code || code === "0x") {
    return null;
  }

  const symbols = await Promise.all([
    getTokenSymbol(provider, event.token0),
    getTokenSymbol(provider, event.token1),
  ]);

  const reserves = await getV2Reserves(
    provider,
    event.pair_address
  );

  const holderInput: HolderExtractionInput = {
    tx_hash: event.tx_hash,
    chain,
    pair_address: event.pair_address,
    token0: event.token0,
    token1: event.token1,
  };

  const top_holders =
    await extractInitialHolders(holderInput);

  return {
    pair_address: event.pair_address,
    tokens: [
      {
        address: event.token0,
        symbol: symbols[0],
      },
      {
        address: event.token1,
        symbol: symbols[1],
      },
    ],
    init_liquidity: reserves,
    top_holders,
    created_at: new Date().toISOString(),
  };
}

export async function handleWebhook(
  request: Request,
  kvNamespace: KVNamespaceLike
): Promise<Response> {
  try {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    const payload =
      (await request.json()) as AlchemyWebhookPayload;

    const chain = detectChain(
      payload.blockchain?.network
    );

    if (!chain) {
      console.warn("Unsupported or missing blockchain network");
      return new Response("OK", { status: 200 });
    }

    const txHash = payload.event?.transaction?.hash;

    if (!txHash) {
      console.warn("Webhook missing transaction hash");
      return new Response("OK", { status: 200 });
    }

    const blockValue =
      payload.event?.block?.number ?? 0;

    const blockNumber =
      typeof blockValue === "string"
        ? Number(blockValue)
        : blockValue;

    const logs = payload.event?.data?.logs ?? [];

    const pairEvents = logs
      .map((log) =>
        parsePairEvent(log, txHash, blockNumber)
      )
      .filter(
        (event): event is PairEvent =>
          event !== null
      );

    if (pairEvents.length === 0) {
      return new Response("OK", { status: 200 });
    }

    const provider = new ethers.JsonRpcProvider(
      CHAINS[chain].rpc_url
    );

    const store = new KVStoreImpl(kvNamespace);

    for (const pairEvent of pairEvents) {
      try {
        const pairAddress =
          normalizeAddress(pairEvent.pair_address);

        const key =
          `pair:${chain}:${pairAddress}`;

        if (await store.isDuplicate(key)) {
          continue;
        }

        const pair = await buildNewPair(
          chain,
          {
            ...pairEvent,
            pair_address: pairAddress,
          },
          provider
        );

        if (!pair) {
          continue;
        }

        await store.write(key, pair);
      } catch (error) {
        console.warn(
          `Failed to process pair ${pairEvent.pair_address}:`,
          error
        );
      }
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.warn("Webhook processing error:", error);

    // Alchemy must receive 200 so transient processing
    // errors do not cause an endless webhook retry loop.
    return new Response("OK", { status: 200 });
  }
}
