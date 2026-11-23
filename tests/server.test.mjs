import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { createBridgeServer } from "../dist/server/server.js";
import { LEVELS } from "../dist/shared/levels.js";

const level = LEVELS[0];
const anchors = level.anchors.map((anchor) => ({
  id: anchor.id,
  x: anchor.x,
  y: anchor.y,
  pinned: true,
}));

const build = {
  nodes: [
    ...anchors,
    { id: "d1", x: 384, y: 368 },
    { id: "d2", x: 464, y: 368 },
    { id: "d3", x: 544, y: 368 },
  ],
  beams: [
    { id: "r1", a: "anchor-left", b: "d1", material: "road" },
    { id: "r2", a: "d1", b: "d2", material: "road" },
    { id: "r3", a: "d2", b: "d3", material: "road" },
    { id: "r4", a: "d3", b: "anchor-right", material: "road" },
  ],
};

const dataDir = path.resolve("tests", ".tmp-api");

async function json(url, options) {
  const response = await fetch(url, options);
  return { status: response.status, body: await response.json() };
}

test("API persists designs, validates payloads, and ranks results", async (t) => {
  await rm(dataDir, { recursive: true, force: true });
  const server = await createBridgeServer({
    port: 0,
    dataDir,
    publicDir: path.resolve("public"),
    verbose: false,
  });
  t.after(async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const base = server.url;

  await t.test("health endpoint reports storage", async () => {
    const { status, body } = await json(`${base}/api/health`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.storage.designs, 0);
  });

  await t.test("static page is served with security headers", async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.ok(response.headers.get("content-security-policy"));
    assert.match(await response.text(), /SPAN/);
  });

  await t.test("static HEAD reports content length without a body", async () => {
    const response = await fetch(`${base}/styles.css`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.ok(Number(response.headers.get("content-length")) > 1000);
    assert.equal(await response.text(), "");
  });

  await t.test("invalid design is rejected", async () => {
    const { status, body } = await json(`${base}/api/designs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nickname: "测试",
        levelId: "creek",
        name: "坏桥",
        build: { nodes: [], beams: [] },
      }),
    });
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  await t.test("design save and read round-trip", async () => {
    const saved = await json(`${base}/api/designs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nickname: "测试工程师",
        levelId: "creek",
        name: "四段桥",
        build,
      }),
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.created, true);
    assert.ok(saved.body.design.cost > 0);
    assert.ok(saved.body.design.cost <= level.budget);

    const loaded = await json(
      `${base}/api/designs?nickname=${encodeURIComponent("测试工程师")}&levelId=creek`,
    );
    assert.equal(loaded.status, 200);
    assert.equal(loaded.body.design.name, "四段桥");
    assert.equal(loaded.body.design.build.nodes.length, build.nodes.length);
  });

  await t.test("result leaderboard keeps the personal best", async () => {
    const first = await json(`${base}/api/results`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: "测试工程师", levelId: "creek", cost: 336, time: 4.2, beams: 4 }),
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.improved, true);

    const worse = await json(`${base}/api/results`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: "测试工程师", levelId: "creek", cost: 500, time: 3.1, beams: 6 }),
    });
    assert.equal(worse.status, 200);
    assert.equal(worse.body.improved, false);

    const better = await json(`${base}/api/results`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: "新工程师", levelId: "creek", cost: 300, time: 4.8, beams: 4 }),
    });
    assert.equal(better.body.improved, true);

    const board = await json(
      `${base}/api/leaderboard?levelId=creek&nickname=${encodeURIComponent("测试工程师")}`,
    );
    assert.equal(board.status, 200);
    assert.equal(board.body.entries.length, 2);
    assert.equal(board.body.entries[0].nickname, "新工程师");
    assert.equal(board.body.entries[0].cost, 300);
    assert.equal(board.body.entries[1].cost, 336);
    assert.equal(board.body.personalBest.cost, 336);
  });

  await t.test("wrong content type and unknown endpoints fail cleanly", async () => {
    const wrongType = await fetch(`${base}/api/designs`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongType.status, 415);

    const missing = await json(`${base}/api/nope`);
    assert.equal(missing.status, 404);
    assert.ok(missing.body.error);
  });
});
