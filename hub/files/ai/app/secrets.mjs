// Secrets: tokens and API keys the AI can USE without ever SEEING them.
// Stored in ~\.fabra-labs-ai\secrets.json, each value encrypted with Windows DPAPI (only this Windows
// user on this PC can decrypt it). The AI only learns the names. A value is put into a command's
// environment only when that command mentions the secret's name ($env:NAME), and any copy of a
// value in command output is replaced with [secret NAME] before the AI or the screen sees it.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const NAME_RE = /^[A-Z_][A-Z0-9_]{1,63}$/;
let file = "", values = new Map(), ready = Promise.resolve();

function ps(script, input) {
  return new Promise((done, fail) => {
    const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) return fail(new Error(String(errOut || err.message).trim().split("\n")[0]));
      done(out);
    });
    child.stdin.end(input);
  });
}
// stdin: JSON {name: text}; stdout: JSON {name: base64}. ProtectedData with CurrentUser scope.
const PROTECT = `Add-Type -AssemblyName System.Security; $j = [Console]::In.ReadToEnd() | ConvertFrom-Json; $o = @{}; foreach ($p in $j.PSObject.Properties) { $b = [Text.Encoding]::UTF8.GetBytes([string]$p.Value); $o[$p.Name] = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser')) }; $o | ConvertTo-Json -Compress`;
const UNPROTECT = `Add-Type -AssemblyName System.Security; $j = [Console]::In.ReadToEnd() | ConvertFrom-Json; $o = @{}; foreach ($p in $j.PSObject.Properties) { try { $b = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([string]$p.Value), $null, 'CurrentUser'); $o[$p.Name] = [Text.Encoding]::UTF8.GetString($b) } catch { } }; $o | ConvertTo-Json -Compress`;

const readStore = () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };

export function initSecrets(path) {
  file = path;
  ready = (async () => {
    const stored = readStore(); if (!Object.keys(stored).length) return;
    try {
      const out = JSON.parse((await ps(UNPROTECT, JSON.stringify(stored))).trim() || "{}");
      values = new Map(Object.entries(out).filter(([, v]) => typeof v === "string"));
    } catch (e) { console.error("Secrets couldn't be unlocked:", e.message); }
  })();
  return ready;
}
export const secretsReady = () => ready;
export const secretNames = () => [...values.keys()].sort();
export const listSecrets = () => {
  const stored = readStore();
  return Object.keys(stored).sort().map((name) => ({ name, ok: values.has(name), hint: values.has(name) ? "…" + values.get(name).slice(-3) : null }));
};

export async function setSecret(name, value) {
  name = String(name || "").trim().toUpperCase();
  if (!NAME_RE.test(name)) throw new Error("Use a name like GITHUB_TOKEN: capital letters, digits and _ only, starting with a letter.");
  value = String(value ?? "");
  const stored = readStore();
  if (!value) { delete stored[name]; values.delete(name); }
  else {
    if (value.length > 20000) throw new Error("That value is too long.");
    if (value.length < 4) throw new Error("That value is too short to be a secret.");
    const enc = JSON.parse((await ps(PROTECT, JSON.stringify({ [name]: value }))).trim());
    if (!enc[name]) throw new Error("Windows couldn't encrypt it.");
    stored[name] = enc[name]; values.set(name, value);
  }
  writeFileSync(file, JSON.stringify(stored, null, 2));
  return name;
}

// The secrets a command asks for, as environment variables: only names the command mentions.
export function envFor(command) {
  const env = {}; const text = String(command || "");
  for (const [k, v] of values) if (new RegExp(`(^|[^A-Za-z0-9_])${k}([^A-Za-z0-9_]|$)`).test(text)) env[k] = v;
  return env;
}
// Hide any secret value that shows up in text (output, errors, files the AI reads).
export function scrub(text) {
  let s = String(text ?? "");
  if (!values.size || !s) return s;
  for (const [k, v] of values) if (v.length >= 4 && s.includes(v)) s = s.split(v).join(`[secret ${k}]`);
  return s;
}
export const hasSecrets = () => values.size > 0;
export const secretValue = (name) => values.get(name);
