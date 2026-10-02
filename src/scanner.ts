import { ethers } from "ethers";
import { ChainName } from "./types";
import { CHAINS } from "./chains";

const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000";

const TRANSFER_TOPIC = ethers.id(
  "Transfer(address,address,uint256)"
);

const MAX_HOLDERS = 10;

export interface HolderExtractionInput {
  tx_hash: string;
  chain: ChainName;
  pair_address: string;
  token0: string;
  token1: string;
}

function normalizeAddress(
  address: string
): string {
  return ethers.getAddress(address);
}

function topicToAddress(
  topic: string
): string {
  if (!topic || topic.length < 40) {
    throw new Error("Invalid indexed address topic");
  }

  return normalizeAddress(
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

function addHolder(
  holders: Set<string>,
  address: string,
  pairAddress?: string
): void {
  const normalized =
    normalizeAddress(address);

  if (
    normalized.toLowerCase() ===
    ZERO_ADDRESS.toLowerCase()
  ) {
    return;
  }

  if (
    pairAddress &&
    normalized.toLowerCase() ===
      pairAddress.toLowerCase()
  ) {
    return;
  }

  holders.add(normalized);
}

export function extractInitialHoldersFromReceipt(
  receipt: any,
  token0Input: string,
  token1Input: string,
  pairAddressInput: string
): string[] {
  try {
    const token0 =
      normalizeAddress(token0Input);

    const token1 =
      normalizeAddress(token1Input);

    const pairAddress =
      normalizeAddress(pairAddressInput);

    const holders =
      new Set<string>();

    const logs =
      receipt?.logs ?? [];

    for (const log of logs) {
      try {
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
          tokenAddress.toLowerCase() !==
            token0.toLowerCase() &&
          tokenAddress.toLowerCase() !==
            token1.toLowerCase()
        ) {
          continue;
        }

        const from =
          topicToAddress(log.topics[1]);

        const to =
          topicToAddress(log.topics[2]);

        /*
         * Initial holder:
         * token was minted from zero address.
         */
        if (
          from.toLowerCase() !==
          ZERO_ADDRESS.toLowerCase()
        ) {
          continue;
        }

        addHolder(
          holders,
          to,
          pairAddress
        );

        if (
          holders.size >= MAX_HOLDERS
        ) {
          break;
        }
      } catch {
        // Ignore malformed individual logs.
      }
    }

    return Array.from(holders)
      .slice(0, MAX_HOLDERS);
  } catch (error) {
    console.warn(
      "Failed to extract holders from receipt:",
      error
    );

    return [];
  }
}

/*
 * Cron and webhook intentionally use
 * the exact same holder extraction logic.
 *
 * No additional eth_getTransactionByHash call
 * is performed here. This keeps the scanner
 * lightweight and avoids unnecessary RPC usage.
 */
export async function extractInitialHolders(
  input: HolderExtractionInput
): Promise<string[]> {
  try {
    const provider =
      getProvider(input.chain);

    const receipt =
      await provider.getTransactionReceipt(
        input.tx_hash
      );

    if (!receipt) {
      console.warn(
        `Transaction receipt not found: ${input.tx_hash}`
      );

      return [];
    }

    return extractInitialHoldersFromReceipt(
      receipt,
      input.token0,
      input.token1,
      input.pair_address
    );
  } catch (error) {
    console.warn(
      `Failed to extract holders for ${input.tx_hash}:`,
      error
    );

    return [];
  }
}
