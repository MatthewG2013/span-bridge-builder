import { MATERIALS, MATERIAL_ORDER, formatMoney, formatTime } from "../shared/materials.js";
import { LEVELS } from "../shared/levels.js";
import type { LeaderboardEntry, MaterialId } from "../shared/types.js";
import type { GameHudState, GameResult } from "./game.js";

export interface UiHandlers {
  onSelectLevel: (index: number) => void;
  onSelectMaterial: (material: MaterialId) => void;
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
  onTest: () => void;
  onSave: () => void;
  onLoad: () => void;
  onNicknameChange: (nickname: string) => void;
  onRefreshBoard: () => void;
}

type ToastKind = "info" | "error" | "success";

interface DialogAction {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
}

interface DialogOptions {
  eyebrow: string;
  title: string;
  body: string;
  actions: DialogAction[];
}

export class UI {
  private readonly handlers: UiHandlers;
  private readonly levelSwitch = byId<HTMLElement>("levelSwitch");
  private readonly levelCode = byId<HTMLElement>("levelCode");
  private readonly levelDifficulty = byId<HTMLElement>("levelDifficulty");
  private readonly levelName = byId<HTMLElement>("levelName");
  private readonly levelSubtitle = byId<HTMLElement>("levelSubtitle");
  private readonly budgetValue = byId<HTMLElement>("budgetValue");
  private readonly budgetBar = byId<HTMLElement>("budgetBar");
  private readonly budgetRing = byId<HTMLElement>("budgetRing");
  private readonly budgetPercent = byId<HTMLElement>("budgetPercent");
  private readonly costValue = byId<HTMLElement>("costValue");
  private readonly beamCount = byId<HTMLElement>("beamCount");
  private readonly spanValue = byId<HTMLElement>("spanValue");
  private readonly materialSummary = byId<HTMLElement>("materialSummary");
  private readonly personalBestEl = byId<HTMLElement>("personalBest");
  private readonly missionTag = byId<HTMLElement>("missionTag");
  private readonly missionBrief = byId<HTMLElement>("missionBrief");
  private readonly missionHint = byId<HTMLElement>("missionHint");
  private readonly materialList = byId<HTMLElement>("materialList");
  private readonly materialTip = byId<HTMLElement>("materialTip");
  private readonly undoBtn = byId<HTMLButtonElement>("undoBtn");
  private readonly redoBtn = byId<HTMLButtonElement>("redoBtn");
  private readonly resetBtn = byId<HTMLButtonElement>("resetBtn");
  private readonly testBtn = byId<HTMLButtonElement>("testBtn");
  private readonly testBtnLabel = byId<HTMLElement>("testBtnLabel");
  private readonly modeBadge = byId<HTMLElement>("modeBadge");
  private readonly stressLegend = byId<HTMLElement>("stressLegend");
  private readonly testMeter = byId<HTMLElement>("testMeter");
  private readonly testProgressBar = byId<HTMLElement>("testProgressBar");
  private readonly testProgressLabel = byId<HTMLElement>("testProgressLabel");
  private readonly testTimeLabel = byId<HTMLElement>("testTimeLabel");
  private readonly integrityValue = byId<HTMLElement>("integrityValue");
  private readonly integrityBar = byId<HTMLElement>("integrityBar");
  private readonly stressValue = byId<HTMLElement>("stressValue");
  private readonly canvasHint = byId<HTMLElement>("canvasHint");
  private readonly canvasHintText = byId<HTMLElement>("canvasHintText");
  private readonly saveBtn = byId<HTMLButtonElement>("saveBtn");
  private readonly loadBtn = byId<HTMLButtonElement>("loadBtn");
  private readonly saveState = byId<HTMLElement>("saveState");
  private readonly nicknameInput = byId<HTMLInputElement>("nicknameInput");
  private readonly nicknameStatus = byId<HTMLElement>("nicknameStatus");
  private readonly serverStatus = byId<HTMLElement>("serverStatus");
  private readonly leaderboard = byId<HTMLElement>("leaderboard");
  private readonly toastStack = byId<HTMLElement>("toastStack");
  private readonly dialog = byId<HTMLDialogElement>("gameDialog");
  private readonly dialogEyebrow = byId<HTMLElement>("dialogEyebrow");
  private readonly dialogTitle = byId<HTMLElement>("dialogTitle");
  private readonly dialogBody = byId<HTMLElement>("dialogBody");
  private readonly dialogActions = byId<HTMLElement>("dialogActions");
  private readonly dialogForm = byId<HTMLFormElement>("dialogForm");
  private readonly refreshBoardBtn = byId<HTMLButtonElement>("refreshBoardBtn");

  private activeLevelIndex = 0;
  private materialButtons = new Map<MaterialId, HTMLButtonElement>();
  private dialogResolver: ((value: string) => void) | null = null;
  private lastSignature = "";
  private dirty = false;

  constructor(handlers: UiHandlers) {
    this.handlers = handlers;
    this.buildLevelTabs();
    this.buildMaterialCards();
    this.bindEvents();
    this.nicknameInput.value = localStorage.getItem("span.nickname") ?? "";
    this.setServerOnline(null);
  }

  private buildLevelTabs(): void {
    this.levelSwitch.replaceChildren();
    for (const level of LEVELS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "level-tab";
      button.dataset.level = String(level.index - 1);
      button.setAttribute("aria-label", `第 ${level.index} 关：${level.name}`);

      const num = document.createElement("span");
      num.className = "num";
      num.textContent = String(level.index).padStart(2, "0");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = level.name;
      button.append(num, name);
      button.addEventListener("click", () => {
        this.handlers.onSelectLevel(level.index - 1);
      });
      this.levelSwitch.append(button);
    }
  }

  private buildMaterialCards(): void {
    this.materialList.replaceChildren();
    for (const id of MATERIAL_ORDER) {
      const material = MATERIALS[id];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "material-card";
      button.dataset.material = id;
      button.innerHTML = `
        <span class="material-swatch ${id}"><i></i></span>
        <span class="material-copy">
          <span class="material-name">${material.label}</span>
          <span class="material-desc">${material.description}</span>
        </span>
        <span class="material-price"><b>$${(material.costPerPixel * 100).toFixed(0)}</b>/100px</span>
      `;
      button.style.setProperty("--swatch", material.color);
      button.style.setProperty("--swatch-dark", material.colorDark);
      button.addEventListener("click", () => this.handlers.onSelectMaterial(id));
      this.materialList.append(button);
      this.materialButtons.set(id, button);
    }
  }

  private bindEvents(): void {
    this.undoBtn.addEventListener("click", () => this.handlers.onUndo());
    this.redoBtn.addEventListener("click", () => this.handlers.onRedo());
    this.resetBtn.addEventListener("click", () => this.handlers.onReset());
    this.testBtn.addEventListener("click", () => this.handlers.onTest());
    this.saveBtn.addEventListener("click", () => this.handlers.onSave());
    this.loadBtn.addEventListener("click", () => this.handlers.onLoad());
    this.refreshBoardBtn.addEventListener("click", () => this.handlers.onRefreshBoard());

    let nicknameTimer = 0;
    this.nicknameInput.addEventListener("input", () => {
      window.clearTimeout(nicknameTimer);
      nicknameTimer = window.setTimeout(() => {
        this.handlers.onNicknameChange(this.nicknameInput.value.trim());
      }, 420);
    });
  }

  get nickname(): string {
    return this.nicknameInput.value.trim();
  }

  setNickname(nickname: string): void {
    this.nicknameInput.value = nickname;
  }

  setNicknameSaved(saved: boolean): void {
    this.nicknameStatus.classList.toggle("saved", saved);
  }

  setServerOnline(online: boolean | null): void {
    this.serverStatus.classList.remove("online", "offline");
    const label = this.serverStatus.querySelector("span");
    if (online === null) {
      if (label) label.textContent = "连接中";
      return;
    }
    this.serverStatus.classList.add(online ? "online" : "offline");
    if (label) label.textContent = online ? "服务器在线" : "服务器离线";
  }

  setActiveLevel(index: number): void {
    this.activeLevelIndex = index;
    this.levelSwitch.querySelectorAll<HTMLElement>(".level-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.level === String(index));
    });
  }

  setCompletedLevels(completed: Set<number>): void {
    this.levelSwitch.querySelectorAll<HTMLElement>(".level-tab").forEach((tab) => {
      const index = Number(tab.dataset.level);
      tab.classList.toggle("done", completed.has(index));
    });
  }

  updateHud(hud: GameHudState): void {
    const level = hud.level;
    this.levelCode.textContent = level.code;
    this.levelDifficulty.textContent = level.difficulty;
    this.levelName.textContent = level.name;
    this.levelSubtitle.textContent = level.subtitle;
    this.missionTag.textContent = String(level.index).padStart(2, "0");
    this.missionBrief.textContent = level.brief;
    this.missionHint.textContent = level.hint;

    const remaining = hud.budget - hud.cost;
    const remainingPercent = Math.max(0, Math.min(100, (remaining / hud.budget) * 100));
    this.budgetValue.textContent = formatMoney(Math.max(0, remaining));
    this.budgetValue.style.color = remaining < 80 ? "var(--red)" : "";
    const ratio = Math.min(100, (hud.cost / hud.budget) * 100);
    this.budgetBar.style.width = `${ratio}%`;
    this.budgetBar.classList.toggle("over", hud.cost > hud.budget);
    this.budgetRing.style.setProperty("--budget-angle", `${remainingPercent * 3.6}deg`);
    this.budgetRing.classList.toggle("low", remainingPercent < 15);
    this.budgetPercent.textContent = `${Math.round(remainingPercent)}%`;
    this.costValue.textContent = formatMoney(hud.cost);
    this.beamCount.textContent = `${hud.beamCount} 根构件`;
    this.spanValue.textContent = `${hud.span} px`;
    document.body.dataset.mode = hud.mode;

    const counts = MATERIAL_ORDER.filter((id) => hud.materialCounts[id] > 0).map(
      (id) => `${MATERIALS[id].label.slice(0, 1)} ${hud.materialCounts[id]}`,
    );
    this.materialSummary.textContent = counts.length ? counts.join(" · ") : "—";

    this.undoBtn.disabled = !hud.canUndo;
    this.redoBtn.disabled = !hud.canRedo;

    this.testBtn.classList.toggle("stop", hud.mode === "test");
    if (hud.mode === "edit") this.testBtnLabel.textContent = "测试桥梁";
    else if (hud.mode === "test") this.testBtnLabel.textContent = "停止测试";
    else this.testBtnLabel.textContent = "返回建造";

    const badgeText = this.modeBadge.querySelector("span");
    this.modeBadge.classList.remove("testing", "failed", "success");
    if (hud.mode === "edit") {
      if (badgeText) badgeText.textContent = "建造模式";
    } else if (hud.mode === "test") {
      this.modeBadge.classList.add("testing");
      if (badgeText) badgeText.textContent = "结构测试中";
    } else if (hud.mode === "success") {
      this.modeBadge.classList.add("success");
      if (badgeText) badgeText.textContent = "测试通过";
    } else {
      this.modeBadge.classList.add("failed");
      if (badgeText) badgeText.textContent = "测试失败";
    }

    const testing = hud.mode !== "edit";
    this.stressLegend.hidden = !testing;
    this.testMeter.hidden = !testing;
    if (testing) {
      this.testProgressBar.style.width = `${Math.max(0, Math.min(100, hud.testProgress))}%`;
      this.testProgressLabel.textContent = `${Math.round(hud.testProgress)}%`;
      this.testTimeLabel.textContent = `${hud.testTimeLeft.toFixed(1)}s`;
      this.integrityValue.textContent = `${Math.round(hud.integrity)}%`;
      this.integrityBar.style.width = `${Math.max(0, Math.min(100, hud.integrity))}%`;
      this.integrityBar.classList.toggle("warn", hud.integrity < 55);
      this.integrityBar.classList.toggle("danger", hud.integrity < 28);
      this.stressValue.textContent = `${Math.round(hud.peakStress * 100)}%`;
      this.stressValue.classList.toggle("danger", hud.peakStress > 0.9);
      this.testMeter.classList.toggle("alert", hud.peakStress > 0.85 || hud.brokenBeams > 0);
    }

    this.canvasHintText.textContent = hud.hint;
    this.canvasHint.classList.toggle("hidden", hud.mode === "test" && hud.testElapsed > 1.2);

    for (const [id, button] of this.materialButtons) {
      button.classList.toggle("active", id === hud.selectedMaterial && hud.mode === "edit");
    }
    const selected = MATERIALS[hud.selectedMaterial];
    this.materialTip.textContent = `${selected.label}：${selected.description} 单根最长 ${selected.maxLength}px。`;

    const signature = `${hud.beamCount}:${hud.nodeCount}:${hud.cost}`;
    if (signature !== this.lastSignature) {
      if (this.lastSignature && hud.mode === "edit" && !this.dirty) this.dirty = true;
      this.lastSignature = signature;
    }
    if (this.dirty && hud.mode === "edit") this.setSaveState("有未保存更改", false);
  }

  markSaved(): void {
    this.dirty = false;
    const now = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    this.setSaveState(`已保存 ${now}`, true);
    this.setNicknameSaved(true);
  }

  markClean(): void {
    this.dirty = false;
    this.setSaveState("未保存", false);
  }

  setSaveState(text: string, saved: boolean): void {
    this.saveState.textContent = text;
    this.saveState.style.color = saved ? "var(--green)" : "";
  }

  setPersonalBest(entry: LeaderboardEntry | null): void {
    this.personalBestEl.textContent = entry ? `${formatMoney(entry.cost)} · ${formatTime(entry.time)}` : "—";
  }

  renderLeaderboard(entries: LeaderboardEntry[], nickname: string): void {
    this.leaderboard.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "leaderboard-empty";
      empty.textContent = "还没有人完成这一关，抢下第一名。";
      this.leaderboard.append(empty);
      return;
    }
    entries.forEach((entry, index) => {
      const row = document.createElement("div");
      row.className = "leaderboard-row";
      if (nickname && entry.nickname.toLowerCase() === nickname.toLowerCase()) {
        row.classList.add("me");
      }
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = String(index + 1).padStart(2, "0");
      const name = document.createElement("span");
      name.className = "board-name";
      name.textContent = entry.nickname;
      const cost = document.createElement("span");
      cost.className = "board-cost";
      cost.textContent = formatMoney(entry.cost);
      const time = document.createElement("span");
      time.className = "board-time";
      time.textContent = formatTime(entry.time);
      row.append(rank, name, cost, time);
      this.leaderboard.append(row);
    });
  }

  toast(message: string, kind: ToastKind = "info"): void {
    const element = document.createElement("div");
    element.className = `toast ${kind}`;
    element.textContent = message;
    this.toastStack.append(element);
    while (this.toastStack.children.length > 3) {
      this.toastStack.firstElementChild?.remove();
    }
    window.setTimeout(() => {
      element.classList.add("leaving");
      window.setTimeout(() => element.remove(), 260);
    }, 3000);
  }

  async confirm(title: string, message: string, confirmLabel = "确认", danger = false): Promise<boolean> {
    const value = await this.openDialog({
      eyebrow: "请确认",
      title,
      body: `<p>${escapeHtml(message)}</p>`,
      actions: [
        { label: "取消", value: "cancel" },
        { label: confirmLabel, value: "confirm", primary: !danger, danger },
      ],
    });
    return value === "confirm";
  }

  async promptNickname(current: string): Promise<string | null> {
    const value = await this.openDialog({
      eyebrow: "工程师档案",
      title: "留下你的昵称",
      body: `<p>昵称用于保存设计和排行榜，同一个昵称会覆盖该关卡旧存档。</p>
        <input class="nickname-input" id="dialogNickname" maxlength="16" autocomplete="nickname" placeholder="例如：桥梁工程师" />`,
      actions: [
        { label: "取消", value: "cancel" },
        { label: "确认", value: "confirm", primary: true },
      ],
    });
    if (value !== "confirm") return null;
    const input = this.dialogBody.querySelector<HTMLInputElement>("#dialogNickname");
    const nickname = (input?.value ?? current).trim();
    if (!nickname) {
      this.toast("昵称不能为空", "error");
      return null;
    }
    if (Array.from(nickname).length > 16) {
      this.toast("昵称最多 16 个字符", "error");
      return null;
    }
    this.setNickname(nickname);
    return nickname;
  }

  async showSuccess(result: GameResult, hasNext: boolean, note: string): Promise<string> {
    const actions: DialogAction[] = [
      { label: "继续优化", value: "optimize" },
      { label: "重试", value: "retry" },
    ];
    if (hasNext) actions.push({ label: "下一关", value: "next", primary: true });
    else actions[0]!.primary = true;

    return this.openDialog({
      eyebrow: "SPAN / PASSED",
      title: "卡车安全抵达",
      body: `
        <p>${note}</p>
        <div class="dialog-stats">
          <div class="dialog-stat"><span>建造成本</span><b>${formatMoney(result.cost)}</b></div>
          <div class="dialog-stat"><span>通过时间</span><b>${formatTime(result.time)}</b></div>
          <div class="dialog-stat"><span>构件数量</span><b>${result.beams}</b></div>
        </div>`,
      actions,
    });
  }

  async showFailure(reason: string): Promise<string> {
    return this.openDialog({
      eyebrow: "SPAN / FAILED",
      title: "桥梁没能撑住",
      body: `<p>${escapeHtml(reason)}</p>
        <p class="dialog-subnote">提示：橙色受拉、蓝色受压，越亮越接近断裂。增加三角支撑、缩短跨度，或把关键受拉构件换成钢材。</p>`,
      actions: [
        { label: "返回建造", value: "optimize", primary: true },
        { label: "直接重试", value: "retry" },
      ],
    });
  }

  private openDialog(options: DialogOptions): Promise<string> {
    if (this.dialogResolver) {
      this.dialogResolver("cancel");
      this.dialogResolver = null;
    }
    if (this.dialog.open) this.dialog.close();

    this.dialogEyebrow.textContent = options.eyebrow;
    this.dialogTitle.textContent = options.title;
    this.dialogBody.innerHTML = options.body;
    this.dialogActions.replaceChildren();

    return new Promise<string>((resolve) => {
      let settled = false;
      const finish = (value: string): void => {
        if (settled) return;
        settled = true;
        this.dialogResolver = null;
        if (this.dialog.open) this.dialog.close();
        resolve(value);
      };
      this.dialogResolver = finish;

      for (const action of options.actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = action.label;
        if (action.primary) button.classList.add("primary");
        if (action.danger) button.classList.add("danger");
        button.addEventListener("click", () => finish(action.value));
        this.dialogActions.append(button);
      }

      this.dialog.oncancel = (event) => {
        event.preventDefault();
        finish("cancel");
      };
      this.dialogForm.onsubmit = (event) => {
        event.preventDefault();
        const primary = options.actions.find((action) => action.primary);
        finish((primary ?? options.actions[options.actions.length - 1])?.value ?? "cancel");
      };
      this.dialog.showModal();
      window.setTimeout(() => {
        const nicknameField = this.dialogBody.querySelector<HTMLInputElement>("#dialogNickname");
        if (nicknameField) {
          nicknameField.value = this.nickname;
          nicknameField.focus();
          nicknameField.select();
        }
      }, 30);
    });
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
