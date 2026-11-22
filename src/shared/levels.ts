import type { Level } from "./types.js";

/**
 * Levels are shared by the client and server. Geometry is expressed in the
 * 1280 x 720 world space; anchors are fixed structural attachment points.
 */
export const LEVELS: Level[] = [
  {
    id: "creek",
    index: 1,
    name: "溪谷小路",
    code: "SPAN-01",
    subtitle: "先让第一辆车通过",
    difficulty: "入门",
    budget: 1050,
    timeLimit: 25,
    gap: { left: 300, right: 620 },
    deckY: 372,
    anchors: [
      { id: "anchor-left", x: 300, y: 372, label: "左岸锚点", deck: true },
      { id: "anchor-right", x: 620, y: 372, label: "右岸锚点", deck: true },
    ],
    startAnchorId: "anchor-left",
    endAnchorId: "anchor-right",
    terrain: [
      { x1: -120, x2: 300, top: 372 },
      { x1: 620, x2: 1400, top: 372 },
      { x1: 220, x2: 300, top: 500 },
      { x1: 620, x2: 700, top: 500 },
    ],
    brief: "320 像素宽的溪谷。用木料搭出三角桁架，再铺一条连续路面。",
    hint: "先连续铺好路面，再从路面节点向斜上方拉出三角形木撑。",
  },
  {
    id: "pillar",
    index: 2,
    name: "双峰之间",
    code: "SPAN-02",
    subtitle: "借力中央石柱",
    difficulty: "进阶",
    budget: 1750,
    timeLimit: 30,
    gap: { left: 230, right: 1050 },
    deckY: 372,
    anchors: [
      { id: "anchor-left", x: 230, y: 372, label: "左岸锚点", deck: true },
      { id: "anchor-mid", x: 650, y: 488, label: "石柱锚点", deck: false },
      { id: "anchor-right", x: 1050, y: 372, label: "右岸锚点", deck: true },
    ],
    startAnchorId: "anchor-left",
    endAnchorId: "anchor-right",
    terrain: [
      { x1: -120, x2: 230, top: 372 },
      { x1: 1050, x2: 1400, top: 372 },
      { x1: 606, x2: 694, top: 488 },
      { x1: 150, x2: 230, top: 520 },
      { x1: 1050, x2: 1130, top: 520 },
    ],
    brief: "中央石柱比桥面低 116 像素。可以把桥面直接架在石柱上，也可以从石柱向上做支撑。",
    hint: "石柱锚点能承担巨大压力，试试从锚点向两侧桥面拉钢梁。",
  },
  {
    id: "gorge",
    index: 3,
    name: "大峡谷",
    code: "SPAN-03",
    subtitle: "极限跨度，精打细算",
    difficulty: "挑战",
    budget: 3900,
    timeLimit: 32,
    gap: { left: 200, right: 1080 },
    deckY: 372,
    anchors: [
      { id: "anchor-left", x: 200, y: 372, label: "左岸锚点", deck: true },
      { id: "anchor-right", x: 1080, y: 372, label: "右岸锚点", deck: true },
      { id: "anchor-left-low", x: 236, y: 512, label: "左岸下锚点", deck: false },
      { id: "anchor-right-low", x: 1044, y: 512, label: "右岸下锚点", deck: false },
    ],
    startAnchorId: "anchor-left",
    endAnchorId: "anchor-right",
    terrain: [
      { x1: -120, x2: 200, top: 372 },
      { x1: 1080, x2: 1400, top: 372 },
      { x1: 120, x2: 200, top: 512 },
      { x1: 1080, x2: 1160, top: 512 },
      { x1: 150, x2: 200, top: 640 },
      { x1: 1080, x2: 1130, top: 640 },
    ],
    brief: "880 像素的超级跨度。下锚点可以做出更深的桁架，但材料也更多。",
    hint: "先铺一条轻质路面，再用钢材做上弦和斜撑，把载荷传回两岸。",
  },
];

export function levelById(id: string): Level | undefined {
  return LEVELS.find((level) => level.id === id);
}

export function terrainAt(level: Level, x: number, y: number): boolean {
  return level.terrain.some(
    (block) => x >= block.x1 && x <= block.x2 && y >= block.top,
  );
}

/** Returns true when a new build node may be placed at this point. */
export function canPlaceAt(level: Level, x: number, y: number): boolean {
  if (x < 24 || x > 1256 || y < 80 || y > 664) return false;
  return !level.terrain.some(
    (block) =>
      x > block.x1 + 10 && x < block.x2 - 10 && y > block.top + 10,
  );
}
