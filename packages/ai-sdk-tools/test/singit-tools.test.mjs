import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { singitTools, SingItPaymentError } from "../src/index.js";

const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "eip155:84532";
const FACILITATOR = `0x${"0".repeat(39)}2`;
const encode = obj => Buffer.from(JSON.stringify(obj)).toString("base64");
const decode = value => JSON.parse(Buffer.from(value, "base64").toString("utf8"));

function exactOffer({ payTo, amount }) {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: ASSET,
    payTo,
    amount,
    maxTimeoutSeconds: 120,
    extra: { name: "USDC", version: "2", billing: { mode: "exact_ceiling", maxChargeAtomic: amount } },
  };
}

function uptoOffer({ payTo, amount }) {
  return {
    scheme: "upto",
    network: NETWORK,
    asset: ASSET,
    payTo,
    amount,
    maxTimeoutSeconds: 120,
    extra: {
      facilitatorAddress: FACILITATOR,
      assetTransferMethod: "permit2",
      name: "USDC",
      version: "2",
      billing: { mode: "actual_usage", maxChargeAtomic: amount },
    },
  };
}

function startMock({ path = "/v1/chat/completions", amount = "4000", scheme = "exact", paidJson } = {}) {
  const payTo = privateKeyToAccount(generatePrivateKey()).address;
  let unsigned = 0;
  let signed = 0;
  let resourceUrl;
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const paymentHeader = req.headers["payment-signature"];
    if (!paymentHeader) {
      unsigned += 1;
      const offer = scheme === "exact" ? exactOffer({ payTo, amount }) : uptoOffer({ payTo, amount });
      res.setHeader("PAYMENT-REQUIRED", encode({ x402Version: 2, resource: { url: resourceUrl }, accepts: [offer] }));
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payment required." }));
      return;
    }
    signed += 1;
    const paymentPayload = decode(paymentHeader);
    const offer = paymentPayload.accepted;
    const payer =
      paymentPayload.payload?.authorization?.from ||
      paymentPayload.payload?.permit2Authorization?.from;
    const billedAtomic = offer?.scheme === "exact" ? offer.amount : (BigInt(offer.amount) / 2n).toString();
    res.setHeader("payment-response", encode({
      success: true,
      network: offer.network,
      payer,
      transaction: `0x${"ab".repeat(32)}`,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(paidJson ?? {
      id: "mock",
      object: "chat.completion",
      created: 0,
      model: "singit-ask-mock",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello back." }, finish_reason: "stop" }],
      billing: { totalAtomic: billedAtomic },
    }));
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resourceUrl = `${url}${path}`;
      resolve({
        url,
        payTo,
        unsigned: () => unsigned,
        signed: () => signed,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

function toolsFor(merchant, overrides = {}) {
  return singitTools({
    wallet: privateKeyToAccount(generatePrivateKey()),
    network: "base-sepolia",
    guards: { maxPerCall: 0.004, maxPerDay: 0.01 },
    baseUrl: merchant.url,
    payTo: merchant.payTo,
    scheme: "exact",
    spendLog: false,
    ...overrides,
  });
}

test("refuses to build tools without both spend ceilings", () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  assert.throws(
    () => singitTools({ wallet, network: "base-sepolia", payTo: `0x${"1".repeat(40)}` }),
    SingItPaymentError,
  );
  assert.throws(
    () => singitTools({ wallet, network: "base-sepolia", guards: { maxPerCall: 0.01 }, payTo: `0x${"1".repeat(40)}` }),
    /maxPerDay/,
  );
});

test("refuses to build tools without a wallet or network", () => {
  assert.throws(
    () => singitTools({ network: "base-sepolia", guards: { maxPerCall: 0.01, maxPerDay: 1 }, payTo: `0x${"1".repeat(40)}` }),
    /wallet/,
  );
  assert.throws(
    () => singitTools({
      wallet: privateKeyToAccount(generatePrivateKey()),
      guards: { maxPerCall: 0.01, maxPerDay: 1 },
      payTo: `0x${"1".repeat(40)}`,
    }),
    /network/,
  );
});

test("singitAsk refuses an over-ceiling quote without signing", async () => {
  const merchant = await startMock({ amount: "9000", scheme: "exact" });
  try {
    const tools = toolsFor(merchant, { guards: { maxPerCall: 0.001, maxPerDay: 0.01 } });
    await assert.rejects(tools.singitAsk.execute({ prompt: "Hello" }), /per-call ceiling/);
    assert.equal(merchant.unsigned(), 1);
    assert.equal(merchant.signed(), 0);
  } finally {
    await merchant.close();
  }
});

test("singitAsk settles a mocked 402 and records spend", async () => {
  const merchant = await startMock({ amount: "4000", scheme: "exact" });
  try {
    const tools = toolsFor(merchant);
    const result = await tools.singitAsk.execute({ prompt: "Hello" });
    assert.equal(result.choices[0].message.content, "Hello back.");
    assert.equal(result.payment.amountAtomic, "4000");
    const status = await tools.singitSpendStatus.execute({});
    assert.equal(status.maxPerCallUsd, 0.004);
    assert.equal(status.maxPerDayUsd, 0.01);
    assert.equal(status.spentTodayUsd, 0.004);
    assert.ok(status.remainingTodayUsd > 0.005 && status.remainingTodayUsd < 0.007);
    assert.equal(merchant.signed(), 1);
  } finally {
    await merchant.close();
  }
});

test("singitSearch settles a mocked 402", async () => {
  const merchant = await startMock({
    path: "/v1/exa/search",
    amount: "4000",
    scheme: "exact",
    paidJson: {
      results: [{ title: "Mock result", url: "https://example.com" }],
      billing: { totalAtomic: "4000" },
    },
  });
  try {
    const tools = toolsFor(merchant);
    const result = await tools.singitSearch.execute({ query: "x402", numResults: 1 });
    assert.equal(result.results[0].title, "Mock result");
    const status = await tools.singitSpendStatus.execute({});
    assert.equal(status.spentTodayUsd, 0.004);
    assert.equal(merchant.signed(), 1);
  } finally {
    await merchant.close();
  }
});

test("daily total blocks a second call without signing again", async () => {
  const merchant = await startMock({ amount: "4000", scheme: "exact" });
  try {
    const tools = toolsFor(merchant, { guards: { maxPerCall: 0.004, maxPerDay: 0.006 } });
    await tools.singitAsk.execute({ prompt: "First" });
    await assert.rejects(tools.singitAsk.execute({ prompt: "Second" }), /Daily spend cap/);
    assert.equal(merchant.signed(), 1);
    assert.equal(merchant.unsigned(), 2);
  } finally {
    await merchant.close();
  }
});
