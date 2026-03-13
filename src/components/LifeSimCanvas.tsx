"use client";

import { useRef, useEffect, useCallback } from "react";
import type { LifeSimAgent } from "@/lib/lifesim/types";
import type { Location as SimLocation } from "@/lib/lifesim/types";
import { MAP_DATA, MAP_COLS, MAP_ROWS, TILE_SIZE, TILE_COLORS, TileType, LOCATIONS } from "@/lib/lifesim/map";

interface Props {
  width: number;
  height: number;
  agents: LifeSimAgent[];
  agentPositions: Record<string, { x: number; y: number; targetX: number; targetY: number }>;
  selectedAgentId: string | null;
  onAgentClick: (id: string) => void;
  chatBubbles: { agentId: string; text: string; x: number; y: number; opacity: number }[];
  actionIndicators: { x: number; y: number; emoji: string; opacity: number }[];
  camera: { x: number; y: number; zoom: number };
}

function darken(hex: string, amount: number): string {
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount);
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount);
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function lighten(hex: string, amount: number): string {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + amount);
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + amount);
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// Seeded pseudo-random for consistent tile details
function sr(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

const T = TILE_SIZE; // 16

// ── Building drawing functions ──────────────────────────────────────────────

function drawTavern(ctx: CanvasRenderingContext2D, loc: SimLocation) {
  const bw = (loc.buildingSize?.w ?? 3) * T;
  const bh = (loc.buildingSize?.h ?? 2) * T;
  const px = loc.x * T;
  const py = loc.y * T;

  // Walls — warm brown wood
  ctx.fillStyle = "#8B6914";
  ctx.fillRect(px, py + 6, bw, bh - 6);
  // Darker base
  ctx.fillStyle = "#6B4F0E";
  ctx.fillRect(px, py + bh - 4, bw, 4);
  // Horizontal plank lines
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  for (let i = 0; i < 4; i++) ctx.fillRect(px, py + 10 + i * 6, bw, 1);
  // Roof — dark brown
  ctx.fillStyle = "#4a2a0a";
  ctx.fillRect(px - 2, py, bw + 4, 8);
  ctx.fillStyle = "#5a3a1a";
  ctx.fillRect(px - 1, py + 1, bw + 2, 6);
  // Roof ridge
  ctx.fillStyle = "#3a1a00";
  ctx.fillRect(px, py, bw, 2);
  // Chimney
  ctx.fillStyle = "#666";
  ctx.fillRect(px + bw - 8, py - 6, 5, 8);
  ctx.fillStyle = "#555";
  ctx.fillRect(px + bw - 8, py - 7, 5, 2);
  // Windows — warm glow
  ctx.fillStyle = "#e8c040";
  ctx.fillRect(px + 4, py + 12, 8, 7);
  ctx.fillRect(px + bw - 12, py + 12, 8, 7);
  // Window frames
  ctx.fillStyle = "#4a2a0a";
  ctx.fillRect(px + 7, py + 12, 2, 7);
  ctx.fillRect(px + 4, py + 15, 8, 1);
  ctx.fillRect(px + bw - 9, py + 12, 2, 7);
  ctx.fillRect(px + bw - 12, py + 15, 8, 1);
  // Door
  ctx.fillStyle = "#5a3010";
  ctx.fillRect(px + bw / 2 - 4, py + 14, 8, bh - 14);
  ctx.fillStyle = "#6a4020";
  ctx.fillRect(px + bw / 2 - 3, py + 15, 6, bh - 16);
  // Doorknob
  ctx.fillStyle = "#c8a040";
  ctx.fillRect(px + bw / 2 + 1, py + 22, 2, 2);
  // Sign hanging from post
  ctx.fillStyle = "#5a3a1a";
  ctx.fillRect(px + bw - 2, py + 4, 2, 14); // post
  ctx.fillStyle = "#c4a050";
  ctx.fillRect(px + bw, py + 6, 8, 6); // sign board
  ctx.fillStyle = "#8B6914";
  ctx.fillRect(px + bw + 1, py + 7, 6, 4);
}

function drawChurch(ctx: CanvasRenderingContext2D, loc: SimLocation) {
  const bw = (loc.buildingSize?.w ?? 3) * T;
  const bh = (loc.buildingSize?.h ?? 3) * T;
  const px = loc.x * T;
  const py = loc.y * T;

  // Stone walls
  ctx.fillStyle = "#a0a0a0";
  ctx.fillRect(px, py + 10, bw, bh - 10);
  // Stone texture
  ctx.fillStyle = "#969696";
  for (let row = 0; row < 4; row++) {
    const off = row % 2 === 0 ? 0 : 6;
    for (let col = 0; col < 4; col++) {
      ctx.fillRect(px + off + col * 12, py + 12 + row * 8, 10, 6);
    }
  }
  // Steep roof
  ctx.fillStyle = "#3a3a4a";
  ctx.fillRect(px - 2, py + 4, bw + 4, 8);
  ctx.fillStyle = "#4a4a5a";
  ctx.fillRect(px, py + 5, bw, 6);
  // Steeple / bell tower
  const cx = px + bw / 2;
  ctx.fillStyle = "#8a8a8a";
  ctx.fillRect(cx - 5, py - 12, 10, 18);
  ctx.fillStyle = "#4a4a5a";
  ctx.fillRect(cx - 6, py - 14, 12, 4);
  // Cross
  ctx.fillStyle = "#c8b040";
  ctx.fillRect(cx - 1, py - 20, 2, 8);
  ctx.fillRect(cx - 3, py - 18, 6, 2);
  // Arched window
  ctx.fillStyle = "#6080c0";
  ctx.fillRect(cx - 4, py + 16, 8, 12);
  ctx.beginPath();
  ctx.arc(cx, py + 16, 4, Math.PI, 0);
  ctx.fill();
  // Window leading
  ctx.fillStyle = "#555";
  ctx.fillRect(cx - 0.5, py + 14, 1, 14);
  ctx.fillRect(cx - 4, py + 20, 8, 1);
  // Door
  ctx.fillStyle = "#5a4030";
  ctx.fillRect(cx - 5, py + bh - 14, 10, 14);
  ctx.fillStyle = "#6a5040";
  ctx.fillRect(cx - 4, py + bh - 13, 8, 12);
  // Door arch
  ctx.fillStyle = "#888";
  ctx.fillRect(cx - 6, py + bh - 15, 12, 2);
}

function drawHouse(ctx: CanvasRenderingContext2D, loc: SimLocation) {
  const bw = (loc.buildingSize?.w ?? 2) * T;
  const bh = (loc.buildingSize?.h ?? 2) * T;
  const px = loc.x * T;
  const py = loc.y * T;
  const r = sr(loc.x, loc.y, 42);

  // Wall color varies per house
  const wallColors = ["#b0a090", "#a09888", "#a8a098", "#98908a"];
  ctx.fillStyle = wallColors[Math.floor(r * wallColors.length)];
  ctx.fillRect(px, py + 5, bw, bh - 5);
  // Timber frame
  ctx.fillStyle = "#6a4a2a";
  ctx.fillRect(px, py + 5, 2, bh - 5);
  ctx.fillRect(px + bw - 2, py + 5, 2, bh - 5);
  ctx.fillRect(px, py + bh / 2 + 2, bw, 2);
  // Roof
  const roofColors = ["#6a3a1a", "#5a4a2a", "#7a4a2a", "#5a3a1a"];
  ctx.fillStyle = roofColors[Math.floor(r * roofColors.length)];
  ctx.fillRect(px - 1, py, bw + 2, 7);
  ctx.fillStyle = lighten(roofColors[Math.floor(r * roofColors.length)], 15);
  ctx.fillRect(px, py + 1, bw, 4);
  // Window
  ctx.fillStyle = "#d8c880";
  ctx.fillRect(px + 3, py + 10, 7, 6);
  ctx.fillStyle = "#5a3a1a";
  ctx.fillRect(px + 6, py + 10, 1, 6);
  ctx.fillRect(px + 3, py + 12, 7, 1);
  // Door
  ctx.fillStyle = "#5a3010";
  ctx.fillRect(px + bw - 10, py + 12, 7, bh - 12);
  ctx.fillStyle = "#6a4020";
  ctx.fillRect(px + bw - 9, py + 13, 5, bh - 14);
  ctx.fillStyle = "#c8a040";
  ctx.fillRect(px + bw - 5, py + 20, 1, 2);
}

function drawBlacksmith(ctx: CanvasRenderingContext2D, loc: SimLocation) {
  const bw = (loc.buildingSize?.w ?? 2) * T;
  const bh = (loc.buildingSize?.h ?? 2) * T;
  const px = loc.x * T;
  const py = loc.y * T;

  // Sooty stone walls
  ctx.fillStyle = "#7a7068";
  ctx.fillRect(px, py + 6, bw, bh - 6);
  // Soot marks
  ctx.fillStyle = "rgba(0,0,0,0.15)";
  ctx.fillRect(px + 2, py + 8, 6, 10);
  ctx.fillRect(px + bw - 8, py + 8, 6, 8);
  // Roof
  ctx.fillStyle = "#4a3a2a";
  ctx.fillRect(px - 1, py, bw + 2, 8);
  ctx.fillStyle = "#5a4a3a";
  ctx.fillRect(px, py + 1, bw, 6);
  // Chimney (bigger, smokier)
  ctx.fillStyle = "#555";
  ctx.fillRect(px + bw - 7, py - 8, 6, 10);
  ctx.fillStyle = "rgba(100,100,100,0.3)";
  ctx.fillRect(px + bw - 6, py - 12, 4, 5);
  // Open front (no door — archway)
  ctx.fillStyle = "#333";
  ctx.fillRect(px + 4, py + 14, 12, bh - 14);
  ctx.fillStyle = "#444";
  ctx.fillRect(px + 5, py + 15, 10, bh - 16);
  // Anvil inside
  ctx.fillStyle = "#666";
  ctx.fillRect(px + 8, py + bh - 6, 6, 3);
  ctx.fillRect(px + 9, py + bh - 8, 4, 2);
  // Forge glow
  ctx.fillStyle = "rgba(255,120,20,0.3)";
  ctx.fillRect(px + 6, py + 16, 8, 4);
}

function drawMarket(ctx: CanvasRenderingContext2D, loc: SimLocation) {
  const bw = (loc.buildingSize?.w ?? 3) * T;
  const bh = (loc.buildingSize?.h ?? 2) * T;
  const px = loc.x * T;
  const py = loc.y * T;

  // Wooden posts
  ctx.fillStyle = "#7a5a2a";
  ctx.fillRect(px + 2, py + 4, 3, bh - 4);
  ctx.fillRect(px + bw / 2 - 1, py + 4, 3, bh - 4);
  ctx.fillRect(px + bw - 5, py + 4, 3, bh - 4);
  // Canopy — colored cloth strips
  const colors = ["#cc4444", "#cc8822", "#cccc44"];
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = colors[i];
    const sx = px + i * (bw / 3);
    ctx.fillRect(sx, py, bw / 3, 6);
    ctx.fillStyle = darken(colors[i], 30);
    ctx.fillRect(sx, py + 5, bw / 3, 2);
  }
  // Counter/tables
  ctx.fillStyle = "#8a6a3a";
  ctx.fillRect(px + 4, py + bh - 8, bw / 3 - 4, 4);
  ctx.fillRect(px + bw / 3 + 2, py + bh - 8, bw / 3 - 4, 4);
  // Goods on counter
  ctx.fillStyle = "#cc8844";
  ctx.fillRect(px + 6, py + bh - 10, 3, 2);
  ctx.fillStyle = "#88aa44";
  ctx.fillRect(px + 11, py + bh - 10, 3, 2);
  ctx.fillStyle = "#ddaa44";
  ctx.fillRect(px + bw / 3 + 4, py + bh - 10, 3, 2);
}

function drawFarmBuilding(ctx: CanvasRenderingContext2D, loc: SimLocation) {
  const bw = (loc.buildingSize?.w ?? 2) * T;
  const bh = (loc.buildingSize?.h ?? 2) * T;
  const px = loc.x * T;
  const py = loc.y * T;

  // Red barn walls
  ctx.fillStyle = "#8a3020";
  ctx.fillRect(px, py + 6, bw, bh - 6);
  // Darker trim
  ctx.fillStyle = "#6a2010";
  ctx.fillRect(px, py + 6, 2, bh - 6);
  ctx.fillRect(px + bw - 2, py + 6, 2, bh - 6);
  // Horizontal boards
  ctx.fillStyle = "rgba(0,0,0,0.08)";
  for (let i = 0; i < 3; i++) ctx.fillRect(px, py + 10 + i * 7, bw, 1);
  // Roof
  ctx.fillStyle = "#5a3a1a";
  ctx.fillRect(px - 1, py, bw + 2, 8);
  ctx.fillStyle = "#6a4a2a";
  ctx.fillRect(px, py + 1, bw, 6);
  // Barn door (large)
  ctx.fillStyle = "#5a2010";
  ctx.fillRect(px + bw / 2 - 6, py + 12, 12, bh - 12);
  ctx.fillStyle = "#6a3020";
  ctx.fillRect(px + bw / 2 - 5, py + 13, 10, bh - 14);
  // X on door
  ctx.fillStyle = "#4a1a08";
  ctx.fillRect(px + bw / 2 - 4, py + 14, 1, 12);
  ctx.fillRect(px + bw / 2 + 3, py + 14, 1, 12);
  // Hay loft opening
  ctx.fillStyle = "#c8a040";
  ctx.fillRect(px + bw / 2 - 3, py + 7, 6, 4);
}

function drawMineEntrance(ctx: CanvasRenderingContext2D, loc: SimLocation) {
  const bw = (loc.buildingSize?.w ?? 2) * T;
  const bh = (loc.buildingSize?.h ?? 2) * T;
  const px = loc.x * T;
  const py = loc.y * T;

  // Rock face / hillside
  ctx.fillStyle = "#6a6a60";
  ctx.fillRect(px, py + 4, bw, bh - 4);
  ctx.fillStyle = "#5a5a52";
  ctx.fillRect(px + 2, py + 6, bw - 4, bh - 8);
  // Rock texture
  ctx.fillStyle = "#7a7a70";
  ctx.fillRect(px + 3, py + 8, 5, 3);
  ctx.fillRect(px + bw - 10, py + 7, 6, 4);
  // Mine entrance (dark opening)
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(px + bw / 2 - 6, py + 12, 12, bh - 12);
  ctx.fillStyle = "#111";
  ctx.fillRect(px + bw / 2 - 5, py + 13, 10, bh - 14);
  // Timber frame
  ctx.fillStyle = "#6a4a2a";
  ctx.fillRect(px + bw / 2 - 7, py + 10, 2, bh - 10);
  ctx.fillRect(px + bw / 2 + 5, py + 10, 2, bh - 10);
  ctx.fillRect(px + bw / 2 - 7, py + 10, 14, 3);
  // Rail tracks
  ctx.fillStyle = "#555";
  ctx.fillRect(px + bw / 2 - 4, py + bh - 3, 8, 1);
  ctx.fillRect(px + bw / 2 - 4, py + bh - 1, 8, 1);
  // Lantern
  ctx.fillStyle = "#e8c040";
  ctx.fillRect(px + bw / 2 - 8, py + 12, 2, 3);
}

function drawBuilding(ctx: CanvasRenderingContext2D, loc: SimLocation) {
  switch (loc.buildingType) {
    case "tavern": drawTavern(ctx, loc); break;
    case "church": drawChurch(ctx, loc); break;
    case "house": drawHouse(ctx, loc); break;
    case "blacksmith": drawBlacksmith(ctx, loc); break;
    case "market": drawMarket(ctx, loc); break;
    case "farm_building": drawFarmBuilding(ctx, loc); break;
    case "mine_entrance": drawMineEntrance(ctx, loc); break;
  }
}

// ── Main component ──────────────────────────────────────────────────────────

export default function LifeSimCanvas({
  width, height, agents, agentPositions, selectedAgentId, onAgentClick,
  chatBubbles, actionIndicators, camera,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseScaleX = width / (MAP_COLS * T);
  const baseScaleY = height / (MAP_ROWS * T);

  const draw = useCallback((ctx: CanvasRenderingContext2D) => {
    ctx.clearRect(0, 0, width, height);
    ctx.save();

    // Apply camera transform
    ctx.translate(camera.x, camera.y);
    ctx.scale(baseScaleX * camera.zoom, baseScaleY * camera.zoom);

    // ── Draw tiles ──
    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        const tile = MAP_DATA[row]?.[col] ?? TileType.GRASS;
        const px = col * T;
        const py = row * T;
        const r = sr(col, row, 42);

        if (tile === TileType.GRASS || tile === TileType.TREE || tile === TileType.FLOWERS) {
          // Varied grass base (5 shades)
          const shades = ["#4a8c3f", "#478a3c", "#4d8e42", "#458838", "#508f44"];
          ctx.fillStyle = shades[Math.floor(r * shades.length)];
          ctx.fillRect(px, py, T, T);
          // Small tufts
          if (r > 0.4) {
            ctx.fillStyle = `rgba(60,110,40,${0.3 + r * 0.2})`;
            ctx.fillRect(px + (r * 10) | 0, py + (r * 12) | 0, 1, 2);
          }
          if (r > 0.7) {
            ctx.fillStyle = "rgba(80,140,55,0.25)";
            ctx.fillRect(px + ((r * 7 + 5) | 0), py + ((r * 8 + 4) | 0), 1, 2);
          }
        } else {
          ctx.fillStyle = TILE_COLORS[tile] ?? "#4a8c3f";
          ctx.fillRect(px, py, T, T);
        }

        // Tile-specific details
        if (tile === TileType.TREE) {
          // Trunk
          ctx.fillStyle = "#3a2a0e";
          ctx.fillRect(px + 6, py + 9, 3, 7);
          ctx.fillStyle = "#5a3a1a";
          ctx.fillRect(px + 6, py + 9, 2, 7);
          // Canopy layers
          ctx.fillStyle = "#1e5510";
          ctx.beginPath();
          ctx.arc(px + 8, py + 7, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#2d6b1e";
          ctx.beginPath();
          ctx.arc(px + 7, py + 6, 5, 0, Math.PI * 2);
          ctx.fill();
          // Highlight
          ctx.fillStyle = "#3a8025";
          ctx.beginPath();
          ctx.arc(px + 6, py + 4, 3, 0, Math.PI * 2);
          ctx.fill();
        } else if (tile === TileType.WATER) {
          // Depth variation
          ctx.fillStyle = "#2a6da8";
          ctx.fillRect(px, py, T, T / 2);
          // Waves
          const t = Date.now() / 800;
          const w1 = Math.sin(t + col * 0.8 + row * 0.3);
          if (w1 > 0.3) {
            ctx.fillStyle = `rgba(120,200,255,${w1 * 0.25})`;
            ctx.fillRect(px + 1, py + 3 + (w1 * 2) | 0, 7, 1);
          }
          const w2 = Math.sin(t * 0.7 + col * 1.2 + row * 0.6);
          if (w2 > 0.2) {
            ctx.fillStyle = `rgba(100,180,240,${w2 * 0.2})`;
            ctx.fillRect(px + 4, py + 9 + (w2 * 2) | 0, 8, 1);
          }
          // Foam edge
          ctx.fillStyle = "rgba(200,230,255,0.15)";
          ctx.fillRect(px, py, T, 1);
        } else if (tile === TileType.PATH) {
          // Gray cobblestone
          ctx.fillStyle = "#8a8a82";
          ctx.fillRect(px, py, T, T);
          // Individual stones
          const stones = [
            [1, 1, 5, 4], [7, 0, 5, 4],
            [0, 6, 4, 4], [5, 5, 6, 5],
            [1, 11, 5, 4], [8, 10, 5, 4],
          ];
          for (const [sx, sy, sw, sh] of stones) {
            ctx.fillStyle = sr(col + sx, row + sy, 77) > 0.5 ? "#929288" : "#82827a";
            ctx.fillRect(px + sx, py + sy, sw, sh);
          }
          // Gaps between stones
          ctx.fillStyle = "rgba(50,50,50,0.12)";
          ctx.fillRect(px + 6, py, 1, T);
          ctx.fillRect(px, py + 5, T, 1);
          ctx.fillRect(px, py + 10, T, 1);
        } else if (tile === TileType.BRIDGE) {
          // Water underneath
          ctx.fillStyle = "#3a7eb8";
          ctx.fillRect(px, py, T, T);
          // Bridge planks
          ctx.fillStyle = "#8B7355";
          ctx.fillRect(px, py + 1, T, T - 2);
          // Individual planks
          for (let i = 0; i < 3; i++) {
            ctx.fillStyle = sr(col, i, 55) > 0.5 ? "#7a6345" : "#9a8365";
            ctx.fillRect(px, py + 1 + i * 5, T, 4);
            ctx.fillStyle = "rgba(0,0,0,0.1)";
            ctx.fillRect(px, py + 1 + i * 5 + 3, T, 1);
          }
          // Railings
          ctx.fillStyle = "#5a3a1a";
          ctx.fillRect(px, py, 2, T);
          ctx.fillRect(px + T - 2, py, 2, T);
        } else if (tile === TileType.FARMLAND) {
          // Soil base
          ctx.fillStyle = "#5a4018";
          ctx.fillRect(px, py, T, T);
          // Crop rows
          for (let i = 0; i < 2; i++) {
            ctx.fillStyle = "#6b5423";
            ctx.fillRect(px + 1, py + 1 + i * 8, 14, 4);
            // Green crops
            ctx.fillStyle = sr(col, row + i, 99) > 0.5 ? "#4a8a2f" : "#3a7020";
            ctx.fillRect(px + 2, py + i * 8, 2, 3);
            ctx.fillRect(px + 6, py + i * 8, 2, 4);
            ctx.fillRect(px + 10, py + 1 + i * 8, 2, 3);
          }
        } else if (tile === TileType.FLOWERS) {
          // Flowers on grass (grass already drawn above)
          const flowers = [
            { x: 3, y: 3, c: "#dd4466" },
            { x: 10, y: 2, c: "#ddaa22" },
            { x: 4, y: 10, c: "#8844cc" },
            { x: 11, y: 9, c: "#dd6622" },
          ];
          for (const f of flowers) {
            // Stem
            ctx.fillStyle = "#3a6a20";
            ctx.fillRect(px + f.x, py + f.y + 2, 1, 3);
            // Petal
            ctx.fillStyle = f.c;
            ctx.beginPath();
            ctx.arc(px + f.x, py + f.y + 1, 2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    // ── Subtle grid ──
    ctx.strokeStyle = "rgba(0,0,0,0.04)";
    ctx.lineWidth = 0.5;
    for (let row = 0; row <= MAP_ROWS; row++) {
      ctx.beginPath();
      ctx.moveTo(0, row * T);
      ctx.lineTo(MAP_COLS * T, row * T);
      ctx.stroke();
    }
    for (let col = 0; col <= MAP_COLS; col++) {
      ctx.beginPath();
      ctx.moveTo(col * T, 0);
      ctx.lineTo(col * T, MAP_ROWS * T);
      ctx.stroke();
    }

    // ── Draw building overlays ──
    for (const loc of LOCATIONS) {
      if (!loc.buildingType) continue;
      drawBuilding(ctx, loc);
    }

    // ── Draw location labels ──
    for (const loc of LOCATIONS) {
      if (loc.type === "house") continue;
      const lx = loc.x * T + T / 2;
      const ly = loc.y * T - 3;
      ctx.font = "bold 7px Arial";
      ctx.textAlign = "center";
      // Background pill
      const metrics = ctx.measureText(loc.name);
      const tw = metrics.width + 6;
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      const rx = lx - tw / 2;
      const ry = ly - 7;
      const rh = 10;
      ctx.beginPath();
      ctx.moveTo(rx + 2, ry);
      ctx.lineTo(rx + tw - 2, ry);
      ctx.quadraticCurveTo(rx + tw, ry, rx + tw, ry + 2);
      ctx.lineTo(rx + tw, ry + rh - 2);
      ctx.quadraticCurveTo(rx + tw, ry + rh, rx + tw - 2, ry + rh);
      ctx.lineTo(rx + 2, ry + rh);
      ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - 2);
      ctx.lineTo(rx, ry + 2);
      ctx.quadraticCurveTo(rx, ry, rx + 2, ry);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillText(loc.name, lx, ly);
    }

    // ── Draw agents ──
    const aliveAgents = agents.filter(a => a.alive);
    for (const agent of aliveAgents) {
      const pos = agentPositions[agent.id];
      if (!pos) continue;
      const x = pos.x;
      const y = pos.y;
      const isSelected = agent.id === selectedAgentId;

      // Shadow
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.beginPath();
      ctx.ellipse(x, y + 10, 5, 2, 0, 0, Math.PI * 2);
      ctx.fill();

      // Body
      ctx.fillStyle = darken(agent.color, 15);
      ctx.fillRect(x - 3, y - 1, 6, 9);
      ctx.fillStyle = agent.color;
      ctx.fillRect(x - 3, y - 2, 6, 8);

      // Head
      ctx.fillStyle = agent.color;
      ctx.beginPath();
      ctx.arc(x, y - 5, 4, 0, Math.PI * 2);
      ctx.fill();

      // Head highlight
      ctx.fillStyle = lighten(agent.color, 50);
      ctx.beginPath();
      ctx.arc(x - 1, y - 6, 2, 0, Math.PI * 2);
      ctx.fill();

      // Eyes
      ctx.fillStyle = "#fff";
      ctx.fillRect(x - 2, y - 6, 1, 1);
      ctx.fillRect(x + 1, y - 6, 1, 1);
      ctx.fillStyle = "#222";
      ctx.fillRect(x - 2, y - 5, 1, 1);
      ctx.fillRect(x + 1, y - 5, 1, 1);

      // Legs
      ctx.fillStyle = darken(agent.color, 40);
      ctx.fillRect(x - 2, y + 7, 2, 3);
      ctx.fillRect(x + 1, y + 7, 2, 3);

      // Selection ring
      if (isSelected) {
        ctx.strokeStyle = "#ffff00";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(x, y + 1, 7, 10, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = "rgba(255,255,0,0.3)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(x, y + 1, 9, 12, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Health bar
      if (agent.health < 100) {
        const barW = 12;
        const barH = 2;
        const bx = x - barW / 2;
        const by = y - 11;
        ctx.fillStyle = "#222";
        ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
        ctx.fillStyle = "#555";
        ctx.fillRect(bx, by, barW, barH);
        const hpPct = agent.health / 100;
        ctx.fillStyle = hpPct > 0.5 ? "#44cc44" : hpPct > 0.25 ? "#cccc44" : "#cc4444";
        ctx.fillRect(bx, by, barW * hpPct, barH);
      }

      // Name label
      ctx.font = "bold 6px Arial";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillText(agent.name, x + 0.5, y + 17);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(agent.name, x, y + 16.5);
    }

    // ── Dead agents ──
    for (const agent of agents.filter(a => !a.alive)) {
      const pos = agentPositions[agent.id];
      if (!pos) continue;
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = "#cc0000";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pos.x - 5, pos.y - 5);
      ctx.lineTo(pos.x + 5, pos.y + 5);
      ctx.moveTo(pos.x + 5, pos.y - 5);
      ctx.lineTo(pos.x - 5, pos.y + 5);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // ── Action indicators (screen space) ──
    for (const ind of actionIndicators) {
      if (ind.opacity <= 0) continue;
      ctx.globalAlpha = ind.opacity;
      ctx.font = "14px Arial";
      ctx.textAlign = "center";
      const sx = ind.x * baseScaleX * camera.zoom + camera.x;
      const sy = ind.y * baseScaleY * camera.zoom + camera.y;
      ctx.fillText(ind.emoji, sx, sy - 14);
      ctx.globalAlpha = 1;
    }
  }, [width, height, agents, agentPositions, selectedAgentId, baseScaleX, baseScaleY, actionIndicators, camera]);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animFrameId: number;
    const loop = () => {
      draw(ctx);
      animFrameId = requestAnimationFrame(loop);
    };
    animFrameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animFrameId);
  }, [draw]);

  // Click handling
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const screenX = (e.clientX - rect.left) * (canvas.width / rect.width);
    const screenY = (e.clientY - rect.top) * (canvas.height / rect.height);
    const worldX = (screenX - camera.x) / (baseScaleX * camera.zoom);
    const worldY = (screenY - camera.y) / (baseScaleY * camera.zoom);

    let closestId: string | null = null;
    let closestDist = 15;
    for (const agent of agents) {
      if (!agent.alive) continue;
      const pos = agentPositions[agent.id];
      if (!pos) continue;
      const dist = Math.hypot(pos.x - worldX, pos.y - worldY);
      if (dist < closestDist) {
        closestDist = dist;
        closestId = agent.id;
      }
    }
    if (closestId) onAgentClick(closestId);
  }, [agents, agentPositions, baseScaleX, baseScaleY, camera, onAgentClick]);

  return (
    <div style={{ position: "relative", width, height }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        onClick={handleClick}
        style={{ display: "block", width, height, cursor: "grab" }}
      />
      {/* Chat bubbles */}
      {chatBubbles.map((bubble, i) => (
        bubble.opacity > 0 && (
          <div
            key={`bubble-${i}-${bubble.agentId}`}
            style={{
              position: "absolute",
              left: bubble.x * baseScaleX * camera.zoom + camera.x - 70,
              top: bubble.y * baseScaleY * camera.zoom + camera.y - 50,
              maxWidth: 140,
              background: "#ffffff",
              border: "1px solid #333",
              borderRadius: 4,
              padding: "3px 6px",
              fontSize: 10,
              lineHeight: 1.3,
              pointerEvents: "none",
              opacity: bubble.opacity,
              transition: "opacity 0.5s",
              zIndex: 10,
              boxShadow: "1px 1px 3px rgba(0,0,0,0.2)",
            }}
          >
            <div style={{ fontWeight: "bold", color: agents.find(a => a.id === bubble.agentId)?.color ?? "#000", fontSize: 9 }}>
              {agents.find(a => a.id === bubble.agentId)?.name}
            </div>
            <div>{bubble.text.length > 80 ? bubble.text.slice(0, 77) + "..." : bubble.text}</div>
            <div style={{
              position: "absolute",
              bottom: -6,
              left: "50%",
              marginLeft: -4,
              width: 0, height: 0,
              borderLeft: "4px solid transparent",
              borderRight: "4px solid transparent",
              borderTop: "6px solid #333",
            }} />
          </div>
        )
      ))}
    </div>
  );
}
