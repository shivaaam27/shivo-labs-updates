// Sign-in (OAuth) for remote connectors, the way Claude Code does it: the app registers itself with
// the service, the user presses Allow in their browser once, and the service sends them back to
// /api/mcp/oauth/callback on this app. Tokens are kept per connector address in
// ~\.fabra-labs-ai\connector-logins.json, encrypted with Windows' own protection (DPAPI), and the
// SDK refreshes them by itself. The AI never sees them.
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { protectValues, unprotectValues } from "./secrets.mjs";

export function makeMcpAuth(dataDir, redirectUrl) {
  const file = join(dataDir, "connector-logins.json");
  const store = {}; // connector address -> { client: { info, redirect }, tokens, verifier, discovery }
  const pending = new Map(); // state -> { url, at }: sign-ins started here and not finished yet
  const authUrls = new Map(); // connector address -> the service's sign-in page, while one is waiting

  const ready = (async () => {
    let enc; try { enc = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
    try {
      for (const [k, v] of Object.entries(await unprotectValues(enc))) { try { store[k] = JSON.parse(v); } catch {} }
    } catch (e) { console.error("Connector sign-ins couldn't be unlocked:", e.message); }
  })();

  let saving = Promise.resolve();
  const persist = () => (saving = saving.then(async () => {
    const plain = Object.fromEntries(Object.entries(store).map(([k, v]) => [k, JSON.stringify({ ...v, verifier: undefined })]));
    writeFileSync(file, JSON.stringify(Object.keys(plain).length ? await protectValues(plain) : {}, null, 2));
  }).catch((e) => console.error("Connector sign-ins couldn't be saved:", e.message)));

  function provider(url) {
    const rec = () => (store[url] ||= {});
    return {
      get redirectUrl() { return redirectUrl; },
      get clientMetadata() {
        return { client_name: "Shivo Labs AI", redirect_uris: [redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
      },
      state() { const s = crypto.randomBytes(16).toString("hex"); pending.set(s, { url, at: Date.now() }); return s; },
      // A registration made for another port (the dev copy, say) doesn't fit this redirect: register again.
      clientInformation() { const c = store[url]?.client; return c && c.redirect === redirectUrl ? c.info : undefined; },
      saveClientInformation(info) { rec().client = { info, redirect: redirectUrl }; return persist(); },
      tokens() { return store[url]?.tokens; },
      saveTokens(t) { rec().tokens = t; return persist(); },
      redirectToAuthorization(u) { authUrls.set(url, u.href); }, // opened by signIn(), never in the middle of a chat
      saveCodeVerifier(v) { rec().verifier = v; },
      codeVerifier() { const v = store[url]?.verifier; if (!v) throw new Error("No sign-in is in progress for this connector."); return v; },
      saveDiscoveryState(d) { rec().discovery = d; },
      discoveryState() { return store[url]?.discovery; },
      invalidateCredentials(scope) {
        const r = store[url]; if (!r) return;
        if (scope === "all") delete store[url]; else delete r[scope]; // client, tokens, verifier or discovery
        return persist();
      },
    };
  }

  return {
    ready: () => ready,
    provider,
    signedIn: (url) => !!store[url]?.tokens,
    waitingUrl: (url) => authUrls.get(url),
    async signOut(url) { delete store[url]; authUrls.delete(url); await persist(); },
    // The browser came back from the service with a code: swap it for tokens. Returns the connector address.
    async finish(state, code) {
      const p = pending.get(String(state || ""));
      if (!p || Date.now() - p.at > 15 * 60000) throw new Error("This sign-in link is old or wasn't started in this app. Start the sign-in again under Settings → Connectors.");
      pending.delete(state);
      const r = await auth(provider(p.url), { serverUrl: p.url, authorizationCode: String(code || "") });
      if (r !== "AUTHORIZED") throw new Error("The service didn't accept the sign-in. Try again.");
      authUrls.delete(p.url);
      return p.url;
    },
  };
}
