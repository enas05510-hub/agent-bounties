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
  address: string
): void {
  const normalized =
    normalizeAddress(address);

  if (
    normalized.toLowerCase() ===
    ZERO_ADDRESS.toLowerCase()
  ) {
    return;
  }

  holders.add(normalized);
}

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

    const token0 =
      normalizeAddress(input.token0);

    const token1 =
      normalizeAddress(input.token1);

    const pairAddress =
      normalizeAddress(input.pair_address);

    const holders =
      new Set<string>();

    /*
     * Primary source:
     *
     * ERC20 Transfer events where:
     *
     * from == address(0)
     *
     * These represent token minting and therefore
     * provide the strongest signal for initial
     * token recipients.
     */
    for (const log of receipt.logs) {
      try {
        if (
          log.topics[0] !==
          TRANSFER_TOPIC
        ) {
          continue;
        }

        if (
          log.topics.length < 3
        ) {
          continue;
        }

        const tokenAddress =
          normalizeAddress(
            log.address
          );

        if (
          tokenAddress !== token0 &&
          tokenAddress !== token1
        ) {
          continue;
        }

        const from =
          topicToAddress(
            log.topics[1]
          );

        const to =
          topicToAddress(
            log.topics[2]
          );

        if (
          from.toLowerCase() !==
          ZERO_ADDRESS.toLowerCase()
        ) {
          continue;
        }

        if (
          to.toLowerCase() ===
          ZERO_ADDRESS.toLowerCase()
        ) {
          continue;
        }

        addHolder(
          holders,
          to
        );

        if (
          holders.size >=
          MAX_HOLDERS
        ) {
          break;
        }
      } catch {
        /*
         * Ignore malformed individual logs while
         * continuing to process the remaining receipt.
         */
        continue;
      }
    }

    /*
     * If mint events gave us fewer than three
     * addresses, inspect the transaction sender.
     *
     * This is a fallback signal, not a primary
     * holder classification.
     */
    if (
      holders.size < 3
    ) {
      try {
        const transaction =
          await provider.getTransaction(
            input.tx_hash
          );

        if (
          transaction?.from
        ) {
          addHolder(
            holders,
            transaction.from
          );
        }
      } catch (error) {
        console.warn(
          `Failed to read transaction sender for ${input.tx_hash}:`,
          error
        );
      }
    }

    /*
     * V3 pools can create the pool without exposing
     * V2-style reserves or a simple mint pattern.
     *
     * As a final fallback, include the pool address
     * so downstream consumers still receive a
     * deterministic address associated with the
     * newly-created market.
     *
     * It is only added when fewer than three genuine
     * candidate holders were found.
     */
    if (
      holders.size < 3
    ) {
      addHolder(
        holders,
        pairAddress
      );
    }

    return Array.from(
      holders
    ).slice(
      0,
      MAX_HOLDERS
    );
  } catch (error) {
    console.warn(
      `Failed to extract holders for ${input.tx_hash}:`,
      error
    );

    return [];
  }
}
