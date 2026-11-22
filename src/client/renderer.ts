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
  bounce: number;
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
  kind?: "spark" | "dust" | "confetti";
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
  shake: number;
}

interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

interface Mote {
  x: number;
  y: number;
  r: number;
  speed: number;
  phase: number;
  alpha: number;
}

const WORLD_WIDTH = 1280;
const WORLD_HEIGHT = 720;

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private view: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0, width: 1280, height: 720 };
  private dpr = 1;
  private readonly stars: { x: number; y: number; r: number; a: number }[] = [];
  private readonly motes: Mote[] = [];
  private skyLayer: HTMLCanvasElement | null = null;
  private terrainLayer: HTMLCanvasElement | null = null;
  private cachedLevelId = "";

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is not available.");
    this.canvas = canvas;
    this.ctx = ctx;
    for (let i = 0; i < 150; i += 1) {
      const seed = hash(i * 31 + 7);
      this.stars.push({
        x: ((seed % 10000) / 10000) * WORLD_WIDTH,
        y: ((hash(i * 71 + 13) % 10000) / 10000) * 330,
        r: 0.35 + ((hash(i * 17 + 3) % 100) / 100) * 1.2,
        a: 0.12 + ((hash(i * 43 + 1) % 100) / 100) * 0.55,
      });
    }
    for (let i = 0; i < 34; i += 1) {
      this.motes.push({
        x: (hash(i * 97 + 21) % 10000) / 10000 * WORLD_WIDTH,
        y: 300 + (hash(i * 13 + 5) % 10000) / 10000 * 330,
        r: 0.6 + (hash(i * 29 + 9) % 100) / 100 * 1.7,
        speed: 3 + (hash(i * 51 + 3) % 100) / 100 * 9,
        phase: (hash(i * 11 + 7) % 1000) / 1000 * Math.PI * 2,
        alpha: 0.05 + (hash(i * 83 + 2) % 100) / 100 * 0.1,
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
    this.ensureStaticLayers(state);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#050c16";
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    const shakeX = Math.sin(state.time * 93) * state.shake * 5;
    const shakeY = Math.cos(state.time * 71) * state.shake * 4;
    ctx.translate(this.view.offsetX + shakeX, this.view.offsetY + shakeY);
    ctx.scale(this.view.scale, this.view.scale);
    ctx.beginPath();
    ctx.rect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    ctx.clip();

    if (this.skyLayer) ctx.drawImage(this.skyLayer, 0, 0);
    this.drawWater(state);
    this.drawGrid(state);
    if (this.terrainLayer) ctx.drawImage(this.terrainLayer, 0, 0);
    this.drawAtmosphere(state);
    this.drawSpanDimension(state);
    this.drawBridge(state);
    this.drawLoadArrows(state);
    this.drawParticles(state);
    this.drawCar(state);
    this.drawAnchors(state);
    this.drawDrag(state);
    this.drawVignette(state);
    this.drawScanLine(state.time);

    if (state.mode === "failure" && state.shake > 0.05) {
      ctx.fillStyle = `rgba(255, 60, 50, ${state.shake * 0.09})`;
      ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    }
    if (state.mode === "success") {
      const glow = ctx.createRadialGradient(1030, 330, 10, 1030, 330, 420);
      glow.addColorStop(0, "rgba(255, 205, 120, 0.05)");
      glow.addColorStop(1, "rgba(255, 205, 120, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    }

    ctx.restore();
  }

  private ensureStaticLayers(state: RenderState): void {
    if (this.skyLayer && this.terrainLayer && this.cachedLevelId === state.level.id) return;

    this.cachedLevelId = state.level.id;
    const sky = document.createElement("canvas");
    sky.width = WORLD_WIDTH;
    sky.height = WORLD_HEIGHT;
    const skyCtx = sky.getContext("2d");
    if (skyCtx) {
      this.paintSky(skyCtx, state.level);
      this.paintDistantCanyon(skyCtx, state.level);
      this.skyLayer = sky;
    }

    const terrain = document.createElement("canvas");
    terrain.width = WORLD_WIDTH;
    terrain.height = WORLD_HEIGHT;
    const terrainCtx = terrain.getContext("2d");
    if (terrainCtx) {
      this.paintTerrain(terrainCtx, state.level);
      this.terrainLayer = terrain;
    }
  }

  // ---------------------------------------------------------------------------
  // Static environment
  // ---------------------------------------------------------------------------

  private paintSky(ctx: CanvasRenderingContext2D, level: Level): void {
    const sky = ctx.createLinearGradient(0, 0, 0, 620);
    sky.addColorStop(0, "#050d1a");
    sky.addColorStop(0.28, "#0d2035");
    sky.addColorStop(0.55, "#29465d");
    sky.addColorStop(0.76, "#7c6460");
    sky.addColorStop(0.92, "#cd8e63");
    sky.addColorStop(1, "#e0a06f");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, WORLD_WIDTH, 620);

    for (const star of this.stars) {
      ctx.globalAlpha = star.a;
      ctx.fillStyle = "#dcefff";
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Sun and atmospheric bloom
    const sunX = 1010;
    const sunY = 252;
    const glow = ctx.createRadialGradient(sunX, sunY, 5, sunX, sunY, 280);
    glow.addColorStop(0, "rgba(255, 231, 187, 0.8)");
    glow.addColorStop(0.13, "rgba(253, 192, 126, 0.44)");
    glow.addColorStop(0.42, "rgba(221, 133, 87, 0.14)");
    glow.addColorStop(1, "rgba(221, 133, 87, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(sunX - 300, sunY - 300, 600, 600);

    ctx.fillStyle = "rgba(255, 232, 191, 0.94)";
    ctx.beginPath();
    ctx.arc(sunX, sunY, 42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 242, 211, 0.35)";
    ctx.beginPath();
    ctx.arc(sunX - 8, sunY - 9, 18, 0, Math.PI * 2);
    ctx.fill();

    this.drawCloud(ctx, 170, 142, 1.0, 0.1);
    this.drawCloud(ctx, 470, 92, 0.8, 0.065);
    this.drawCloud(ctx, 760, 182, 1.3, 0.08);
    this.drawCloud(ctx, 1120, 116, 0.62, 0.06);

    this.drawRidge(ctx, 438, 44, 0.016, "#21384c", 1.3);
    this.drawRidge(ctx, 480, 55, 0.012, "#172b3e", 2.2);
    this.drawRidge(ctx, 522, 40, 0.021, "#102132", 3.4);
    this.drawRidge(ctx, 562, 28, 0.028, "#0b1927", 4.6);

    const haze = ctx.createLinearGradient(0, 380, 0, 590);
    haze.addColorStop(0, "rgba(242, 166, 108, 0)");
    haze.addColorStop(0.55, "rgba(242, 166, 108, 0.09)");
    haze.addColorStop(1, "rgba(242, 166, 108, 0.16)");
    ctx.fillStyle = haze;
    ctx.fillRect(0, 380, WORLD_WIDTH, 210);

    // A few distant silhouette trees on the far bank.
    ctx.fillStyle = "rgba(7, 16, 27, 0.72)";
    for (let i = 0; i < 16; i += 1) {
      const x = 50 + i * 76 + (hash(i * 17) % 20);
      const h = 8 + (hash(i * 41) % 18);
      ctx.beginPath();
      ctx.moveTo(x, level.deckY + 4);
      ctx.lineTo(x + 3, level.deckY - h);
      ctx.lineTo(x + 6, level.deckY + 4);
      ctx.closePath();
      ctx.fill();
    }

    this.drawCrane(ctx, 1148, level.deckY + 2);
    this.drawSurveyFlag(ctx, level.gap.left - 72, level.deckY, "#f1b45d");
    this.drawSurveyFlag(ctx, level.gap.right + 78, level.deckY, "#72d8e6");
  }

  private drawCrane(ctx: CanvasRenderingContext2D, x: number, baseY: number): void {
    const height = 156;
    const topY = baseY - height;
    ctx.save();
    ctx.strokeStyle = "rgba(5, 13, 21, 0.76)";
    ctx.fillStyle = "rgba(5, 13, 21, 0.76)";
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";

    ctx.beginPath();
    ctx.moveTo(x, baseY);
    ctx.lineTo(x, topY);
    ctx.moveTo(x - 6, baseY);
    ctx.lineTo(x - 6, topY);
    for (let i = 0; i < 7; i += 1) {
      const y1 = baseY - i * 22;
      const y2 = baseY - (i + 1) * 22;
      ctx.moveTo(x - 6, y1);
      ctx.lineTo(x, y2);
      ctx.moveTo(x, y1);
      ctx.lineTo(x - 6, y2);
    }
    ctx.stroke();

    // Jib and counter-jib.
    ctx.beginPath();
    ctx.moveTo(x + 26, topY + 8);
    ctx.lineTo(x - 126, topY + 8);
    ctx.lineTo(x - 126, topY + 12);
    ctx.lineTo(x + 26, topY + 12);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 4, topY - 4);
    ctx.lineTo(x - 120, topY + 8);
    ctx.lineTo(x - 120, topY + 2);
    ctx.closePath();
    ctx.fill();
    for (let i = 0; i < 8; i += 1) {
      const px = x - 12 - i * 14;
      ctx.beginPath();
      ctx.moveTo(px, topY + 8);
      ctx.lineTo(px, topY + 14);
      ctx.stroke();
    }

    // Cable and hook.
    ctx.strokeStyle = "rgba(5, 13, 21, 0.55)";
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(x - 92, topY + 14);
    ctx.lineTo(x - 92, topY + 72);
    ctx.stroke();
    ctx.fillStyle = "rgba(5, 13, 21, 0.7)";
    ctx.beginPath();
    ctx.arc(x - 92, topY + 74, 2.6, 0, Math.PI * 2);
    ctx.fill();

    // Warm warning beacon.
    ctx.fillStyle = "rgba(255, 143, 95, 0.8)";
    ctx.shadowColor = "#ff8f5f";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(x + 2, topY - 6, 2.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  private drawSurveyFlag(
    ctx: CanvasRenderingContext2D,
    x: number,
    topY: number,
    color: string,
  ): void {
    ctx.save();
    ctx.strokeStyle = "rgba(199, 215, 225, 0.4)";
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, topY);
    ctx.lineTo(x, topY - 27);
    ctx.stroke();
    ctx.globalAlpha = 0.65;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, topY - 27);
    ctx.lineTo(x + 15, topY - 23);
    ctx.lineTo(x + 0.5, topY - 18);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawCloud(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, alpha: number): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;
    const cloud = ctx.createLinearGradient(0, -16, 0, 12);
    cloud.addColorStop(0, "rgba(220, 233, 242, 0.9)");
    cloud.addColorStop(1, "rgba(167, 187, 201, 0.25)");
    ctx.fillStyle = cloud;
    ctx.beginPath();
    ctx.ellipse(0, 0, 62, 9, 0, 0, Math.PI * 2);
    ctx.ellipse(-28, -6, 28, 12, 0, 0, Math.PI * 2);
    ctx.ellipse(18, -8, 34, 14, 0, 0, Math.PI * 2);
    ctx.ellipse(46, -2, 22, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawRidge(
    ctx: CanvasRenderingContext2D,
    baseY: number,
    amplitude: number,
    frequency: number,
    color: string,
    phase: number,
  ): void {
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

  private paintDistantCanyon(ctx: CanvasRenderingContext2D, level: Level): void {
    ctx.save();
    ctx.globalAlpha = 0.82;
    const far = ctx.createLinearGradient(0, 360, 0, 620);
    far.addColorStop(0, "#172c3d");
    far.addColorStop(1, "#0a1723");
    ctx.fillStyle = far;
    ctx.beginPath();
    ctx.moveTo(0, 560);
    ctx.lineTo(0, 350);
    ctx.lineTo(level.gap.left - 210, 430);
    ctx.lineTo(level.gap.left - 70, 540);
    ctx.lineTo(level.gap.right + 70, 540);
    ctx.lineTo(level.gap.right + 210, 430);
    ctx.lineTo(WORLD_WIDTH, 350);
    ctx.lineTo(WORLD_WIDTH, 560);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "rgba(233, 161, 108, 0.07)";
    ctx.beginPath();
    ctx.moveTo(level.gap.left - 110, 560);
    ctx.lineTo(level.gap.left + 10, 488);
    ctx.lineTo(level.gap.right - 10, 488);
    ctx.lineTo(level.gap.right + 110, 560);
    ctx.closePath();
    ctx.fill();

    // Faint distant bridge silhouette for a sense of place.
    ctx.strokeStyle = "rgba(164, 203, 216, 0.12)";
    ctx.lineWidth = 1.5;
    const bx = level.gap.left - 140;
    const ex = level.gap.right + 140;
    ctx.beginPath();
    ctx.moveTo(bx, 440);
    ctx.quadraticCurveTo((bx + ex) / 2, 380, ex, 440);
    ctx.stroke();
    for (let i = 1; i < 8; i += 1) {
      const t = i / 8;
      const x = bx + (ex - bx) * t;
      const y = 440 - Math.sin(t * Math.PI) * 45;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, 445);
      ctx.stroke();
    }
    ctx.restore();
  }

  private paintTerrain(ctx: CanvasRenderingContext2D, level: Level): void {
    for (const [index, block] of level.terrain.entries()) {
      const shade = index % 2 === 0;
      const rock = ctx.createLinearGradient(block.x1, block.top, block.x2, 740);
      rock.addColorStop(0, shade ? "#4c5358" : "#555a5c");
      rock.addColorStop(0.18, shade ? "#39434b" : "#41494f");
      rock.addColorStop(0.55, shade ? "#242f39" : "#2b353e");
      rock.addColorStop(1, "#0b151f");
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

      // Strata
      for (let i = 0; i < 8; i += 1) {
        const y = block.top + 20 + i * 28;
        ctx.strokeStyle = `rgba(8, 14, 21, ${0.17 + (i % 2) * 0.08})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(block.x1 - 4, y);
        for (let x = block.x1; x <= block.x2 + 4; x += 24) {
          ctx.lineTo(x, y + Math.sin(x * 0.035 + i * 1.7) * 5);
        }
        ctx.stroke();
      }

      // Broad rock buttresses give the cliff faces depth.
      const width = Math.max(1, block.x2 - block.x1);
      const buttresses = Math.max(1, Math.floor(width / 150));
      for (let i = 0; i < buttresses; i += 1) {
        const bx = block.x1 + 24 + i * (width / buttresses) + (hash(index * 91 + i * 17) % 24);
        const bw = 32 + (hash(index * 37 + i * 11) % 44);
        const shade = ctx.createLinearGradient(bx, 0, bx + bw, 0);
        shade.addColorStop(0, "rgba(6, 12, 18, 0.24)");
        shade.addColorStop(0.42, "rgba(78, 88, 93, 0.1)");
        shade.addColorStop(0.68, "rgba(255, 203, 145, 0.045)");
        shade.addColorStop(1, "rgba(4, 9, 14, 0.2)");
        ctx.fillStyle = shade;
        ctx.beginPath();
        ctx.moveTo(bx, block.top + 8);
        ctx.lineTo(bx + bw * 0.72, block.top + 2);
        ctx.lineTo(bx + bw, block.top + 18);
        ctx.lineTo(bx + bw * 0.84, bottom);
        ctx.lineTo(bx + 5, bottom);
        ctx.lineTo(bx - 3, block.top + 24);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(5, 10, 15, 0.18)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Rock facets
      for (let i = 0; i < 8; i += 1) {
        const wx = Math.max(20, block.x2 - block.x1 - 20);
        const x = block.x1 + 12 + (hash(index * 23 + i * 41) % wx);
        const y = block.top + 18 + (hash(index * 11 + i * 19) % 110);
        const w = 16 + (hash(index * 7 + i * 29) % 44);
        const h = 10 + (hash(index * 5 + i * 13) % 30);
        ctx.fillStyle = `rgba(12, 20, 28, ${0.1 + (i % 3) * 0.05})`;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + w * 0.7, y - h * 0.5);
        ctx.lineTo(x + w, y + h * 0.35);
        ctx.lineTo(x + w * 0.3, y + h);
        ctx.closePath();
        ctx.fill();
      }

      // Cracks
      for (let i = 0; i < 7; i += 1) {
        const x = block.x1 + 12 + (hash(index * 17 + i * 31) % Math.max(20, block.x2 - block.x1 - 24));
        ctx.strokeStyle = "rgba(5, 11, 17, 0.3)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, block.top + 12);
        ctx.lineTo(x + 5, block.top + 36 + (i % 3) * 12);
        ctx.lineTo(x + 1, block.top + 62 + (i % 2) * 18);
        ctx.stroke();
      }

      // Warm rim light on the sun-facing side.
      const rim = ctx.createLinearGradient(block.x2 - 30, 0, block.x2, 0);
      rim.addColorStop(0, "rgba(240, 168, 108, 0)");
      rim.addColorStop(1, "rgba(240, 168, 108, 0.13)");
      ctx.fillStyle = rim;
      ctx.fillRect(block.x2 - 30, block.top, 30, bottom - block.top);

      ctx.restore();

      // Top surface
      ctx.strokeStyle = "rgba(230, 172, 108, 0.46)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(block.x1 + 3, block.top + 2);
      ctx.lineTo(block.x2 - 3, block.top + 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255, 221, 170, 0.24)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(block.x1 + 8, block.top + 5);
      ctx.lineTo(block.x2 - 8, block.top + 5);
      ctx.stroke();

      // Grass tufts / survey details on wide surfaces.
      if (block.x2 - block.x1 > 100) {
        for (let i = 0; i < 10; i += 1) {
          const x = block.x1 + 16 + (hash(index * 57 + i * 13) % Math.max(24, block.x2 - block.x1 - 32));
          const h = 4 + (hash(index * 19 + i * 7) % 8);
          ctx.strokeStyle = i % 3 === 0 ? "rgba(201, 158, 99, 0.55)" : "rgba(96, 125, 99, 0.55)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, block.top);
          ctx.lineTo(x + 1.5, block.top - h);
          ctx.moveTo(x + 2, block.top);
          ctx.lineTo(x + 3.5, block.top - h * 0.7);
          ctx.stroke();
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Animated environment
  // ---------------------------------------------------------------------------

  private drawWater(state: RenderState): void {
    const ctx = this.ctx;
    const water = ctx.createLinearGradient(0, 616, 0, 720);
    water.addColorStop(0, "rgba(75, 116, 127, 0.76)");
    water.addColorStop(0.25, "#224354");
    water.addColorStop(0.68, "#0d2534");
    water.addColorStop(1, "#06131e");
    ctx.fillStyle = water;
    ctx.fillRect(0, 616, WORLD_WIDTH, 110);

    // Golden sun reflection.
    const sunX = 1010;
    for (let i = 0; i < 22; i += 1) {
      const y = 628 + i * 4.1;
      const spread = 16 + i * 5.5;
      const wobble = Math.sin(state.time * 1.1 + i * 0.7) * (5 + i * 0.4);
      const alpha = 0.18 * (1 - i / 24);
      ctx.fillStyle = `rgba(255, 190, 120, ${alpha})`;
      ctx.beginPath();
      ctx.ellipse(sunX + wobble, y, spread, 1.1, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.lineCap = "round";
    for (let i = 0; i < 30; i += 1) {
      const y = 632 + i * 3.1;
      const offset = Math.sin(state.time * 0.55 + i * 0.9) * 18;
      const alpha = 0.06 + (i / 30) * 0.1;
      ctx.strokeStyle = `rgba(173, 222, 226, ${alpha})`;
      ctx.lineWidth = i % 4 === 0 ? 1.2 : 0.7;
      ctx.beginPath();
      for (let x = -40; x < WORLD_WIDTH + 40; x += 42) {
        const wave = Math.sin(x * 0.019 + state.time * 0.8 + i) * 5;
        if (x === -40) ctx.moveTo(x, y + wave + offset * 0.05);
        else ctx.lineTo(x, y + wave + offset * 0.05);
      }
      ctx.stroke();
    }

    const mist = ctx.createLinearGradient(0, 600, 0, 690);
    mist.addColorStop(0, "rgba(206, 229, 231, 0)");
    mist.addColorStop(0.5, "rgba(206, 229, 231, 0.065)");
    mist.addColorStop(1, "rgba(206, 229, 231, 0)");
    ctx.fillStyle = mist;
    ctx.fillRect(0, 600, WORLD_WIDTH, 90);
  }

  private drawAtmosphere(state: RenderState): void {
    const ctx = this.ctx;

    // Floating dust motes.
    for (const mote of this.motes) {
      const y = ((mote.y - state.time * mote.speed) % 380 + 380) % 380 + 260;
      const x = mote.x + Math.sin(state.time * 0.4 + mote.phase) * 14;
      ctx.fillStyle = `rgba(255, 206, 146, ${mote.alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, mote.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Three distant birds.
    ctx.strokeStyle = "rgba(8, 17, 26, 0.55)";
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 3; i += 1) {
      const x = 160 + ((state.time * (6 + i * 1.4) + i * 280) % 1100);
      const y = 130 + i * 22 + Math.sin(state.time * 0.5 + i) * 5;
      const flap = Math.sin(state.time * 4 + i * 1.7) * 3;
      ctx.beginPath();
      ctx.moveTo(x - 7, y + flap);
      ctx.quadraticCurveTo(x - 3, y - 3, x, y);
      ctx.quadraticCurveTo(x + 3, y - 3, x + 7, y + flap);
      ctx.stroke();
    }

    const fog = ctx.createLinearGradient(0, 520, 0, 640);
    fog.addColorStop(0, "rgba(224, 190, 156, 0)");
    fog.addColorStop(0.55, "rgba(224, 190, 156, 0.035)");
    fog.addColorStop(1, "rgba(224, 190, 156, 0)");
    ctx.fillStyle = fog;
    ctx.fillRect(0, 520, WORLD_WIDTH, 120);
  }

  private drawGrid(state: RenderState): void {
    if (state.mode !== "edit") return;
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = "rgba(114, 216, 230, 0.07)";
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
    ctx.strokeStyle = "rgba(241, 180, 93, 0.36)";
    ctx.fillStyle = "rgba(241, 180, 93, 0.55)";
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
    ctx.fillStyle = "rgba(8, 18, 30, 0.84)";
    ctx.strokeStyle = "rgba(241, 180, 93, 0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(midX - width / 2, y - 10, width, 20, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(247, 215, 166, 0.9)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, midX, y + 0.5);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Bridge, vehicle, anchors
  // ---------------------------------------------------------------------------

  private positionsFor(state: RenderState): Map<string, Vec2> {
    const positions = new Map<string, Vec2>();
    for (const node of state.build.nodes) positions.set(node.id, { x: node.x, y: node.y });
    if (state.sim) {
      for (const node of state.sim.nodes.values()) positions.set(node.id, { x: node.x, y: node.y });
    }
    return positions;
  }

  private drawBridge(state: RenderState): void {
    const ctx = this.ctx;
    const positions = this.positionsFor(state);
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
      const stress = state.showStress && sim ? Math.min(1.4, sim.stress) : 0;

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Ambient shadow
      ctx.strokeStyle = "rgba(0, 0, 0, 0.42)";
      ctx.lineWidth = beam.material === "road" ? 17 : beam.material === "steel" ? 12 : 10;
      ctx.beginPath();
      ctx.moveTo(a.x + 2.5, a.y + 4);
      ctx.lineTo(b.x + 2.5, b.y + 4);
      ctx.stroke();

      // Dark underlay
      ctx.strokeStyle = material.colorDark;
      ctx.lineWidth = beam.material === "road" ? 15 : beam.material === "steel" ? 10 : 8;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      // Main member
      ctx.strokeStyle = material.color;
      ctx.lineWidth = beam.material === "road" ? 11 : beam.material === "steel" ? 6.5 : 5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      if (beam.material === "steel") {
        this.drawSteelDetail(a, b);
      } else if (beam.material === "wood") {
        this.drawWoodDetail(a, b);
      } else {
        this.drawRoadDetail(a, b);
      }

      if (stress > 0.1) {
        const ratio = Math.min(1.2, (stress - 0.1) / 0.9);
        const color = stressColor(ratio, sim?.axial ?? 0);

        // A thin directional line keeps tension/compression readable even at
        // low stress, where the material's base colour would otherwise dominate.
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.15 + ratio * 0.55;
        ctx.lineWidth = 2.1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.globalAlpha = 1;

        if (stress > 0.32) {
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.2 + ratio * 0.64;
          ctx.lineWidth = beam.material === "road" ? 5.5 : 3.6;
          ctx.shadowColor = color;
          ctx.shadowBlur = 9 + ratio * 18;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 1;
        }

        if (stress > 0.82) {
          const pulse = 0.45 + Math.sin(state.time * 15) * 0.3;
          ctx.strokeStyle = `rgba(255, 246, 217, ${pulse * 0.35})`;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      if (state.hoveredBeamId === beam.id && state.mode === "edit") {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
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
      if (!p || node.pinned) continue;
      ctx.save();
      ctx.fillStyle = "#0b1723";
      ctx.strokeStyle = "#d5a461";
      ctx.lineWidth = 1.4;
      ctx.shadowColor = "#f4bf72";
      ctx.shadowBlur = 5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255, 224, 166, 0.72)";
      ctx.beginPath();
      ctx.arc(p.x - 0.7, p.y - 0.9, 1.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawSteelDetail(a: Vec2, b: Vec2): void {
    const ctx = this.ctx;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 2) return;
    const nx = -dy / length;
    const ny = dx / length;
    ctx.save();
    ctx.strokeStyle = "rgba(229, 252, 255, 0.4)";
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(a.x - nx * 1.5, a.y - ny * 1.5);
    ctx.lineTo(b.x - nx * 1.5, b.y - ny * 1.5);
    ctx.stroke();
    ctx.fillStyle = "rgba(230, 250, 255, 0.55)";
    for (const t of [0.22, 0.5, 0.78]) {
      const x = a.x + dx * t;
      const y = a.y + dy * t;
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawWoodDetail(a: Vec2, b: Vec2): void {
    const ctx = this.ctx;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 2) return;
    const nx = -dy / length;
    const ny = dx / length;
    ctx.save();
    ctx.strokeStyle = "rgba(255, 217, 164, 0.24)";
    ctx.lineWidth = 0.8;
    for (let d = 10; d < length - 6; d += 22) {
      const t = d / length;
      const x = a.x + dx * t;
      const y = a.y + dy * t;
      ctx.beginPath();
      ctx.moveTo(x + nx * 1.4, y + ny * 1.4);
      ctx.lineTo(x + nx * 2.2, y + ny * 2.2);
      ctx.stroke();
    }
    ctx.restore();
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
    ctx.strokeStyle = "rgba(58, 37, 20, 0.58)";
    ctx.lineWidth = 1;
    for (let d = 7; d < length - 3; d += 13) {
      const t = d / length;
      const x = a.x + dx * t;
      const y = a.y + dy * t;
      ctx.beginPath();
      ctx.moveTo(x + nx * 4.2, y + ny * 4.2);
      ctx.lineTo(x - nx * 4.2, y - ny * 4.2);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255, 226, 172, 0.12)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(a.x - nx * 2.8, a.y - ny * 2.8);
    ctx.lineTo(b.x - nx * 2.8, b.y - ny * 2.8);
    ctx.stroke();
    ctx.restore();
  }

  private drawBrokenStub(a: Vec2, b: Vec2, material: MaterialId): void {
    const ctx = this.ctx;
    const spec = MATERIALS[material];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1) return;
    const ux = (b.x - a.x) / length;
    const uy = (b.y - a.y) / length;
    const stub = Math.min(13, length * 0.24);
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(24, 16, 12, 0.75)";
    ctx.lineWidth = material === "road" ? 12 : 7;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(a.x + ux * stub, a.y + uy * stub);
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - ux * stub, b.y - uy * stub);
    ctx.stroke();
    ctx.strokeStyle = spec.colorDark;
    ctx.lineWidth = material === "road" ? 9 : 4.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(a.x + ux * stub * 0.7, a.y + uy * stub * 0.7);
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - ux * stub * 0.7, b.y - uy * stub * 0.7);
    ctx.stroke();
    ctx.restore();
  }

  private drawLoadArrows(state: RenderState): void {
    if (!state.car || !state.car.visible) return;
    if (state.mode !== "test" && state.mode !== "failure") return;
    const ctx = this.ctx;
    const { x, y } = state.car;
    ctx.save();
    ctx.strokeStyle = "rgba(255, 184, 100, 0.62)";
    ctx.fillStyle = "rgba(255, 184, 100, 0.62)";
    ctx.lineWidth = 1.4;
    for (const dx of [-16, 16]) {
      const ax = x + dx;
      const ay = y + 15 + Math.sin(state.time * 5 + dx) * 1.2;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax, ay + 12);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ax - 3, ay + 8);
      ctx.lineTo(ax, ay + 13);
      ctx.lineTo(ax + 3, ay + 8);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private drawCar(state: RenderState): void {
    if (!state.car || !state.car.visible) return;
    const ctx = this.ctx;
    const { x, y, angle, bounce } = state.car;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Ground shadow
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(0, 14, 31, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Wheels stay on the deck; body bounces on the suspension.
    for (const wheelX of [-17, 16]) {
      ctx.fillStyle = "#080f16";
      ctx.strokeStyle = "#50616d";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(wheelX, 10, 6.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#7c8f99";
      ctx.beginPath();
      ctx.arc(wheelX, 10, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    const bodyY = bounce;
    ctx.save();
    ctx.translate(0, bodyY);

    // Suspension arms
    ctx.strokeStyle = "rgba(208, 174, 132, 0.55)";
    ctx.lineWidth = 1;
    for (const wheelX of [-17, 16]) {
      ctx.beginPath();
      ctx.moveTo(wheelX - 2, 5);
      ctx.lineTo(wheelX - 1, 10);
      ctx.moveTo(wheelX + 2, 5);
      ctx.lineTo(wheelX + 1, 10);
      ctx.stroke();
    }

    // Cargo bed
    const cargo = ctx.createLinearGradient(0, -13, 0, 8);
    cargo.addColorStop(0, "#d98b4d");
    cargo.addColorStop(1, "#a85d32");
    ctx.fillStyle = cargo;
    ctx.strokeStyle = "#5f321b";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(-29, -13, 35, 21, 3);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 220, 170, 0.26)";
    ctx.lineWidth = 0.8;
    for (let i = -24; i < 4; i += 6) {
      ctx.beginPath();
      ctx.moveTo(i, -11);
      ctx.lineTo(i, 6);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(70, 36, 18, 0.7)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-29, -3);
    ctx.lineTo(6, -3);
    ctx.stroke();

    // Cab
    const cab = ctx.createLinearGradient(6, -16, 6, 8);
    cab.addColorStop(0, "#f5c776");
    cab.addColorStop(1, "#d79642");
    ctx.fillStyle = cab;
    ctx.strokeStyle = "#6d4a1e";
    ctx.beginPath();
    ctx.roundRect(6, -16, 23, 24, 4);
    ctx.fill();
    ctx.stroke();

    // Window
    ctx.fillStyle = "#17323f";
    ctx.beginPath();
    ctx.roundRect(17, -12, 9, 9, 1.5);
    ctx.fill();
    ctx.fillStyle = "rgba(163, 237, 245, 0.42)";
    ctx.beginPath();
    ctx.roundRect(18, -11, 7, 6, 1);
    ctx.fill();

    // Bumper and headlight
    ctx.fillStyle = "#2a190d";
    ctx.beginPath();
    ctx.roundRect(26, 1, 5, 4, 1);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 246, 194, 0.98)";
    ctx.shadowColor = "#ffe0a0";
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(30, 3, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Headlight cone
    if (state.mode === "test" || state.mode === "failure") {
      const beam = ctx.createLinearGradient(31, 3, 96, 0);
      beam.addColorStop(0, "rgba(255, 226, 164, 0.2)");
      beam.addColorStop(1, "rgba(255, 226, 164, 0)");
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(31, 2);
      ctx.lineTo(106, -24);
      ctx.lineTo(106, 28);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.restore();
  }

  private drawAnchors(state: RenderState): void {
    const ctx = this.ctx;
    for (const anchor of state.level.anchors) {
      const p = state.build.nodes.find((node) => node.id === anchor.id) ?? anchor;
      const isDeck = anchor.deck;
      const color = isDeck ? "#f1b45d" : "#72d8e6";
      const pulse = state.mode === "edit" ? 0.5 + Math.sin(state.time * 2.4 + anchor.x * 0.01) * 0.18 : 0.5;

      ctx.save();
      ctx.translate(p.x, p.y);

      // Plate
      ctx.shadowColor = color;
      ctx.shadowBlur = 12 + pulse * 8;
      ctx.fillStyle = "rgba(7, 16, 27, 0.96)";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(9, -3.5);
      ctx.lineTo(9, 6.5);
      ctx.lineTo(0, 11);
      ctx.lineTo(-9, 6.5);
      ctx.lineTo(-9, -3.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Bolts
      ctx.fillStyle = color;
      const bolts: [number, number][] = [[-4, -2], [4, -2], [-4, 4], [4, 4]];
      for (const [bx, by] of bolts) {
        ctx.beginPath();
        ctx.arc(bx, by, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(0, 0, 2.4, 0, Math.PI * 2);
      ctx.fill();

      if (state.mode === "edit") {
        const label = anchor.label;
        ctx.font = "600 8px 'Cascadia Code', Consolas, monospace";
        const width = ctx.measureText(label).width + 12;
        const labelY = anchor.y > 450 ? 26 : -18;
        ctx.fillStyle = "rgba(8, 18, 30, 0.86)";
        ctx.strokeStyle = isDeck ? "rgba(241, 180, 93, 0.26)" : "rgba(114, 216, 230, 0.24)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(-width / 2, labelY - 7, width, 14, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = isDeck ? "rgba(255, 219, 166, 0.9)" : "rgba(163, 240, 248, 0.84)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, 0, labelY + 0.5);
      }
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------------
  // Particles, drag, overlays
  // ---------------------------------------------------------------------------

  private drawParticles(state: RenderState): void {
    const ctx = this.ctx;
    for (const particle of state.particles) {
      const alpha = Math.max(0, particle.life / particle.maxLife);
      if (particle.kind === "dust") {
        ctx.globalAlpha = alpha * 0.55;
        ctx.fillStyle = particle.color;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size * (1.4 - alpha * 0.4), 0, Math.PI * 2);
        ctx.fill();
      } else if (particle.kind === "confetti") {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(particle.x, particle.y);
        ctx.rotate(particle.x * 0.05 + state.time * 4);
        ctx.fillStyle = particle.color;
        ctx.fillRect(-particle.size, -particle.size * 0.55, particle.size * 2, particle.size * 1.1);
        ctx.restore();
      } else {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = particle.color;
        ctx.shadowColor = particle.color;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size * (0.4 + alpha * 0.6), 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
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
    ctx.globalAlpha = 0.92;
    ctx.lineWidth = 2.6;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    ctx.fillStyle = "rgba(8, 18, 30, 0.94)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(to.x, to.y, 5.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2 - 18;
    const label = state.drag.label;
    ctx.font = "600 9px 'Cascadia Code', Consolas, monospace";
    const width = ctx.measureText(label).width + 16;
    ctx.fillStyle = valid ? "rgba(8, 18, 30, 0.92)" : "rgba(55, 15, 15, 0.92)";
    ctx.strokeStyle = valid ? "rgba(241, 180, 93, 0.4)" : "rgba(255, 111, 104, 0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(midX - width / 2, midY - 10, width, 19, 6);
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
    gradient.addColorStop(0.5, "rgba(114, 216, 230, 0.03)");
    gradient.addColorStop(1, "rgba(114, 216, 230, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, y - 24, WORLD_WIDTH, 48);
  }

  private drawVignette(state: RenderState): void {
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
    vignette.addColorStop(1, "rgba(1, 5, 11, 0.55)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    const bottom = ctx.createLinearGradient(0, 650, 0, 720);
    bottom.addColorStop(0, "rgba(3, 8, 13, 0)");
    bottom.addColorStop(1, "rgba(3, 8, 13, 0.55)");
    ctx.fillStyle = bottom;
    ctx.fillRect(0, 650, WORLD_WIDTH, 70);

    if (state.mode === "test" && state.car && state.car.visible) {
      const focus = ctx.createRadialGradient(state.car.x, state.car.y, 110, state.car.x, state.car.y, 430);
      focus.addColorStop(0, "rgba(255, 196, 120, 0.015)");
      focus.addColorStop(1, "rgba(0, 0, 0, 0.18)");
      ctx.fillStyle = focus;
      ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    }
  }
}

function stressColor(ratio: number, axial: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  if (axial >= 0) {
    const r = 255;
    const g = Math.round(170 - 135 * clamped);
    const b = Math.round(110 - 90 * clamped);
    return `rgb(${r}, ${g}, ${b})`;
  }
  const r = Math.round(80 - 28 * clamped);
  const g = Math.round(220 - 38 * clamped);
  const b = 255;
  return `rgb(${r}, ${g}, ${b})`;
}

function hash(n: number): number {
  let x = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}
