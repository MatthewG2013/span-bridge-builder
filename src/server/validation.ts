import { LEVELS, levelById } from "../shared/levels.js";
import { buildCost } from "../shared/materials.js";
import type {
  Build,
  BuildBeam,
  BuildNode,
  MaterialId,
  SaveDesignRequest,
  SubmitResultRequest,
} from "../shared/types.js";

export class ValidationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
  }
}

const MATERIAL_IDS = new Set<MaterialId>(["road", "wood", "steel"]);

export function validateNickname(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("昵称不能为空");
  const trimmed = value.trim().replace(/\s+/g, " ");
  const length = Array.from(trimmed).length;
  if (length < 1) throw new ValidationError("昵称不能为空");
  if (length > 16) throw new ValidationError("昵称最多 16 个字符");
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new ValidationError("昵称包含非法字符");
  return trimmed;
}

export function validateDesignName(value: unknown): string {
  if (value === undefined || value === null || value === "") return "未命名桥梁";
  if (typeof value !== "string") throw new ValidationError("设计名称格式错误");
  const trimmed = value.trim();
  if (Array.from(trimmed).length > 32) throw new ValidationError("设计名称最多 32 个字符");
  return trimmed || "未命名桥梁";
}

export function validateLevelId(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("关卡参数缺失");
  const level = levelById(value);
  if (!level) throw new ValidationError("未知关卡", 404);
  return level.id;
}

export function validateBuild(raw: unknown): Build {
  if (!raw || typeof raw !== "object") throw new ValidationError("桥梁数据缺失");
  const input = raw as { nodes?: unknown; beams?: unknown };
  if (!Array.isArray(input.nodes) || !Array.isArray(input.beams)) {
    throw new ValidationError("桥梁数据结构不完整");
  }
  if (input.nodes.length > 200) throw new ValidationError("节点数量超出限制");
  if (input.beams.length > 240) throw new ValidationError("构件数量超出限制");

  const nodes: BuildNode[] = [];
  const nodeIds = new Set<string>();
  for (const value of input.nodes) {
    if (!value || typeof value !== "object") throw new ValidationError("节点格式错误");
    const node = value as Partial<BuildNode>;
    if (typeof node.id !== "string" || node.id.length < 1 || node.id.length > 64) {
      throw new ValidationError("节点 ID 非法");
    }
    if (nodeIds.has(node.id)) throw new ValidationError("存在重复节点");
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      throw new ValidationError("节点坐标非法");
    }
    if (node.x! < -160 || node.x! > 1440 || node.y! < -60 || node.y! > 820) {
      throw new ValidationError("节点超出场景范围");
    }
    nodeIds.add(node.id);
    nodes.push({
      id: node.id,
      x: Math.round(node.x! * 100) / 100,
      y: Math.round(node.y! * 100) / 100,
      ...(node.pinned ? { pinned: true } : {}),
    });
  }

  const beams: BuildBeam[] = [];
  const edges = new Set<string>();
  for (const value of input.beams) {
    if (!value || typeof value !== "object") throw new ValidationError("构件格式错误");
    const beam = value as Partial<BuildBeam>;
    if (
      typeof beam.id !== "string" ||
      typeof beam.a !== "string" ||
      typeof beam.b !== "string" ||
      typeof beam.material !== "string" ||
      !MATERIAL_IDS.has(beam.material as MaterialId)
    ) {
      throw new ValidationError("构件字段非法");
    }
    if (beam.a === beam.b) throw new ValidationError("构件不能连接同一个节点");
    if (!nodeIds.has(beam.a) || !nodeIds.has(beam.b)) {
      throw new ValidationError("构件引用了不存在的节点");
    }
    const key = [beam.a, beam.b].sort().join("|");
    if (edges.has(key)) throw new ValidationError("存在重复构件");
    edges.add(key);
    beams.push({
      id: beam.id.slice(0, 64),
      a: beam.a,
      b: beam.b,
      material: beam.material as MaterialId,
    });
  }

  return { nodes, beams };
}

export function validateDesign(body: unknown): SaveDesignRequest & { cost: number } {
  if (!body || typeof body !== "object") throw new ValidationError("请求体格式错误");
  const input = body as Record<string, unknown>;
  const nickname = validateNickname(input.nickname);
  const levelId = validateLevelId(input.levelId);
  const name = validateDesignName(input.name);
  const build = validateBuild(input.build);
  const level = levelById(levelId)!;

  // Every saved bridge must keep the level's anchors intact.
  for (const anchor of level.anchors) {
    const node = build.nodes.find((item) => item.id === anchor.id);
    if (!node || Math.abs(node.x - anchor.x) > 1 || Math.abs(node.y - anchor.y) > 1) {
      throw new ValidationError("桥梁数据缺少关卡锚点");
    }
  }

  for (const beam of build.beams) {
    const a = build.nodes.find((node) => node.id === beam.a)!;
    const b = build.nodes.find((node) => node.id === beam.b)!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > 190) throw new ValidationError("存在过长的构件");
  }

  const cost = buildCost(build);
  if (cost > level.budget) throw new ValidationError("设计超出关卡预算");
  return { nickname, levelId, name, build, cost };
}

export function validateResult(body: unknown): SubmitResultRequest {
  if (!body || typeof body !== "object") throw new ValidationError("请求体格式错误");
  const input = body as Record<string, unknown>;
  const nickname = validateNickname(input.nickname);
  const levelId = validateLevelId(input.levelId);
  const cost = Number(input.cost);
  const time = Number(input.time);
  const beams = Number(input.beams);
  const level = levelById(levelId)!;

  if (!Number.isFinite(cost) || cost < 0 || cost > level.budget) {
    throw new ValidationError("成绩成本非法");
  }
  if (!Number.isFinite(time) || time < 0.05 || time > 300) {
    throw new ValidationError("成绩时间非法");
  }
  if (!Number.isInteger(beams) || beams < 0 || beams > 240) {
    throw new ValidationError("构件数量非法");
  }

  return {
    nickname,
    levelId,
    cost: Math.round(cost),
    time: Math.round(time * 100) / 100,
    beams,
  };
}

export function validateLevelQuery(value: unknown): string {
  return validateLevelId(value);
}

export function listPublicLevels(): unknown[] {
  return LEVELS.map((level) => ({
    id: level.id,
    index: level.index,
    name: level.name,
    budget: level.budget,
  }));
}
