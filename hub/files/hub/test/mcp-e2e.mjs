// The hub as a connector for Shivo Labs AI (hub/api/mcp.mjs), with the same MCP client the AI app uses
// (@modelcontextprotocol/sdk from ai/app/node_modules, or SDK_DIR). Needs a test hub with Shivo Cloud set up
// (files/test/cloud-folder-e2e.mjs explains the local Files Worker):
//   node hub/test/mcp-e2e.mjs http://localhost:4817
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const HUB = process.argv[2] || "http://localhost:4817";
const SDK = process.env.SDK_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "ai", "app", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
const { Client } = await import(pathToFileURL(join(SDK, "client", "index.js")).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(join(SDK, "client", "streamableHttp.js")).href);
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const text = (r) => r.content?.[0]?.text || "";
const data = (r) => { try { return JSON.parse(text(r)); } catch { return null; } };

// without the hub's header (a web page can't add it), the connector is refused
const bare = await fetch(HUB + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
ok(bare.status === 403, "a request without x-hub is refused (" + bare.status + ")");

const client = new Client({ name: "test", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(HUB + "/mcp"), { requestInit: { headers: { "x-hub": "1" } } }));
ok(true, "connected with the SDK the AI app uses");
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
ok(["cloud_search", "cloud_share_link", "chat_send", "tv_remote", "beam_send", "xtools_renew", "pc_devices"].every((n) => names.includes(n)), `${tools.length} tools: ${names.join(", ")}`);

const call = (name, args = {}) => client.callTool({ name, arguments: args });
const found = data(await call("cloud_search", { query: "beach" }));
ok(found?.items?.[0]?.name === "beach.png" && found.items[0].in === "Holiday", "cloud_search finds beach.png in Holiday: " + text(await call("cloud_search", { query: "beach" })).slice(0, 160));
const top = data(await call("cloud_list", {}));
ok(top?.items?.some((x) => x.name === "Holiday" && x.kind === "folder"), "cloud_list shows the top");
const inner = data(await call("cloud_list", { folder: "holiday" }));
ok(inner?.items?.some((x) => x.name === "beach.png"), "cloud_list of a folder by path (any case)");
const missing = await call("cloud_list", { folder: "Nope/Deeper" });
ok(missing.isError && /No "Nope"/.test(text(missing)), "a wrong path says so: " + text(missing));
const dir = mkdtempSync(join(tmpdir(), "mcp-e2e-")), f = join(dir, "from-ai.txt");
writeFileSync(f, "written by the AI test");
const added = data(await call("cloud_add", { file: f, folder: "Holiday" }));
ok(added?.added === "from-ai.txt", "cloud_add copied a PC file into Holiday");
const link = data(await call("cloud_share_link", { path: "Holiday/from-ai.txt", days: 2 }));
ok(/\/s\/[^#]+#/.test(link?.link || ""), "cloud_share_link made a file link");
const flink = data(await call("cloud_share_link", { path: "Holiday" }));
ok(/\.zip/.test(flink?.of || "") && /\/s\//.test(flink?.link || ""), "and a folder link: " + flink?.of);
ok(data(await call("cloud_move", { path: "Holiday/from-ai.txt", to: "" }))?.moved === "from-ai.txt", "cloud_move to the top");
ok(data(await call("cloud_delete", { path: "from-ai.txt" }))?.trashed === "from-ai.txt", "cloud_delete puts it in the Trash");
const chat = await call("chat_overview");
ok(chat.isError && /Open Chat/.test(text(chat)), "chat without the Chat page's sign-in explains what to do: " + text(chat));
const xs = data(await call("xtools_status"));
ok(Array.isArray(xs?.apps), "xtools_status answers: " + text(await call("xtools_status")).slice(0, 160));
const tv = await call("tv_list");
ok(!tv.isError, "tv_list answers: " + text(tv).slice(0, 120));
const unknown = await call("nope_tool").catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
ok(unknown.isError, "an unknown tool is an error");
await client.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
