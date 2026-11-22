import type {
  Build,
  DesignRecord,
  LeaderboardEntry,
  ResultRecord,
  SaveDesignRequest,
  SubmitResultRequest,
} from "../shared/types.js";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

interface LeaderboardResponse {
  levelId: string;
  entries: LeaderboardEntry[];
  personalBest: LeaderboardEntry | null;
}

interface SaveDesignResponse {
  ok: boolean;
  created: boolean;
  design: DesignRecord;
}

interface SubmitResultResponse {
  ok: boolean;
  improved: boolean;
  result: ResultRecord;
  leaderboard: LeaderboardEntry[];
}

interface HealthResponse {
  ok: boolean;
  name: string;
  version: string;
  time: string;
  storage: { designs: number; results: number };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      cache: "no-store",
    });
  } catch {
    throw new ApiError("无法连接服务器。请确认后端已启动。", 0);
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `请求失败 (${response.status})`;
    throw new ApiError(message, response.status);
  }

  return body as T;
}

export const api = {
  health(): Promise<HealthResponse> {
    return request<HealthResponse>("/api/health");
  },

  leaderboard(levelId: string, nickname?: string): Promise<LeaderboardResponse> {
    const params = new URLSearchParams({ levelId });
    if (nickname) params.set("nickname", nickname);
    return request<LeaderboardResponse>(`/api/leaderboard?${params.toString()}`);
  },

  getDesign(nickname: string, levelId: string): Promise<{ design: DesignRecord | null }> {
    const params = new URLSearchParams({ nickname, levelId });
    return request<{ design: DesignRecord | null }>(`/api/designs?${params.toString()}`);
  },

  saveDesign(
    nickname: string,
    levelId: string,
    name: string,
    build: Build,
  ): Promise<SaveDesignResponse> {
    const payload: SaveDesignRequest = { nickname, levelId, name, build };
    return request<SaveDesignResponse>("/api/designs", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  submitResult(
    nickname: string,
    levelId: string,
    cost: number,
    time: number,
    beams: number,
  ): Promise<SubmitResultResponse> {
    const payload: SubmitResultRequest = { nickname, levelId, cost, time, beams };
    return request<SubmitResultResponse>("/api/results", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
};
