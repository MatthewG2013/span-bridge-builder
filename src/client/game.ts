import { MATERIALS, beamCost } from "../shared/materials.js";
import { canPlaceAt, LEVELS } from "../shared/levels.js";
import type { Build, BuildBeam, BuildNode, Level, MaterialId, Vec2 } from "../shared/types.js";
import {
  BridgeSimulation,
  createInitialBuild,
  findDuplicateBeam,
  findRoadPath,
  pathLength,
  pointOnPath,
  type RoadPath,
  type SimBeam,
} from "./physics.js";
import {
  Renderer,
  type CarRenderState,
  type DragPreview,
  type Particle,
  type RenderMode,
  type RenderState,
} from "./renderer.js";

export interface GameHudState {
  level: Level;
  mode: RenderMode;
  cost: number;
  budget: number;
  beamCount: number;
  nodeCount: number;
  materialCounts: Record<MaterialId, number>;
  span: number;
  canUndo: boolean;
  canRedo: boolean;
  hint: string;
  roadConnected: boolean;
  selectedMaterial: MaterialId;
  testProgress: number;
  testTimeLeft: number;
  testElapsed: number;
}

export interface GameResult {
  levelId: string;
  levelName: string;
  cost: number;
  time: number;
  beams: number;
}

export interface GameCallbacks {
  onHud: (state: GameHudState) => void;
  onToast: (message: string, kind?: "info" | "error" | "success") => void;
  onSuccess: (result: GameResult) => void;
  onFailure: (reason: string, result: GameResult) => void;
}

interface DragState {
  fromId: string;
  from: Vec2;
  to: Vec2;
  material: MaterialId;
  valid: boolean;
  targetNodeId: string | null;
  targetPoint: Vec2;
  label: string;
  pointerId: number;
}

interface TestState {
  elapsed: number;
  runTime: number;
  travelled: number;
  carDistance: number;
  path: RoadPath | null;
  pathLength: number;
  missingFor: number;
  finished: boolean;
  failure: string | null;
  lastCar: CarRenderState;
}

const STEP = 1 / 120;
const TRUCK_SPEED = 118;
const CAR_LOAD = 4400;
const START_DELAY = 0.55;

export class Game {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: Renderer;
  private readonly callbacks: GameCallbacks;

  private level: Level;
  private build: Build;
  private mode: RenderMode = "edit";
  private sim: BridgeSimulation | null = null;
  private test: TestState | null = null;

  private selectedMaterial: MaterialId = "road";
  private tool: "build" | "erase" = "build";
  private drag: DragState | null = null;
  private hoveredBeamId: string | null = null;
  private particles: Particle[] = [];

  private undoStack: Build[] = [];
  private redoStack: Build[] = [];
  private roadConnected = false;
  private accumulator = 0;
  private lastFrame = performance.now();
  private lastHud = 0;

  constructor(canvas: HTMLCanvasElement, callbacks: GameCallbacks, levelIndex = 0) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.renderer = new Renderer(canvas);
    this.level = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, levelIndex))]!;
    this.build = this.makeStarterBuild();

    this.bindEvents();
    this.roadConnected = this.checkRoadConnected();
    this.renderer.resize();
    requestAnimationFrame(this.frame);
    this.emitHud();
  }

  get currentLevel(): Level {
    return this.level;
  }

  get currentBuild(): Build {
    return cloneBuild(this.build);
  }

  get currentMode(): RenderMode {
    return this.mode;
  }

  get selected(): MaterialId {
    return this.selectedMaterial;
  }

  setLevel(index: number): void {
    const next = LEVELS[index];
    if (!next || next.id === this.level.id) return;
    this.stopTest(true);
    this.level = next;
    this.build = this.makeStarterBuild();
    this.undoStack = [];
    this.redoStack = [];
    this.particles = [];
    this.hoveredBeamId = null;
    this.roadConnected = this.checkRoadConnected();
    this.emitHud();
    this.callbacks.onToast(`已载入「${next.name}」`, "info");
  }

  setMaterial(material: MaterialId): void {
    this.selectedMaterial = material;
    this.tool = "build";
    this.canvas.style.cursor = "crosshair";
    this.emitHud();
  }

  setTool(tool: "build" | "erase"): void {
    this.tool = tool;
    this.canvas.style.cursor = tool === "erase" ? "not-allowed" : "crosshair";
    this.emitHud();
  }

  undo(): void {
    if (this.mode !== "edit") return;
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(cloneBuild(this.build));
    this.build = previous;
    this.afterBuildChange();
    this.callbacks.onToast("已撤销上一步", "info");
  }

  redo(): void {
    if (this.mode !== "edit") return;
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(cloneBuild(this.build));
    this.build = next;
    this.afterBuildChange();
    this.callbacks.onToast("已重做", "info");
  }

  clearBuild(): boolean {
    if (this.mode !== "edit") return false;
    if (this.build.beams.length === 0) return false;
    this.pushHistory();
    this.build = this.makeStarterBuild();
    this.afterBuildChange();
    this.callbacks.onToast("建造已清空，锚点保留", "info");
    return true;
  }

  startTest(): void {
    if (this.mode === "test" || this.mode === "success" || this.mode === "failure") return;
    if (this.build.beams.length === 0) {
      this.callbacks.onToast("先搭一座桥再测试", "error");
      return;
    }

    const path = this.checkRoadPath();
    if (!path) {
      this.callbacks.onToast("路面还没有连通两岸。选择「路面」从锚点铺到对岸。", "error");
      return;
    }

    this.sim = new BridgeSimulation(this.build);
    this.mode = "test";
    this.test = {
      elapsed: 0,
      runTime: 0,
      travelled: 0,
      carDistance: -68,
      path,
      pathLength: path.length,
      missingFor: 0,
      finished: false,
      failure: null,
      lastCar: {
        x: this.level.anchors[0]!.x - 68,
        y: this.level.anchors[0]!.y - 10,
        angle: 0,
        visible: true,
      },
    };
    this.particles = [];
    this.accumulator = 0;
    this.hoveredBeamId = null;
    this.emitHud();
    this.callbacks.onToast("测试开始 — 注意观察构件颜色", "info");
  }

  stopTest(silent = false): void {
    if (this.mode === "edit") return;
    this.mode = "edit";
    this.sim = null;
    this.test = null;
    this.particles = [];
    this.emitHud();
    if (!silent) this.callbacks.onToast("已返回建造模式", "info");
  }

  retryTest(): void {
    this.stopTest(true);
    this.startTest();
  }

  /** Loads a previously saved build, replacing the current design. */
  loadBuild(raw: Build): boolean {
    if (this.mode !== "edit") this.stopTest(true);
    const sanitized = this.sanitizeBuild(raw);
    if (sanitized.beams.length === 0) {
      this.callbacks.onToast("存档里没有可用的构件", "error");
      return false;
    }
    this.pushHistory();
    this.build = sanitized;
    this.afterBuildChange();
    this.emitHud();
    return true;
  }

  getResult(): GameResult {
    return {
      levelId: this.level.id,
      levelName: this.level.name,
      cost: this.cost(),
      time: this.test?.runTime ?? 0,
      beams: this.build.beams.length,
    };
  }

  resize(): void {
    this.renderer.resize();
  }

  private makeStarterBuild(): Build {
    return createInitialBuild(
      this.level.anchors.map((anchor) => ({
        id: anchor.id,
        x: anchor.x,
        y: anchor.y,
        pinned: true,
      })),
    );
  }

  private bindEvents(): void {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerCancel);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("resize", () => this.renderer.resize());
  }

  private frame = (now: number): void => {
    const dt = Math.min(0.05, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.updateParticles(dt);

    if (this.mode === "test") {
      this.updateTest(dt);
    } else if (this.mode === "success" || this.mode === "failure") {
      // Let the structure settle briefly behind the result modal.
      if (this.sim && this.test && !this.test.finished) this.stepSimulation(dt);
    }

    this.render();
    if (now - this.lastHud > 100) {
      this.lastHud = now;
      this.emitHud();
    }
    requestAnimationFrame(this.frame);
  };

  private updateTest(dt: number): void {
    const test = this.test;
    const sim = this.sim;
    if (!test || !sim || test.finished) return;

    this.accumulator = Math.min(this.accumulator + dt, 0.12);
    while (this.accumulator >= STEP) {
      this.accumulator -= STEP;
      this.substepTest(STEP);
      if (!this.test || this.test.finished) break;
    }
  }

  private substepTest(dt: number): void {
    const test = this.test;
    const sim = this.sim;
    if (!test || !sim || test.finished) return;

    test.elapsed += dt;
    if (test.elapsed > this.level.timeLimit) {
      this.failTest("超时：卡车没能在时限内抵达对岸。");
      return;
    }

    const path = sim.activeRoadPath(this.level.startAnchorId, this.level.endAnchorId);
    test.path = path;
    if (path) {
      test.pathLength = pathLength(path, (id) => sim.nodePosition(id));
      test.missingFor = 0;
    } else {
      test.missingFor += dt;
    }

    if (test.elapsed > START_DELAY) {
      test.runTime += dt;
      test.travelled += TRUCK_SPEED * dt;
      test.carDistance = -68 + test.travelled;
    }

    const startAnchor = this.level.anchors.find((anchor) => anchor.id === this.level.startAnchorId)!;
    const endAnchor = this.level.anchors.find((anchor) => anchor.id === this.level.endAnchorId)!;
    const car: CarRenderState = {
      x: startAnchor.x - 68,
      y: startAnchor.y - 10,
      angle: 0,
      visible: true,
    };

    let deckPoint: { x: number; y: number; angle: number; segment: number; t: number } | null = null;

    if (test.carDistance >= 0) {
      if (!path) {
        if (test.missingFor > 0.32 && test.carDistance > 2) {
          this.failTest("路面断开：关键构件失效，卡车失去支撑。");
          return;
        }
      } else {
        const point = pointOnPath(path, test.carDistance, (id) => sim.nodePosition(id));
        if (point) {
          deckPoint = point;
          car.x = point.x;
          car.y = point.y - 10;
          car.angle = clamp(point.angle, -0.65, 0.65);
          if (point.y > 590) {
            this.failTest("桥面塌陷：路面已经沉入峡谷。");
            return;
          }
        } else if (test.carDistance > test.pathLength + 8) {
          car.x = endAnchor.x + (test.carDistance - test.pathLength);
          car.y = endAnchor.y - 10;
        }
      }
    }

    if (path && deckPoint) {
      const front = pointOnPath(path, test.carDistance, (id) => sim.nodePosition(id));
      const rear = pointOnPath(path, Math.max(0, test.carDistance - 20), (id) => sim.nodePosition(id));
      if (front) {
        const a = path.nodeIds[front.segment];
        const b = path.nodeIds[front.segment + 1];
        if (a && b) sim.applyDeckLoad(a, b, front.t, CAR_LOAD * 0.64);
      }
      if (rear) {
        const a = path.nodeIds[rear.segment];
        const b = path.nodeIds[rear.segment + 1];
        if (a && b) sim.applyDeckLoad(a, b, rear.t, CAR_LOAD * 0.36);
      }
    }

    test.lastCar = car;

    const stepResult = sim.step(dt);
    for (const beam of stepResult.broken) {
      this.spawnBreakParticles(beam);
      this.callbacks.onToast(`${MATERIALS[beam.material].label}构件断裂！`, "error");
    }

    if (stepResult.outOfBounds) {
      this.failTest("结构坠入峡谷，测试失败。");
      return;
    }

    if (path && test.carDistance > test.pathLength + 78 && test.elapsed > START_DELAY) {
      this.succeedTest();
    }
  }

  private stepSimulation(dt: number): void {
    if (!this.sim) return;
    const result = this.sim.step(dt);
    for (const beam of result.broken) this.spawnBreakParticles(beam);
  }

  private succeedTest(): void {
    const test = this.test;
    if (!test || test.finished) return;
    test.finished = true;
    this.mode = "success";
    this.test!.lastCar = {
      x: this.level.anchors.find((a) => a.id === this.level.endAnchorId)!.x + 14,
      y: this.level.anchors.find((a) => a.id === this.level.endAnchorId)!.y - 10,
      angle: 0,
      visible: true,
    };
    this.emitHud();
    this.callbacks.onSuccess(this.getResult());
  }

  private failTest(reason: string): void {
    const test = this.test;
    if (!test || test.finished) return;
    test.finished = true;
    test.failure = reason;
    this.mode = "failure";
    this.emitHud();
    this.callbacks.onFailure(reason, this.getResult());
  }

  private render(): void {
    let car: CarRenderState | null = null;
    if (this.test) {
      car = this.test.lastCar;
    }
    const dragPreview: DragPreview | null = this.drag
      ? {
          from: this.drag.from,
          to: this.drag.targetPoint,
          material: this.drag.material,
          valid: this.drag.valid,
          label: this.drag.label,
        }
      : null;

    const state: RenderState = {
      level: this.level,
      build: this.build,
      mode: this.mode,
      material: this.selectedMaterial,
      tool: this.tool,
      sim: this.sim,
      drag: dragPreview,
      hoveredBeamId: this.hoveredBeamId,
      particles: this.particles,
      car,
      time: performance.now() / 1000,
      showStress: this.mode !== "edit",
    };
    this.renderer.render(state);
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.mode !== "edit") return;
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    const point = this.renderer.screenToWorld(event.clientX, event.clientY);

    if (event.button === 2 || this.tool === "erase") {
      this.eraseAt(point);
      return;
    }
    if (event.button !== 0) return;

    const node = this.findNodeNear(point, 18);
    if (!node) return;
    this.drag = {
      fromId: node.id,
      from: { x: node.x, y: node.y },
      to: point,
      material: this.selectedMaterial,
      valid: false,
      targetNodeId: null,
      targetPoint: point,
      label: "",
      pointerId: event.pointerId,
    };
    this.updateDrag(point);
    document.getElementById("canvasHint")?.classList.add("hidden");
  };

  private onPointerMove = (event: PointerEvent): void => {
    const point = this.renderer.screenToWorld(event.clientX, event.clientY);
    if (this.mode === "edit" && !this.drag) {
      const beam = this.findBeamNear(point, 9);
      this.hoveredBeamId = beam?.id ?? null;
      this.canvas.style.cursor =
        this.tool === "erase" && beam
          ? "pointer"
          : this.findNodeNear(point, 18)
            ? "grab"
            : this.tool === "erase"
              ? "not-allowed"
              : "crosshair";
    }
    if (this.drag) this.updateDrag(point);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    const drag = this.drag;
    this.drag = null;
    if (!drag.valid) {
      if (drag.label) this.callbacks.onToast(drag.label, "error");
      return;
    }

    const length = Math.hypot(drag.targetPoint.x - drag.from.x, drag.targetPoint.y - drag.from.y);
    const cost = beamCost(drag.material, length);
    if (this.cost() + cost > this.level.budget) {
      this.callbacks.onToast("预算不足，缩短构件或换用更便宜的材料。", "error");
      return;
    }

    this.pushHistory();
    let targetId = drag.targetNodeId;
    if (!targetId) {
      const newNode: BuildNode = {
        id: newId("n"),
        x: drag.targetPoint.x,
        y: drag.targetPoint.y,
      };
      this.build.nodes.push(newNode);
      targetId = newNode.id;
    }
    this.build.beams.push({
      id: newId("b"),
      a: drag.fromId,
      b: targetId,
      material: drag.material,
    });
    this.afterBuildChange();
  };

  private onPointerCancel = (): void => {
    this.drag = null;
  };

  private onPointerLeave = (): void => {
    if (!this.drag) this.hoveredBeamId = null;
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (document.querySelector("dialog[open]")) return;
    const target = event.target as HTMLElement | null;
    if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      this.redo();
      return;
    }
    if (event.key === "Escape") {
      if (this.drag) this.drag = null;
      else if (this.mode !== "edit") this.stopTest();
      return;
    }
    if (this.mode !== "edit") {
      if (event.key.toLowerCase() === "t") this.startTest();
      return;
    }
    if (event.key === "1") this.setMaterial("road");
    if (event.key === "2") this.setMaterial("wood");
    if (event.key === "3") this.setMaterial("steel");
    if (event.key.toLowerCase() === "t") this.startTest();
    if ((event.key === "Delete" || event.key === "Backspace") && this.hoveredBeamId) {
      event.preventDefault();
      this.eraseBeam(this.hoveredBeamId);
    }
  };

  private updateDrag(point: Vec2): void {
    if (!this.drag) return;
    const drag = this.drag;
    const fromNode = this.build.nodes.find((node) => node.id === drag.fromId);
    if (!fromNode) {
      this.drag = null;
      return;
    }
    drag.from = { x: fromNode.x, y: fromNode.y };

    const candidateNode = this.findNodeNear(point, 22, drag.fromId);
    let targetPoint: Vec2;
    let targetNodeId: string | null = null;

    if (candidateNode) {
      targetPoint = { x: candidateNode.x, y: candidateNode.y };
      targetNodeId = candidateNode.id;
    } else {
      targetPoint = {
        x: Math.round(point.x / 16) * 16,
        y: Math.round(point.y / 16) * 16,
      };
    }

    const length = Math.hypot(targetPoint.x - drag.from.x, targetPoint.y - drag.from.y);
    const material = MATERIALS[drag.material];
    let valid = true;
    let reason = "";

    if (length < 24) {
      valid = false;
      reason = "构件太短";
    } else if (length > material.maxLength) {
      valid = false;
      reason = `超过最大长度 ${material.maxLength}px`;
    } else if (targetNodeId && findDuplicateBeam(this.build, drag.fromId, targetNodeId)) {
      valid = false;
      reason = "这两个节点已经相连";
    } else if (!targetNodeId && !canPlaceAt(this.level, targetPoint.x, targetPoint.y)) {
      valid = false;
      reason = "不能建在岩体里";
    } else if (this.cost() + beamCost(drag.material, length) > this.level.budget) {
      valid = false;
      reason = "预算不足";
    } else if (this.build.beams.length >= 220) {
      valid = false;
      reason = "构件数量达到上限";
    }

    const cost = beamCost(drag.material, length);
    drag.to = targetPoint;
    drag.targetPoint = targetPoint;
    drag.targetNodeId = targetNodeId;
    drag.valid = valid;
    drag.label = valid ? `$${cost}` : reason;
  }

  private eraseAt(point: Vec2): void {
    const beam = this.findBeamNear(point, 10);
    if (beam) {
      this.eraseBeam(beam.id);
      return;
    }
    const node = this.findNodeNear(point, 15);
    if (node && !node.pinned) {
      const connected = this.build.beams.filter((item) => item.a === node.id || item.b === node.id);
      if (connected.length > 0) {
        this.pushHistory();
        const ids = new Set(connected.map((item) => item.id));
        this.build.beams = this.build.beams.filter((item) => !ids.has(item.id));
        this.removeOrphanNodes();
        this.afterBuildChange();
        this.callbacks.onToast(`已拆除 ${connected.length} 根构件`, "info");
      }
    }
  }

  private eraseBeam(beamId: string): void {
    const beam = this.build.beams.find((item) => item.id === beamId);
    if (!beam) return;
    this.pushHistory();
    this.build.beams = this.build.beams.filter((item) => item.id !== beamId);
    this.removeOrphanNodes();
    this.afterBuildChange();
    this.callbacks.onToast("构件已拆除，预算已返还", "info");
  }

  private removeOrphanNodes(): void {
    const used = new Set<string>();
    for (const beam of this.build.beams) {
      used.add(beam.a);
      used.add(beam.b);
    }
    this.build.nodes = this.build.nodes.filter((node) => node.pinned || used.has(node.id));
  }

  private findNodeNear(point: Vec2, radius: number, excludeId?: string): BuildNode | null {
    let best: BuildNode | null = null;
    let bestDistance = radius;
    for (const node of this.build.nodes) {
      if (node.id === excludeId) continue;
      const distance = Math.hypot(node.x - point.x, node.y - point.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = node;
      }
    }
    return best;
  }

  private findBeamNear(point: Vec2, radius: number): BuildBeam | null {
    const positions = new Map(this.build.nodes.map((node) => [node.id, node]));
    let best: BuildBeam | null = null;
    let bestDistance = radius;
    for (const beam of this.build.beams) {
      const a = positions.get(beam.a);
      const b = positions.get(beam.b);
      if (!a || !b) continue;
      const distance = pointSegmentDistance(point, a, b);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = beam;
      }
    }
    return best;
  }

  private pushHistory(): void {
    this.undoStack.push(cloneBuild(this.build));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
  }

  private afterBuildChange(): void {
    this.roadConnected = this.checkRoadConnected();
    this.hoveredBeamId = null;
    this.emitHud();
  }

  private checkRoadPath(): RoadPath | null {
    const beams: SimBeam[] = this.build.beams.map((beam) => {
      const a = this.build.nodes.find((node) => node.id === beam.a);
      const b = this.build.nodes.find((node) => node.id === beam.b);
      return {
        ...beam,
        rest: a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 1,
        stiffness: 1,
        breakStrain: 1,
        broken: false,
        stress: 0,
        overload: 0,
        firstStrain: 0,
        finalStrain: 0,
      };
    });
    const positions = new Map(this.build.nodes.map((node) => [node.id, node]));
    return findRoadPath(beams, this.level.startAnchorId, this.level.endAnchorId, (id) => positions.get(id));
  }

  private checkRoadConnected(): boolean {
    return this.checkRoadPath() !== null;
  }

  private cost(): number {
    const positions = new Map(this.build.nodes.map((node) => [node.id, node]));
    let total = 0;
    for (const beam of this.build.beams) {
      const a = positions.get(beam.a);
      const b = positions.get(beam.b);
      if (!a || !b) continue;
      total += beamCost(beam.material, Math.hypot(b.x - a.x, b.y - a.y));
    }
    return total;
  }

  private emitHud(): void {
    const cost = this.cost();
    const materialCounts: Record<MaterialId, number> = { road: 0, wood: 0, steel: 0 };
    for (const beam of this.build.beams) materialCounts[beam.material] += 1;
    const test = this.test;
    const progress = test
      ? Math.max(0, Math.min(100, (test.carDistance / Math.max(1, test.pathLength)) * 100))
      : 0;

    this.callbacks.onHud({
      level: this.level,
      mode: this.mode,
      cost,
      budget: this.level.budget,
      beamCount: this.build.beams.length,
      nodeCount: this.build.nodes.length,
      materialCounts,
      span: this.level.gap.right - this.level.gap.left,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      hint: this.hintFor(cost),
      roadConnected: this.roadConnected,
      selectedMaterial: this.selectedMaterial,
      testProgress: progress,
      testTimeLeft: Math.max(0, this.level.timeLimit - (test?.elapsed ?? 0)),
      testElapsed: test?.elapsed ?? 0,
    });
  }

  private hintFor(cost: number): string {
    if (this.mode === "test") return "测试中：红色构件正在过载，连续过载会断裂。";
    if (this.mode === "success") return "卡车已安全抵达对岸。";
    if (this.mode === "failure") return "测试失败。调整结构后重试。";
    if (this.build.beams.length === 0) return "从锚点或已有节点按住拖动，拉出第一根构件。";
    if (!this.roadConnected) return "还没有连通的桥面：选择「路面」，从一岸连续铺到另一岸。";
    if (this.level.budget - cost < 60) return "预算所剩无几。可以拆除多余构件，或直接测试。";
    return "桥面已连通。点击「测试桥梁」，观察橙色与红色受力构件。";
  }

  private sanitizeBuild(raw: Build): Build {
    const result = this.makeStarterBuild();
    const anchorIds = new Set(result.nodes.map((node) => node.id));
    const known = new Map<string, BuildNode>();
    for (const node of result.nodes) known.set(node.id, node);

    if (Array.isArray(raw?.nodes)) {
      for (const node of raw.nodes.slice(0, 160)) {
        if (!node || typeof node.id !== "string" || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
        if (anchorIds.has(node.id)) continue;
        if (node.x < 0 || node.x > 1280 || node.y < 20 || node.y > 690) continue;
        const clean: BuildNode = { id: node.id.slice(0, 40), x: node.x, y: node.y };
        known.set(clean.id, clean);
        result.nodes.push(clean);
      }
    }

    if (Array.isArray(raw?.beams)) {
      const seen = new Set<string>();
      for (const beam of raw.beams.slice(0, 240)) {
        if (!beam || typeof beam.id !== "string" || typeof beam.a !== "string" || typeof beam.b !== "string") continue;
        if (!known.has(beam.a) || !known.has(beam.b) || beam.a === beam.b) continue;
        if (!["road", "wood", "steel"].includes(beam.material)) continue;
        const key = [beam.a, beam.b].sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        result.beams.push({
          id: beam.id.slice(0, 40),
          a: beam.a,
          b: beam.b,
          material: beam.material,
        });
      }
    }

    this.removeOrphansStatic(result);
    return result;
  }

  private removeOrphansStatic(build: Build): void {
    const used = new Set<string>();
    for (const beam of build.beams) {
      used.add(beam.a);
      used.add(beam.b);
    }
    build.nodes = build.nodes.filter((node) => node.pinned || used.has(node.id));
  }

  private spawnBreakParticles(beam: SimBeam): void {
    const sim = this.sim;
    if (!sim) return;
    const a = sim.nodePosition(beam.a);
    const b = sim.nodePosition(beam.b);
    if (!a || !b) return;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const color = MATERIALS[beam.material].glow;
    for (let i = 0; i < 16; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 24 + Math.random() * 105;
      this.particles.push({
        x: mx + (Math.random() - 0.5) * 16,
        y: my + (Math.random() - 0.5) * 8,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 35,
        life: 0.7 + Math.random() * 0.9,
        maxLife: 1.6,
        color,
        size: 1.4 + Math.random() * 2.6,
        gravity: 280,
      });
    }
  }

  private updateParticles(dt: number): void {
    for (const particle of this.particles) {
      particle.life -= dt;
      particle.vy += particle.gravity * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
    }
    this.particles = this.particles.filter((particle) => particle.life > 0);
  }
}

function cloneBuild(build: Build): Build {
  return {
    nodes: build.nodes.map((node) => ({ ...node })),
    beams: build.beams.map((beam) => ({ ...beam })),
  };
}

function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function pointSegmentDistance(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
