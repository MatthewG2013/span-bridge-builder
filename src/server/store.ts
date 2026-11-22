import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  DesignRecord,
  LeaderboardEntry,
  ResultRecord,
  SaveDesignRequest,
  SubmitResultRequest,
} from "../shared/types.js";

interface Database {
  version: 1;
  designs: DesignRecord[];
  results: ResultRecord[];
}

const EMPTY_DB: Database = { version: 1, designs: [], results: [] };

export interface SaveDesignResult {
  design: DesignRecord;
  created: boolean;
}

export interface SubmitResultResult {
  result: ResultRecord;
  improved: boolean;
}

export class JsonStore {
  readonly filePath: string;
  private data: Database = clone(EMPTY_DB);
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  static async open(dataDir: string): Promise<JsonStore> {
    const filePath = path.join(path.resolve(dataDir), "db.json");
    const store = new JsonStore(filePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.persist();
        return;
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(text) as Partial<Database>;
      this.data = {
        version: 1,
        designs: Array.isArray(parsed.designs) ? parsed.designs.filter(isDesign) : [],
        results: Array.isArray(parsed.results) ? parsed.results.filter(isResult) : [],
      };
    } catch {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        await rename(this.filePath, backup);
      } catch {
        // If the backup fails we still want a usable, empty database.
      }
      this.data = clone(EMPTY_DB);
      await this.persist();
    }
  }

  async saveDesign(
    request: SaveDesignRequest & { cost: number },
  ): Promise<SaveDesignResult> {
    const now = new Date().toISOString();
    const existingIndex = this.data.designs.findIndex(
      (design) =>
        design.levelId === request.levelId &&
        design.nickname.toLowerCase() === request.nickname.toLowerCase(),
    );

    let design: DesignRecord;
    let created = false;
    if (existingIndex >= 0) {
      const previous = this.data.designs[existingIndex]!;
      design = {
        ...previous,
        nickname: request.nickname,
        name: request.name,
        build: clone(request.build),
        cost: request.cost,
        updatedAt: now,
      };
      this.data.designs[existingIndex] = design;
    } else {
      created = true;
      design = {
        id: randomUUID(),
        nickname: request.nickname,
        levelId: request.levelId,
        name: request.name,
        build: clone(request.build),
        cost: request.cost,
        createdAt: now,
        updatedAt: now,
      };
      this.data.designs.unshift(design);
      if (this.data.designs.length > 600) {
        this.data.designs.length = 600;
      }
    }

    await this.persist();
    return { design: clone(design), created };
  }

  findDesign(nickname: string, levelId: string): DesignRecord | null {
    const found = this.data.designs.find(
      (design) =>
        design.levelId === levelId &&
        design.nickname.toLowerCase() === nickname.toLowerCase(),
    );
    return found ? clone(found) : null;
  }

  async submitResult(request: SubmitResultRequest): Promise<SubmitResultResult> {
    const existingIndex = this.data.results.findIndex(
      (result) =>
        result.levelId === request.levelId &&
        result.nickname.toLowerCase() === request.nickname.toLowerCase(),
    );

    const now = new Date().toISOString();
    if (existingIndex >= 0) {
      const previous = this.data.results[existingIndex]!;
      const better =
        request.cost < previous.cost ||
        (request.cost === previous.cost && request.time < previous.time);
      if (!better) {
        return { result: clone(previous), improved: false };
      }
      const result: ResultRecord = {
        ...previous,
        nickname: request.nickname,
        cost: request.cost,
        time: request.time,
        beams: request.beams,
        createdAt: now,
      };
      this.data.results[existingIndex] = result;
      await this.persist();
      return { result: clone(result), improved: true };
    }

    const result: ResultRecord = {
      id: randomUUID(),
      nickname: request.nickname,
      levelId: request.levelId,
      cost: request.cost,
      time: request.time,
      beams: request.beams,
      createdAt: now,
    };
    this.data.results.push(result);
    if (this.data.results.length > 3000) {
      this.data.results = this.data.results
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 3000);
    }
    await this.persist();
    return { result: clone(result), improved: true };
  }

  leaderboard(levelId: string, limit = 10): LeaderboardEntry[] {
    return this.data.results
      .filter((result) => result.levelId === levelId)
      .sort((a, b) => a.cost - b.cost || a.time - b.time || a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, Math.min(50, limit)))
      .map((result) => ({
        nickname: result.nickname,
        cost: result.cost,
        time: result.time,
        beams: result.beams,
        createdAt: result.createdAt,
      }));
  }

  personalBest(nickname: string, levelId: string): LeaderboardEntry | null {
    const found = this.data.results.find(
      (result) =>
        result.levelId === levelId &&
        result.nickname.toLowerCase() === nickname.toLowerCase(),
    );
    if (!found) return null;
    return {
      nickname: found.nickname,
      cost: found.cost,
      time: found.time,
      beams: found.beams,
      createdAt: found.createdAt,
    };
  }

  stats(): { designs: number; results: number } {
    return { designs: this.data.designs.length, results: this.data.results.length };
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    const filePath = this.filePath;
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await writeFile(tempPath, snapshot, "utf8");
      await rename(tempPath, filePath);
    });
    return this.writeQueue;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isDesign(value: unknown): value is DesignRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DesignRecord>;
  return (
    typeof item.id === "string" &&
    typeof item.nickname === "string" &&
    typeof item.levelId === "string" &&
    typeof item.name === "string" &&
    typeof item.cost === "number" &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string" &&
    Boolean(item.build) &&
    Array.isArray(item.build?.nodes) &&
    Array.isArray(item.build?.beams)
  );
}

function isResult(value: unknown): value is ResultRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ResultRecord>;
  return (
    typeof item.id === "string" &&
    typeof item.nickname === "string" &&
    typeof item.levelId === "string" &&
    typeof item.cost === "number" &&
    typeof item.time === "number" &&
    typeof item.beams === "number" &&
    typeof item.createdAt === "string"
  );
}
