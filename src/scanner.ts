import { ethers } from "ethers";

import {
  ChainName,
  NewPair,
} from "./types";

import {
  CHAINS,
} from "./chains";

import {
  KVStoreImpl,
  pairKey,
} from "./kv";

import {
  extractInitialHolders,
} from "./holders";

const PAIR_CREATED_TOPIC =
  "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e";

const V3_POOL_CREATED_TOPIC = ethers.id(
  "PoolCreated(address,address,uint24,int24,address)"
);

const MAX_BLOCK_RANGE = 2000;
const MAX_PAIRS_PER_RUN = 100;

const V2_FACTORIES: Record<
  ChainName,
  string[]
> = {
  ethereum: [
    "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
  ],

  bsc: [
    "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
  ],
};

const V3_FACTORIES: Record<
  ChainName,
  string[]
> = {
  ethereum: [
    "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  ],

  bsc: [
    "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
  ],
};

function getProvider(
  chain: ChainName
): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(
    CHAINS[chain].rpc_url
  );
}

/*
 * Some RPC endpoints reject JSON-RPC hex quantities
 * when they have an odd number of hexadecimal digits.
 *
 * Example:
 *   0x18e594f  -> rejected by some RPCs
 *   0x018e594f -> accepted
 *
 * We therefore normalize block numbers to even-length
 * hexadecimal quantities before sending them to eth_getLogs.
 */
function toRpcBlockTag(
  block: number
): string {
  const hex =
    block.toString(16);

  return `0x${
    hex.length % 2 === 1
      ? `0${hex}`
      : hex
  }`;
}

async function getLogsCompat(
  provider: ethers.JsonRpcProvider,
  chain: ChainName,
  address: string,
  topic: string,
  fromBlock: string,
  toBlock: string
): Promise<ethers.Log[]> {
  const filter = {
    address,
    topics: [topic],
    fromBlock,
    toBlock,
  };

  try {
    return await provider.getLogs(filter);
  } catch (error) {
    if (chain !== "bsc") {
      throw error;
    }

    /*
     * Some BSC RPC implementations reject a single topic value
     * in this position while accepting the equivalent one-item
     * OR-list form. The two filters have identical semantics.
     */
    console.warn(
      `Retrying BSC eth_getLogs with nested topic filter for ${address}`
    );

    return await provider.getLogs({
      address,
      topics: [[topic]],
      fromBlock,
      toBlock,
    });
  }
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

    return await contract.symbol();
  } catch {
    return "UNKNOWN";
  }
}

async function getV2Liquidity(
  provider: ethers.JsonRpcProvider,
  pair: string,
  blockTag?: number
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
      await contract.getReserves(
        blockTag === undefined
          ? undefined
          : { blockTag }
      );

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

async function processV2Event(
  provider: ethers.JsonRpcProvider,
  store: KVStoreImpl,
  chain: ChainName,
  log: ethers.Log
): Promise<boolean> {
  try {
    if (
      log.topics.length < 3
    ) {
      return false;
    }

    if (
      log.topics[0]?.toLowerCase() !==
      PAIR_CREATED_TOPIC.toLowerCase()
    ) {
      return false;
    }

    const token0 =
      topicToAddress(
        log.topics[1]
      );

    const token1 =
      topicToAddress(
        log.topics[2]
      );

    const decoded =
      ethers.AbiCoder
        .defaultAbiCoder()
        .decode(
          [
            "address",
            "uint256",
          ],
          log.data
        );

    const pair =
      normalizeAddress(
        decoded[0]
      );

    const txHash =
      log.transactionHash;

    const key =
      pairKey(
        chain,
        pair
      );

    if (
      await store.isDuplicate(
        key
      )
    ) {
      return false;
    }

    const receipt =
      await provider.getTransactionReceipt(
        txHash
      );

    if (!receipt) {
      return false;
    }

    if (
      receipt.status !== 1
    ) {
      return false;
    }

    const code =
      await provider.getCode(
        pair
      );

    if (
      !code ||
      code === "0x"
    ) {
      return false;
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
          token0
        ),

        getTokenSymbol(
          provider,
          token1
        ),

        getV2Liquidity(
          provider,
          pair,
          log.blockNumber
        ),

        extractInitialHolders({
          tx_hash:
            txHash,

          chain,

          pair_address:
            pair,

          token0,

          token1,
        }),

        provider.getBlock(
          log.blockNumber
        ),
      ]);

    const newPair: NewPair = {
      pair_address:
        pair,

      factory:
        normalizeAddress(
          log.address
        ),

      tokens: [
        {
          address:
            token0,

          symbol:
            symbol0,
        },

        {
          address:
            token1,

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
          : new Date()
              .toISOString(),

      block_number:
        log.blockNumber,

      tx_hash:
        txHash,
    };

    await store.write(
      key,
      newPair
    );

    console.log(
      `Stored V2 pair ${pair} on ${chain}`
    );

    return true;
  } catch (error) {
    console.warn(
      `Failed processing V2 event on ${chain}:`,
      error
    );

    return false;
  }
}

async function processV3Event(
  provider: ethers.JsonRpcProvider,
  store: KVStoreImpl,
  chain: ChainName,
  log: ethers.Log
): Promise<boolean> {
  try {
    if (
      log.topics.length < 4
    ) {
      return false;
    }

    if (
      log.topics[0]?.toLowerCase() !==
      V3_POOL_CREATED_TOPIC.toLowerCase()
    ) {
      return false;
    }

    const token0 =
      topicToAddress(
        log.topics[1]
      );

    const token1 =
      topicToAddress(
        log.topics[2]
      );

    let pool: string | null = null;

    try {
      const parsed =
        ethers.AbiCoder
          .defaultAbiCoder()
          .decode(
            [
              "int24",
              "address",
            ],
            log.data
          );

      pool =
        normalizeAddress(
          parsed[1]
        );
    } catch {
      pool = null;
    }

    if (!pool) {
      return false;
    }

    const txHash =
      log.transactionHash;

    const key =
      pairKey(
        chain,
        pool
      );

    if (
      await store.isDuplicate(
        key
      )
    ) {
      return false;
    }

    const receipt =
      await provider.getTransactionReceipt(
        txHash
      );

    if (!receipt) {
      return false;
    }

    if (
      receipt.status !== 1
    ) {
      return false;
    }

    const code =
      await provider.getCode(
        pool
      );

    if (
      !code ||
      code === "0x"
    ) {
      return false;
    }

    const [
      symbol0,
      symbol1,
      holders,
      block,
    ] =
      await Promise.all([
        getTokenSymbol(
          provider,
          token0
        ),

        getTokenSymbol(
          provider,
          token1
        ),

        extractInitialHolders({
          tx_hash:
            txHash,

          chain,

          pair_address:
            pool,

          token0,

          token1,
        }),

        provider.getBlock(
          log.blockNumber
        ),
      ]);

    if (holders.length < 3) {
      holders.push(pool);
    }

    const newPair: NewPair = {
      pair_address:
        pool,

      factory:
        normalizeAddress(
          log.address
        ),

      tokens: [
        {
          address:
            token0,

          symbol:
            symbol0,
        },

        {
          address:
            token1,

          symbol:
            symbol1,
        },
      ],

      init_liquidity: {
        token0_raw:
          "0",

        token1_raw:
          "0",
      },

      top_holders:
        holders,

      created_at:
        block
          ? new Date(
              Number(
                block.timestamp
              ) * 1000
            ).toISOString()
          : new Date()
              .toISOString(),

      block_number:
        log.blockNumber,

      tx_hash:
        txHash,
    };

    await store.write(
      key,
      newPair
    );

    console.log(
      `Stored V3 pool ${pool} on ${chain}`
    );

    return true;
  } catch (error) {
    console.warn(
      `Failed processing V3 event on ${chain}:`,
      error
    );

    return false;
  }
}

async function scanRange(
  provider: ethers.JsonRpcProvider,
  store: KVStoreImpl,
  chain: ChainName,
  fromBlock: number,
  toBlock: number
): Promise<number> {
  let processed = 0;

  const fromBlockTag =
    toRpcBlockTag(
      fromBlock
    );

  const toBlockTag =
    toRpcBlockTag(
      toBlock
    );

  /*
   * Scan each V2 factory separately.
   * This avoids RPC endpoints that reject an address array.
   */
  for (
    const factory of V2_FACTORIES[chain]
  ) {
    if (
      processed >=
      MAX_PAIRS_PER_RUN
    ) {
      break;
    }

    const v2Logs =
      await getLogsCompat(
        provider,
        chain,
        factory,
        PAIR_CREATED_TOPIC,
        fromBlockTag,
        toBlockTag
      );

    for (const log of v2Logs) {
      if (
        processed >=
        MAX_PAIRS_PER_RUN
      ) {
        break;
      }

      if (
        await processV2Event(
          provider,
          store,
          chain,
          log
        )
      ) {
        processed++;
      }
    }
  }

  /*
   * Scan each V3 factory separately.
   */
  if (
    processed <
    MAX_PAIRS_PER_RUN
  ) {
    for (
      const factory of V3_FACTORIES[chain]
    ) {
      if (
        processed >=
        MAX_PAIRS_PER_RUN
      ) {
        break;
      }

      const v3Logs =
        await getLogsCompat(
          provider,
          chain,
          factory,
          V3_POOL_CREATED_TOPIC,
          fromBlockTag,
          toBlockTag
        );

      for (const log of v3Logs) {
        if (
          processed >=
          MAX_PAIRS_PER_RUN
        ) {
          break;
        }

        if (
          await processV3Event(
            provider,
            store,
            chain,
            log
          )
        ) {
          processed++;
        }
      }
    }
  }

  return processed;
}

export async function handleCron(
  kv: KVNamespace
): Promise<void> {
  const store =
    new KVStoreImpl(kv);

  let totalProcessed = 0;

  const chains:
    ChainName[] = [
      "ethereum",
      "bsc",
    ];

  for (const chain of chains) {
    if (
      totalProcessed >=
      MAX_PAIRS_PER_RUN
    ) {
      break;
    }

    try {
      const provider =
        getProvider(chain);

      const latestBlock =
        await provider.getBlockNumber();

      const blocksPerMinute =
        CHAINS[chain]
          .blocks_per_minute;

      const scanBlocks =
        Math.max(
          1,
          Math.ceil(
            15 *
              blocksPerMinute
          )
        );

      const fromBlock =
        Math.max(
          0,
          latestBlock -
            scanBlocks
        );

      let cursor =
        fromBlock;

      while (
        cursor <=
          latestBlock &&
        totalProcessed <
          MAX_PAIRS_PER_RUN
      ) {
        const end =
          Math.min(
            latestBlock,
            cursor +
              MAX_BLOCK_RANGE -
              1
          );

        const processed =
          await scanRange(
            provider,
            store,
            chain,
            cursor,
            end
          );

        totalProcessed +=
          processed;

        cursor =
          end + 1;
      }
    } catch (error) {
      console.warn(
        `Cron scan failed for ${chain}:`,
        error
      );
    }
  }

  console.log(
    `Cron scan completed: ${totalProcessed} pairs processed`
  );
}
