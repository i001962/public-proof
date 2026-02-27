/**
 * OpenClaw ↔ GunDB Chat Bridge
 *
 * Subscribes to the GunDB inbox index for this agent's public key.
 * When a new inbound message arrives, calls the OpenClaw /hooks/agent
 * endpoint and writes the signed reply back into the Gun thread.
 *
 * Required environment variables:
 *   OPENCLAW_AGENT_SEA   – JSON string of the SEA keypair (same value as
 *                          OPENCLAW_AGENT_SEA used by your OpenClaw instance)
 *   OPENCLAW_HOOKS_TOKEN – shared secret configured in OpenClaw hooks.token
 *   OPENCLAW_BASE_URL    – base URL of the running OpenClaw instance
 *                          (e.g. http://localhost:3000)
 *
 * Optional environment variables:
 *   OPENCLAW_AGENT_ID    – human-readable agent id forwarded in the webhook
 *                          prompt (default: "agent")
 *   GUN_PEERS            – comma-separated Gun relay URLs
 *                          (defaults to the public relay peers used by the
 *                          chat UI)
 */

"use strict";

const Gun = require("gun");
require("gun/sea");

const SEA = Gun.SEA;

// ── Config ────────────────────────────────────────────────────────────────────

const MY_PAIR = JSON.parse(process.env.OPENCLAW_AGENT_SEA || "null");
const HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN || "";
const BASE_URL = (process.env.OPENCLAW_BASE_URL || "").replace(/\/$/, "");
const AGENT_ID = process.env.OPENCLAW_AGENT_ID || "agent";
const GUN_PEERS = (
  process.env.GUN_PEERS ||
  "https://gun-manhattan.herokuapp.com/gun,https://gun-agent-8786540a978c.herokuapp.com/gun"
)
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

if (!MY_PAIR || !MY_PAIR.pub || !MY_PAIR.priv) {
  console.error(
    "OPENCLAW_AGENT_SEA is required and must be a valid SEA keypair JSON string."
  );
  process.exit(1);
}
if (!HOOKS_TOKEN) {
  console.error("OPENCLAW_HOOKS_TOKEN is required.");
  process.exit(1);
}
if (!BASE_URL) {
  console.error("OPENCLAW_BASE_URL is required.");
  process.exit(1);
}

const MY_PUB = MY_PAIR.pub;
const MESSAGE_ID_LENGTH = 9;

// Time to wait (ms) for Gun's .once() to fire and collect all cached messages
// before processing. Gun propagates data asynchronously; 800 ms covers typical
// relay round-trip times on public peers.
const THREAD_FETCH_TIMEOUT_MS = 800;

// Debounce window (ms) per thread. Rapid sequential inbox updates (e.g. a user
// typing several messages quickly) are collapsed into a single agent reply.
const DEBOUNCE_DELAY_MS = 2000;

// ── GunDB setup ───────────────────────────────────────────────────────────────

const gun = Gun({ peers: GUN_PEERS, localStorage: false, radisk: false });
const root = gun.get("openclaw");

// ── Helpers ───────────────────────────────────────────────────────────────────

function canonicalThreadId(a, b) {
  return [a, b].sort().join("__");
}

/**
 * Fetch and verify all messages in a thread, returning them sorted by
 * timestamp (oldest first).
 */
function fetchThreadMessages(threadId) {
  return new Promise((resolve) => {
    const msgs = [];
    const seen = new Set();
    const verifications = [];

    root
      .get("chat")
      .get("threads")
      .get(threadId)
      .get("messages")
      .map()
      .once((obj, id) => {
        if (!obj || !id || seen.has(id)) return;
        seen.add(id);
        const { from, signed } = obj;
        if (!from || !signed) return;

        const p = SEA.verify(signed, from)
          .then((v) => { if (v) msgs.push(v); })
          .catch(() => {});
        verifications.push(p);
      });

    // Wait for Gun .once to fire, then wait for all verifications to settle
    setTimeout(async () => {
      await Promise.allSettled(verifications);
      resolve(msgs.sort((a, b) => a.when - b.when));
    }, THREAD_FETCH_TIMEOUT_MS);
  });
}

/**
 * Call OpenClaw POST /hooks/agent and return the reply text.
 */
async function callHooksAgent(threadId, latestMsg) {
  const prompt =
    `You have received an inbound chat message in thread ${threadId}.\n` +
    `From: ${latestMsg.from}\n` +
    `Message: ${latestMsg.text}\n\n` +
    `Please reply to this message.`;

  const res = await fetch(`${BASE_URL}/hooks/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${HOOKS_TOKEN}`,
    },
    body: JSON.stringify({
      agentId: AGENT_ID,
      wakeMode: "now",
      prompt,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `OpenClaw /hooks/agent returned ${res.status}: ${await res.text()}`
    );
  }

  const data = await res.json();
  // OpenClaw returns the agent reply in `reply`, `response`, or `output`
  // depending on the wakeMode and delivery configuration.
  // See: https://docs.openclaw.ai/automation/webhook
  return data.reply || data.response || data.output || "(no reply)";
}

/**
 * Sign and write a reply message into the Gun thread, and update the
 * inbox index so the other party can see the latest activity.
 */
async function writeReply(threadId, fromPub, replyText) {
  const msg = {
    type: "chat",
    from: MY_PUB,
    to: fromPub,
    when: Date.now(),
    text: replyText,
  };

  const signed = await SEA.sign(msg, MY_PAIR);
  const id = Gun.text.random(MESSAGE_ID_LENGTH);

  root
    .get("chat")
    .get("threads")
    .get(threadId)
    .get("messages")
    .get(id)
    .put({ from: MY_PUB, signed });

  // Update inbox index for the other party so they can see our reply
  root.get("inbox").get(fromPub).get(threadId).put({ ts: Date.now(), from: MY_PUB });

  console.log(
    `[bridge] Replied to thread ${threadId}: ${replyText.slice(0, 80)}${replyText.length > 80 ? "…" : ""}`
  );
}

// ── Main: subscribe to inbox index ───────────────────────────────────────────

// Debounce per thread so rapid sequential updates trigger only one reply
const debounceTimers = new Map();

console.log(
  `[bridge] Listening on inbox for pub ${MY_PUB.slice(0, 8)}… via ${GUN_PEERS.join(", ")}`
);

root
  .get("inbox")
  .get(MY_PUB)
  .map()
  .on(async (entry, threadId) => {
    if (!entry || !threadId) return;
    // Ignore updates that we ourselves wrote (our own replies)
    if (entry.from === MY_PUB) return;

    // Debounce: if multiple updates arrive within 2 s, handle only the last one
    if (debounceTimers.has(threadId)) {
      clearTimeout(debounceTimers.get(threadId));
    }

    debounceTimers.set(
      threadId,
      setTimeout(async () => {
        console.log(`[bridge] New inbound message in thread ${threadId}`);

        try {
          const messages = await fetchThreadMessages(threadId);
          if (!messages.length) return;

          // Only reply to messages from other agents
          const inbound = messages.filter((m) => m.from !== MY_PUB);
          if (!inbound.length) return;

          const latest = inbound[inbound.length - 1];
          const replyText = await callHooksAgent(threadId, latest);
          await writeReply(threadId, latest.from, replyText);
        } catch (err) {
          console.error(
            `[bridge] Error handling thread ${threadId}:`,
            err.message
          );
        }
      }, DEBOUNCE_DELAY_MS)
    );
  });
