// V-Project: Mercari JP watcher for Tamiya Vanguard Sonic, Victory Magnum (non-Premium) and the
// single-shaft Mach Dash motor. Node 22, no dependencies. The same file runs on GitHub Actions
// and on the Windows PC; both share one state file in the GitHub repo so a listing is notified once.
//
// Two lanes, both pushed to the ntfy app with prices in rupiah (BCA bank notes selling rate):
//   BARU      - every new listing that passes the title filter
//   TERMURAH  - a listing cheaper than the cheapest one known so far, per product,
//               plus one summary per product every morning (digestHourWib in config.json)
//
// Products and filters: config.json. PC-only settings (ntfy topic, repo, loop): local.json.
// Flags: --once (single check)  --dry (show filter verdicts, send nothing)
//        --test-phone (send a test notification)  --digest (send the morning summary now)
// Env on GitHub Actions: NTFY_TOPIC, GITHUB_TOKEN, GITHUB_REPOSITORY, CHECKS, INTERVAL_SEC

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const ARGS = new Set(process.argv.slice(2));
const ON_ACTIONS = !!process.env.GITHUB_ACTIONS;
const readJson = (p) => JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const d = new Date(Date.now() + 7 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const line = `[${d}] ${msg}`;
  console.log(line);
  if (!ON_ACTIONS && !ARGS.has("--dry")) try { appendFileSync(join(DIR, "watcher.log"), line + "\n"); } catch {}
}

// ---------- settings ----------
const config = readJson(join(DIR, "config.json"));
const LOCAL_FILE = join(DIR, "local.json");
const local = existsSync(LOCAL_FILE) ? readJson(LOCAL_FILE) : {};
if (!ON_ACTIONS && !local.ntfyTopic && !process.env.NTFY_TOPIC) {
  // The topic is generated once on this PC and kept; it is never written to a file that goes to GitHub.
  local.ntfyTopic = "vproject-" + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  writeFileSync(LOCAL_FILE, JSON.stringify(local, null, 2) + "\n");
}
const NTFY_TOPIC = (process.env.NTFY_TOPIC || local.ntfyTopic || "").trim();
const REPO = process.env.GITHUB_REPOSITORY || local.githubRepo || "";
const STATE_PATH = config.stateFile || "state.json";
const DIGEST_HOUR = Number(config.digestHourWib ?? 7);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// ---------- title filter ----------
const norm = (s) => (s || "").normalize("NFKC").toLowerCase().replace(/[\s\-_.・]/g, "");
const products = config.products.map((p) => ({
  key: p.key,
  name: p.name,
  keywords: p.keywords,
  mustMatch: p.mustMatch.map(norm),
  exclude: [...(config.excludeAll || []), ...(p.exclude || [])].map(norm),
  lowExclude: [...(config.lowExcludeAll || []), ...(p.lowExclude || [])].map(norm),
  page: "https://jp.mercari.com/search?keyword=" + encodeURIComponent(p.keywords[0]) + "&status=on_sale",
}));
function isTarget(p, name) {
  const n = norm(name);
  if (p.exclude.some((x) => n.includes(x))) return false;
  return p.mustMatch.some((m) => n.includes(m));
}
// Lane TERMURAH is stricter: only a complete, unused item counts (boxed kit, motor still in its
// blister). Photos can't be read, so this goes by what the seller states: the listing is marked
// new/unused or its title says unbuilt / unopened / boxed, and the title has no loose-item word.
const LOW_CONDITIONS = (config.lowConditionIds || ["1"]).map(String);
const LOW_REQUIRE = (config.lowRequireAny || []).map(norm);
function isLowTarget(p, it) {
  if (it.price <= 0 || !isTarget(p, it.name)) return false;
  const n = norm(it.name);
  if (p.lowExclude.some((x) => n.includes(x))) return false;
  return LOW_CONDITIONS.includes(it.cond) || LOW_REQUIRE.some((x) => n.includes(x));
}

// ---------- DPoP token (ES256 JWT that Mercari's API requires) ----------
const MERCARI_API = "https://api.mercari.jp/v2/entities:search";
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const b64uText = (s) => b64u(new TextEncoder().encode(s));

async function makeDpop(url, method) {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: { crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y } };
  const payload = { iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID(), htu: url, htm: method, uuid: crypto.randomUUID() };
  const input = b64uText(JSON.stringify(header)) + "." + b64uText(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(input));
  return input + "." + b64u(sig);
}

// ---------- Mercari search ----------
async function searchMercari(keyword, sort, order, pageToken = "") {
  const body = {
    userId: "", pageSize: 120, pageToken,
    searchSessionId: crypto.randomUUID().replace(/-/g, ""),
    indexRouting: "INDEX_ROUTING_UNSPECIFIED", thumbnailTypes: [],
    searchCondition: {
      keyword, excludeKeyword: "", sort, order, status: ["STATUS_ON_SALE"],
      sizeId: [], categoryId: [], brandId: [], sellerId: [], priceMin: 0, priceMax: 0,
      itemConditionId: [], shippingPayerId: [], shippingFromArea: [], shippingMethod: [],
      colorId: [], hasCoupon: false, attributes: [], itemTypes: [], skuIds: [],
    },
    defaultDatasets: ["DATASET_TYPE_MERCARI", "DATASET_TYPE_BEYOND"], serviceFrom: "suruga",
    withItemBrand: true, withItemSize: false, withItemPromotions: true, withItemSizes: true, withShopname: false,
  };
  const res = await fetch(MERCARI_API, {
    method: "POST",
    headers: {
      DPoP: await makeDpop(MERCARI_API, "POST"),
      "X-Platform": "web",
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Mercari HTTP ${res.status}: ${(await res.text()).slice(0, 150).replace(/\s+/g, " ")}`);
  const json = await res.json();
  const items = (json.items || []).map((it) => {
    const shop = it.itemType === "ITEM_TYPE_BEYOND";
    return {
      id: it.id,
      name: it.name,
      price: Number(it.price),
      url: shop ? `https://jp.mercari.com/shops/product/${it.id}` : `https://jp.mercari.com/item/${it.id}`,
      thumb: it.thumbnails && it.thumbnails[0],
      cond: String(it.itemConditionId || ""), // "1" = new / unused
    };
  });
  return { items, next: (json.meta && json.meta.nextPageToken) || "" };
}

// Lane BARU: the newest listings of every product that pass its filter, keyed by listing id.
async function collectNewest() {
  const byId = new Map();
  for (const p of products) {
    for (const kw of p.keywords) {
      const { items } = await searchMercari(kw, "SORT_CREATED_TIME", "ORDER_DESC");
      for (const it of items) {
        if (!isTarget(p, it.name)) continue;
        const known = byId.get(it.id);
        if (known) { if (!known.products.includes(p.name)) known.products.push(p.name); }
        else byId.set(it.id, { ...it, products: [p.name] });
      }
      await sleep(300);
    }
  }
  return byId;
}

// Lane TERMURAH: the cheapest on-sale listing of every product that passes its filter.
// Results come cheapest first, so the first page holding a match holds the cheapest one.
async function collectLows() {
  const lows = {};
  for (const p of products) {
    let best = null;
    for (const kw of p.keywords) {
      let token = "";
      for (let page = 0; page < 3; page++) {
        const { items, next } = await searchMercari(kw, "SORT_PRICE", "ORDER_ASC", token);
        await sleep(300);
        const hits = items.filter((it) => isLowTarget(p, it));
        if (hits.length) {
          const min = hits.reduce((a, b) => (b.price < a.price ? b : a));
          if (!best || min.price < best.price) best = min;
          break;
        }
        if (!next) break;
        token = next;
      }
    }
    lows[p.key] = best;
  }
  return lows;
}

// ---------- BCA bank notes selling rate (rupiah per 1 yen) ----------
let rateCache = null; // { sell, asOf, at }
async function fetchBcaRate() {
  const res = await fetch("https://www.bca.co.id/id/informasi/kurs", { headers: { "User-Agent": UA, "Accept-Language": "id" } });
  if (!res.ok) throw new Error(`BCA HTTP ${res.status}`);
  const html = await res.text();
  const row = html.match(/<tr[^>]*code="JPY"[\s\S]*?rate-type="BankNotes-sell">\s*<p>\s*([\d.,]+)\s*<\/p>/);
  if (!row) throw new Error("BCA: baris JPY bank notes tidak ditemukan");
  const sell = Number(row[1].replace(/\./g, "").replace(",", "."));
  if (!(sell > 20 && sell < 1000)) throw new Error(`BCA: nilai kurs tidak wajar (${row[1]})`);
  const when = html.match(/<span>Bank Notes<\/span>\s*<br\s*\/?>\s*<span[^>]*>([^<]+)<\/span>/);
  return { sell, asOf: when ? when[1].trim() : "" };
}

// Fresh rate at most once an hour; if BCA can't be reached the last known rate is used.
async function getRate(state) {
  if (rateCache && Date.now() - rateCache.at < 3600 * 1000) return rateCache;
  try {
    rateCache = { ...(await fetchBcaRate()), at: Date.now() };
  } catch (e) {
    log(`Kurs BCA gagal diambil: ${e.message}`);
    if (!rateCache && state.rate) rateCache = { ...state.rate, at: 0 };
  }
  return rateCache;
}

const dots = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const rp = (yen, rate) => (rate ? `Rp ${dots(yen * rate.sell)}` : `${dots(yen)} yen (kurs BCA belum terbaca)`);
const rateLine = (rate) => (rate ? `Kurs jual bank notes BCA: Rp ${String(rate.sell).replace(".", ",")}/yen${rate.asOf ? ` (${rate.asOf})` : ""}` : "");

// ---------- notifications ----------
function toast(title, message, url, image) {
  if (ON_ACTIONS || process.platform !== "win32" || local.toast === false) return;
  const data = Buffer.from(JSON.stringify({ title, message, url: url || "", image: image || "" }), "utf8").toString("base64");
  execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(DIR, "toast.ps1"), "-Data", data], { windowsHide: true }, () => {});
}

async function notify({ title, message, url, image, tags = ["racing_car"], priority = 4 }) {
  toast(title, message, url, image);
  const payload = { topic: NTFY_TOPIC, title, message, priority, tags };
  if (url) { payload.click = url; payload.actions = [{ action: "view", label: "Buka listing", url }]; }
  if (image) payload.attach = image;
  try {
    const r = await fetch(local.ntfyServer || "https://ntfy.sh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!r.ok) log(`ntfy HTTP ${r.status}`);
  } catch (e) { log(`Kirim ke HP gagal: ${e.message}`); }
}

// ---------- shared state ----------
// With a repo configured, the state file lives in that GitHub repo and is shared by the PC and the
// GitHub watcher. Without one (local testing) a state.json next to this script is used.
let ghToken = process.env.GITHUB_TOKEN || "";
function getToken() {
  if (ghToken || !REPO) return ghToken;
  try { ghToken = execFileSync(local.ghExe || "C:\\Program Files\\GitHub CLI\\gh.exe", ["auth", "token"], { encoding: "utf8", windowsHide: true }).trim(); }
  catch { log("Token GitHub tidak terbaca (gh auth login belum dilakukan?); pakai catatan lokal."); }
  return ghToken;
}
const LOCAL_STATE = join(DIR, "state.json");
const GH_URL = `https://api.github.com/repos/${REPO}/contents/${STATE_PATH}`;
const ghHeaders = () => ({ Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json", "User-Agent": "v-project" });
const parseState = (text) => {
  const s = JSON.parse(text.replace(/^\uFEFF/, ""));
  return { ids: s.ids || null, fails: s.fails || 0, low: s.low || {}, lowHist: s.lowHist || {}, digestDate: s.digestDate || "", rate: s.rate || null };
};
const emptyState = () => parseState("{}");

async function loadState() {
  if (!getToken()) return { state: existsSync(LOCAL_STATE) ? parseState(readFileSync(LOCAL_STATE, "utf8")) : emptyState(), sha: null };
  const r = await fetch(GH_URL, { headers: ghHeaders() });
  if (r.status === 404) return { state: emptyState(), sha: null };
  if (!r.ok) throw new Error(`GitHub GET ${r.status}`);
  const j = await r.json();
  return { state: parseState(Buffer.from(j.content, "base64").toString("utf8")), sha: j.sha };
}

async function updateState(mutate) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { state, sha } = await loadState();
    mutate(state);
    if (state.ids) state.ids = state.ids.slice(-5000);
    const text = JSON.stringify(state) + "\n";
    if (!ghToken) { writeFileSync(LOCAL_STATE, text); return state; }
    const r = await fetch(GH_URL, {
      method: "PUT",
      headers: ghHeaders(),
      body: JSON.stringify({ message: "Update V-Project state", content: Buffer.from(text).toString("base64"), sha: sha || undefined }),
    });
    if (r.ok) return state;
    if (r.status === 403) throw new Error("GitHub PUT 403: aktifkan Settings > Actions > General > Workflow permissions > Read and write permissions");
    if (r.status !== 409 && r.status !== 422) throw new Error(`GitHub PUT ${r.status}`);
    await sleep(1000 + Math.random() * 2000); // the other watcher wrote at the same moment; reload and retry
  }
  throw new Error("Gagal menyimpan catatan setelah 5x");
}

const addIds = (ids, more) => [...new Set([...(ids || []), ...more])];
const wibNow = () => new Date(Date.now() + 7 * 3600 * 1000); // read with the UTC getters
const wibDate = () => wibNow().toISOString().slice(0, 10);

function lowLine(p, low, rate) {
  return low ? `${p.name}: ${rp(low.price, rate)}` : `${p.name}: belum ada listing`;
}

async function sendDigest(lows, rate) {
  for (const p of products) {
    const low = lows[p.key];
    if (!low) continue;
    await notify({
      title: `RANGKUMAN PAGI | ${p.name} termurah: ${rp(low.price, rate)}`,
      message: [low.name, rateLine(rate)].filter(Boolean).join("\n"),
      url: low.url, image: low.thumb, tags: ["sunrise"], priority: 3,
    });
  }
}

// ---------- one check ----------
async function checkOnce() {
  const { state } = await loadState();
  const rate = await getRate(state);

  let newest, lows;
  try {
    newest = await collectNewest();
    lows = await collectLows();
  } catch (e) {
    const s = await updateState((st) => { st.fails += 1; });
    log(`GAGAL (${s.fails}x berturut-turut): ${e.message}`);
    if (s.fails === 5) await notify({ title: "V-Project bermasalah", message: `5x gagal berturut-turut: ${e.message}`, url: products[0].page, tags: ["rotating_light"] });
    return;
  }
  const items = [...newest.values()];
  const rateChanged = rate && rate.at && (!state.rate || state.rate.sell !== rate.sell || state.rate.asOf !== rate.asOf);
  const saveRate = (st) => { if (rateChanged) st.rate = { sell: rate.sell, asOf: rate.asOf }; };
  const saveLows = (st) => {
    for (const p of products) {
      const low = lows[p.key];
      st.low[p.key] = low ? { id: low.id, price: low.price } : null;
      if (low) {
        const hist = { ...(st.lowHist[p.key] || {}), [low.id]: low.price };
        st.lowHist[p.key] = Object.fromEntries(Object.entries(hist).slice(-40));
      }
    }
  };

  // First run: record what is already on sale, notify nothing but a single "aktif" message.
  if (!state.ids) {
    await updateState((st) => {
      st.ids = addIds(st.ids, items.map((i) => i.id)); st.fails = 0;
      saveLows(st); saveRate(st);
      if (wibNow().getUTCHours() >= DIGEST_HOUR) st.digestDate = wibDate();
    });
    log(`Run pertama: ${items.length} listing dicatat.`);
    await notify({
      title: "V-Project aktif",
      message: [`${items.length} listing yang sudah ada dicatat. Termurah saat ini:`, ...products.map((p) => lowLine(p, lows[p.key], rate)), rateLine(rate)].filter(Boolean).join("\n"),
      url: products[0].page,
    });
    return;
  }

  // Lane BARU
  const seen = new Set(state.ids);
  const fresh = items.filter((i) => !seen.has(i.id));
  for (const n of fresh) {
    log(`BARU [${n.products.join(" + ")}]: ${n.price} yen | ${n.name} | ${n.url}`);
    await notify({
      title: `BARU | ${n.products.join(" + ")}: ${rp(n.price, rate)}`,
      message: [n.name, rateLine(rate)].filter(Boolean).join("\n"),
      url: n.url, image: n.thumb, tags: ["new"],
    });
  }

  // Lane TERMURAH: cheaper than the cheapest known so far. A listing that was already the
  // cheapest once at this price (it only dropped out of the results for a moment) stays quiet.
  let lowChanged = false;
  for (const p of products) {
    const low = lows[p.key], prev = state.low[p.key];
    if ((low && low.id) !== (prev && prev.id) || (low && low.price) !== (prev && prev.price)) lowChanged = true;
    if (!low || !prev || low.price >= prev.price) continue;
    const before = (state.lowHist[p.key] || {})[low.id];
    if (before !== undefined && before <= low.price) continue;
    log(`TERMURAH [${p.name}]: ${low.price} yen (sebelumnya ${prev.price}) | ${low.name} | ${low.url}`);
    await notify({
      title: `TERMURAH | ${p.name}: ${rp(low.price, rate)}`,
      message: [low.name, `Termurah sebelumnya: ${rp(prev.price, rate)}`, rateLine(rate)].filter(Boolean).join("\n"),
      url: low.url, image: low.thumb, tags: ["moneybag"], priority: 5,
    });
  }

  // Morning summary, once a day
  const digestDue = ARGS.has("--digest") || (wibNow().getUTCHours() >= DIGEST_HOUR && state.digestDate !== wibDate());
  if (digestDue) { await sendDigest(lows, rate); log("Rangkuman pagi dikirim."); }

  if (fresh.length || lowChanged || digestDue || rateChanged || state.fails) {
    await updateState((st) => {
      st.ids = addIds(st.ids, fresh.map((n) => n.id)); st.fails = 0;
      saveLows(st); saveRate(st);
      if (digestDue) st.digestDate = wibDate();
    });
  }
  log(`OK: ${items.length} listing dicek, ${fresh.length} baru. Termurah: ${products.map((p) => lowLine(p, lows[p.key], rate)).join(" | ")}`);
}

// ---------- dry run: show what the filters accept and reject, send nothing ----------
async function dryRun() {
  const rate = await getRate(emptyState());
  let out = rateLine(rate) + "\n";
  for (const p of products) {
    const seen = new Set();
    out += `\n===== ${p.name} =====\n`;
    for (const kw of p.keywords) {
      const { items } = await searchMercari(kw, "SORT_CREATED_TIME", "ORDER_DESC");
      for (const it of items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out += `${isTarget(p, it.name) ? "LOLOS  " : "DITOLAK"} ${rp(it.price, rate).padStart(13)}  ${it.name}\n`;
      }
    }
  }
  for (const p of products) {
    const seen = new Set();
    out += `\n===== Kandidat termurah (kit utuh / blister): ${p.name} =====\n`;
    for (const kw of p.keywords) {
      const { items } = await searchMercari(kw, "SORT_PRICE", "ORDER_ASC");
      for (const it of items) {
        if (seen.has(it.id) || !isTarget(p, it.name)) continue;
        seen.add(it.id);
        out += `${isLowTarget(p, it) ? "MASUK  " : "TIDAK  "} kondisi ${it.cond || "?"} ${rp(it.price, rate).padStart(13)}  ${it.name}\n`;
      }
    }
  }
  const lows = await collectLows();
  out += "\n===== Termurah saat ini =====\n";
  for (const p of products) out += `${lowLine(p, lows[p.key], rate)}${lows[p.key] ? `  | ${lows[p.key].name} | ${lows[p.key].url}` : ""}\n`;
  writeFileSync(join(DIR, "dryrun.txt"), out);
  console.log(out);
}

// ---------- main ----------
if (ARGS.has("--dry")) { await dryRun(); process.exit(0); }
if (!NTFY_TOPIC) {
  console.log("Topic ntfy belum diisi (secret NTFY_TOPIC_V di GitHub, atau ntfyTopic di local.json).");
  process.exit(process.env.GITHUB_EVENT_NAME === "schedule" ? 0 : 1);
}
if (ARGS.has("--test-phone")) {
  await notify({ title: "Tes notifikasi V-Project", message: "Kalau ini muncul di HP, notifikasi berfungsi.", url: products[0].page, priority: 3 });
  console.log(`Terkirim ke topic ntfy: ${NTFY_TOPIC}`);
  process.exit(0);
}

const loopMinutes = ON_ACTIONS || ARGS.has("--once") || ARGS.has("--digest") ? 0 : Number(local.loopMinutes || 0);
if (loopMinutes) {
  log(`V-Project memantau ${products.map((p) => p.name).join(", ")} setiap ${loopMinutes} menit. Catatan bersama: ${REPO || "(lokal)"}`);
  for (;;) {
    try { await checkOnce(); } catch (e) { log(`ERROR: ${e.message}`); }
    await sleep(loopMinutes * 60000 + Math.random() * 30000);
  }
} else {
  const checks = Number(process.env.CHECKS || 1), gap = Number(process.env.INTERVAL_SEC || 180);
  for (let i = 0; i < checks; i++) {
    if (i > 0) await sleep(gap * 1000);
    try { await checkOnce(); } catch (e) { log(`ERROR: ${e.message}`); }
  }
}
