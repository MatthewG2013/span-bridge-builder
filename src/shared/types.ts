export type MaterialId = "road" | "wood" | "steel";

export interface Vec2 {
  x: number;
  y: number;
}

export interface TerrainBlock {
  x1: number;
  x2: number;
  /** Top surface of the rock. Everything at or below this line is solid. */
  top: number;
}

export interface Anchor extends Vec2 {
  id: string;
  label: string;
  /** Deck anchors are the required road endpoints. */
  deck: boolean;
}

export interface Level {
  id: string;
  index: number;
  name: string;
  code: string;
  subtitle: string;
  difficulty: "入门" | "进阶" | "挑战";
  budget: number;
  timeLimit: number;
  gap: { left: number; right: number };
  deckY: number;
  anchors: Anchor[];
  startAnchorId: string;
  endAnchorId: string;
  terrain: TerrainBlock[];
  brief: string;
  hint: string;
}

export interface BuildNode extends Vec2 {
  id: string;
  pinned?: boolean;
}

export interface BuildBeam {
  id: string;
  a: string;
  b: string;
  material: MaterialId;
}

export interface Build {
  nodes: BuildNode[];
  beams: BuildBeam[];
}

export interface DesignRecord {
  id: string;
  nickname: string;
  levelId: string;
  name: string;
  build: Build;
  cost: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResultRecord {
  id: string;
  nickname: string;
  levelId: string;
  cost: number;
  time: number;
  beams: number;
  createdAt: string;
}

export interface LeaderboardEntry {
  nickname: string;
  cost: number;
  time: number;
  beams: number;
  createdAt: string;
}

export interface SaveDesignRequest {
  nickname: string;
  levelId: string;
  name: string;
  build: Build;
}

export interface SubmitResultRequest {
  nickname: string;
  levelId: string;
  cost: number;
  time: number;
  beams: number;
}
