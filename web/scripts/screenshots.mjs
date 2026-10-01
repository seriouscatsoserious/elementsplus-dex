// Screenshot the app (run against `npm run dev:mock`).
//   BASE_URL=http://127.0.0.1:5173 OUT=/tmp/screens CHROME=/usr/bin/google-chrome node scripts/screenshots.mjs
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const OUT = process.env.OUT ?? "screens";
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
mkdirSync(OUT, { recursive: true });

const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
];

/** name, path, optional interaction */
const shots = [
  ["swap", "/swap", async (p) => { await p.getByLabel("Amount to pay").fill("100"); await p.waitForTimeout(900); }],
  ["swap-empty-input", "/swap"],
  ["markets", "/markets"],
  ["launch", "/launch", async (p) => {
    await p.getByLabel("Name", { exact: true }).fill("Nova");
    await p.getByLabel("Ticker", { exact: true }).fill("NOVA");
    await p.getByLabel("Total supply").fill("21000000");
    await p.getByLabel("Amount to list").fill("2100000");
    await p.getByLabel("Price per token").fill("0.003");
  }],
  ["swap-no-wallet", "/swap?wallet=none"],
  ["markets-disconnected", "/markets?wallet=disconnected"],
  ["markets-server-down", "/markets?api=down"],
  ["swap-no-markets", "/swap?api=empty"],
];

const only = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
const errors = [];
for (const vp of viewports) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
  for (const [name, path, act] of shots) {
    if (only.length && !only.includes(name)) continue;
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${name}@${vp.name}: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && errors.push(`${name}@${vp.name} console: ${m.text()}`));
    await page.goto(BASE + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    if (act) await act(page);
    await page.waitForTimeout(400);
    const file = join(OUT, `${name}-${vp.name}.png`);
    await page.screenshot({ path: file, fullPage: name === "markets" || name === "launch" });
    console.log(file);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
if (errors.length) {
  console.error("Page errors:\n" + errors.join("\n"));
  process.exitCode = 1;
}
