import type { Build, MaterialId } from "./types.js";

export interface MaterialSpec {
  id: MaterialId;
  label: string;
  short: string;
  /** Cost in dollars per world pixel. */
  costPerPixel: number;
  density: number;
  /** Position-based constraint stiffness, 0..1. */
  stiffness: number;
  /** Maximum positive strain before damage. */
  tensionLimit: number;
  /** Maximum negative strain before damage (compression / buckling). */
  compressionLimit: number;
  maxLength: number;
  color: string;
  colorDark: string;
  glow: string;
  description: string;
}

export const MATERIALS: Record<MaterialId, MaterialSpec> = {
  road: {
    id: "road",
    label: "路面",
    short: "RD",
    costPerPixel: 1.05,
    density: 0.019,
    stiffness: 0.82,
    tensionLimit: 0.0065,
    compressionLimit: 0.008,
    maxLength: 150,
    color: "#d9a05b",
    colorDark: "#8b6338",
    glow: "#ffd08a",
    description: "卡车唯一能行驶的构件，必须从左岸连到右岸。",
  },
  wood: {
    id: "wood",
    label: "木材",
    short: "WD",
    costPerPixel: 0.72,
    density: 0.011,
    stiffness: 0.52,
    tensionLimit: 0.0072,
    compressionLimit: 0.0062,
    maxLength: 150,
    color: "#b97a4b",
    colorDark: "#6f422a",
    glow: "#ffb27a",
    description: "轻便便宜，适合做三角支撑；受压时容易屈曲。",
  },
  steel: {
    id: "steel",
    label: "钢材",
    short: "ST",
    costPerPixel: 1.92,
    density: 0.022,
    stiffness: 0.9,
    tensionLimit: 0.0145,
    compressionLimit: 0.0115,
    maxLength: 170,
    color: "#7fa6bd",
    colorDark: "#3f5f73",
    glow: "#a9e7ff",
    description: "昂贵而强韧，主跨上弦和关键受拉构件首选。",
  },
};

export const MATERIAL_ORDER: MaterialId[] = ["road", "wood", "steel"];

export function beamCost(material: MaterialId, length: number): number {
  return Math.max(1, Math.round(MATERIALS[material].costPerPixel * length));
}

/** Server-authoritative construction cost for a saved design. */
export function buildCost(build: Build): number {
  const positions = new Map(build.nodes.map((node) => [node.id, node]));
  let total = 0;
  for (const beam of build.beams) {
    const a = positions.get(beam.a);
    const b = positions.get(beam.b);
    if (!a || !b) continue;
    total += beamCost(beam.material, Math.hypot(b.x - a.x, b.y - a.y));
  }
  return total;
}

export function formatMoney(value: number): string {
  return "$" + Math.round(value).toLocaleString("en-US");
}

export function formatTime(value: number): string {
  return value.toFixed(2) + "s";
}
