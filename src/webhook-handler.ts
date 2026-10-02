import { ethers } from "ethers";

const PAIR_CREATED_TOPIC =
"0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e";

const FACTORIES = new Set([
"0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
"0x1f98431c8ad98523631ae4a59f267346ea31f984",
"0xca143ce32fe78f1f7019d7d551a6402fc5350c73",
"0x0fbcf9fa4f9c56b0f40a671ad40e0805a091865",
]);

const TRANSFER_TOPIC = ethers.id(
"Transfer(address,address,uint256)"
);

type WebhookLog = {
data?: string;
topics?: string[];
account?: {
address?: string;
};
address?: string;
transaction?: {
hash?: string;
};
transactionHash?: string;
};

type WebhookPayload = {
event?: {
data?: {
block?: {
number?: number | string;
logs?: WebhookLog[];
};
};
};
data?: {
block?: {
number?: number | string;
logs?: WebhookLog[];
};
};
block?: {
number?: number | string;
logs?: WebhookLog[];
};
};

interface Env {
PAIRS_KV: KVNamespace;
}

const RPCS: Record<string, string> = {
ethereum: "https://ethereum-rpc.publicnode.com",
bsc: "https://bsc-rpc.publicnode.com",
};

function normalizeAddress(value?: string): string | null {
if (!value) {
return null;
}

try {
return ethers.getAddress(value);
} catch {
return null;
}
}

function getBlockAndLogs(
payload: WebhookPayload
): {
number?: number | string;
logs?: WebhookLog[];
} | null {
return (
payload.event?.data?.block ??
payload.data?.block ??
payload.block ??
null
);
}

function getLogAddress(
log: WebhookLog
): string | null {
return normalizeAddress(
log.account?.address ?? log.address
);
}

function getTransactionHash(
log: WebhookLog
): string | null {
return (
log.transaction?.hash ??
log.transactionHash ??
null
);
}

type ParsedPair = {
token0: string;
token1: string;
pair: string;
pairIndex: bigint;
};

function extractPair(
log: WebhookLog
): ParsedPair | null {
const topics = log.topics ?? [];

if (topics.length < 3) {
return null;
}

if (
topics[0]?.toLowerCase() !==
PAIR_CREATED_TOPIC.toLowerCase()
) {
return null;
}

if (!log.data) {
return null;
}

try {
const token0Raw = ethers.dataSlice(
topics[1],
12,
32
);

```
const token1Raw = ethers.dataSlice(
  topics[2],
  12,
  32
);

const token0 =
  normalizeAddress(token0Raw);

const token1 =
  normalizeAddress(token1Raw);

if (!token0 || !token1) {
  return null;
}

if (log.data.length < 130) {
  return null;
}

const pairRaw = ethers.dataSlice(
  log.data,
  12,
  32
);

const pair =
  normalizeAddress(pairRaw);

if (!pair) {
  return null;
}

const pairIndexRaw =
  ethers.dataSlice(
    log.data,
    32,
    64
  );

const pairIndex =
  BigInt(pairIndexRaw);

return {
  token0,
  token1,
  pair,
  pairIndex,
};


} catch {
return null;
}
}

async function rpc(
rpcUrl: string,
method: string,
params: unknown[]
): Promise<any> {
const response = await fetch(rpcUrl, {
method: "POST",
headers: {
"content-type": "application/json",
},
body: JSON.stringify({
jsonrpc: "2.0",
id: 1,
method,
params,
}),
});

if (!response.ok) {
throw new Error(
`RPC HTTP ${response.status}`
);
}

const json =
await response.json<any>();

if (json.error) {
throw new Error(
json.error.message ??
"RPC request failed"
);
}

return json.result;
}

async function rpcWithRetry(
rpcUrl: string,
method: string,
params: unknown[]
): Promise<any> {
try {
return await rpc(
rpcUrl,
method,
params
);
} catch {
return await rpc(
rpcUrl,
method,
params
);
}
}

async function getReceipt(
rpcUrl: string,
txHash: string
): Promise<any> {
return rpcWithRetry(
rpcUrl,
"eth_getTransactionReceipt",
[txHash]
);
}

async function getCode(
rpcUrl: string,
address: string
): Promise<string> {
return rpcWithRetry(
rpcUrl,
"eth_getCode",
[address, "latest"]
);
}

function extractInitialHolders(
receipt: any,
token0: string,
token1: string,
pair: string
): string[] {
const holders = new Set<string>();
const logs = receipt?.logs ?? [];

for (const log of logs) {
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

if (!tokenAddress) {
  continue;
}

const isToken =
  tokenAddress.toLowerCase() ===
    token0.toLowerCase() ||
  tokenAddress.toLowerCase() ===
    token1.toLowerCase();

if (!isToken) {
  continue;
}

let from: string | null = null;
let to: string | null = null;

try {
  from = normalizeAddress(
    ethers.dataSlice(
      log.topics[1],
      12,
      32
    )
  );

  to = normalizeAddress(
    ethers.dataSlice(
      log.topics[2],
      12,
      32
    )
  );
} catch {
  continue;
}

if (
  from &&
  from !== ethers.ZeroAddress &&
  from.toLowerCase() !==
    pair.toLowerCase()
) {
  holders.add(from);
}

if (
  to &&
  to !== ethers.ZeroAddress &&
  to.toLowerCase() !==
    pair.toLowerCase()
) {
  holders.add(to);
}


}

return Array.from(holders);
}

async function storePair(
env: Env,
chain: string,
pair: ParsedPair,
txHash: string | null,
blockNumber: number,
holders: string[]
): Promise<void> {
const key =
`${chain}:${pair.pair.toLowerCase()}`;

const value = {
chain,
pair: pair.pair,
token0: pair.token0,
token1: pair.token1,
token0_raw: pair.token0,
token1_raw: pair.token1,
pair_index:
pair.pairIndex.toString(),
tx_hash: txHash,
block_number: blockNumber,
holders,
detected_at:
new Date().toISOString(),
};

await env.PAIRS_KV.put(
key,
JSON.stringify(value)
);
}

export async function handleWebhook(
payload: WebhookPayload,
env: Env
): Promise<Response> {
const block =
getBlockAndLogs(payload);

if (!block) {
return new Response(
JSON.stringify({
ok: true,
processed: 0,
reason: "no_block",
}),
{
status: 200,
headers: {
"content-type":
"application/json",
},
}
);
}

const blockNumber = Number(
block.number ?? 0
);

const logs = block.logs ?? [];

let processed = 0;

for (const log of logs) {
const factory =
getLogAddress(log);

```
if (!factory) {
  continue;
}

if (
  !FACTORIES.has(
    factory.toLowerCase()
  )
) {
  continue;
}

const parsed =
  extractPair(log);

if (!par

