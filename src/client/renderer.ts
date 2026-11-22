import { MATERIALS } from "../shared/materials.js";
import type { Build, Level, MaterialId, Vec2 } from "../shared/types.js";
import type { BridgeSimulation } from "./physics.js";

export type RenderMode = "edit" | "test" | "success" | "failure";

export interface DragPreview {
  from: Vec2;
  to: Vec2;
  material: MaterialId;
  valid: boolean;
  label: string;
}

export interface CarRenderState {
  x: number;
  y: number;
  angle: number;
  visible: boolean;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  gravity: number;
}

export interface RenderState {
  level: Level;
  build: Build;
  mode: RenderMode;
  material: MaterialId;
  tool: "build" | "erase";
  sim: BridgeSimulation | null;
  drag: DragPreview | null;
  hoveredBeamId: string | null;
  particles: Particle[];
  car: CarRenderState | null;
  time: number;
  showStress: boolean;
}

interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

const WORLD_WIDTH = 1280;
const WORLD_HEIGHT = 720;

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private view: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0, width: 1280, height: 720 };
  private dpr = 1;
  private stars: { x: number; y: number; r: number; a: number }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is not available.");
    this.canvas = canvas;
    this.ctx = ctx;
    for (let i = 0; i < 110; i += 1) {
      const seed = hash(i * 31 + 7);
      this.stars.push({
        x: (seed % 10000) / 10000 * WORLD_WIDTH,
        y: (hash(i * 71 + 13) % 10000) / 10000 * 300,
        r: 0.4 + (hash(i * 17 + 3) % 100) / 100 * 1.1,
        a: 0.16 + (hash(i * 43 + 1) % 100) / 100 * 0.5,
      });
    }
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.dpr = dpr;
    const scale = Math.min(rect.width / WORLD_WIDTH, rect.height / WORLD_HEIGHT);
    this.view = {
      scale,
      offsetX: (rect.width - WORLD_WIDTH * scale) / 2,
      offsetY: (rect.height - WORLD_HEIGHT * scale) / 2,
      width: rect.width,
      height: rect.height,
    };
  }

  screenToWorld(clientX: number, clientY: number): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.view.offsetX) / this.view.scale,
      y: (clientY - rect.top - this.view.offsetY) / this.view.scale,
    };
  }

  render(state: RenderState): void {
    const ctx = this.ctx;
    const { width, height } = this.view;
    if (width <= 0 || height <= 0) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#07101c";
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(this.view.offsetX, this.view.offsetY);
    ctx.scale(this.view.scale, this.view.scale);
    ctx.beginPath();
    ctx.rect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    ctx.clip();

    this.drawSky(state);
    this.drawWater(state);
    this.drawDistantCanyon(state);
    this.drawTerrain(state);
    this.drawGrid(state);
    this.drawSpanDimension(state);
    this.drawBridge(state);
    this.drawParticles(state);
    this.drawCar(state);
    this.drawAnchors(state);
    this.drawDrag(state);
    this.drawVignette();

    if (state.mode === "test" || state.mode === "failure" || state.mode === "success") {
      this.drawScanLine(state.time);
    }

    ctx.restore();
  }

  private drawSky(state: RenderState): void {
    const ctx = this.ctx;
    const sky = ctx.createLinearGradient(0, 0, 0, 560);
    sky.addColorStop(0, "#07101f");
    sky.addColorStop(0.34, "#12283d");
    sky.addColorStop(0.63, "#36536a");
    sky.addColorStop(0.82, "#8c6b62");
    sky.addColorStop(1, "#d89a68");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, WORLD_WIDTH, 620);

    for (const star of this.stars) {
      const twinkle = 0.72 + Math.sin(state.time * 0.7 + star.x * 0.01) * 0.28;
      ctx.globalAlpha = star.a * twinkle;
      ctx.fillStyle = "#dcefff";
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const sunX = 1010;
    const sunY = 254;
    const glow = ctx.createRadialGradient(sunX, sunY, 4, sunX, sunY, 230);
    glow.addColorStop(0, "rgba(255, 224, 171, 0.72)");
    glow.addColorStop(0.18, "rgba(250, 181, 112, 0.32)");
    glow.addColorStop(0.55, "rgba(212, 124, 83, 0.1)");
    glow.addColorStop(1, "rgba(212, 124, 83, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(sunX - 260, sunY - 260, 520, 520);

    ctx.fillStyle = "rgba(255, 226, 178, 0.88)";
    ctx.beginPath();
    ctx.arc(sunX, sunY, 44, 0, Math.PI * 2);
    ctx.fill();

    this.drawCloud(190, 148, 1.05, 0.12);
    this.drawCloud(480, 96, 0.8, 0.08);
    this.drawCloud(790, 190, 1.3, 0.09);
    this.drawCloud(1110, 120, 0.66, 0.07);

    this.drawRidge(442, 42, 0.016, "#243a4e", 1.3);
    this.drawRidge(486, 52, 0.012, "#1a2c3e", 2.2);
    this.drawRidge(528, 38, 0.021, "#132434", 3.4);
  }

  private drawCloud(x: number, y: number, scale: number, alpha: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#dbe9f2";
    ctx.beginPath();
    ctx.ellipse(0, 0, 62, 9, 0, 0, Math.PI * 2);
    ctx.ellipse(-28, -6, 28, 12, 0, 0, Math.PI * 2);
    ctx.ellipse(18, -8, 34, 14, 0, 0, Math.PI * 2);
    ctx.ellipse(46, -2, 22, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawRidge(baseY: number, amplitude: number, frequency: number, color: string, phase: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, baseY + amplitude);
    for (let x = 0; x <= WORLD_WIDTH; x += 12) {
      const y =
        baseY +
        Math.sin(x * frequency + phase) * amplitude +
        Math.sin(x * frequency * 2.7 + phase * 1.8) * amplitude * 0.38;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(WORLD_WIDTH, 650);
    ctx.lineTo(0, 650);
    ctx.closePath();
    ctx.fill();
  }

  private drawWater(state: RenderState): void {
    const ctx = this.ctx;
    const water = ctx.createLinearGradient(0, 622, 0, 720);
    water.addColorStop(0, "rgba(68, 108, 119, 0.72)");
    water.addColorStop(0.28, "#1d3b4b");
    water.addColorStop(1, "#07131f");
    ctx.fillStyle = water;
    ctx.fillRect(0, 620, WORLD_WIDTH, 100);

    const shimmer = ctx.createLinearGradient(0, 0, 0, 720);
    shimmer.addColorStop(0.82, "rgba(237, 161, 97, 0)");
    shimmer.addColorStop(0.89, "rgba(237, 161, 97, 0.15)");
    shimmer.addColorStop(1, "rgba(237, 161, 97, 0)");
    ctx.fillStyle = shimmer;
    ctx.fillRect(0, 590, WORLD_WIDTH, 130);

    ctx.lineCap = "round";
    for (let i = 0; i < 26; i += 1) {
      const y = 636 + i * 3.4;
      const offset = Math.sin(state.time * 0.55 + i * 0.9) * 22;
      const alpha = 0.08 + (i / 26) * 0.09;
      ctx.strokeStyle = `rgba(173, 222, 226, ${alpha})`;
      ctx.lineWidth = i % 4 === 0 ? 1.2 : 0.7;
      ctx.beginPath();
      for (let x = -40; x < WORLD_WIDTH + 40; x += 42) {
        const wave = Math.sin(x * 0.019 + state.time * 0.8 + i) * 5;
        if (x === -40) ctx.moveTo(x, y + wave + offset * 0.1);
        else ctx.lineTo(x, y + wave + offset * 0.1);
      }
      ctx.stroke();
    }

    const mist = ctx.createLinearGradient(0, 600, 0, 690);
    mist.addColorStop(0, "rgba(198, 222, 227, 0)");
    mist.addColorStop(0.5, "rgba(198, 222, 227, 0.06)");
    mist.addColorStop(1, "rgba(198, 222, 227, 0)");
    ctx.fillStyle = mist;
    ctx.fillRect(0, 600, WORLD_WIDTH, 90);
  }

  private drawDistantCanyon(state: RenderState): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.65;
    ctx.fillStyle = "#0e1d2b";
    ctx.beginPath();
    ctx.moveTo(0, 520);
    ctx.lineTo(0, 360);
    ctx.lineTo(levelSafeX(state.level, state.level.gap.left - 190), 420);
    ctx.lineTo(state.level.gap.left - 80, 520);
    ctx.lineTo(state.level.gap.right + 80, 520);
    ctx.lineTo(levelSafeX(state.level, state.level.gap.right + 190), 420);
    ctx.lineTo(WORLD_WIDTH, 360);
    ctx.lineTo(WORLD_WIDTH, 520);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "rgba(231, 154, 102, 0.08)";
    ctx.beginPath();
    ctx.moveTo(state.level.gap.left - 90, 540);
    ctx.lineTo(state.level.gap.left + 20, 470);
    ctx.lineTo(state.level.gap.right - 20, 470);
    ctx.lineTo(state.level.gap.right + 90, 540);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawTerrain(state: RenderState): void {
    const ctx = this.ctx;
    for (const [index, block] of state.level.terrain.entries()) {
      const shade = index % 2 === 0 ? 0 : 1;
      const rock = ctx.createLinearGradient(block.x1, block.top, block.x2, 720);
      rock.addColorStop(0, shade ? "#384754" : "#3e4a55");
      rock.addColorStop(0.3, shade ? "#27333e" : "#2c3741");
      rock.addColorStop(1, "#111b25");
      ctx.fillStyle = rock;

      const bottom = 745;
      const lip = 10 + (index % 3) * 4;
      ctx.beginPath();
      ctx.moveTo(block.x1, bottom);
      ctx.lineTo(block.x1, block.top + lip);
      ctx.lineTo(block.x1 + 8, block.top + 2);
      ctx.lineTo(block.x2 - 8, block.top + 2);
      ctx.lineTo(block.x2, block.top + lip);
      ctx.lineTo(block.x2, bottom);
      ctx.closePath();
      ctx.fill();

      ctx.save();
      ctx.clip();
      for (let i = 0; i < 6; i += 1) {
        const y = block.top + 22 + i * 28;
        ctx.strokeStyle = `rgba(10, 17, 24, ${0.18 + (i % 2) * 0.08})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(block.x1 - 4, y);
        for (let x = block.x1; x <= block.x2 + 4; x += 28) {
          ctx.lineTo(x, y + Math.sin(x * 0.04 + i) * 4);
        }
        ctx.stroke();
      }
      for (let i = 0; i < 7; i += 1) {
        const x = block.x1 + 18 + hash(index * 17 + i * 31) % Math.max(20, block.x2 - block.x1 - 36);
        ctx.strokeStyle = "rgba(8, 14, 21, 0.22)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, block.top + 12);
        ctx.lineTo(x + 7, block.top + 40 + (i % 3) * 15);
        ctx.stroke();
      }
      ctx.restore();

      ctx.strokeStyle = "rgba(223, 164, 101, 0.38)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(block.x1 + 3, block.top + 2);
      ctx.lineTo(block.x2 - 3, block.top + 2);
      ctx.stroke();

      ctx.strokeStyle = "rgba(255, 216, 161, 0.18)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(block.x1 + 8, block.top + 5);
      ctx.lineTo(block.x2 - 8, block.top + 5);
      ctx.stroke();
    }
  }

  private drawGrid(state: RenderState): void {
    if (state.mode !== "edit") return;
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = "rgba(114, 216, 230, 0.075)";
    for (let x = 0; x <= WORLD_WIDTH; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x, 80);
      ctx.lineTo(x, 640);
      ctx.stroke();
    }
    for (let y = 80; y <= 640; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(WORLD_WIDTH, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(114, 216, 230, 0.12)";
    for (let x = 0; x <= WORLD_WIDTH; x += 160) {
      ctx.beginPath();
      ctx.moveTo(x, 80);
      ctx.lineTo(x, 640);
      ctx.stroke();
    }
    for (let y = 80; y <= 640; y += 160) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(WORLD_WIDTH, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawSpanDimension(state: RenderState): void {
    if (state.mode !== "edit" || state.build.beams.length > 0) return;
    const start = state.level.anchors.find((anchor) => anchor.id === state.level.startAnchorId);
    const end = state.level.anchors.find((anchor) => anchor.id === state.level.endAnchorId);
    if (!start || !end) return;
    const ctx = this.ctx;
    const y = state.level.deckY - 88;
    const midX = (start.x + end.x) / 2;
    const label = `跨度 ${end.x - start.x} px · 从锚点拖出路面`;

    ctx.save();
    ctx.strokeStyle = "rgba(241, 180, 93, 0.34)";
    ctx.fillStyle = "rgba(241, 180, 93, 0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(start.x, y);
    ctx.lineTo(end.x, y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const x of [start.x, end.x]) {
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x, y + 6);
      ctx.stroke();
    }
    ctx.font = "500 9px 'Cascadia Code', Consolas, monospace";
    const width = ctx.measureText(label).width + 18;
    ctx.fillStyle = "rgba(8, 18, 30, 0.82)";
    ctx.strokeStyle = "rgba(241, 180, 93, 0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(midX - width / 2, y - 10, width, 20, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(247, 215, 166, 0.86)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, midX, y + 0.5);
    ctx.restore();
  }

  private drawBridge(state: RenderState): void {
    const ctx = this.ctx;
    const positions = new Map<string, Vec2>();
    for (const node of state.build.nodes) positions.set(node.id, { x: node.x, y: node.y });
    if (state.sim) {
      for (const node of state.sim.nodes.values()) {
        positions.set(node.id, { x: node.x, y: node.y });
      }
    }

    const simBeams = new Map(state.sim?.beams.map((beam) => [beam.id, beam]) ?? []);
    const broken = new Set(state.sim?.brokenBeams.map((beam) => beam.id) ?? []);

    for (const beam of state.build.beams) {
      const a = positions.get(beam.a);
      const b = positions.get(beam.b);
      if (!a || !b) continue;
      const sim = simBeams.get(beam.id);
      if (broken.has(beam.id)) {
        this.drawBrokenStub(a, b, beam.material);
        continue;
      }
      const material = MATERIALS[beam.material];
      const stress = state.showStress && sim ? Math.min(1.3, sim.stress) : 0;

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Drop shadow gives members a little separation from the background.
      ctx.strokeStyle = "rgba(0, 0, 0, 0.38)";
      ctx.lineWidth = beam.material === "road" ? 16 : beam.material === "steel" ? 11 : 9;
      ctx.beginPath();
      ctx.moveTo(a.x + 2, a.y + 3);
      ctx.lineTo(b.x + 2, b.y + 3);
      ctx.stroke();

      ctx.strokeStyle = material.colorDark;
      ctx.lineWidth = beam.material === "road" ? 15 : beam.material === "steel" ? 10 : 8;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      ctx.strokeStyle = material.color;
      ctx.lineWidth = beam.material === "road" ? 11 : beam.material === "steel" ? 6.5 : 5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      if (beam.material === "steel") {
        ctx.strokeStyle = "rgba(227, 249, 255, 0.38)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(a.x - 1.5, a.y - 2);
        ctx.lineTo(b.x - 1.5, b.y - 2);
        ctx.stroke();
      }

      if (beam.material === "road") {
        this.drawRoadDetail(a, b);
      }

      if (stress > 0.28) {
        const ratio = Math.min(1, (stress - 0.28) / 0.72);
        const color = stressColor(ratio);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.32 + ratio * 0.62;
        ctx.lineWidth = beam.material === "road" ? 5 : 3.2;
        ctx.shadowColor = color;
        ctx.shadowBlur = 8 + ratio * 16;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;

        if (stress > 0.86) {
          const pulse = 0.55 + Math.sin(state.time * 14) * 0.3;
          ctx.strokeStyle = `rgba(255, 92, 79, ${pulse * 0.5})`;
          ctx.lineWidth = 10;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      if (state.hoveredBeamId === beam.id && state.mode === "edit") {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
        ctx.lineWidth = beam.material === "road" ? 2 : 1.4;
        ctx.setLineDash([4, 5]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    for (const node of state.build.nodes) {
      const p = positions.get(node.id);
      if (!p) continue;
      if (node.pinned) continue;
      ctx.fillStyle = "#101c28";
      ctx.strokeStyle = "#c79a5d";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "rgba(255, 220, 164, 0.55)";
      ctx.beginPath();
      ctx.arc(p.x - 0.7, p.y - 0.8, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawRoadDetail(a: Vec2, b: Vec2): void {
    const ctx = this.ctx;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 2) return;
    const nx = -dy / length;
    const ny = dx / length;
    ctx.save();
    ctx.strokeStyle = "rgba(54, 35, 20, 0.55)";
    ctx.lineWidth = 1;
    for (let d = 7; d < length - 3; d += 13) {
      const t = d / length;
      const x = a.x + dx * t;
      const y = a.y + dy * t;
      ctx.beginPath();
      ctx.moveTo(x + nx * 4, y + ny * 4);
      ctx.lineTo(x - nx * 4, y - ny * 4);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawBrokenStub(a: Vec2, b: Vec2, material: MaterialId): void {
    const ctx = this.ctx;
    const spec = MATERIALS[material];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1) return;
    const ux = (b.x - a.x) / length;
    const uy = (b.y - a.y) / length;
    const stub = Math.min(12, length * 0.22);
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = spec.colorDark;
    ctx.lineWidth = material === "road" ? 11 : 6;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(a.x + ux * stub, a.y + uy * stub);
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - ux * stub, b.y - uy * stub);
    ctx.stroke();
    ctx.restore();
  }

  private drawAnchors(state: RenderState): void {
    const ctx = this.ctx;
    for (const anchor of state.level.anchors) {
      const pinned = state.build.nodes.find((node) => node.id === anchor.id);
      const p = pinned ?? anchor;
      const isDeck = anchor.deck;
      const color = isDeck ? "#f1b45d" : "#72d8e6";

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = "rgba(8, 17, 27, 0.95)";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(8, -3);
      ctx.lineTo(8, 6);
      ctx.lineTo(0, 10);
      ctx.lineTo(-8, 6);
      ctx.lineTo(-8, -3);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (state.mode === "edit") {
        ctx.fillStyle = isDeck ? "rgba(255, 214, 158, 0.78)" : "rgba(154, 238, 248, 0.72)";
        ctx.font = "600 8px 'Cascadia Code', Consolas, monospace";
        ctx.textAlign = "center";
        const labelY = anchor.y > 450 ? 24 : -14;
        ctx.fillText(anchor.label, 0, labelY);
      }
      ctx.restore();
    }
  }

  private drawCar(state: RenderState): void {
    if (!state.car || !state.car.visible) return;
    const ctx = this.ctx;
    const { x, y, angle } = state.car;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.globalAlpha = 0.26;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(0, 13, 30, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Wheels
    ctx.fillStyle = "#0b1118";
    ctx.strokeStyle = "#45535f";
    ctx.lineWidth = 1;
    for (const wheelX of [-17, 16]) {
      ctx.beginPath();
      ctx.arc(wheelX, 10, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#778892";
      ctx.beginPath();
      ctx.arc(wheelX, 10, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#0b1118";
    }

    // Cargo bed and cab
    ctx.fillStyle = "#c97b43";
    ctx.strokeStyle = "#6d3b1f";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(-28, -12, 34, 20, 3);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 218, 172, 0.26)";
    ctx.lineWidth = 0.8;
    for (let i = -23; i < 3; i += 6) {
      ctx.beginPath();
      ctx.moveTo(i, -10);
      ctx.lineTo(i, 6);
      ctx.stroke();
    }

    ctx.fillStyle = "#e9b25e";
    ctx.strokeStyle = "#765021";
    ctx.beginPath();
    ctx.roundRect(6, -15, 22, 23, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#1b3440";
    ctx.beginPath();
    ctx.roundRect(17, -11, 9, 8, 1.5);
    ctx.fill();
    ctx.fillStyle = "rgba(155, 233, 242, 0.45)";
    ctx.beginPath();
    ctx.roundRect(18, -10, 7, 5, 1);
    ctx.fill();

    ctx.fillStyle = "#2a180c";
    ctx.beginPath();
    ctx.roundRect(25, 1, 5, 3, 1);
    ctx.fill();

    ctx.fillStyle = "rgba(255, 240, 181, 0.95)";
    ctx.shadowColor = "#ffe0a0";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(29, 3, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  private drawParticles(state: RenderState): void {
    const ctx = this.ctx;
    for (const particle of state.particles) {
      const alpha = Math.max(0, particle.life / particle.maxLife);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = particle.color;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.size * (0.4 + alpha * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawDrag(state: RenderState): void {
    if (!state.drag) return;
    const { from, to, material, valid } = state.drag;
    const spec = MATERIALS[material];
    const ctx = this.ctx;
    const color = valid ? spec.color : "#ff6f68";

    ctx.save();
    ctx.lineCap = "round";
    ctx.setLineDash([7, 6]);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2.4;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    ctx.fillStyle = "rgba(8, 18, 30, 0.92)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(to.x, to.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2 - 18;
    const label = state.drag.label;
    ctx.font = "500 9px 'Cascadia Code', Consolas, monospace";
    const width = ctx.measureText(label).width + 14;
    ctx.fillStyle = valid ? "rgba(8, 18, 30, 0.9)" : "rgba(55, 15, 15, 0.9)";
    ctx.strokeStyle = valid ? "rgba(241, 180, 93, 0.35)" : "rgba(255, 111, 104, 0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(midX - width / 2, midY - 9, width, 17, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = valid ? "#f6d7a9" : "#ffb2ad";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, midX, midY + 0.5);
    ctx.restore();
  }

  private drawScanLine(time: number): void {
    const ctx = this.ctx;
    const y = (time * 55) % 720;
    const gradient = ctx.createLinearGradient(0, y - 24, 0, y + 24);
    gradient.addColorStop(0, "rgba(114, 216, 230, 0)");
    gradient.addColorStop(0.5, "rgba(114, 216, 230, 0.035)");
    gradient.addColorStop(1, "rgba(114, 216, 230, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, y - 24, WORLD_WIDTH, 48);
  }

  private drawVignette(): void {
    const ctx = this.ctx;
    const vignette = ctx.createRadialGradient(
      WORLD_WIDTH / 2,
      WORLD_HEIGHT / 2,
      220,
      WORLD_WIDTH / 2,
      WORLD_HEIGHT / 2,
      760,
    );
    vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
    vignette.addColorStop(1, "rgba(1, 5, 11, 0.52)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
  }
}

function stressColor(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const r = Math.round(124 + (255 - 124) * clamped);
  const g = Math.round(217 - 140 * clamped);
  const b = Math.round(168 - 120 * clamped);
  return `rgb(${r}, ${g}, ${b})`;
}

function levelSafeX(level: Level, x: number): number {
  return Math.max(0, Math.min(WORLD_WIDTH, x)) + 0;
}

function hash(n: number): number {
  let x = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}
