import { ethers } from "ethers";
import { ChainName } from "./types";
import { CHAINS } from "./chains";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const TRANSFER_TOPIC = ethers.id(
  "Transfer(address,address,uint256)"
);

export interface HolderExtractionInput {
  tx_hash: string;
  chain: ChainName;
  pair_address: string;
  token0: string;
  token1: string;
}

function normalizeAddress(address: string): string {
  return ethers.getAddress(address);
}

function topicToAddress(topic: string): string {
  return normalizeAddress(`0x${topic.slice(-40)}`);
}

function getProvider(chain: ChainName): ethers.JsonRpcProvider {
  const config = CHAINS[chain];

  return new ethers.JsonRpcProvider(config.rpc_url);
}

export async function extractInitialHolders(
  input: HolderExtractionInput
): Promise<string[]> {
  try {
    const provider = getProvider(input.chain);

    const receipt = await provider.getTransactionReceipt(
      input.tx_hash
    );

    if (!receipt) {
      console.warn(
        `Transaction receipt not found: ${input.tx_hash}`
      );
      return [];
    }

    const token0 = normalizeAddress(input.token0);
    const token1 = normalizeAddress(input.token1);
    const pairAddress = normalizeAddress(input.pair_address);

    const holders = new Set<string>();

    for (const log of receipt.logs) {
      if (log.topics[0] !== TRANSFER_TOPIC) {
        continue;
      }

      if (log.topics.length < 3) {
        continue;
      }

      const tokenAddress = normalizeAddress(log.address);

      if (tokenAddress !== token0 && tokenAddress !== token1) {
        continue;
      }

      const from = topicToAddress(log.topics[1]);
      const to = topicToAddress(log.topics[2]);

      if (
        from.toLowerCase() !== ZERO_ADDRESS &&
        from.toLowerCase() !== ZERO_ADDRESS.toLowerCase()
      ) {
        continue;
      }

      if (to.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
        continue;
      }

      holders.add(to);

      if (holders.size >= 10) {
        break;
      }
    }

    const transaction = await provider.getTransaction(input.tx_hash);

    const deployer = transaction?.from
      ? normalizeAddress(transaction.from)
      : null;

    if (deployer) {
      holders.add(deployer);
    }

    holders.add(pairAddress);

    const result = Array.from(holders).slice(0, 10);

    if (result.length < 3) {
      const fallback = new Set<string>();

      if (deployer) {
        fallback.add(deployer);
      }

      fallback.add(pairAddress);

      return Array.from(fallback).slice(0, 10);
    }

    return result;
  } catch (error) {
    console.warn(
      `Failed to extract holders for ${input.tx_hash}:`,
      error
    );

    return [];
  }
}
