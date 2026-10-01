import { Hono } from "hono";

import {
  paymentMiddleware,
  x402ResourceServer,
} from "@x402/hono";

import {
  HTTPFacilitatorClient,
} from "@x402/core/server";

import {
  ExactEvmScheme,
} from "@x402/evm/exact/server";

import {
  ChainName,
  FACTORIES,
  NewPair,
} from "./types";

import {
  isSupportedChain,
} from "./chains";

import {
  KVNamespaceLike,
  KVStoreImpl,
} from "./kv";

import {
  handleWebhook,
} from "./webhook";

import {
  handleCron,
} from "./scanner";

interface Env {
  PAIRS_KV: KVNamespaceLike;

  PAY_TO?: string;

  X402_NETWORK?: string;

  X402_PRICE?: string;

  X402_FACILITATOR_URL?: string;
}

interface ScanRequest {
  chain?: string;

  factories?: string[];

  window_minutes?: number;
}

interface ScanResponse {
  chain: ChainName;

  window_minutes: number;

  from_block: number;

  to_block: number;

  new_pairs: NewPair[];

  total_found: number;
}

const app =
  new Hono<{
    Bindings: Env;
  }>();

const DEFAULT_WINDOW_MINUTES = 5;

const MAX_WINDOW_MINUTES = 10;

const HEALTH_KEY =
  "health:status";

const X402_DEFAULT_NETWORK =
  "eip155:84532";

const X402_DEFAULT_PRICE =
  "$0.01";

const X402_DEFAULT_FACILITATOR =
  "https://x402.org/facilitator";

function normalizeAddress(
  address: string
): string {
  return address.toLowerCase();
}

function getFactories(
  chain: ChainName
): string[] {
  return FACTORIES[
    chain
  ].map(normalizeAddress);
}

function validateFactories(
  chain: ChainName,
  factories?: string[]
): string[] | null {
  if (
    factories === undefined
  ) {
    return getFactories(chain);
  }

  if (
    !Array.isArray(factories) ||
    factories.length === 0
  ) {
    return null;
  }

  const allowed =
    new Set(
      getFactories(chain)
    );

  const normalized =
    factories.map(
      normalizeAddress
    );

  for (
    const factory of normalized
  ) {
    if (
      !allowed.has(factory)
    ) {
      return null;
    }
  }

  return [
    ...new Set(normalized),
  ];
}

function validateWindow(
  value: unknown
): number | null {
  if (
    value === undefined
  ) {
    return DEFAULT_WINDOW_MINUTES;
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_WINDOW_MINUTES
  ) {
    return null;
  }

  return value;
}

async function getLatestBlock(
  chain: ChainName
): Promise<number> {
  const rpc =
    chain === "ethereum"
      ? "https://eth.llamarpc.com"
      : "https://bsc-dataseed.binance.org";

  const response =
    await fetch(
      rpc,
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json",
        },

        body: JSON.stringify({
          jsonrpc: "2.0",

          id: 1,

          method:
            "eth_blockNumber",

          params: [],
        }),
      }
    );

  if (!response.ok) {
    throw new Error(
      `RPC returned ${response.status}`
    );
  }

  const body =
    (await response.json()) as {
      result?: string;
      error?: unknown;
    };

  if (
    body.error ||
    typeof body.result !==
      "string"
  ) {
    throw new Error(
      "RPC did not return a valid block number"
    );
  }

  const block =
    Number(
      BigInt(body.result)
    );

  if (
    !Number.isSafeInteger(block)
  ) {
    throw new Error(
      "RPC returned an unsafe block number"
    );
  }

  return block;
}

async function updateHealth(
  kv: KVNamespaceLike,
  field:
    | "last_webhook"
    | "last_cron"
): Promise<void> {
  const current =
    (await kv.get<{
      last_webhook:
        string | null;

      last_cron:
        string | null;
    }>(
      HEALTH_KEY,
      "json"
    )) ?? {
      last_webhook: null,

      last_cron: null,
    };

  current[field] =
    new Date().toISOString();

  await kv.put(
    HEALTH_KEY,

    JSON.stringify(
      current
    ),

    {
      expirationTtl:
        60 * 60 * 24 * 7,
    }
  );
}

async function getHealth(
  kv: KVNamespaceLike
): Promise<{
  last_webhook:
    string | null;

  last_cron:
    string | null;

  pairs_cached: number;
}> {
  const status =
    (await kv.get<{
      last_webhook:
        string | null;

      last_cron:
        string | null;
    }>(
      HEALTH_KEY,
      "json"
    )) ?? {
      last_webhook: null,

      last_cron: null,
    };

  const store =
    new KVStoreImpl(kv);

  const [
    ethereumPairs,
    bscPairs,
  ] = await Promise.all([
    store.listByChain(
      "ethereum"
    ),

    store.listByChain(
      "bsc"
    ),
  ]);

  return {
    last_webhook:
      status.last_webhook,

    last_cron:
      status.last_cron,

    pairs_cached:
      ethereumPairs.length +
      bscPairs.length,
  };
}

function createX402Middleware(
  env: Env
) {
  const payTo =
    env.PAY_TO?.trim();

  if (!payTo) {
    throw new Error(
      "PAY_TO is not configured"
    );
  }

  const network =
    env.X402_NETWORK ??
    X402_DEFAULT_NETWORK;

  const price =
    env.X402_PRICE ??
    X402_DEFAULT_PRICE;

  const facilitator =
    new HTTPFacilitatorClient({
      url:
        env.X402_FACILITATOR_URL ??
        X402_DEFAULT_FACILITATOR,
    });

  const resourceServer =
    new x402ResourceServer(
      facilitator
    );

  resourceServer.register(
    network,
    new ExactEvmScheme()
  );

  return paymentMiddleware(
    {
      "POST /scan": {
        accepts: [
          {
            scheme: "exact",

            price,

            network,

            payTo,

            maxTimeoutSeconds:
              60,
          },
        ],

        description:
          "Scan recently created AMM pairs",

        mimeType:
          "application/json",
      },
    },

    resourceServer
  );
}

app.get(
  "/health",
  async (c) => {
    try {
      const health =
        await getHealth(
          c.env.PAIRS_KV
        );

      return c.json({
        status: "ok",

        ...health,
      });
    } catch (error) {
      console.warn(
        "Health check failed:",
        error
      );

      return c.json(
        {
          status:
            "error",
        },

        500
      );
    }
  }
);

app.post(
  "/webhook",
  async (c) => {
    try {
      const response =
        await handleWebhook(
          c.req.raw,
          c.env.PAIRS_KV
        );

      await updateHealth(
        c.env.PAIRS_KV,
        "last_webhook"
      );

      return response;
    } catch (error) {
      console.warn(
        "Webhook route failed:",
        error
      );

      return new Response(
        "OK",
        {
          status: 200,
        }
      );
    }
  }
);

/*
 * IMPORTANT:
 *
 * x402 is attached directly to the POST /scan
 * route instead of using app.use("/scan", ...).
 *
 * This guarantees that the payment middleware
 * and the actual scan handler participate in the
 * same Hono route chain.
 */
app.post(
  "/scan",

  async (c, next) => {
    try {
      const middleware =
        createX402Middleware(
          c.env
        );

      return middleware(
        c,
        next
      );
    } catch (error) {
      console.warn(
        "x402 configuration error:",
        error
      );

      return c.json(
        {
          error:
            "Payment service is not configured",
        },

        500
      );
    }
  },

  async (c) => {
    let body:
      ScanRequest;

    try {
      body =
        (await c.req.json()) as
          ScanRequest;
    } catch {
      return c.json(
        {
          error:
            "Invalid JSON body",
        },

        400
      );
    }

    if (
      typeof body !==
        "object" ||
      body === null ||
      Array.isArray(body)
    ) {
      return c.json(
        {
          error:
            "Request body must be an object",
        },

        400
      );
    }

    if (
      typeof body.chain !==
        "string" ||
      !isSupportedChain(
        body.chain
      )
    ) {
      return c.json(
        {
          error:
            'chain must be "ethereum" or "bsc"',
        },

        400
      );
    }

    const chain:
      ChainName =
      body.chain;

    const windowMinutes =
      validateWindow(
        body.window_minutes
      );

    if (
      windowMinutes ===
      null
    ) {
      return c.json(
        {
          error:
            "window_minutes must be an integer between 1 and 10",
        },

        400
      );
    }

    const factories =
      validateFactories(
        chain,
        body.factories
      );

    if (
      factories === null
    ) {
      return c.json(
        {
          error:
            "factories contains an unsupported factory address",
        },

        400
      );
    }

    try {
      const currentBlock =
        await getLatestBlock(
          chain
        );

      const blocksPerMinute =
        chain ===
        "ethereum"
          ? 5
          : 20;

      const fromBlock =
        Math.max(
          0,

          currentBlock -
            windowMinutes *
              blocksPerMinute
        );

      const store =
        new KVStoreImpl(
          c.env.PAIRS_KV
        );

      const cached =
        await store.listByChain(
          chain
        );

      const factorySet =
        new Set(
          factories.map(
            normalizeAddress
          )
        );

      const newPairs =
        cached.filter(
          (
            pair: NewPair
          ) => {
            const pairFactory =
              normalizeAddress(
                pair.factory
              );

            return (
              factorySet.has(
                pairFactory
              ) &&

              pair.block_number >=
                fromBlock &&

              pair.block_number <=
                currentBlock
            );
          }
        );

      const response:
        ScanResponse = {
        chain,

        window_minutes:
          windowMinutes,

        from_block:
          fromBlock,

        to_block:
          currentBlock,

        new_pairs:
          newPairs,

        total_found:
          newPairs.length,
      };

      return c.json(
        response,
        200
      );
    } catch (error) {
      console.warn(
        "Scan failed:",
        error
      );

      return c.json(
        {
          error:
            "Scan failed",
        },

        500
      );
    }
  }
);

export default {
  fetch:
    app.fetch,

  async scheduled(
    _event:
      ScheduledEvent,

    env:
      Env,

    ctx:
      ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          await handleCron(
            env.PAIRS_KV
          );

          await updateHealth(
            env.PAIRS_KV,
            "last_cron"
          );
        } catch (error) {
          console.warn(
            "Scheduled scan failed:",
            error
          );
        }
      })()
    );
  },
};
