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
  pairKey,
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

const MAX_BLOCK_RANGE = 2000;
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

function getProvider(
  chain: ChainName
): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(
    CHAINS[chain].rpc_url
  );
}

function getV2Factories(
  chain: ChainName
): string[] {
  return [
    ethers.getAddress(
      FACTORIES[chain][0]
    ),
  ];
}

function getV3Factories(
  chain: ChainName
): string[] {
  return [
    ethers.getAddress(
      FACTORIES[chain][1]
    ),
  ];
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

async function parseV2Factory(
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
      const parsed =
        V2_FACTORY_INTERFACE.parseLog(
          {
            topics:
              log.topics,

            data:
              log.data,
          }
        );

      if (!parsed) {
        continue;
      }

      const token0 =
        ethers.getAddress(
          String(
            parsed.args[0]
          )
        );

      const token1 =
        ethers.getAddress(
          String(
            parsed.args[1]
          )
        );

      const pair =
        ethers.getAddress(
          String(
            parsed.args[2]
          )
        );

      events.push({
        factory:
          ethers.getAddress(
            factory
          ),

        token0,

        token1,

        pair_address:
          pair,

        tx_hash:
          log.transactionHash,

        block_number:
          log.blockNumber,

        isV3: false,
      });
    } catch (error) {
      console.warn(
        `Failed to decode V2 PairCreated log in ${factory}:`,
        error
      );
    }
  }

  return events;
}

async function parseV3Factory(
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
      const parsed =
        V3_FACTORY_INTERFACE.parseLog(
          {
            topics:
              log.topics,

            data:
              log.data,
          }
        );

      if (!parsed) {
        continue;
      }

      const token0 =
        ethers.getAddress(
          String(
            parsed.args[0]
          )
        );

      const token1 =
        ethers.getAddress(
          String(
            parsed.args[1]
          )
        );

      const pool =
        ethers.getAddress(
          String(
            parsed.args[4]
          )
        );

      events.push({
        factory:
          ethers.getAddress(
            factory
          ),

        token0,

        token1,

        pair_address:
          pool,

        tx_hash:
          log.transactionHash,

        block_number:
          log.blockNumber,

        isV3: true,
      });
    } catch (error) {
      console.warn(
        `Failed to decode V3 PoolCreated log in ${factory}:`,
        error
      );
    }
  }

  return events;
}

async function discoverEvents(
  provider: ethers.JsonRpcProvider,
  chain: ChainName,
  fromBlock: number,
  toBlock: number
): Promise<FactoryEvent[]> {
  const events:
    FactoryEvent[] = [];

  for (
    const factory of getV2Factories(
      chain
    )
  ) {
    try {
      const factoryEvents =
        await parseV2Factory(
          provider,
          factory,
          fromBlock,
          toBlock
        );

      events.push(
        ...factoryEvents
      );
    } catch (error) {
      console.warn(
        `V2 scan failed for ${factory}:`,
        error
      );
    }
  }

  for (
    const factory of getV3Factories(
      chain
    )
  ) {
    try {
      const factoryEvents =
        await parseV3Factory(
          provider,
          factory,
          fromBlock,
          toBlock
        );

      events.push(
        ...factoryEvents
      );
    } catch (error) {
      console.warn(
        `V3 scan failed for ${factory}:`,
        error
      );
    }
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

    const [
      symbol0,
      symbol1,
      liquidity,
      holders,
      block,
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

        provider.getBlock(
          event.block_number
        ),
      ]);

    const createdAt =
      block
        ? new Date(
            Number(
              block.timestamp
            ) * 1000
          ).toISOString()
        : new Date().toISOString();

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
        createdAt,

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
): Promise<void> {
  let processed = 0;

  for (
    const event of events
  ) {
    if (
      processed >=
      MAX_PAIRS_PER_RUN
    ) {
      break;
    }

    const pairAddress =
      ethers.getAddress(
        event.pair_address
      );

    const key =
      pairKey(
        chain,
        pairAddress
      );

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

      processed++;
    } catch (error) {
      console.warn(
        `Failed processing pair ${pairAddress}:`,
        error
      );
    }
  }
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
        getProvider(
          chain
        );

      const latestBlock =
        await provider.getBlockNumber();

      const blocksPerMinute =
        CHAINS[chain]
          .blocks_per_minute;

      /*
       * Keep the Cron discovery window aligned
       * with the fresh-market purpose while avoiding
       * unnecessarily large scans.
       */
      const requestedFrom =
        Math.max(
          0,
          latestBlock -
            10 *
              blocksPerMinute
        );

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
            await discoverEvents(
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
            `Failed scanning ${chain} ${fromBlock}-${toBlock}:`,
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
