import test from "node:test";
import assert from "node:assert/strict";
import {
  BridgeSimulation,
  findRoadPath,
  pathLength,
  pointOnPath,
} from "../public/js/client/physics.js";
import { LEVELS } from "../public/js/shared/levels.js";
import { buildCost } from "../public/js/shared/materials.js";

const level = LEVELS[0];

const node = (id, x, y) => ({ id, x, y });
const beam = (id, a, b, material) => ({ id, a, b, material });

const deck = {
  nodes: [node("d1", 380, 372), node("d2", 460, 372), node("d3", 540, 372)],
  beams: [
    beam("r1", "anchor-left", "d1", "road"),
    beam("r2", "d1", "d2", "road"),
    beam("r3", "d2", "d3", "road"),
    beam("r4", "d3", "anchor-right", "road"),
  ],
};

const truss = {
  nodes: [
    ...deck.nodes,
    node("t1", 380, 296),
    node("t2", 460, 296),
    node("t3", 540, 296),
  ],
  beams: [
    ...deck.beams,
    beam("w1", "d1", "t1", "wood"),
    beam("w2", "d2", "t2", "wood"),
    beam("w3", "d3", "t3", "wood"),
    beam("w4", "t1", "t2", "wood"),
    beam("w5", "t2", "t3", "wood"),
    beam("w6", "anchor-left", "t1", "wood"),
    beam("w7", "t1", "d2", "wood"),
    beam("w8", "t2", "d3", "wood"),
    beam("w9", "t3", "anchor-right", "wood"),
  ],
};

function withAnchors(build, targetLevel = level) {
  const targetAnchors = targetLevel.anchors.map((anchor) => ({
    id: anchor.id,
    x: anchor.x,
    y: anchor.y,
    pinned: true,
  }));
  return { nodes: [...targetAnchors, ...build.nodes], beams: build.beams.map((item) => ({ ...item })) };
}

function simulate(build, seconds = 12, targetLevel = level) {
  const sim = new BridgeSimulation(build);
  let travelled = 0;
  let maxStress = 0;
  let broken = 0;
  let success = false;
  let failure = null;

  const initial = sim.activeRoadPath(targetLevel.startAnchorId, targetLevel.endAnchorId);
  if (!initial) return { success, failure: "no initial path", maxStress, broken };

  for (let frame = 0; frame < 120 * seconds; frame += 1) {
    const dt = 1 / 120;
    const path = sim.activeRoadPath(targetLevel.startAnchorId, targetLevel.endAnchorId);
    if (!path) {
      failure = "path lost";
      break;
    }
    const length = pathLength(path, (id) => sim.nodePosition(id));
    const point = pointOnPath(path, Math.max(0, travelled), (id) => sim.nodePosition(id));
    if (point) {
      const a = path.nodeIds[point.segment];
      const b = path.nodeIds[point.segment + 1];
      sim.applyDeckLoad(a, b, point.t, 4400 * 0.64);
      const rear = pointOnPath(path, Math.max(0, travelled - 20), (id) => sim.nodePosition(id));
      if (rear) {
        const ra = path.nodeIds[rear.segment];
        const rb = path.nodeIds[rear.segment + 1];
        sim.applyDeckLoad(ra, rb, rear.t, 4400 * 0.36);
      }
    }
    const result = sim.step(dt);
    broken += result.broken.length;
    maxStress = Math.max(maxStress, result.maxStress);
    if (result.outOfBounds) {
      failure = "out of bounds";
      break;
    }
    travelled += 118 * dt;
    if (travelled > length + 78) {
      success = true;
      break;
    }
  }

  return { success, failure, maxStress, broken, travelled };
}

test("road pathfinding follows connected road beams only", () => {
  const build = withAnchors(deck);
  const sim = new BridgeSimulation(build);
  const path = sim.activeRoadPath(level.startAnchorId, level.endAnchorId);
  assert.ok(path);
  assert.equal(path.nodeIds.length, 5);
  assert.equal(path.beamIds.length, 4);
  assert.equal(sim.isPathIntact(path), true);

  const broken = new BridgeSimulation(build);
  broken.beams.find((item) => item.id === "r2").broken = true;
  assert.equal(broken.activeRoadPath(level.startAnchorId, level.endAnchorId), null);
  assert.equal(broken.isPathIntact(path), false);
});

test("solver exposes bounded adaptive iterations", () => {
  const sim = new BridgeSimulation(withAnchors(truss));
  for (let i = 0; i < 60; i += 1) sim.step(1 / 120);
  assert.ok(sim.lastIterations > 0);
  assert.ok(sim.lastIterations <= 10);
  assert.ok(sim.lastResidual >= 0);
});

test("beams record separate tension and compression limits", () => {
  const sim = new BridgeSimulation(withAnchors(truss));
  for (const beam of sim.beams) {
    assert.ok(beam.tensionLimit > 0);
    assert.ok(beam.compressionLimit > 0);
    assert.ok(Math.abs(beam.axial) <= 1);
  }
});

test("findRoadPath ignores structural-only connections", () => {
  const fake = [
    { id: "w1", a: "anchor-left", b: "anchor-right", material: "wood", broken: false },
  ];
  const positions = new Map([
    ["anchor-left", { x: 0, y: 0 }],
    ["anchor-right", { x: 100, y: 0 }],
  ]);
  assert.equal(
    findRoadPath(fake, "anchor-left", "anchor-right", (id) => positions.get(id)),
    null,
  );
});

test("design cost stays inside level budget", () => {
  const build = withAnchors(truss);
  const cost = buildCost(build);
  assert.ok(cost > 0);
  assert.ok(cost <= level.budget, `truss costs ${cost}, budget ${level.budget}`);
});

test("unsupported deck collapses under the truck", () => {
  const result = simulate(withAnchors(deck), 6);
  assert.equal(result.success, false);
  assert.ok(result.failure, "expected a concrete failure reason");
});

test("triangulated wood truss carries the truck across", () => {
  const result = simulate(withAnchors(truss), 12);
  assert.equal(result.success, true, `failure=${result.failure}, stress=${result.maxStress}`);
  assert.equal(result.broken, 0);
  assert.ok(result.maxStress < 1.1, `stress too close to breaking: ${result.maxStress}`);
});

test("central pillar support carries the level 2 span", () => {
  const target = LEVELS[1];
  const nodes = [];
  const beams = [];
  let previous = "anchor-left";
  for (let i = 1, x = 312; x < 1014; x += 82, i += 1) {
    nodes.push(node(`d${i}`, x, 372));
    beams.push(beam(`r${i}`, previous, `d${i}`, "road"));
    previous = `d${i}`;
  }
  beams.push(beam("r10", previous, "anchor-right", "road"));
  for (const [index, id] of ["d4", "d5", "d6"].entries()) {
    beams.push(beam(`s${index}`, "anchor-mid", id, "wood"));
  }
  const build = withAnchors({ nodes, beams }, target);
  const cost = buildCost(build);
  assert.ok(cost <= target.budget);
  const result = simulate(build, 18, target);
  assert.equal(result.success, true, `failure=${result.failure}, stress=${result.maxStress}`);
});

test("steel top chord carries the level 3 super-span", () => {
  const target = LEVELS[2];
  const nodes = [];
  const beams = [];
  let previous = "anchor-left";
  const deck = [];
  for (let i = 1, x = 310; x < 1040; x += 110, i += 1) {
    nodes.push(node(`d${i}`, x, 372));
    beams.push(beam(`r${i}`, previous, `d${i}`, "road"));
    previous = `d${i}`;
    deck.push(`d${i}`);
  }
  beams.push(beam(`r${deck.length + 1}`, previous, "anchor-right", "road"));
  for (let i = 1; i <= deck.length; i += 1) {
    nodes.push(node(`t${i}`, 310 + (i - 1) * 110, 282));
  }
  for (let i = 0; i < deck.length - 1; i += 1) {
    beams.push(beam(`tc${i}`, `t${i + 1}`, `t${i + 2}`, "steel"));
  }
  for (let i = 0; i < deck.length; i += 1) {
    beams.push(beam(`v${i}`, `d${i + 1}`, `t${i + 1}`, "wood"));
  }
  for (let i = 0; i < deck.length - 1; i += 1) {
    beams.push(beam(`x${i}`, `t${i + 1}`, `d${i + 2}`, "wood"));
  }
  beams.push(beam("xa", "anchor-left", "t1", "wood"));
  beams.push(beam("xb", `t${deck.length}`, "anchor-right", "wood"));

  const build = withAnchors({ nodes, beams }, target);
  const cost = buildCost(build);
  assert.ok(cost <= target.budget);
  const result = simulate(build, 20, target);
  assert.equal(result.success, true, `failure=${result.failure}, stress=${result.maxStress}`);
});
