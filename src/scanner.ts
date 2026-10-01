import { ethers } from "ethers";
import { CHAINS } from "./chains";
import {
  ChainName,
  KVStore,
  NewPair,
} from "./types";
import { KVNamespaceLike, KVStoreImpl } from "./kv";
import { extractInitialHolders } from "./holders";

const PAIR_CREATED_TOPIC = ethers.id(
  "PairCreated(address,address,address,uint256)"
);

const POOL_CREATED_TOPIC = ethers.id(
  "PoolCreated(address,address,uint24,int24,address)"
);

const MAX_RUNTIME_MS = 25_000;
const BATCH_SIZE = 20;

interface FactoryEvent {
  token0: string;
  token1: string;
  pair_address: string;
  tx_hash: string;
  block_number: number;
  factory: string;
  isV3: boolean;
}

interface ScanResult {
  total_found: number;
  processed: number;
  stored: number;
  skipped: number;
  errors: number;
  elapsed_ms: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function topicToAddress(topic: string): string {
  return ethers.getAddress(`0x${topic.slice(-40)}`);
}

function normalizeAddress(address: string): string {
  return ethers.getAddress(address);
}

function createProvider(
  chain: ChainName
): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(
    CHAINS[chain].rpc_url
  );
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

    return String(await contract.symbol());
  } catch {
    return "UNKNOWN";
  }
}

async function getReserves(
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

function decodePairEvent(
  log: ethers.Log,
  isV3: boolean
): FactoryEvent | null {
  try {
    const topic = log.topics[0];

    if (
      topic !== PAIR_CREATED_TOPIC &&
      topic !== POOL_CREATED_TOPIC
    ) {
      return null;
    }

    if (log.topics.length < 3) {
      return null;
    }

    const token0 = topicToAddress(log.topics[1]);
    const token1 = topicToAddress(log.topics[2]);

    let pairAddress: string;

    if (!isV3) {
      if (log.topics.length >= 4) {
        pairAddress = topicToAddress(log.topics[3]);
      } else {
        return null;
      }
    } else {
      const decoded =
        ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "uint24", "int24", "address"],
          log.data
        );

      pairAddress = normalizeAddress(decoded[3]);
    }

    return {
      token0,
      token1,
      pair_address: pairAddress,
      tx_hash: log.transactionHash,
      block_number: log.blockNumber,
      factory: normalizeAddress(log.address),
      isV3,
    };
  } catch {
    return null;
  }
}

async function queryFactoryEvents(
  provider: ethers.JsonRpcProvider,
  factory: string,
  fromBlock: number,
  toBlock: number,
  isV3: boolean
): Promise<FactoryEvent[]> {
  const topic = isV3
    ? POOL_CREATED_TOPIC
    : PAIR_CREATED_TOPIC;

  const filter = {
    address: factory,
    fromBlock,
    toBlock,
    topics: [topic],
  };

  const logs = await provider.getLogs(filter);

  const events: FactoryEvent[] = [];

  for (const log of logs) {
    const parsed = decodePairEvent(log, isV3);

    if (parsed) {
      events.push(parsed);
    }
  }

  return events;
}

async function buildPair(
  provider: ethers.JsonRpcProvider,
  chain: ChainName,
  event: FactoryEvent
): Promise<NewPair | null> {
  const receipt = await provider.getTransactionReceipt(
    event.tx_hash
  );

  if (!receipt || receipt.status !== 1) {
    return null;
  }

  const code = await provider.getCode(
    event.pair_address
  );

  if (!code || code === "0x") {
    return null;
  }

  const [symbol0, symbol1, reserves, holders] =
    await Promise.all([
      getTokenSymbol(provider, event.token0),
      getTokenSymbol(provider, event.token1),
      getReserves(
        provider,
        event.pair_address,
        event.isV3
      ),
      extractInitialHolders({
        tx_hash: event.tx_hash,
        chain,
        pair_address: event.pair_address,
        token0: event.token0,
        token1: event.token1,
      }),
    ]);

  return {
    pair_address: event.pair_address,
    tokens: [
      {
        address: event.token0,
        symbol: symbol0,
      },
      {
        address: event.token1,
        symbol: symbol1,
      },
    ],
    init_liquidity: reserves,
    top_holders: holders,
    created_at: new Date().toISOString(),
  };
}

async function processBatch(
  events: FactoryEvent[],
  chain: ChainName,
  provider: ethers.JsonRpcProvider,
  store: KVStore
): Promise<{
  processed: number;
  stored: number;
  skipped: number;
  errors: number;
}> {
  let processed = 0;
  let stored = 0;
  let skipped = 0;
  let errors = 0;

  for (const event of events) {
    processed++;

    try {
      const pairAddress = normalizeAddress(
        event.pair_address
      );

      const key = `pair:${chain}:${pairAddress}`;

      if (await store.isDuplicate(key)) {
        skipped++;
        continue;
      }

      const pair = await buildPair(
        provider,
        chain,
        {
          ...event,
          pair_address: pairAddress,
        }
      );

      if (!pair) {
        skipped++;
        continue;
      }

      await store.write(key, pair);
      stored++;
    } catch (error) {
      errors++;

      console.warn(
        `Failed to process pair ${event.pair_address}:`,
        error
      );
    }
  }

  return {
    processed,
    stored,
    skipped,
    errors,
  };
}

export async function scanChain(
  chain: ChainName,
  kvNamespace: KVNamespaceLike
): Promise<ScanResult> {
  const startedAt = Date.now();

  const provider = createProvider(chain);
  const store = new KVStoreImpl(kvNamespace);
  const config = CHAINS[chain];

  let totalFound = 0;
  let processed = 0;
  let stored = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const currentBlock =
      await provider.getBlockNumber();

    const fromBlock =
      Math.max(
        0,
        currentBlock -
          15 * config.blocks_per_minute
      );

    const allEvents: FactoryEvent[] = [];

    for (const factory of config.factories) {
      try {
        const factoryCode =
          await provider.getCode(factory);

        if (!factoryCode || factoryCode === "0x") {
          console.warn(
            `Factory does not exist: ${factory}`
          );
          continue;
        }

        const factoryEvents =
          await queryFactoryEvents(
            provider,
            factory,
            fromBlock,
            currentBlock,
            factory === config.factories[1]
          );

        allEvents.push(...factoryEvents);
      } catch (error) {
        errors++;

        console.warn(
          `Failed scanning factory ${factory}:`,
          error
        );
      }
    }

    totalFound = allEvents.length;

    for (
      let i = 0;
      i < allEvents.length;
      i += BATCH_SIZE
    ) {
      if (Date.now() - startedAt >= MAX_RUNTIME_MS) {
        console.warn(
          `CPU protection triggered for ${chain}`
        );
        break;
      }

      const batch = allEvents.slice(
        i,
        i + BATCH_SIZE
      );

      const result = await processBatch(
        batch,
        chain,
        provider,
        store
      );

      processed += result.processed;
      stored += result.stored;
      skipped += result.skipped;
      errors += result.errors;

      if (Date.now() - startedAt >= MAX_RUNTIME_MS) {
        console.warn(
          `CPU protection triggered after batch`
        );
        break;
      }

      if (i + BATCH_SIZE < allEvents.length) {
        await sleep(10);
      }
    }
  } catch (error) {
    errors++;

    console.warn(
      `Cron scan failed for ${chain}:`,
      error
    );
  }

  const elapsed = Date.now() - startedAt;

  console.log(
    JSON.stringify({
      chain,
      total_pairs_found: totalFound,
      processed,
      stored,
      skipped,
      errors,
      elapsed_ms: elapsed,
    })
  );

  return {
    total_found: totalFound,
    processed,
    stored,
    skipped,
    errors,
    elapsed_ms: elapsed,
  };
}

export async function handleCron(
  kvNamespace: KVNamespaceLike
): Promise<void> {
  const startedAt = Date.now();

  for (const chain of ["ethereum", "bsc"] as ChainName[]) {
    if (Date.now() - startedAt >= MAX_RUNTIME_MS) {
      console.warn(
        "Global CPU protection triggered"
      );
      break;
    }

    await scanChain(chain, kvNamespace);
  }

  console.log(
    `Cron completed in ${Date.now() - startedAt}ms`
  );
}
