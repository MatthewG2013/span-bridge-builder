import type { Build, BuildBeam, BuildNode, MaterialId, Vec2 } from "../shared/types.js";
import { MATERIALS } from "../shared/materials.js";

export interface SimNode extends BuildNode {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  loadX: number;
  loadY: number;
  mass: number;
  pinned: boolean;
}

export interface SimBeam {
  id: string;
  a: string;
  b: string;
  material: MaterialId;
  rest: number;
  stiffness: number;
  breakStrain: number;
  broken: boolean;
  stress: number;
  overload: number;
  firstStrain: number;
  finalStrain: number;
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
}

const GRAVITY = 1350;
const CONSTRAINT_ITERATIONS = 9;
const DAMPING = 0.9985;
const MAX_SPEED = 16;
const MAX_STRAIN_SAMPLE = 4;

/**
 * Position-based bridge solver. Nodes are particles; beams are stiff distance
 * constraints. Stress is sampled from the first solver iteration each frame,
 * which reflects the strain introduced by gravity and the moving truck before
 * the constraints pull the structure back into shape.
 */
export class BridgeSimulation {
  readonly nodes = new Map<string, SimNode>();
  readonly beams: SimBeam[] = [];
  readonly brokenBeams: SimBeam[] = [];
  time = 0;

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
        pinned: Boolean(source.pinned),
      };
      this.nodes.set(node.id, node);
    }

    for (const source of build.beams) {
      const a = this.nodes.get(source.a);
      const b = this.nodes.get(source.b);
      if (!a || !b) continue;
      const material = MATERIALS[source.material];
      const rest = Math.hypot(b.x - a.x, b.y - a.y);
      if (rest < 1) continue;
      const beam: SimBeam = {
        ...source,
        rest,
        stiffness: 0.55 + material.stiffness * 0.42,
        breakStrain: material.breakStrain,
        broken: false,
        stress: 0,
        overload: 0,
        firstStrain: 0,
        finalStrain: 0,
      };
      this.beams.push(beam);
      a.mass += rest * material.density * 0.5;
      b.mass += rest * material.density * 0.5;
    }

    for (const node of this.nodes.values()) {
      node.mass = Math.min(12, Math.max(0.55, node.mass));
    }
  }

  get activeBeams(): SimBeam[] {
    return this.beams.filter((beam) => !beam.broken);
  }

  step(dt: number): StepResult {
    const clampedDt = Math.min(dt, 1 / 30);
    this.time += clampedDt;
    const dt2 = clampedDt * clampedDt;
    const firstStrains = new Map<string, number>();

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

      const ax = node.loadX;
      const ay = GRAVITY + node.loadY;
      node.x += vx + ax * dt2;
      node.y += vy + ay * dt2;

      node.loadX = 0;
      node.loadY = 0;

      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
        node.x = node.prevX;
        node.y = node.prevY;
        node.prevX = node.x;
        node.prevY = node.y;
      }

      // Keep runaway simulation inside a broad sandbox.
      node.x = clamp(node.x, -240, 1520);
      node.y = clamp(node.y, -420, 940);
    }

    for (let iteration = 0; iteration < CONSTRAINT_ITERATIONS; iteration += 1) {
      for (const beam of this.beams) {
        if (beam.broken) continue;
        const a = this.nodes.get(beam.a);
        const b = this.nodes.get(beam.b);
        if (!a || !b) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 0.0001) continue;

        const strain = (dist - beam.rest) / beam.rest;
        if (iteration === 0) {
          firstStrains.set(beam.id, Math.min(Math.abs(strain), MAX_STRAIN_SAMPLE));
        }

        const invA = a.pinned ? 0 : 1 / a.mass;
        const invB = b.pinned ? 0 : 1 / b.mass;
        const invSum = invA + invB;
        if (invSum === 0) continue;

        const correction = ((dist - beam.rest) / dist) * beam.stiffness;
        a.x += dx * correction * (invA / invSum);
        a.y += dy * correction * (invA / invSum);
        b.x -= dx * correction * (invB / invSum);
        b.y -= dy * correction * (invB / invSum);
      }
    }

    const newlyBroken: SimBeam[] = [];
    let maxStress = 0;
    let outOfBounds = false;

    for (const beam of this.beams) {
      if (beam.broken) continue;
      const a = this.nodes.get(beam.a);
      const b = this.nodes.get(beam.b);
      if (!a || !b) continue;

      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const finalStrain = Math.abs((dist - beam.rest) / beam.rest);
      const first = firstStrains.get(beam.id) ?? 0;
      const sampled = Math.max(first, finalStrain * 0.45);
      const ratio = sampled / beam.breakStrain;

      beam.firstStrain = first;
      beam.finalStrain = finalStrain;
      beam.stress += (Math.min(ratio, 2.4) - beam.stress) * 0.34;
      maxStress = Math.max(maxStress, beam.stress);

      if (ratio > 1) {
        beam.overload += clampedDt * 60 * (0.55 + (ratio - 1) * 2.5);
        if (beam.overload > 5.5 || ratio > 2.4) {
          beam.broken = true;
          beam.stress = 1.6;
          newlyBroken.push(beam);
          this.brokenBeams.push(beam);
        }
      } else {
        beam.overload = Math.max(0, beam.overload - clampedDt * 90);
      }
    }

    for (const node of this.nodes.values()) {
      if (node.y > 780 || node.x < -160 || node.x > 1440) {
        outOfBounds = true;
      }
    }

    return { broken: newlyBroken, maxStress, outOfBounds };
  }

  /** Adds a downward acceleration to the deck segment nearest the truck. */
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
}

export function pathLength(path: RoadPath, positionOf: (id: string) => Vec2 | undefined): number {
  let total = 0;
  for (let i = 0; i < path.nodeIds.length - 1; i += 1) {
    const a = positionOf(path.nodeIds[i]!);
    const b = positionOf(path.nodeIds[i + 1]!);
    if (!a || !b) continue;
    total += Math.hypot(b.x - a.x, b.y - a.y);
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
    const segmentLength = Math.hypot(b.x - a.x, b.y - a.y);
    if (segmentLength < 0.001) continue;
    if (remaining <= segmentLength || i === path.nodeIds.length - 2) {
      const t = Math.min(1, remaining / segmentLength);
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        angle: Math.atan2(b.y - a.y, b.x - a.x),
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
  beams: SimBeam[],
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
