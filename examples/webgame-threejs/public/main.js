// @ts-check
// Browser side of the guild-panel example. Loaded as an ES module; the import
// map in index.html resolves "@junjo.io/sdk" to /vendor/sdk/index.js, which
// server.mjs serves from the installed package.

import { Junjo, JunjoError } from "@junjo.io/sdk";

// Proxy mode: no credential in the page. Every request goes to /api/junjo/*
// and server.mjs injects the key after pinning the user id.
const junjo = new Junjo({ proxy: true, baseUrl: "/api/junjo" });

// Display only. The proxy overwrites user ids with its session value, so
// whatever this page sends is untrusted input by design.
const USER_ID = /** @type {import("@junjo.io/sdk").UserId} */ ("demo-player-1");

/** @param {string} id */
function el(id) {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element #${id}`);
  return node;
}

/** @param {unknown} err */
function describeError(err) {
  if (!(err instanceof JunjoError)) return String(err);
  // Branch on err.code (stable), never on err.message (not stable).
  switch (err.code) {
    case "rate_limit_exceeded":
      return `Rate limited. Retry in ${err.retryAfterSeconds ?? "a few"} seconds.`;
    case "already_member":
      return "You are already a member of that guild.";
    case "banned":
      return "This user is banned from that guild.";
    case "permission_denied":
      return "That guild requires an invitation to join.";
    case "bad_request":
      return `Rejected by the server: ${err.message}`;
    case "network_error":
      return "Cannot reach the proxy. Is server.mjs running?";
    case "not_found":
      return "The proxy refused that route, or the guild no longer exists.";
    default:
      return `${err.code}: ${err.message}`;
  }
}

/** @param {string} text */
function setError(text) {
  el("error").textContent = text;
}

async function refresh() {
  const page = await junjo.groups.list({ limit: 50 });
  const list = el("groups");
  list.textContent = "";
  for (const group of page.items) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    const members = `${group.memberCount} member${group.memberCount === 1 ? "" : "s"}`;
    label.textContent = `${group.name} (${group.kind}, ${group.visibility}, ${members})`;
    item.append(label);
    if (group.visibility === "public") {
      const button = document.createElement("button");
      button.textContent = "Join";
      button.addEventListener("click", async () => {
        setError("");
        try {
          await junjo.groups.join(group.id, USER_ID);
          await refresh();
        } catch (err) {
          setError(describeError(err));
        }
      });
      item.append(" ", button);
    }
    list.append(item);
  }
  el("empty").hidden = page.items.length > 0;
}

el("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("");
  const input = /** @type {HTMLInputElement} */ (el("guild-name"));
  try {
    await junjo.groups.create({
      kind: "guild",
      name: input.value,
      visibility: "public",
      creatorUserId: USER_ID,
    });
    input.value = "";
    await refresh();
  } catch (err) {
    setError(describeError(err));
  }
});

async function init() {
  try {
    const info = await junjo.keyInfo();
    el("status").textContent = `Connected through the proxy as ${USER_ID} (game ${info.gameId}).`;
    await refresh();
  } catch (err) {
    setError(describeError(err));
  }
}

void init();
