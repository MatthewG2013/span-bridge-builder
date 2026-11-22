import type { Build, BuildBeam, BuildNode, MaterialId, Vec2 } from "../shared/types.js";
import { MATERIALS } from "../shared/materials.js";

export interface RoadBeam {
  id: string;
  a: string;
  b: string;
  material: MaterialId;
  broken: boolean;
}

export interface SimNode extends BuildNode {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  loadX: number;
  loadY: number;
  mass: number;
  invMass: number;
  pinned: boolean;
}

export interface SimBeam extends RoadBeam {
  nodeA: SimNode;
  nodeB: SimNode;
  rest: number;
  stiffness: number;
  tensionLimit: number;
  compressionLimit: number;
  /** Smoothed stress ratio for rendering (0 safe, 1 near breaking). */
  stress: number;
  /** Signed load direction: negative compression, positive tension. */
  axial: number;
  damage: number;
  sampledStrain: number;
  sampledSignedStrain: number;
  finalStrain: number;
  peakStress: number;
}

export interface RoadPath {
  nodeIds: string[];
  beamIds: string[];
  length: number;
}

export interface PathPoint extends Vec2 {
  angle: number;
  segment: number;
  t: number;
}

export interface StepResult {
  broken: SimBeam[];
  maxStress: number;
  outOfBounds: boolean;
  iterations: number;
}

const GRAVITY = 1350;
const MIN_ITERATIONS = 4;
const MAX_ITERATIONS = 10;
const SOLVER_TOLERANCE = 0.12;
const DAMPING = 0.9985;
const MAX_SPEED = 16;
const MAX_CORRECTION = 0.9;
const MAX_STRAIN_SAMPLE = 4;
const COLLAPSE_X_MIN = -240;
const COLLAPSE_X_MAX = 1520;
const COLLAPSE_Y_MAX = 940;

/**
 * Position-based bridge solver.
 *
 * Two properties matter for feel and performance:
 * - beams hold direct references to their end nodes, so the hot constraint loop
 *   does not touch a Map;
 * - iteration count adapts to residual error, which keeps stable bridges cheap
 *   while still spending extra iterations on heavily loaded spans.
 */
export class BridgeSimulation {
  readonly nodes = new Map<string, SimNode>();
  readonly beams: SimBeam[] = [];
  readonly beamById = new Map<string, SimBeam>();
  readonly brokenBeams: SimBeam[] = [];
  time = 0;
  lastIterations = 0;
  lastResidual = 0;

  constructor(build: Build) {
    for (const source of build.nodes) {
      const node: SimNode = {
        ...source,
        x: source.x,
        y: source.y,
        prevX: source.x,
        prevY: source.y,
        loadX: 0,
        loadY: 0,
        mass: 0.5,
        invMass: 2,
        pinned: Boolean(source.pinned),
      };
      this.nodes.set(node.id, node);
    }

    for (const source of build.beams) {
      const nodeA = this.nodes.get(source.a);
      const nodeB = this.nodes.get(source.b);
      if (!nodeA || !nodeB) continue;
      const material = MATERIALS[source.material];
      const rest = Math.hypot(nodeB.x - nodeA.x, nodeB.y - nodeA.y);
      if (rest < 1) continue;
      const beam: SimBeam = {
        ...source,
        nodeA,
        nodeB,
        rest,
        stiffness: 0.68 + material.stiffness * 0.3,
        tensionLimit: material.tensionLimit,
        compressionLimit: material.compressionLimit,
        broken: false,
        stress: 0,
        axial: 0,
        damage: 0,
        sampledStrain: 0,
        sampledSignedStrain: 0,
        finalStrain: 0,
        peakStress: 0,
      };
      this.beams.push(beam);
      this.beamById.set(beam.id, beam);
      nodeA.mass += rest * material.density * 0.5;
      nodeB.mass += rest * material.density * 0.5;
    }

    for (const node of this.nodes.values()) {
      node.mass = Math.min(12, Math.max(0.55, node.mass));
      node.invMass = node.pinned ? 0 : 1 / node.mass;
    }
  }

  get activeBeams(): SimBeam[] {
    return this.beams.filter((beam) => !beam.broken);
  }

  step(dt: number): StepResult {
    const clampedDt = Math.min(dt, 1 / 30);
    this.time += clampedDt;
    const dt2 = clampedDt * clampedDt;

    for (const beam of this.beams) {
      if (!beam.broken) {
        beam.sampledStrain = 0;
        beam.sampledSignedStrain = 0;
      }
    }

    for (const node of this.nodes.values()) {
      if (node.pinned) {
        node.prevX = node.x;
        node.prevY = node.y;
        node.loadX = 0;
        node.loadY = 0;
        continue;
      }

      const vx = clamp((node.x - node.prevX) * DAMPING, -MAX_SPEED, MAX_SPEED);
      const vy = clamp((node.y - node.prevY) * DAMPING, -MAX_SPEED, MAX_SPEED);
      node.prevX = node.x;
      node.prevY = node.y;

      node.x += vx + node.loadX * dt2;
      node.y += vy + (GRAVITY + node.loadY) * dt2;

      node.loadX = 0;
      node.loadY = 0;

      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
        node.x = node.prevX;
        node.y = node.prevY;
        node.prevX = node.x;
        node.prevY = node.y;
      }

      node.x = clamp(node.x, COLLAPSE_X_MIN, COLLAPSE_X_MAX);
      node.y = clamp(node.y, -420, COLLAPSE_Y_MAX);
    }

    let iterations = 0;
    let residualAtExit = 0;
    for (; iterations < MAX_ITERATIONS; iterations += 1) {
      let maxResidual = 0;
      for (const beam of this.beams) {
        if (beam.broken) continue;
        const a = beam.nodeA;
        const b = beam.nodeB;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.0001) continue;

        const strain = (dist - beam.rest) / beam.rest;
        if (iterations === 0) {
          beam.sampledSignedStrain = strain;
          beam.sampledStrain = Math.min(Math.abs(strain), MAX_STRAIN_SAMPLE);
        }

        const invSum = a.invMass + b.invMass;
        if (invSum === 0) continue;

        const residual = Math.abs(dist - beam.rest);
        if (residual > maxResidual) maxResidual = residual;

        const rawCorrection = ((dist - beam.rest) / dist) * beam.stiffness;
        const correction = clamp(rawCorrection, -MAX_CORRECTION, MAX_CORRECTION);
        const wa = (a.invMass / invSum) * correction;
        const wb = (b.invMass / invSum) * correction;
        a.x += dx * wa;
        a.y += dy * wa;
        b.x -= dx * wb;
        b.y -= dy * wb;
      }

      residualAtExit = maxResidual;
      if (iterations + 1 >= MIN_ITERATIONS && maxResidual < SOLVER_TOLERANCE) {
        iterations += 1;
        break;
      }
    }
    this.lastIterations = iterations;
    this.lastResidual = residualAtExit;

    const newlyBroken: SimBeam[] = [];
    let maxStress = 0;
    let outOfBounds = false;

    for (const beam of this.beams) {
      if (beam.broken) continue;
      const a = beam.nodeA;
      const b = beam.nodeB;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const finalSigned = (dist - beam.rest) / beam.rest;
      const finalAbs = Math.abs(finalSigned);
      const sampledSigned = Math.abs(beam.sampledSignedStrain) > finalAbs * 0.45
        ? beam.sampledSignedStrain
        : finalSigned;
      const sampledAbs = Math.max(beam.sampledStrain, finalAbs * 0.45);
      const limit = sampledSigned >= 0 ? beam.tensionLimit : beam.compressionLimit;
      const ratio = sampledAbs / limit;

      beam.finalStrain = finalSigned;
      beam.peakStress = Math.max(beam.peakStress, ratio);
      beam.stress += (Math.min(ratio, 2.8) - beam.stress) * 0.32;
      beam.axial += ((sampledSigned >= 0 ? 1 : -1) * Math.min(1, ratio) - beam.axial) * 0.3;
      maxStress = Math.max(maxStress, beam.stress);

      if (ratio > 1) {
        beam.damage += clampedDt * 60 * (0.35 + (ratio - 1) * 2.35);
        if (beam.damage > 7.5 || ratio > 3.1) {
          beam.broken = true;
          beam.stress = 1.7;
          newlyBroken.push(beam);
          this.brokenBeams.push(beam);
        }
      } else {
        beam.damage = Math.max(0, beam.damage - clampedDt * 85);
      }
    }

    for (const node of this.nodes.values()) {
      if (
        node.y > 780 ||
        node.x < COLLAPSE_X_MIN + 80 ||
        node.x > COLLAPSE_X_MAX - 80
      ) {
        outOfBounds = true;
      }
    }

    return { broken: newlyBroken, maxStress, outOfBounds, iterations: this.lastIterations };
  }

  /** Adds a downward acceleration to the deck segment under an axle. */
  applyDeckLoad(aId: string, bId: string, t: number, force: number): void {
    const a = this.nodes.get(aId);
    const b = this.nodes.get(bId);
    if (!a || !b) return;
    a.loadY += force * (1 - t);
    b.loadY += force * t;
  }

  nodePosition(id: string): Vec2 | undefined {
    const node = this.nodes.get(id);
    if (!node) return undefined;
    return { x: node.x, y: node.y };
  }

  activeRoadPath(startId: string, endId: string): RoadPath | null {
    return findRoadPath(this.beams, startId, endId, (id) => {
      const node = this.nodes.get(id);
      return node ? { x: node.x, y: node.y } : undefined;
    });
  }

  /** Fast check used to avoid running Dijkstra on every physics substep. */
  isPathIntact(path: RoadPath): boolean {
    for (const beamId of path.beamIds) {
      const beam = this.beamById.get(beamId);
      if (!beam || beam.broken) return false;
    }
    return true;
  }

  peakStress(): number {
    let peak = 0;
    for (const beam of this.beams) {
      if (!beam.broken && beam.peakStress > peak) peak = beam.peakStress;
    }
    return peak;
  }
}

export function pathLength(path: RoadPath, positionOf: (id: string) => Vec2 | undefined): number {
  let total = 0;
  for (let i = 0; i < path.nodeIds.length - 1; i += 1) {
    const a = positionOf(path.nodeIds[i]!);
    const b = positionOf(path.nodeIds[i + 1]!);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

export function pointOnPath(
  path: RoadPath,
  distance: number,
  positionOf: (id: string) => Vec2 | undefined,
): PathPoint | null {
  let remaining = Math.max(0, distance);
  for (let i = 0; i < path.nodeIds.length - 1; i += 1) {
    const a = positionOf(path.nodeIds[i]!);
    const b = positionOf(path.nodeIds[i + 1]!);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segmentLength = Math.sqrt(dx * dx + dy * dy);
    if (segmentLength < 0.001) continue;
    if (remaining <= segmentLength || i === path.nodeIds.length - 2) {
      const t = Math.min(1, remaining / segmentLength);
      return {
        x: a.x + dx * t,
        y: a.y + dy * t,
        angle: Math.atan2(dy, dx),
        segment: i,
        t,
      };
    }
    remaining -= segmentLength;
  }
  return null;
}

/**
 * Dijkstra over intact road beams. Positions are used for edge weights so the
 * shortest physical deck wins when the player creates loops.
 */
export function findRoadPath(
  beams: readonly RoadBeam[],
  startId: string,
  endId: string,
  positionOf: (id: string) => Vec2 | undefined,
): RoadPath | null {
  if (startId === endId) return { nodeIds: [startId], beamIds: [], length: 0 };

  const adjacency = new Map<string, { to: string; beamId: string; weight: number }[]>();
  for (const beam of beams) {
    if (beam.broken || beam.material !== "road") continue;
    const a = positionOf(beam.a);
    const b = positionOf(beam.b);
    if (!a || !b) continue;
    const weight = Math.hypot(b.x - a.x, b.y - a.y);
    if (!adjacency.has(beam.a)) adjacency.set(beam.a, []);
    if (!adjacency.has(beam.b)) adjacency.set(beam.b, []);
    adjacency.get(beam.a)!.push({ to: beam.b, beamId: beam.id, weight });
    adjacency.get(beam.b)!.push({ to: beam.a, beamId: beam.id, weight });
  }

  const distances = new Map<string, number>();
  const previous = new Map<string, { nodeId: string; beamId: string }>();
  const visited = new Set<string>();
  distances.set(startId, 0);

  while (true) {
    let current: string | null = null;
    let best = Infinity;
    for (const [id, distance] of distances) {
      if (!visited.has(id) && distance < best) {
        best = distance;
        current = id;
      }
    }
    if (current === null) break;
    if (current === endId) break;
    visited.add(current);

    for (const edge of adjacency.get(current) ?? []) {
      if (visited.has(edge.to)) continue;
      const next = best + edge.weight;
      if (next < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to, next);
        previous.set(edge.to, { nodeId: current, beamId: edge.beamId });
      }
    }
  }

  if (!distances.has(endId)) return null;

  const nodeIds: string[] = [endId];
  const beamIds: string[] = [];
  let cursor = endId;
  while (cursor !== startId) {
    const step = previous.get(cursor);
    if (!step) return null;
    beamIds.unshift(step.beamId);
    nodeIds.unshift(step.nodeId);
    cursor = step.nodeId;
  }

  return { nodeIds, beamIds, length: distances.get(endId) ?? 0 };
}

export function createInitialBuild(anchors: BuildNode[]): Build {
  return {
    nodes: anchors.map((anchor) => ({ ...anchor, pinned: true })),
    beams: [],
  };
}

export function findDuplicateBeam(
  build: Build,
  aId: string,
  bId: string,
): BuildBeam | undefined {
  return build.beams.find(
    (beam) =>
      (beam.a === aId && beam.b === bId) || (beam.a === bId && beam.b === aId),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
