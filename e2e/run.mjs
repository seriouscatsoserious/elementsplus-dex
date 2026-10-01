// Full-product end-to-end test on a live Elements+ regtest chain.
//
// Drives two real Chrome profiles (Maker, Taker) with the regtest build of the
// Elements+ wallet extension loaded over a CDP pipe (branded Chrome ignores
// --load-extension), the DEX web app (Vite dev server) and the running DEX
// server. Every step clicks/types in the real UIs and approves in the
// extension's approval windows. Funding/mining goes through the node CLI.
//
//   node run.mjs            (see README.md for env vars)
//
// Prerequisites (not started here): Elements+ regtest node with a funded
// `miner` wallet, the Esplora bridge, the DEX server, and a built regtest
// extension (`node scripts/build-regtest.mjs` in the wallet repo).
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const here = import.meta.dirname;
const env = process.env;
const WALLET_REPO = path.resolve(env.WALLET_REPO ?? path.join(here, "..", "..", "elementsplus-wallet-extension"));
const EXTENSION = path.resolve(env.EXTENSION_DIST ?? path.join(WALLET_REPO, ".regtest", "dist", "chromium"));
const CLI = env.ELEMENTS_CLI ?? path.join(WALLET_REPO, ".local", "elementsplus-node", "build-regtest", "bin", "elements-functional-test-cli");
const DATADIR = env.ELEMENTS_DATADIR ?? path.join(WALLET_REPO, ".regtest", "node");
const RPC_PORT = env.ELEMENTS_RPC_PORT ?? "18884";
const DEX_API = (env.DEX_API ?? "http://127.0.0.1:8790/api").replace(/\/+$/, "");
const DEX_WEB = (env.DEX_WEB ?? "http://127.0.0.1:5173").replace(/\/+$/, "");
const ESPLORA = (env.ESPLORA_URL ?? "http://127.0.0.1:43199/api").replace(/\/+$/, "");
const CHROME = env.CHROME_BIN ?? ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((file) => existsSync(file));
const OUT = path.resolve(env.E2E_OUT ?? path.join(tmpdir(), "elementsplus-dex-e2e"));
const HEADLESS = env.E2E_HEADED !== "1";
const PASSWORD = "disposable e2e password";
const FUND_ECX = "10";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${args.join(" ")}\n`);
function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}
const num = (text) => Number(String(text).replace(/[,\s ]/g, ""));
const results = [];
async function step(name, fn) {
  log(`=== ${name}`);
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, ms: Date.now() - started });
    log(`PASS ${name}${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
    return detail;
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
    log(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`);
    throw error;
  }
}

// ------------------------------------------------------------------ chain

function cli(...args) {
  const result = spawnSync(CLI, ["-chain=elementsregtest", `-datadir=${DATADIR}`, `-rpcport=${RPC_PORT}`, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`elements-cli ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const miner = (...args) => cli("-rpcwallet=miner", ...args);
let minerAddress;
async function mine(label) {
  minerAddress ??= miner("getnewaddress");
  const [hash] = JSON.parse(miner("generatetoaddress", "1", minerAddress));
  const height = Number(cli("getblockcount"));
  await until(async () => Number(await (await fetch(`${ESPLORA}/blocks/tip/height`)).text()) >= height, `explorer at ${height}`);
  await until(async () => (await getJson(`${DEX_API}/health`)).tip >= height, `DEX server at ${height}`);
  log(`mined ${label ?? ""} block ${hash.slice(0, 12)}… height ${height}`);
  return height;
}
function mempool() {
  return JSON.parse(cli("getrawmempool"));
}

async function getJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} → ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function until(predicate, label, timeout = 60_000, interval = 250) {
  let lastError;
  for (const end = Date.now() + timeout; Date.now() < end; await delay(interval)) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ""}`);
}

// ------------------------------------------------------------------ CDP

class PipeCdp {
  #next = 1;
  #pending = new Map();
  #buffer = "";
  constructor(input, output) {
    this.input = input;
    output.on("data", (chunk) => {
      this.#buffer += chunk.toString("utf8");
      for (let end = this.#buffer.indexOf("\0"); end >= 0; end = this.#buffer.indexOf("\0")) {
        const message = JSON.parse(this.#buffer.slice(0, end));
        this.#buffer = this.#buffer.slice(end + 1);
        if (message.id === undefined) {
          this.onEvent?.(message);
          continue;
        }
        const pending = this.#pending.get(message.id);
        if (pending === undefined) continue;
        this.#pending.delete(message.id);
        if (message.error !== undefined) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) })}\0`);
    });
  }
}

// Helpers injected into every evaluated expression.
const PRELUDE = `
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const visible = (el) => !!el && el.getClientRects().length > 0;
const byText = (selector, text) => $$(selector).find((el) => visible(el) && el.textContent.replace(/\\s+/g, " ").trim().includes(text));
const setValue = (el, value) => {
  if (!el) throw new Error("setValue: no element");
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
};
const clickEl = (el, what) => {
  if (!el) throw new Error("click: not found: " + what);
  if (el.disabled) throw new Error("click: disabled: " + what);
  el.scrollIntoView({ block: "center" });
  el.click();
  return true;
};
const clickText = (selector, text) => clickEl(byText(selector, text), selector + " ~ " + text);
`;

class Page {
  constructor(browser, targetId, sessionId, label) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.label = label;
  }
  async eval(expression) {
    const result = await this.browser.cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${PRELUDE}\n return (${expression}); })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, this.sessionId);
    if (result.exceptionDetails !== undefined) throw new Error(`[${this.label}] ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  }
  async waitFor(expression, label, timeout = 30_000) {
    let last;
    for (const end = Date.now() + timeout; Date.now() < end; await delay(150)) {
      try {
        const value = await this.eval(expression);
        if (value) return value;
      } catch (error) {
        last = error;
      }
    }
    await this.shot(`timeout-${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`).catch(() => undefined);
    const text = await this.eval("document.body?.innerText.slice(0, 1500)").catch(() => "<unavailable>");
    throw new Error(`[${this.label}] Timed out: ${label}${last ? ` (${last.message})` : ""}\n--- page text ---\n${text}`);
  }
  async click(selector, text) {
    await this.waitFor(`(() => { const el = byText(${JSON.stringify(selector)}, ${JSON.stringify(text)}); return !!el && !el.disabled; })()`, `enabled ${selector} "${text}"`);
    await this.eval(`clickText(${JSON.stringify(selector)}, ${JSON.stringify(text)})`);
  }
  async type(selector, value) {
    await this.waitFor(`visible($(${JSON.stringify(selector)}))`, `input ${selector}`);
    await this.eval(`setValue($(${JSON.stringify(selector)}), ${JSON.stringify(value)})`);
  }
  async text(selector) {
    return this.eval(`$(${JSON.stringify(selector)})?.textContent ?? null`);
  }
  async goto(url) {
    await this.browser.cdp.send("Page.navigate", { url }, this.sessionId);
    await delay(300);
    await this.waitFor("document.readyState === 'complete'", `load ${url}`);
  }
  async reload() {
    await this.browser.cdp.send("Page.reload", { ignoreCache: true }, this.sessionId);
    await delay(300);
    await this.waitFor("document.readyState === 'complete'", "reload");
  }
  async shot(name) {
    await this.browser.cdp.send("Page.bringToFront", {}, this.sessionId).catch(() => undefined);
    const { data } = await this.browser.cdp.send("Page.captureScreenshot", { format: "png" }, this.sessionId);
    const file = path.join(OUT, `${String(++Page.counter).padStart(2, "0")}-${this.browser.name.toLowerCase()}-${name}.png`);
    await writeFile(file, Buffer.from(data, "base64"));
    Page.shots.push(file);
  }
  static counter = 0;
  static shots = [];
}

class Browser {
  constructor(name) {
    this.name = name;
    this.seenApprovals = new Set();
    this.logs = [];
  }
  async launch() {
    this.profile = await mkdtemp(path.join(OUT, `profile-${this.name.toLowerCase()}-`));
    const args = [
      "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
      ...(HEADLESS ? ["--headless=new"] : []),
      ...(env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
      `--user-data-dir=${this.profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync",
      "--window-size=1360,900", "about:blank",
    ];
    this.chrome = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    this.chrome.stderr.on("data", () => undefined);
    this.cdp = new PipeCdp(this.chrome.stdio[3], this.chrome.stdio[4]);
    this.cdp.onEvent = (message) => {
      if (message.method === "Runtime.consoleAPICalled") {
        const text = message.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
        this.logs.push(`[console.${message.params.type}] ${text}`);
      } else if (message.method === "Runtime.exceptionThrown") {
        this.logs.push(`[exception] ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
      }
    };
    const { id } = await this.cdp.send("Extensions.loadUnpacked", { path: EXTENSION });
    this.extensionId = id;
    log(`${this.name}: Chrome up, extension ${id}`);
  }
  async attach(targetId, label) {
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await this.cdp.send("Runtime.enable", {}, sessionId);
    await this.cdp.send("Page.enable", {}, sessionId);
    return new Page(this, targetId, sessionId, `${this.name}/${label}`);
  }
  async open(url, label) {
    const { targetId } = await this.cdp.send("Target.createTarget", { url });
    const page = await this.attach(targetId, label);
    await page.waitFor("document.readyState === 'complete'", `load ${url}`);
    return page;
  }
  async targets() {
    return (await this.cdp.send("Target.getTargets")).targetInfos;
  }
  /** Wait for a new approval window, attach, and return it. */
  async approvalWindow(label, timeout = 30_000) {
    const target = await until(async () => (await this.targets()).find((t) => t.type === "page" && t.url.includes("/src/ui/approve.html") && !this.seenApprovals.has(t.targetId)), `${this.name} approval window (${label})`, timeout, 150).catch(async (error) => {
      const targets = (await this.targets()).map((t) => `${t.type} ${t.url}`).join("\n  ");
      const pages = [this.dex, this.wallet].filter(Boolean);
      const texts = await Promise.all(pages.map((p) => p.eval("document.body.innerText.slice(0, 1200)").catch((e) => String(e))));
      throw new Error(`${error.message}\ntargets:\n  ${targets}\n--- pages ---\n${texts.join("\n-----\n")}`);
    });
    this.seenApprovals.add(target.targetId);
    return this.attach(target.targetId, `approve:${label}`);
  }
  /** Approve the next approval window with the given button label. */
  async approve(label, button = "Approve", { shotName, expect } = {}) {
    const win = await this.approvalWindow(label);
    await win.waitFor(`!!byText(".foot .btn", ${JSON.stringify(button)}) || !!byText("h1", "Couldn't prepare") || !!byText("h1", "Something went wrong")`, `${label} approval UI`);
    const failed = await win.eval(`byText("h1", "Couldn't prepare") || byText("h1", "Something went wrong") ? document.body.innerText : null`);
    if (failed) {
      await win.shot(`${shotName ?? label}-failed`).catch(() => undefined);
      throw new Error(`${label}: approval window shows an error:\n${failed}`);
    }
    if (expect) await win.waitFor(`document.body.innerText.includes(${JSON.stringify(expect)})`, `${label} review mentions "${expect}"`);
    await win.shot(shotName ?? `approve-${label}`);
    const review = await win.eval("document.body.innerText");
    await win.eval(`clickText(".foot .btn", ${JSON.stringify(button)})`);
    if (button === "Approve") {
      // Window shows "Approved" and closes itself, or an error line.
      await until(async () => {
        const gone = !(await this.targets()).some((t) => t.targetId === win.targetId);
        if (gone) return true;
        const state = await win.eval(`(() => { const err = $(".err:not([hidden])"); if (err && err.textContent) return "ERR:" + err.textContent; return byText("h1", "Approved") ? "ok" : null; })()`).catch(() => "ok");
        if (typeof state === "string" && state.startsWith("ERR:")) throw new Error(`${label}: approval failed: ${state.slice(4)}`);
        return state === "ok";
      }, `${label} approved`, 60_000);
    }
    return review;
  }
  async close() {
    try { await this.cdp.send("Browser.close"); } catch { /* already gone */ }
    await Promise.race([new Promise((resolve) => this.chrome.once("exit", resolve)), delay(3_000)]);
    if (this.chrome.exitCode === null) this.chrome.kill("SIGKILL");
  }
}

// ------------------------------------------------------------------ wallet UI

async function onboard(browser) {
  const wallet = await browser.open(`chrome-extension://${browser.extensionId}/src/ui/wallet.html`, "wallet");
  browser.wallet = wallet;
  await wallet.waitFor("$('#app')?.dataset.screen === 'welcome'", "welcome screen");
  await wallet.shot("welcome");
  await wallet.click("button", "Create a new wallet");
  await wallet.waitFor("$('#app')?.dataset.screen === 'show-phrase'", "show-phrase screen");
  await wallet.eval(`clickEl($(".cover"), "reveal")`);
  const words = await wallet.eval(`$$(".words .w").map((el) => el.textContent.trim())`);
  assert(words.length === 12 && words.every((w) => /^[a-z]+$/.test(w)), `12-word phrase shown, got ${JSON.stringify(words)}`);
  await wallet.shot("phrase");
  await wallet.click("button", "I've written it down");
  await wallet.waitFor("$('#app')?.dataset.screen === 'confirm-phrase'", "confirm-phrase screen");
  const positions = await wallet.eval(`$$("input[aria-label^='Word #']").map((el) => Number(el.getAttribute("aria-label").slice(6)))`);
  assert(positions.length === 3, "three confirm words requested");
  for (const position of positions) await wallet.type(`input[aria-label='Word #${position}']`, words[position - 1]);
  await wallet.shot("confirm-words");
  await wallet.click(".foot .btn", "Continue");
  await wallet.waitFor("$('#app')?.dataset.screen === 'password'", "password screen");
  await wallet.type("input[aria-label='New password']", PASSWORD);
  await wallet.type("input[aria-label='Confirm password']", PASSWORD);
  await wallet.click(".foot .btn", "Create wallet");
  await wallet.waitFor("$('#app')?.dataset.screen === 'home'", "home screen", 60_000);
  await wallet.click("button.act", "Receive");
  await wallet.waitFor("$('#app')?.dataset.screen === 'receive' && /^ert1[0-9a-z]+$/.test($('[data-testid=receive-address]')?.textContent ?? '')", "receive address");
  const address = (await wallet.text("[data-testid=receive-address]")).trim();
  await wallet.shot("receive");
  await wallet.click("button[aria-label=Back]", "");
  await wallet.waitFor("$('#app')?.dataset.screen === 'home'", "home again");
  return { address, words };
}

/** Reload the wallet popup and read Home: ECX balance and token rows. */
async function walletHome(browser, { unlock = true } = {}) {
  const wallet = browser.wallet;
  await wallet.reload();
  await wallet.waitFor("['home', 'lock'].includes($('#app')?.dataset.screen)", "home or lock");
  if (unlock && (await wallet.eval("$('#app').dataset.screen")) === "lock") {
    await wallet.type("input[type=password]", PASSWORD);
    await wallet.click("button", "Unlock");
  }
  await wallet.waitFor("$('#app')?.dataset.screen === 'home' && !$('.tok.skeleton') && !$('.big.dim')", "home balances loaded", 60_000);
  return wallet.eval(`({
    ecx: $(".bal .big").firstChild.textContent.trim(),
    error: byText(".empty p", "Couldn't reach") ? $(".empty").innerText : null,
    tokens: $$(".list .tok").map((row) => ({
      name: row.querySelector(".nm strong").firstChild?.textContent ?? "",
      unverified: !!row.querySelector(".nm .tag"),
      sub: row.querySelector(".nm small").textContent,
      amount: row.querySelector(".amt strong").textContent,
      unit: row.querySelector(".amt small").textContent,
    })),
  })`);
}

async function waitWalletHome(browser, predicate, label, timeout = 60_000) {
  let home;
  await until(async () => {
    home = await walletHome(browser);
    return predicate(home);
  }, `${browser.name} wallet: ${label}`, timeout, 1_500).catch((error) => {
    throw new Error(`${error.message}; last home: ${JSON.stringify(home)}`);
  });
  return home;
}

async function walletActivity(browser) {
  const wallet = browser.wallet;
  await wallet.reload();
  await wallet.waitFor("$('#app')?.dataset.screen === 'home'", "home");
  await wallet.click("nav.nav button", "Activity");
  await wallet.waitFor("$('#app')?.dataset.screen === 'activity' && !$('.tx.skeleton')", "activity loaded", 60_000);
  return wallet.eval(`$$(".list .tx").map((row) => ({
    title: row.querySelector(".nm strong").textContent,
    sub: row.querySelector(".nm small").textContent,
    amount: row.querySelector(".amt strong").textContent.replace(/\u2212/g, "-"),
    status: row.querySelector(".amt small").textContent.replace(/\u2212/g, "-"),
  }))`);
}

// ------------------------------------------------------------------ DEX UI

async function dexConnect(browser, page) {
  await page.waitFor(`!!byText("nav.nav .wal", "Connect wallet") || !!$("nav.nav .wal .av")`, "wallet button");
  if (await page.eval(`!!$("nav.nav .wal .av")`)) return;
  await page.click("nav.nav .wal", "Connect wallet");
  await browser.approve("connect", "Connect", { shotName: "approve-connect" });
  await page.waitFor(`!!$("nav.nav .wal .av")`, "connected wallet chip");
}

// ------------------------------------------------------------------ dev server

async function ensureDevServer() {
  const up = async () => {
    try {
      const response = await fetch(`${DEX_WEB}/`);
      return response.ok;
    } catch {
      return false;
    }
  };
  if (await up()) {
    log(`DEX web already serving at ${DEX_WEB}`);
    return undefined;
  }
  const url = new URL(DEX_WEB);
  const web = path.join(here, "..", "web");
  const child = spawn("bash", ["-lc", `source ~/.nvm/nvm.sh >/dev/null 2>&1; exec npx vite --host ${url.hostname} --port ${url.port} --strictPort`], {
    cwd: web,
    env: { ...env, DEX_SERVER: new URL(DEX_API).origin },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  await until(up, `vite dev server at ${DEX_WEB}`, 60_000, 300).catch((error) => {
    throw new Error(`${error.message}\n${output}`);
  });
  log(`started vite dev server (pid ${child.pid}) at ${DEX_WEB}`);
  return child;
}

// ------------------------------------------------------------------ scenario

async function main() {
  assert(CHROME !== undefined, "set CHROME_BIN");
  assert(existsSync(path.join(EXTENSION, "manifest.json")), `no regtest extension at ${EXTENSION} (run node scripts/build-regtest.mjs in the wallet repo)`);
  await mkdir(OUT, { recursive: true });
  // Screenshots from a previous run would be confusing next to this run's.
  for (const file of await readdir(OUT)) if (/^\d\d-.*\.png$|-console\.log$/.test(file)) await rm(path.join(OUT, file), { force: true });
  const health = await getJson(`${DEX_API}/health`);
  const POLICY = health.policy_asset;
  log(`DEX server ok: tip ${health.tip}, network ${health.network}, policy ${POLICY.slice(0, 12)}…`);
  assert(cli("getblockhash", "0") === health.genesis_hash, "DEX server genesis matches node");
  const vite = await ensureDevServer();

  const maker = new Browser("Maker");
  const taker = new Browser("Taker");
  const ctx = { txids: {} };
  try {
    await maker.launch();
    await taker.launch();

    // 1. Onboard
    await step("1. onboard new wallets (create → phrase → confirm → password) and read Receive address", async () => {
      const [m, t] = await Promise.all([onboard(maker), onboard(taker)]);
      ctx.makerAddress = m.address;
      ctx.takerAddress = t.address;
      assert(m.address !== t.address, "distinct wallets");
      return { maker: m.address, taker: t.address };
    });

    // 2. Fund
    await step(`2. fund both with ${FUND_ECX} ECX from miner, mine, Home shows balance`, async () => {
      ctx.txids.fundMaker = miner("sendtoaddress", ctx.makerAddress, FUND_ECX);
      ctx.txids.fundTaker = miner("sendtoaddress", ctx.takerAddress, FUND_ECX);
      await mine("funding");
      const [mh, th] = await Promise.all([
        waitWalletHome(maker, (h) => num(h.ecx) === Number(FUND_ECX), `ECX ${FUND_ECX}`),
        waitWalletHome(taker, (h) => num(h.ecx) === Number(FUND_ECX), `ECX ${FUND_ECX}`),
      ]);
      await maker.wallet.shot("home-funded");
      await taker.wallet.shot("home-funded");
      return { fundMaker: ctx.txids.fundMaker, fundTaker: ctx.txids.fundTaker, makerEcx: mh.ecx, takerEcx: th.ecx };
    });

    // 3. Launch + list
    const tag = Date.now().toString(36).slice(-5).toUpperCase();
    const token = { name: `E2E Token ${tag}`, ticker: `E2E${tag}`.slice(0, 8), supply: "1000", decimals: "2", listAmount: "100", listPrice: "0.01" };
    await step("3. Maker launches a token on the DEX (connect, issue, register, list) and it is on the book", async () => {
      const page = await maker.open(`${DEX_WEB}/launch`, "dex");
      maker.dex = page;
      await page.waitFor("window.elementsplus?.isElementsPlus === true", "provider injected");
      await dexConnect(maker, page);
      await page.type("input[placeholder='Nova']", token.name);
      await page.type("input[placeholder='NOVA']", token.ticker);
      await page.type("input[placeholder='21,000,000']", token.supply);
      await page.type("input[inputmode=numeric][maxlength='1']", token.decimals);
      await page.waitFor(`$("input[placeholder='2,100,000']") !== null`, "list fields visible");
      await page.type("input[placeholder='2,100,000']", token.listAmount);
      await page.type("input[placeholder='0.003']", token.listPrice);
      await page.waitFor(`document.body.innerText.includes("Sell order asks 1 ECX")`, "listing total computed");
      await page.shot("launch-form");
      await page.click("button[type=submit]", "Create token");
      await maker.approve("issuance", "Approve", { shotName: "approve-issuance", expect: token.ticker });
      const listingReview = await maker.approve("listing", "Approve", { shotName: "approve-listing", expect: token.ticker });
      assert(!listingReview.includes("UNVERIFIED") && listingReview.replace(/\u2212/g, "-").includes(`-100 ${token.ticker}`), `listing review shows the verified new token:\n${listingReview}`);
      await page.waitFor(`$$(".steps .step-dot.done").length === 3 || $$(".steps .step-dot.error").length > 0`, "launch steps finished", 90_000);
      const errors = await page.eval(`$$(".steps .step-dot.error").length ? document.querySelector(".note.warn")?.innerText ?? "error" : null`);
      await page.shot("launch-done");
      assert(errors === null, `launch progress error: ${errors}`);
      const asset = await until(async () => (await getJson(`${DEX_API}/assets`)).items.find((a) => a.contract?.name === token.name), "registry entry");
      ctx.asset = asset.asset_id;
      ctx.txids.issuance = asset.issuance_txid;
      const mempoolBefore = mempool();
      await mine("launch");
      const book = await until(async () => {
        const b = await getJson(`${DEX_API}/markets/${ctx.asset}/${POLICY}/book`);
        return b.asks.length === 1 ? b : null;
      }, "ask on the book");
      ctx.listOffer = { txid: book.asks[0].txid, vout: book.asks[0].vout };
      const markets = await getJson(`${DEX_API}/markets`);
      const market = markets.items.find((m) => m.base === ctx.asset && m.quote === POLICY);
      assert(market && market.best_ask != null, `market listed with an ask: ${JSON.stringify(market)}`);
      assert(asset.contract.ticker === token.ticker && Number(asset.contract.precision) === 2, "registry contract matches");
      await waitWalletHome(maker, (h) => h.tokens.some((t) => t.name === token.name && !t.unverified && num(t.amount.replace(/,/g, "")) === 1000), `maker holds 1000 verified (offered coin stays in the wallet until filled) ${token.ticker}`, 15_000);
      await page.goto(`${DEX_WEB}/markets/${ctx.asset}/${POLICY}`);
      await page.waitFor(`document.body.innerText.includes(${JSON.stringify(token.ticker)}) && $$(".ob.dn").length >= 1`, "market page shows the ask");
      await page.shot("market-listed");
      return { assetId: ctx.asset, issuanceTxid: ctx.txids.issuance, offer: `${ctx.listOffer.txid}:${ctx.listOffer.vout}`, mempoolMined: mempoolBefore, bestAsk: market.best_ask };
    });

    // 4. Taker swap
    await step("4. Taker swaps ECX → token on the Swap page, filling the listed offer", async () => {
      const before = await walletHome(maker);
      ctx.makerEcxBeforeFill = num(before.ecx);
      const page = await taker.open(`${DEX_WEB}/swap`, "dex");
      taker.dex = page;
      await page.waitFor("window.elementsplus?.isElementsPlus === true", "provider injected");
      await dexConnect(taker, page);
      // Pick pay = ECX, receive = the new token (search by asset id).
      await page.waitFor(`!!$("button[aria-label^='Token to pay']")`, "pay token button");
      await page.eval(`clickEl($("button[aria-label^='Token to pay']"), "pay picker")`);
      await page.waitFor(`!!$("input.search")`, "token picker");
      await page.type("input.search", POLICY.slice(0, 16));
      await page.click("button.tok-row", "ECX");
      await page.eval(`clickEl($("button[aria-label^='Token to receive']"), "receive picker")`);
      await page.waitFor(`!!$("input.search")`, "token picker");
      await page.type("input.search", ctx.asset.slice(0, 16));
      await page.click("button.tok-row", token.ticker);
      await page.type("input[inputmode=decimal].amt", "1");
      await page.waitFor(`!!byText("button.btn.lg", "Swap") && !byText("button.btn.lg", "Swap").disabled && document.body.innerText.includes("Fills 1 order")`, "swap quote ready", 30_000);
      await page.shot("swap-quote");
      await page.click("button.btn.lg", "Swap");
      await taker.approve("swap", "Approve", { shotName: "approve-swap" });
      const toast = await page.waitFor(`(() => { const t = $$("[role=status], [role=alert], .toast").map((e) => e.innerText).join(" | "); return /Swapped|Swap failed/.test(t) ? t : null; })()`, "swap toast", 60_000);
      await page.shot("swap-done");
      assert(/Swapped/.test(toast), `swap toast: ${toast}`);
      const pool = mempool();
      assert(pool.length >= 1, "swap tx in mempool");
      await mine("swap");
      const trades = await until(async () => {
        const t = await getJson(`${DEX_API}/markets/${ctx.asset}/${POLICY}/trades`);
        const items = t.items ?? t;
        return items.length >= 1 ? items : null;
      }, "trade recorded", 60_000);
      ctx.txids.swap = trades[0].txid;
      const offer = await until(async () => {
        const o = await getJson(`${DEX_API}/offers/${ctx.listOffer.txid}/${ctx.listOffer.vout}`);
        return o.status === "filled" ? o : null;
      }, "offer status filled", 60_000);
      const takerHome = await waitWalletHome(taker, (h) => h.tokens.some((t) => t.name === token.name && !t.unverified && num(t.amount) === 100), `token ${token.ticker} 100 verified`);
      await taker.wallet.shot("home-token");
      const makerHome = await waitWalletHome(maker, (h) => num(h.ecx) === ctx.makerEcxBeforeFill + 1, "maker ECX +1");
      await maker.wallet.shot("home-after-fill");
      const row = takerHome.tokens.find((t) => t.name === token.name);
      assert(row.sub === token.ticker, `ticker shown: ${row.sub}`);
      return { swapTxid: ctx.txids.swap, trade: trades[0], offerStatus: offer.status, takerToken: row, makerEcx: `${ctx.makerEcxBeforeFill} → ${makerHome.ecx}` };
    });

    // 5. Limit order + cancel
    await step("5. Maker places a limit sell on Markets, then cancels it from Your open orders", async () => {
      const page = maker.dex;
      await page.goto(`${DEX_WEB}/markets/${ctx.asset}/${POLICY}`);
      await page.waitFor(`!!$("nav.nav .wal .av")`, "connected");
      await page.click("[role=tablist][aria-label=Side] button", "Sell");
      await page.click("[role=tablist][aria-label='Order type'] button", "Limit");
      await page.type("label.fl input[placeholder='0.00']", "0.02");
      await page.type("label.fl input[placeholder='0']", "50");
      await page.waitFor(`!!byText("button[type=submit]", "Place sell order") && !byText("button[type=submit]", "Place sell order").disabled`, "place order enabled");
      await page.shot("limit-form");
      await page.click("button[type=submit]", "Place sell order");
      await maker.approve("limit-offer", "Approve", { shotName: "approve-limit-offer" });
      const placed = await page.waitFor(`(() => { const t = $$("[role=status], [role=alert], .toast").map((e) => e.innerText).join(" | "); return /order placed|not listed|Order failed/.test(t) ? t : null; })()`, "order toast", 60_000);
      assert(/order placed/.test(placed), `limit order toast: ${placed}`);
      const offers = await until(async () => {
        const b = await getJson(`${DEX_API}/markets/${ctx.asset}/${POLICY}/book`);
        return b.asks.length === 1 ? b.asks : null;
      }, "limit ask on the book");
      ctx.limitOffer = { txid: offers[0].txid, vout: offers[0].vout };
      await page.waitFor(`!!byText("td.r button", "Cancel")`, "open order row with Cancel", 30_000);
      await page.shot("open-orders");
      await page.click("td.r button", "Cancel");
      await maker.approve("cancel", "Approve", { shotName: "approve-cancel" });
      const cancelled = await page.waitFor(`(() => { const t = $$("[role=status], [role=alert], .toast").map((e) => e.innerText).join(" | "); return /Order cancelled|Cancel failed/.test(t) ? t : null; })()`, "cancel toast", 60_000);
      assert(/Order cancelled/.test(cancelled), `cancel toast: ${cancelled}`);
      await mine("cancel");
      const offer = await until(async () => {
        const o = await getJson(`${DEX_API}/offers/${ctx.limitOffer.txid}/${ctx.limitOffer.vout}`);
        return o.status === "cancelled" ? o : null;
      }, "offer status cancelled", 60_000);
      const out = await getJson(`${ESPLORA}/tx/${ctx.limitOffer.txid}/outspend/${ctx.limitOffer.vout}`);
      ctx.txids.cancel = out.txid;
      await page.reload();
      await page.waitFor(`document.body.innerText.includes("No open orders")`, "open orders empty", 30_000);
      await page.shot("orders-cancelled");
      return { limitOffer: `${ctx.limitOffer.txid}:${ctx.limitOffer.vout}`, cancelTxid: ctx.txids.cancel, status: offer.status };
    });

    // 6. Wallet send
    await step("6. Maker sends 25 token to Taker from the wallet Send screen", async () => {
      const home = await waitWalletHome(maker, (h) => h.tokens.some((t) => t.name === token.name && num(t.amount) === 900), "maker holds 900 token");
      const wallet = maker.wallet;
      await wallet.click(".list .tok", token.name);
      await wallet.waitFor("$('#app')?.dataset.screen === 'send'", "send screen");
      await wallet.type("input[aria-label='Recipient address']", ctx.takerAddress);
      await wallet.type("input[aria-label='Amount']", "25");
      await wallet.shot("send-form");
      await wallet.click(".foot .btn", "Continue");
      await wallet.waitFor("$('#app')?.dataset.screen === 'confirm' || ($('.err:not([hidden])')?.textContent ?? '') !== ''", "confirm screen", 60_000);
      const err = await wallet.eval("$('#app').dataset.screen === 'confirm' ? null : $('.err:not([hidden])').textContent");
      assert(err === null, `send prepare error: ${err}`);
      await wallet.shot("send-confirm");
      await wallet.click(".foot .btn", "Confirm");
      await wallet.waitFor("$('#app')?.dataset.screen === 'sent' || ($('.err:not([hidden])')?.textContent ?? '') !== ''", "sent screen", 60_000);
      const err2 = await wallet.eval("$('#app').dataset.screen === 'sent' ? null : $('.err:not([hidden])').textContent");
      assert(err2 === null, `send error: ${err2}`);
      await wallet.shot("sent");
      const pool = mempool();
      await mine("send");
      ctx.txids.send = pool.find((txid) => txid !== ctx.txids.swap);
      const [mh, th] = await Promise.all([
        waitWalletHome(maker, (h) => h.tokens.some((t) => t.name === token.name && num(t.amount) === 875), "maker token 875"),
        waitWalletHome(taker, (h) => h.tokens.some((t) => t.name === token.name && num(t.amount) === 125), "taker token 125"),
      ]);
      await maker.wallet.shot("home-final");
      await taker.wallet.shot("home-final");
      const [ma, ta] = [await walletActivity(maker), await walletActivity(taker)];
      await maker.wallet.shot("activity");
      await taker.wallet.shot("activity");
      const sentRow = ma.find((r) => r.title === "Sent" && r.amount.includes("-25"));
      const recvRow = ta.find((r) => r.title === "Received" && r.amount.includes("+25"));
      assert(sentRow, `maker Activity has Sent -25: ${JSON.stringify(ma)}`);
      assert(recvRow, `taker Activity has Received +25: ${JSON.stringify(ta)}`);
      assert(ma.some((r) => r.title === "Issued token"), `maker Activity has issuance: ${JSON.stringify(ma)}`);
      assert(ta.some((r) => r.title === "Swapped"), `taker Activity has swap: ${JSON.stringify(ta)}`);
      return { sendTxid: ctx.txids.send, makerToken: mh.tokens.find((t) => t.name === token.name).amount, takerToken: th.tokens.find((t) => t.name === token.name).amount, makerActivity: ma, takerActivity: ta, before: home.ecx };
    });
  } finally {
    for (const b of [maker, taker]) {
      if (b.logs.length) await writeFile(path.join(OUT, `${b.name.toLowerCase()}-console.log`), b.logs.join("\n")).catch(() => undefined);
      if (b.cdp) await b.close();
      if (b.profile && env.E2E_KEEP_PROFILES !== "1") await rm(b.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
    }
    if (vite) {
      try { process.kill(-vite.pid, "SIGTERM"); } catch { /* gone */ }
    }
    await writeFile(path.join(OUT, "results.json"), JSON.stringify({ results, txids: ctx.txids, asset: ctx.asset, screenshots: Page.shots }, null, 2));
    log("---- summary ----");
    for (const r of results) log(`${r.ok ? "PASS" : "FAIL"} ${r.name} (${(r.ms / 1000).toFixed(1)}s)`);
    log(`screenshots: ${OUT}`);
  }
}

await main().then(() => log("E2E PASSED"), (error) => {
  process.stderr.write(`E2E FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
