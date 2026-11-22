import { api, ApiError } from "./api.js";
import { Game, type GameResult } from "./game.js";
import { LEVELS } from "../shared/levels.js";
import { formatMoney } from "../shared/materials.js";
import { UI, type UiHandlers } from "./ui.js";

const STORAGE_NICKNAME = "span.nickname";
const STORAGE_COMPLETED = "span.completed";
const STORAGE_LEVEL = "span.level";

class App {
  private readonly ui: UI;
  private readonly game: Game;
  private levelIndex = 0;
  private completed = new Set<number>();
  private boardRequest = 0;

  constructor() {
    this.completed = this.readCompleted();
    const handlers: UiHandlers = {
      onSelectLevel: (index) => this.selectLevel(index),
      onSelectMaterial: (material) => this.game.setMaterial(material),
      onUndo: () => this.game.undo(),
      onRedo: () => this.game.redo(),
      onReset: () => void this.resetBuild(),
      onTest: () => this.toggleTest(),
      onSave: () => void this.saveDesign(),
      onLoad: () => void this.loadDesign(),
      onNicknameChange: (nickname) => this.handleNicknameChange(nickname),
      onRefreshBoard: () => void this.refreshLeaderboard(),
    };

    this.ui = new UI(handlers);
    const canvas = document.getElementById("gameCanvas") as HTMLCanvasElement | null;
    if (!canvas) throw new Error("Missing #gameCanvas");

    this.levelIndex = this.readLevelIndex();
    this.game = new Game(
      canvas,
      {
        onHud: (hud) => this.ui.updateHud(hud),
        onToast: (message, kind) => this.ui.toast(message, kind),
        onSuccess: (result) => void this.handleSuccess(result),
        onFailure: (reason) => void this.handleFailure(reason),
      },
      this.levelIndex,
    );
    this.ui.setActiveLevel(this.levelIndex);
    this.ui.setCompletedLevels(this.completed);
    this.ui.setSaveState("未保存", false);
    (window as unknown as { __SPAN__?: unknown }).__SPAN__ = {
      game: this.game,
      ui: this.ui,
      app: this,
    };
    void this.init();
  }

  private async init(): Promise<void> {
    const nickname = this.ui.nickname;
    this.ui.setNicknameSaved(Boolean(nickname));

    try {
      await api.health();
      this.ui.setServerOnline(true);
    } catch {
      this.ui.setServerOnline(false);
      this.ui.toast("后端未连接：仍可建造，但服务器存档与排行榜不可用。", "error");
      this.ui.setSaveState("离线", false);
      return;
    }

    await this.refreshLeaderboard();
    if (nickname) {
      await this.restoreDesign(nickname, true);
    }
  }

  private selectLevel(index: number): void {
    const next = LEVELS[index];
    if (!next) return;
    if (index === this.levelIndex) return;
    this.game.setLevel(index);
    this.levelIndex = index;
    localStorage.setItem(STORAGE_LEVEL, String(index));
    this.ui.setActiveLevel(index);
    this.ui.setCompletedLevels(this.completed);
    this.ui.markClean();
    void this.refreshLeaderboard();
    this.ui.toast(`进入「${next.name}」`, "info");
    void this.notifySavedDesign();
  }

  private async notifySavedDesign(): Promise<void> {
    const nickname = this.ui.nickname;
    if (!nickname) return;
    try {
      const response = await api.getDesign(nickname, this.currentLevel.id);
      if (response.design) {
        this.ui.toast("检测到本关服务器存档，可点击「读取存档」恢复。", "info");
      }
    } catch {
      // Non-critical check; the load button reports real errors.
    }
  }

  private toggleTest(): void {
    if (this.game.currentMode === "edit") {
      this.game.startTest();
      return;
    }
    this.game.stopTest();
  }

  private async resetBuild(): Promise<void> {
    if (this.game.currentMode !== "edit") {
      this.game.stopTest(true);
    }
    if (this.game.currentBuild.beams.length === 0) {
      this.ui.toast("当前没有可清空的构件", "info");
      return;
    }
    const ok = await this.ui.confirm(
      "清空当前设计？",
      "所有构件会被拆除，预算恢复到关卡初始值。锚点会保留。",
      "清空设计",
      true,
    );
    if (ok) {
      this.game.clearBuild();
      this.ui.markClean();
    }
  }

  private async ensureNickname(): Promise<string | null> {
    let nickname = this.ui.nickname;
    if (!nickname) {
      nickname = (await this.ui.promptNickname("")) ?? "";
      if (!nickname) return null;
    }
    nickname = nickname.trim();
    localStorage.setItem(STORAGE_NICKNAME, nickname);
    this.ui.setNickname(nickname);
    this.ui.setNicknameSaved(true);
    return nickname;
  }

  private async saveDesign(): Promise<void> {
    const nickname = await this.ensureNickname();
    if (!nickname) return;
    const level = this.currentLevel;
    const build = this.game.currentBuild;
    if (build.beams.length === 0) {
      this.ui.toast("先搭几根构件再保存", "error");
      return;
    }
    this.ui.setSaveState("保存中…", false);
    try {
      await api.saveDesign(nickname, level.id, `${level.name} · ${nickname}`, build);
      this.ui.setServerOnline(true);
      this.ui.markSaved();
      this.ui.toast(`设计已保存到服务器（${nickname} / ${level.name}）`, "success");
      void this.refreshLeaderboard();
    } catch (error) {
      this.reportError(error, "保存失败");
      this.ui.setSaveState("保存失败", false);
    }
  }

  private async loadDesign(): Promise<void> {
    const nickname = await this.ensureNickname();
    if (!nickname) return;
    const level = this.currentLevel;
    this.ui.setSaveState("读取中…", false);
    try {
      const response = await api.getDesign(nickname, level.id);
      this.ui.setServerOnline(true);
      if (!response.design) {
        this.ui.setSaveState("无存档", false);
        this.ui.toast(`昵称「${nickname}」在「${level.name}」还没有存档。`, "error");
        return;
      }
      if (this.game.currentBuild.beams.length > 0) {
        const ok = await this.ui.confirm(
          "读取服务器存档？",
          "当前设计会被服务器存档覆盖，这一步可以撤销。",
          "读取存档",
        );
        if (!ok) {
          this.ui.setSaveState("未保存", false);
          return;
        }
      }
      const loaded = this.game.loadBuild(response.design.build);
      if (loaded) {
        this.ui.markSaved();
        this.ui.toast(
          `已读取「${response.design.name}」· ${formatMoney(response.design.cost)}`,
          "success",
        );
        void this.refreshLeaderboard();
      }
    } catch (error) {
      this.reportError(error, "读取存档失败");
      this.ui.setSaveState("读取失败", false);
    }
  }

  private async restoreDesign(nickname: string, silent: boolean): Promise<void> {
    try {
      const response = await api.getDesign(nickname, this.currentLevel.id);
      if (!response.design) return;
      if (this.game.currentBuild.beams.length > 0) return;
      this.game.loadBuild(response.design.build);
      this.ui.markSaved();
      if (!silent) {
        this.ui.toast("已从服务器恢复上次保存的设计", "success");
      } else {
        this.ui.toast("已恢复服务器上的本关设计", "info");
      }
    } catch {
      // Health/leaderboard already surface connectivity issues.
    }
  }

  private handleNicknameChange(nickname: string): void {
    localStorage.setItem(STORAGE_NICKNAME, nickname);
    this.ui.setNicknameSaved(false);
    this.ui.setSaveState("未保存", false);
    if (!nickname) {
      this.ui.setPersonalBest(null);
      void this.refreshLeaderboard();
      return;
    }
    if (Array.from(nickname).length > 16) return;
    void this.refreshLeaderboard();
  }

  private async refreshLeaderboard(): Promise<void> {
    const requestId = ++this.boardRequest;
    const nickname = this.ui.nickname;
    try {
      const response = await api.leaderboard(this.currentLevel.id, nickname || undefined);
      if (requestId !== this.boardRequest) return;
      this.ui.setServerOnline(true);
      this.ui.renderLeaderboard(response.entries, nickname);
      this.ui.setPersonalBest(response.personalBest);
    } catch {
      if (requestId !== this.boardRequest) return;
      this.ui.setServerOnline(false);
      this.ui.renderLeaderboard([], nickname);
      this.ui.setPersonalBest(null);
    }
  }

  private async handleSuccess(result: GameResult): Promise<void> {
    this.completed.add(this.levelIndex);
    this.persistCompleted();
    this.ui.setCompletedLevels(this.completed);

    const nickname = this.ui.nickname;
    let note = "填写昵称后再次通过，就能把成绩写进服务器排行榜。";
    if (nickname) {
      this.ui.setSaveState("上传成绩…", false);
      try {
        const response = await api.submitResult(
          nickname,
          result.levelId,
          result.cost,
          result.time,
          result.beams,
        );
        this.ui.setServerOnline(true);
        const rank = response.leaderboard.findIndex(
          (entry) => entry.nickname.toLowerCase() === nickname.toLowerCase(),
        );
        const best = response.leaderboard.find(
          (entry) => entry.nickname.toLowerCase() === nickname.toLowerCase(),
        );
        this.ui.renderLeaderboard(response.leaderboard, nickname);
        this.ui.setPersonalBest(best ?? null);
        note = response.improved
          ? `成绩已上传${rank >= 0 ? `，当前排名第 ${rank + 1}` : ""}。`
          : "成绩已记录；你此前的成绩更好，排行榜继续保留最佳成绩。";
        this.ui.setSaveState("成绩已上传", true);
      } catch (error) {
        this.reportError(error, "成绩上传失败");
        note = "服务器暂时不可用，本次成绩没有上传，但通关记录已保存在本机。";
        this.ui.setSaveState("上传失败", false);
      }
    }

    const action = await this.ui.showSuccess(result, this.levelIndex < LEVELS.length - 1, note);
    if (action === "next") {
      this.selectLevel(this.levelIndex + 1);
    } else if (action === "retry") {
      this.game.retryTest();
    } else {
      this.game.stopTest(true);
    }
  }

  private async handleFailure(reason: string): Promise<void> {
    const action = await this.ui.showFailure(reason);
    if (action === "retry") {
      this.game.retryTest();
    } else {
      this.game.stopTest(true);
    }
  }

  private reportError(error: unknown, fallback: string): void {
    const message = error instanceof ApiError ? error.message : fallback;
    if (error instanceof ApiError && error.status === 0) {
      this.ui.setServerOnline(false);
    }
    this.ui.toast(`${fallback}：${message}`, "error");
  }

  private readCompleted(): Set<number> {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_COMPLETED) ?? "[]") as unknown;
      if (!Array.isArray(raw)) return new Set();
      return new Set(raw.filter((value): value is number => Number.isInteger(value) && value >= 0));
    } catch {
      return new Set();
    }
  }

  private persistCompleted(): void {
    localStorage.setItem(STORAGE_COMPLETED, JSON.stringify([...this.completed]));
  }

  private readLevelIndex(): number {
    const raw = Number(localStorage.getItem(STORAGE_LEVEL) ?? "0");
    if (!Number.isInteger(raw) || raw < 0 || raw >= LEVELS.length) return 0;
    return raw;
  }

  private get currentLevel() {
    return LEVELS[this.levelIndex]!;
  }
}

function boot(): void {
  try {
    new App();
  } catch (error) {
    console.error(error);
    const stack = document.getElementById("toastStack");
    if (stack) {
      const item = document.createElement("div");
      item.className = "toast error";
      item.textContent = "页面初始化失败，请刷新重试。";
      stack.append(item);
    }
  }
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
