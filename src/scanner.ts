import { ethers } from "ethers";

import {
  ChainName,
  FACTORIES,
  NewPair,
} from "./types";

import {
  CHAINS,
} from "./chains";

import {
  KVNamespaceLike,
  KVStoreImpl,
} from "./kv";

import {
  extractInitialHolders,
} from "./holders";

const PAIR_CREATED_TOPIC =
  ethers.id(
    "PairCreated(address,address,address,uint256)"
  );

const POOL_CREATED_TOPIC =
  ethers.id(
    "PoolCreated(address,address,uint24,int24,address)"
  );

const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000";

const MAX_BLOCK_RANGE = 2_000;

const MAX_PAIRS_PER_RUN = 100;

interface FactoryEvent {
  factory: string;
  token0: string;
  token1: string;
  pair_address: string;
  tx_hash: string;
  block_number: number;
  isV3: boolean;
}

function normalizeAddress(
  address: string
): string {
  return ethers
    .getAddress(address)
    .toLowerCase();
}

function topicToAddress(
  topic: string
): string {
  if (
    typeof topic !== "string" ||
    topic.length < 42
  ) {
    throw new Error(
      "Invalid indexed address topic"
    );
  }

  return ethers.getAddress(
    `0x${topic.slice(-40)}`
  );
}

function getProvider(
  chain: ChainName
): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(
    CHAINS[chain].rpc_url
  );
}

function isV3Factory(
  chain: ChainName,
  factory: string
): boolean {
  return (
    normalizeAddress(
      factory
    ) ===
    normalizeAddress(
      FACTORIES[chain][1]
    )
  );
}

function getFactoryFilter(
  chain: ChainName
): string[] {
  return FACTORIES[chain].map(
    normalizeAddress
  );
}

async function getLatestBlock(
  provider: ethers.JsonRpcProvider
): Promise<number> {
  const block =
    await provider.getBlockNumber();

  if (
    !Number.isSafeInteger(block) ||
    block < 0
  ) {
    throw new Error(
      "Invalid latest block number"
    );
  }

  return block;
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
   * V3 does not expose the V2 getReserves()
   * interface. The scanner therefore records
   * zero here until a V3-specific liquidity
   * calculation is performed.
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

async function parseV2Logs(
  provider: ethers.JsonRpcProvider,
  factory: string,
  fromBlock: number,
  toBlock: number
): Promise<FactoryEvent[]> {
  const logs =
    await provider.getLogs({
      address: factory,
      topics: [
        PAIR_CREATED_TOPIC,
      ],
      fromBlock,
      toBlock,
    });

  const events:
    FactoryEvent[] = [];

  for (
    const log of logs
  ) {
    try {
      if (
        log.topics.length <
        4
      ) {
        continue;
      }

      const token0 =
        topicToAddress(
          log.topics[1]
        );

      const token1 =
        topicToAddress(
          log.topics[2]
        );

      const pairAddress =
        topicToAddress(
          log.topics[3]
        );

      events.push({
        factory:
          ethers.getAddress(
            factory
          ),

        token0,

        token1,

        pair_address:
          pairAddress,

        tx_hash:
          log.transactionHash,

        block_number:
          log.blockNumber,

        isV3: false,
      });
    } catch {
      continue;
    }
  }

  return events;
}

async function parseV3Logs(
  provider: ethers.JsonRpcProvider,
  factory: string,
  fromBlock: number,
  toBlock: number
): Promise<FactoryEvent[]> {
  const logs =
    await provider.getLogs({
      address: factory,
      topics: [
        POOL_CREATED_TOPIC,
      ],
      fromBlock,
      toBlock,
    });

  const events:
    FactoryEvent[] = [];

  for (
    const log of logs
  ) {
    try {
      if (
        log.topics.length <
        4
      ) {
        continue;
      }

      const token0 =
        topicToAddress(
          log.topics[1]
        );

      const token1 =
        topicToAddress(
          log.topics[2]
        );

      if (
        !log.data ||
        log.data === "0x"
      ) {
        continue;
      }

      const decoded =
        ethers
          .AbiCoder
          .defaultAbiCoder()
          .decode(
            [
              "address",
              "int24",
              "address",
            ],
            log.data
          );

      const pairAddress =
        ethers.getAddress(
          String(decoded[2])
        );

      events.push({
        factory:
          ethers.getAddress(
            factory
          ),

        token0,

        token1,

        pair_address:
          pairAddress,

        tx_hash:
          log.transactionHash,

        block_number:
          log.blockNumber,

        isV3: true,
      });
    } catch {
      continue;
    }
  }

  return events;
}

async function discoverFactoryEvents(
  provider: ethers.JsonRpcProvider,
  chain: ChainName,
  fromBlock: number,
  toBlock: number
): Promise<FactoryEvent[]> {
  const factories =
    getFactoryFilter(
      chain
    );

  const events:
    FactoryEvent[] = [];

  for (
    const factory of factories
  ) {
    const v3 =
      isV3Factory(
        chain,
        factory
      );

    const found =
      v3
        ? await parseV3Logs(
            provider,
            factory,
            fromBlock,
            toBlock
          )
        : await parseV2Logs(
            provider,
            factory,
            fromBlock,
            toBlock
          );

    events.push(
      ...found
    );
  }

  return events;
}

async function buildNewPair(
  provider: ethers.JsonRpcProvider,
  chain: ChainName,
  event: FactoryEvent
): Promise<NewPair | null> {
  try {
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

    const block =
      await provider.getBlock(
        event.block_number
      );

    const [
      symbol0,
      symbol1,
      liquidity,
      holders,
    ] =
      await Promise.all([
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
        ethers.getAddress(
          event.pair_address
        ),

      factory:
        ethers.getAddress(
          event.factory
        ),

      tokens: [
        {
          address:
            ethers.getAddress(
              event.token0
            ),
          symbol:
            symbol0,
        },
        {
          address:
            ethers.getAddress(
              event.token1
            ),
          symbol:
            symbol1,
        },
      ],

      init_liquidity:
        liquidity,

      top_holders:
        holders,

      created_at:
        block
          ? new Date(
              Number(
                block.timestamp
              ) * 1000
            ).toISOString()
          : new Date().toISOString(),

      block_number:
        event.block_number,

      tx_hash:
        event.tx_hash,
    };
  } catch (error) {
    console.warn(
      `Failed to build pair ${event.pair_address}:`,
      error
    );

    return null;
  }
}

async function processEvents(
  provider: ethers.JsonRpcProvider,
  chain: ChainName,
  events: FactoryEvent[],
  store: KVStoreImpl
): Promise<number> {
  let saved = 0;

  const seen =
    new Set<string>();

  for (
    const event of events
  ) {
    if (
      saved >=
      MAX_PAIRS_PER_RUN
    ) {
      break;
    }

    const pairAddress =
      normalizeAddress(
        event.pair_address
      );

    if (
      pairAddress ===
      ZERO_ADDRESS
    ) {
      continue;
    }

    const key =
      `pair:${chain}:${pairAddress}`;

    if (
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);

    try {
      if (
        await store.isDuplicate(
          key
        )
      ) {
        continue;
      }

      const pair =
        await buildNewPair(
          provider,
          chain,
          event
        );

      if (!pair) {
        continue;
      }

      await store.write(
        key,
        pair
      );

      saved++;
    } catch (error) {
      console.warn(
        `Failed processing ${pairAddress}:`,
        error
      );
    }
  }

  return saved;
}

export async function handleCron(
  kvNamespace: KVNamespaceLike
): Promise<void> {
  const store =
    new KVStoreImpl(
      kvNamespace
    );

  for (
    const chain of [
      "ethereum",
      "bsc",
    ] as ChainName[]
  ) {
    try {
      const provider =
        getProvider(chain);

      const latestBlock =
        await getLatestBlock(
          provider
        );

      /*
       * Cron runs every 10 minutes.
       * Scan 15 minutes to provide overlap
       * and protect against missed webhook events.
       */
      const blocksPerMinute =
        CHAINS[chain]
          .blocks_per_minute;

      const requestedFrom =
        Math.max(
          0,
          latestBlock -
            15 *
              blocksPerMinute
        );

      /*
       * Split large RPC ranges into smaller
       * chunks to avoid provider limits.
       */
      let fromBlock =
        requestedFrom;

      while (
        fromBlock <=
        latestBlock
      ) {
        const toBlock =
          Math.min(
            latestBlock,
            fromBlock +
              MAX_BLOCK_RANGE -
              1
          );

        try {
          const events =
            await discoverFactoryEvents(
              provider,
              chain,
              fromBlock,
              toBlock
            );

          if (
            events.length > 0
          ) {
            await processEvents(
              provider,
              chain,
              events,
              store
            );
          }
        } catch (error) {
          console.warn(
            `Failed scanning ${chain} blocks ${fromBlock}-${toBlock}:`,
            error
          );
        }

        fromBlock =
          toBlock + 1;
      }
    } catch (error) {
      console.warn(
        `Cron scan failed for ${chain}:`,
        error
      );
    }
  }
}
