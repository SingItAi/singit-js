// The AgentAllowance limiter option: X-SingIt-Limiter on the unpaid request, and the 402's X-SingIt-Spend-Limit
// refusing an offer that does not fit before anything is reserved or signed. Offline, mocked fetch only.
import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SingIt, SingItPaymentError, spendLimitFromResponse } from "../src/index.js";
import { NETWORKS } from "../src/pins.js";

const encode = obj => Buffer.from(JSON.stringify(obj)).toString("base64");
const LIMITER = `0x${"1".repeat(40)}`;
const NETWORK = NETWORKS["base-sepolia"].caip;
const url = "http://localhost/v1/chat/completions";

const spendLimit = (fits, reason) => ({
  v: 1, limiter: LIMITER, network: NETWORK, remainingTodayAtomic: "2500", perPurchaseCapAtomic: "5000",
  spendableNowAtomic: "2500", offers: [{ scheme: "exact", network: NETWORK, amountAtomic: "4000", fits, ...(reason ? { reason } : {}) }],
});

function setup({ limit, limiter = LIMITER } = {}) {
  const payer = privateKeyToAccount(generatePrivateKey());
  const payee = privateKeyToAccount(generatePrivateKey());
  const requests = [];
  let signs = 0;
  const client = new SingIt({ spendLog: false,
    evmAccount: payer, network: "base-sepolia", baseUrl: "http://localhost",
    payTo: payee.address, maxPerCallUsd: 0.004, maxPerDayUsd: 0.006, limiter,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (new URL(request.url).origin !== "http://localhost") return new Response("elsewhere");
      if (!request.headers.has("payment-signature")) return new Response("{}", {
        status: 402, headers: {
          "payment-required": encode({
            x402Version: 2, resource: { url }, accepts: [{
              scheme: "exact", network: NETWORK, asset: NETWORKS["base-sepolia"].asset, payTo: payee.address,
              amount: "4000", maxTimeoutSeconds: 120, extra: {},
            }],
          }),
          ...(limit ? { "x-singit-spend-limit": JSON.stringify(limit) } : {}),
        },
      });
      return new Response(JSON.stringify({ billing: { totalAtomic: "4000" } }), {
        headers: { "payment-response": encode({ network: NETWORK, payer: payer.address, transaction: "0xreceipt" }) },
      });
    },
  });
  client._sign = async (_scheme, offer) => {
    signs++;
    return { accepted: offer, payload: { authorization: { from: payer.address } } };
  };
  const paid = () => requests.filter(r => r.headers.has("payment-signature")).length;
  return { client, requests, signs: () => signs, paid };
}

const invoke = (client, method) => method === "paidFetch"
  ? client.paidFetch({ scheme: "exact" })(new Request(url, { method: "POST", body: '{"stream":false}' }))
  : client.chat({ messages: [{ role: "user", content: "Hello" }], scheme: "exact" });

test("an invalid limiter address is refused at construction", () => {
  for (const limiter of ["0x123", "not-an-address", `0x${"g".repeat(40)}`, 42]) {
    assert.throws(() => new SingIt({ spendLog: false, evmPrivateKey: generatePrivateKey(), network: "base-sepolia",
      payTo: `0x${"2".repeat(40)}`, maxPerCallUsd: 1, maxPerDayUsd: 1, limiter }), SingItPaymentError);
  }
});

for (const method of ["chat", "paidFetch"]) {
  test(`${method} sends X-SingIt-Limiter on the unpaid request`, async () => {
    const { client, requests } = setup({ limit: spendLimit(true) });
    await invoke(client, method);
    assert.equal(requests[0].headers.has("payment-signature"), false);
    assert.equal(requests[0].headers.get("x-singit-limiter"), LIMITER);
  });

  test(`${method} sends no X-SingIt-Limiter without the option`, async () => {
    const { client, requests } = setup({ limiter: null });
    await invoke(client, method);
    assert.ok(requests.every(r => !r.headers.has("x-singit-limiter")));
  });

  test(`${method} refuses an offer marked fits:false before signing or sending payment`, async () => {
    const { client, signs, paid } = setup({ limit: spendLimit(false, "over_remaining_today") });
    await assert.rejects(invoke(client, method), error => {
      assert.ok(error instanceof SingItPaymentError);
      assert.match(error.message, /over_remaining_today/);
      assert.match(error.message, /remainingTodayAtomic=2500/);
      assert.match(error.message, /spendableNowAtomic=2500/);
      assert.match(error.message, /perPurchaseCapAtomic=5000/);
      return true;
    });
    assert.equal(signs(), 0);
    assert.equal(paid(), 0);
    assert.equal(client.limiter.remainingAtomic(), 6000n);
    assert.equal(client.lastSpendLimit.offers[0].reason, "over_remaining_today");
  });

  for (const fits of [true, null]) {
    test(`${method} signs and pays an offer marked fits:${fits}, exposing lastSpendLimit`, async () => {
      const { client, signs, paid } = setup({ limit: spendLimit(fits, fits === null ? "not_checked" : undefined) });
      await invoke(client, method);
      assert.equal(signs(), 1);
      assert.equal(paid(), 1);
      assert.equal(client.lastSpendLimit.remainingTodayAtomic, "2500");
      assert.equal(client.lastSpendLimit.offers[0].fits, fits);
      assert.equal(client.limiter.remainingAtomic(), 2000n);
    });
  }

  test(`${method} without the header behaves as before and still enforces the daily cap`, async () => {
    const { client, signs, paid } = setup({ limit: null });
    await invoke(client, method);
    assert.equal(client.lastSpendLimit, null);
    await assert.rejects(invoke(client, method), /Daily spend cap/);
    assert.equal(signs(), 1);
    assert.equal(paid(), 1);
  });
}

test("a fits:false entry for a different offer does not refuse the selected one", async () => {
  const limit = spendLimit(true);
  limit.offers.push({ scheme: "upto", network: NETWORK, amountAtomic: "4000", fits: false, reason: "over_per_purchase_cap" });
  const { client, signs } = setup({ limit });
  await invoke(client, "chat");
  assert.equal(signs(), 1);
});

test("paidFetch never sends X-SingIt-Limiter to another origin", async () => {
  const { client, requests } = setup();
  const response = await client.paidFetch()("http://elsewhere.example/v1/x", { method: "POST", body: "{}" });
  assert.equal(await response.text(), "elsewhere");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.has("x-singit-limiter"), false);
});

test("spendLimitFromResponse parses the header and ignores absent or malformed values", () => {
  const info = spendLimit(false, "limiter_paused");
  assert.deepEqual(spendLimitFromResponse(new Response("", { headers: { "X-SingIt-Spend-Limit": JSON.stringify(info) } })), info);
  assert.equal(spendLimitFromResponse(new Response("")), null);
  assert.equal(spendLimitFromResponse(new Response("", { headers: { "X-SingIt-Spend-Limit": "{not json" } })), null);
  assert.equal(spendLimitFromResponse(new Response("", { headers: { "X-SingIt-Spend-Limit": "[1]" } })), null);
  assert.equal(spendLimitFromResponse(null), null);
});
