// Real @solana/kit signing through SingIt.chat(), with only loopback RPC traffic.
// The client builds and partially signs; funding, simulation and broadcast belong to settlement.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  generateKeyPairSigner, getCompiledTransactionMessageDecoder, getTransactionDecoder, verifySignature,
} from "@solana/kit";
import { SingIt } from "../src/singit.js";
import { NETWORKS } from "../src/pins.js";

const PIN = NETWORKS.solana;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const BLOCKHASH = "11111111111111111111111111111111";
const SLOT = 123456789;
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64");

async function startRpc(t) {
  // Legacy SPL mint layout: two COption<Pubkey>s, supply, decimals, initialized.
  // USDC has 6 decimals. Neither client needs actual supply or mint authorities.
  const mint = Buffer.alloc(82);
  mint[44] = 6;
  mint[45] = 1;
  const calls = [];
  const errors = [];
  const server = http.createServer(async (req, res) => {
    let id = null;
    try {
      assert.equal(req.method, "POST");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      id = request.id;
      assert.equal(request.jsonrpc, "2.0");
      calls.push(request.method);
      let result;
      switch (request.method) {
        case "getAccountInfo":
          assert.equal(request.params[0], PIN.asset);
          assert.equal(request.params[1].encoding, "base64");
          result = { context: { slot: SLOT }, value: {
            data: [mint.toString("base64"), "base64"], executable: false,
            lamports: 1461600, owner: TOKEN_PROGRAM, rentEpoch: 0, space: mint.length,
          } };
          break;
        case "getLatestBlockhash":
          result = { context: { slot: SLOT }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: SLOT + 150 } };
          break;
        case "getSlot":
          result = SLOT;
          break;
        default:
          assert.fail(`Unexpected RPC method: ${request.method}`);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch (error) {
      errors.push(error);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, errors };
}

for (const scheme of ["upto", "exact"]) {
  test(`chat() signs a Solana ${scheme} payment with a Kit 8 signer offline`, async t => {
    const rpc = await startRpc(t);
    const signer = await generateKeyPairSigner();
    const feePayer = (await generateKeyPairSigner()).address;
    const offer = {
      scheme, network: PIN.caip, asset: PIN.asset, payTo: PIN.payTo,
      amount: "3000", maxTimeoutSeconds: 300,
      extra: { feePayer, ...(scheme === "upto" ? {
        receiverAuthorizer: PIN.payTo, withdrawDelay: 300, billing: { maxChargeAtomic: "3000" },
      } : {}) },
    };
    const originalOffer = structuredClone(offer);
    // Block any accidental external RPC fallback before it reaches the transport.
    const localFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", (input, init) => {
      assert.equal(new URL(input instanceof Request ? input.url : input).origin, rpc.url);
      return localFetch(input, init);
    });
    let requests = 0;
    let payment;
    const billed = scheme === "upto" ? "1500" : offer.amount;
    const client = new SingIt({
      network: "solana", solanaSigner: signer, rpcUrl: rpc.url, baseUrl: rpc.url,
      maxPerCallUsd: 0.003, maxPerDayUsd: 0.01,
      fetchImpl: async (url, init) => {
        requests++;
        assert.equal(url, `${rpc.url}/v1/chat/completions`);
        const header = new Headers(init.headers).get("payment-signature");
        if (!header) return new Response("{}", {
          status: 402, headers: { "payment-required": encode({
            x402Version: 2, resource: { url }, accepts: [offer],
          }) },
        });
        payment = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Hello back." } }],
          billing: { totalAtomic: billed },
        }));
      },
    });

    const answer = await client.chat({ messages: [{ role: "user", content: "Hello" }], scheme });
    assert.equal(requests, 2);
    assert.equal(answer.choices[0].message.content, "Hello back.");
    assert.deepEqual(answer.payment, { scheme, network: "solana", amountAtomic: billed });
    assert.equal(client.limiter.remainingAtomic(), 10000n - BigInt(billed));
    assert.equal(payment.x402Version, 2);
    assert.deepEqual(payment.accepted, originalOffer);
    assert.deepEqual(offer, originalOffer);

    // upto returns a channel openTransaction; exact returns a transfer transaction.
    const encoded = scheme === "upto" ? payment.payload.openTransaction : payment.payload.transaction;
    assert.equal(typeof encoded, "string");
    assert.ok(encoded.length > 0);
    const bytes = Buffer.from(encoded, "base64");
    assert.equal(bytes.toString("base64"), encoded);
    const transaction = getTransactionDecoder().decode(bytes);
    const signature = transaction.signatures[signer.address];
    assert.ok(signature, "the transaction must contain the payer's signature");
    assert.equal(await verifySignature(signer.keyPair.publicKey, signature, transaction.messageBytes), true);
    assert.equal(transaction.signatures[feePayer], null, "the facilitator has yet to sign");
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    assert.equal(message.staticAccounts[0], feePayer);
    assert.equal(message.lifetimeToken, BLOCKHASH);
    assert.ok(message.staticAccounts.includes(PIN.asset));
    if (scheme === "upto") {
      assert.equal(payment.payload.from, signer.address);
      assert.equal(payment.payload.authorizedSigner, offer.extra.receiverAuthorizer);
      assert.equal(payment.payload.deposit, offer.amount);
      assert.equal(payment.payload.maxAmount, offer.amount);
      assert.equal(payment.payload.openSlot, String(SLOT));
      assert.equal(typeof payment.payload.channelId, "string");
    }
    assert.deepEqual(rpc.errors, []);
    // No simulateTransaction, balance lookup or sendTransaction is needed to sign.
    assert.deepEqual(rpc.calls, ["getAccountInfo", "getLatestBlockhash", ...(scheme === "upto" ? ["getSlot"] : [])]);
  });
}
