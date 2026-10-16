// Unit tests for the extension's pure logic — the same cases as
// tests/test_scoring.py, so the Python and JS versions agree.
// Run in the VM: tests/extension/vm-run.sh --test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../../extension/lib/scoring.js";
import * as yt from "../../extension/lib/youtube.js";
import { buildRules } from "../../extension/lib/net.js";

const FIXTURES = new URL("../fixtures/", import.meta.url);

test("name matching", () => {
  assert.ok(S.nameMatches("Sam Rivera", "sam  rivera"));
  assert.ok(!S.nameMatches("Sam Rivera", "Sam Riveras"));
  assert.ok(S.nameMatches("Alex Morgan Ta…", "Alex Morgan Taylor"));
  assert.ok(S.nameMatches("Robin Talks M...", "Robin Talks Maths"));
  assert.ok(!S.nameMatches("Alex Morgan Ta…", "Alex Morgan"));
  assert.ok(S.nameMatches("Kim's Economics", "Kim’s Economics"));
});

test("pick channel: one big namesake accepted, two dropped, none dropped", () => {
  const r = [
    { channel_id: "A", title: "Jordan Lee", subscribers: 601_000 },
    { channel_id: "B", title: "Jordan Lee", subscribers: 822 },
    { channel_id: "C", title: "JORDAN LEE FINANCE", subscribers: 50_000 },
  ];
  const { best, matches } = S.pickChannel("Jordan Lee", r, 10_000);
  assert.equal(best.channel_id, "A");
  assert.equal(matches.length, 2);
  assert.equal(S.pickChannel("Sam Smith", [
    { channel_id: "A", title: "Sam Smith", subscribers: 900_000 },
    { channel_id: "B", title: "Sam Smith", subscribers: 40_000 }], 10_000).best, null);
  assert.equal(S.pickChannel("Nobody", [], 10_000).best, null);
});

test("clickbait", () => {
  for (const t of ["How to Invest at Every Salary", "Lead Architect Reveals His Rules for Coding Agents",
                   "The Band - Full Performance (Live in Studio)", "GPT-5 vs Claude on the ARC benchmark",
                   "The UK pension triple lock, explained", "Running LLMs locally on an M4 Mac"])
    assert.ok(S.clickbaitScore(t) < 1, t);
  for (const t of ["You WON'T BELIEVE What Happened!!!", "This Changes EVERYTHING 🤯🔥",
                   "I Got DESTROYED by AI?!", "SHOCKING truth they don't want you to know..."])
    assert.ok(S.clickbaitScore(t) >= 2, t);
  assert.equal(S.clickbaitScore("NVIDIA GPU and CPU prices in the UK"), 0);
});

function entries() {
  const out = [];
  for (let i = 0; i < 6; i++) out.push({ id: `a${i}`, channel_id: "A", published: `2026-10-15T1${9 - i}:00:00+00:00` });
  for (let i = 0; i < 3; i++) {
    out.push({ id: `b${i}`, channel_id: "B", published: `2026-10-14T1${9 - i}:00:00+00:00` });
    out.push({ id: `c${i}`, channel_id: "C", published: `2026-10-13T1${9 - i}:00:00+00:00` });
  }
  return out;
}

test("feed selection", async () => {
  const ids = l => l.map(e => e.id);
  assert.deepEqual(ids(await S.selectFeed(entries(), 9, 3, async () => true)),
                   ["a0", "a1", "a2", "b0", "b1", "b2", "c0", "c1", "c2"]);
  assert.deepEqual(ids(await S.selectFeed(entries(), 4, 3, () => true)), ["a0", "a1", "a2", "b0"]);
  assert.deepEqual(ids(await S.selectFeed(entries(), 3, 3, e => e.id !== "a1")), ["a0", "a2", "a3"]);
  const seen = [];
  await S.selectFeed(entries(), 2, 3, e => { seen.push(e.id); return true; });
  assert.deepEqual(seen, ["a0", "a1"]);
});

const CFG = { min_recent_uploads: 3, max_uploads_per_week: 7, max_clickbait: 1.0, cooldown_days: 30,
              blocked_creators: ["Bad Channel"], blocked_keywords: ["crypto"] };
const NOW = Date.parse("2026-10-16T00:00:00Z");
const feed = (titles, everyDays = 7) =>
  titles.map((title, i) => ({ title, published: new Date(NOW - everyDays * i * 86400e3).toISOString() }));

test("suggestion assessment", () => {
  const ok = S.assessCandidate(feed(["Rust ownership explained", "Writing a parser in Rust",
                                     "Rust async in depth", "Benchmarking Rust and Go"]), NOW, CFG, ["rust", "parser"]);
  assert.notEqual(ok.score, null);
  assert.equal(ok.cadence, "about weekly");
  assert.equal(S.assessCandidate(feed(["INSANE AI trick!!!", "You won't believe this 🤯", "SHOCKING results!!", "OMG"]),
                                 NOW, CFG, []).score, null);
  assert.equal(S.assessCandidate(feed(Array.from({ length: 15 }, (_, i) => `Daily update ${i}`), 0.5), NOW, CFG, []).score, null);
  assert.equal(S.assessCandidate(feed(["Old talk", "Older talk", "Oldest talk"], 200), NOW, CFG, []).score, null);
});

test("non-Latin titles are not suggested", () => {
  assert.ok(S.nonLatinShare(["தமிழில் mid cap fund vs Nifty"]) > 0.2);
  assert.equal(S.nonLatinShare(["Café crème, naïve résumé"]), 0);
  const tamil = feed(["தமிழில் மியூச்சுவல் ஃபண்ட்", "பங்குச் சந்தை இன்று", "முதலீடு எப்படி"]);
  assert.equal(S.assessCandidate(tamil, NOW, CFG, []).why, "titles not in a Latin script");
});

test("spin-offs, blocking, keywords", () => {
  const listed = ["Acme Tech", "Bright Science", "Two Minute Maths"];
  for (const t of ["Acme Clips", "AcmeClass", "Bright Science Podcast", "Some Show Highlights", "Other Clips"])
    assert.ok(S.spinOff(t, listed), t);
  for (const t of ["Calm Woodwork", "The Prime Lens", "Maths Please Reviews"])
    assert.ok(!S.spinOff(t, listed), t);
  assert.ok(S.blocked({ channel: "bad channel" }, CFG));
  assert.ok(S.blocked({ title: "My Crypto picks" }, CFG));
  assert.ok(!S.blocked({ channel: "Good", title: "Fine" }, CFG));
  assert.deepEqual(S.keywords(["The best Rust parser", "A Rust parser in depth", "Rust and you"]).slice(0, 2),
                   ["rust", "parser"]);
});

test("parsing", () => {
  assert.equal(yt.parseCount("601k subscribers"), 601_000);
  assert.equal(yt.parseCount("1.36M subscribers"), 1_360_000);
  assert.equal(yt.parseCount("8.56 thousand subscribers"), 8_560);
  assert.equal(yt.parseCount("228 subscribers"), 228);
  assert.equal(yt.parseCount(""), 0);
  const items = yt.parseFeed(readFileSync(new URL("feed.xml", FIXTURES), "utf8"));
  assert.equal(items.length, 2);
  assert.equal(items[0].id, "newer000001");
  assert.equal(items[0].channel, "Example Channel");
  assert.equal(items[0].title, "A newer video");
  assert.equal(items[1].description, "Second description");
  assert.equal(yt.unescapeXml("Tom &amp; Jerry &#39;s &#x2019;"), "Tom & Jerry 's ’");
  const page = `<script>var ytInitialData = {"a":"}{\\"","b":{"c":[1,2]}};</script>`;
  assert.deepEqual(yt.embeddedJson(page, "ytInitialData"), { a: '}{"', b: { c: [1, 2] } });
});

test("network rules are scoped to Pacifier's tabs and initiators", () => {
  const rules = buildRules([42], "extid");
  assert.ok(rules.length > 5);
  for (const r of rules) {
    assert.ok(r.condition.initiatorDomains?.includes("extid"), `rule ${r.id} must require our initiator`);
    assert.ok(!r.condition.resourceTypes.includes("main_frame"), `rule ${r.id} must not touch navigations`);
  }
  assert.ok(rules.some(r => r.action.type === "block"));
  for (const r of rules) assert.deepEqual(r.condition.tabIds, [42], `rule ${r.id} must be tab-scoped`);
  const ids = rules.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("manifest stays minimal", () => {
  const m = JSON.parse(readFileSync(new URL("../../extension/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual([...m.permissions].sort(), ["declarativeNetRequest", "storage"]);
  assert.deepEqual([...m.host_permissions].sort(), ["https://www.youtube-nocookie.com/*", "https://www.youtube.com/*"]);
  assert.equal(m.web_accessible_resources, undefined);
  assert.deepEqual(m.externally_connectable, { ids: [] });
  assert.match(m.content_security_policy.extension_pages, /script-src 'self';/);
  assert.doesNotMatch(m.content_security_policy.extension_pages, /unsafe-(eval|inline)/);
});

test("hostile feed data is dropped", () => {
  const entry = (id, ch, pub = "2026-10-10T09:00:00+00:00") =>
    `<entry><yt:videoId>${id}</yt:videoId><yt:channelId>${ch}</yt:channelId><title>t</title><published>${pub}</published></entry>`;
  const xml = `<feed><title>X</title>${entry("__proto__", "UCxxxxxxxxxxxxxxxxxxxxxx")}${entry("abcdefghijk", "constructor")}` +
              `${entry("a\"><img src=x>", "UCxxxxxxxxxxxxxxxxxxxxxx")}${entry("abcdefghijk", "UCxxxxxxxxxxxxxxxxxxxxxx", "not a date")}` +
              `${entry("good_id-123", "UCxxxxxxxxxxxxxxxxxxxxxx")}</feed>`;
  const items = yt.parseFeed(xml);
  assert.deepEqual(items.map(i => i.id), ["good_id-123"]);
  assert.ok(yt.isVideoId("dQw4w9WgXcQ") && !yt.isVideoId("__proto__") && !yt.isVideoId("../../../etc"));
  assert.ok(yt.isChannelId("UCsBjURrPoezykLs9EqgamOA") && !yt.isChannelId("UC__proto__"));
});
