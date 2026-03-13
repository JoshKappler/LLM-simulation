import type { Location } from "./types";

// Tile types for the map grid
export enum TileType {
  GRASS = 0,
  PATH = 1,
  WATER = 2,
  BRIDGE = 3,
  BUILDING = 4, // kept in enum but unused in map data — buildings are location overlays
  TREE = 5,
  FARMLAND = 6,
  FLOWERS = 7,
}

// Tile colors for rendering
export const TILE_COLORS: Record<TileType, string> = {
  [TileType.GRASS]: "#4a8c3f",
  [TileType.PATH]: "#8a8a82",
  [TileType.WATER]: "#3a7eb8",
  [TileType.BRIDGE]: "#8B7355",
  [TileType.BUILDING]: "#8a7a6a",
  [TileType.TREE]: "#4a8c3f",
  [TileType.FARMLAND]: "#6b5423",
  [TileType.FLOWERS]: "#4a8c3f",
};

export const TILE_SIZE = 16;
export const MAP_COLS = 48;
export const MAP_ROWS = 32;

// G=grass, P=path, W=water, B=bridge, T=tree, F=farmland, L=flowers
const legend: Record<string, TileType> = {
  G: TileType.GRASS, P: TileType.PATH, W: TileType.WATER, B: TileType.BRIDGE,
  X: TileType.BUILDING, T: TileType.TREE, F: TileType.FARMLAND, L: TileType.FLOWERS,
};

// 48 cols x 32 rows — generated programmatically, verified 48 chars each
const MAP_STR = [
  "TTTGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGWWGTTT",
  "TTTGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGWWGTTT",
  "TGGGGGGGGGGGGGGGPGGGGGGGGGGGPGGGGGGGGGGGGGWWGGGG",
  "TGGGGGGGGGPGGGGGPGGGPGGGGGGGPGGGGGGGGGGGGGGWWGGG",
  "GGGGGGGGGGPGGGGGPGGGPGGGPPPPPGGGGGGGGGGGGGGWWGGG",
  "GGGGGGGGGGPGPPPPPGGGPGGGPGGGPGGGGGGGGGGGGGGWWGGG",
  "GGGGGGGGGGPGPGGGPGGGPGGGPGGGPGGGGGGGGGGGGGGWWGGG",
  "GGGGGGGGGGPGPGGGPGGGPGGGPGGGPGGGGGGGGGGGGGGWWGGG",
  "GGGGGGPPPPPPPPPPPPPPPPPPPPPPPPPPPPPGGGGGGGGWWGGGG",
  "GGGGGGPGGGGGGGGGPGGGGGGGGGGGPGPGPGGGGGGGGGGWWGGG",
  "GGGGGGPGGGGGGGGGPGLLLLLLGGGGPGPGPGGGGGGGGGGWWGGG",
  "GGGGGGPGGGGGGGGGPGLLLLLLGGGGPGPGPGGGGGGGGGWWGGGG",
  "GGGGGGPGGGGGGGGGPGLLLLLLGGGGPGPGPGGGGGGGGGWWGGGG",
  "GGGGGGPGGGGGGGGGPGGGGGGGGGGGPGPGPGGGGGGGGGWWGGGG",
  "GPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPBBPGGGG",
  "GPFFFFFFFFPGGGGGPGGGGGPGGGGGGGGGGGGGPGGGGWWGGGGG",
  "GPFFFFFFFFPGGGGGPGGGGGPGGGGGGGGGGGGGPGGGGWWGGGGG",
  "GPFFFFFFFFPGGGGGPGGGGGPGGGGGGGGGGGGGPGGGGWWGGGGG",
  "GGFFFFFFFFPGGGGGPGGGGGPGGGGGGGGGGGGGPGGGGWWGGGGG",
  "GGFFFFFFFFGGGGGGPGGGGGPGGGGGGGGGGGGGPGGGGWWGGGGG",
  "GGFFFFFFFFGGTTTTPGGGGGPGGGGGTTTTTGGGPGGGGWWGGGGG",
  "GGFFFFFFFFGGTTTTPGGGGGPGGGGGTTTTTGGGGGGGGWWGGGGG",
  "GGFFFFFFFFTTTTTTPTTTTTPTTTTTTTTTTTTGGGGGGWWGGGGG",
  "GGFFFFFFFFTTTTTTTTTTTGGGTTTTTTTTTTTGGGGGGWWGGGGG",
  "GGGGGGGGGGTTTTTTTTTTGGGGGTTTTTTTTTTTTTTTTGWWGGGG",
  "GGGGGGGGGGTTTTTTTTTGGGGGGGTTTTTTTTTTTTTTTGWWGGGG",
  "GGGGGGGGGGTTTTTTTTTTGGGGGTTTTTTTTTTTTTTTTGWWGGGG",
  "GGGGGGGGGGTTTTTTTTTTTGGGTTTTTTTTTTTTTTTTTGWWGGGG",
  "GGGGGGGGGGTTTTTTTTTTTTGTTTTTTTTTTTTTTTTTTGGWWGGG",
  "GGGGGGGGGGTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTGGWWGGG",
  "GGGGGGGGGGTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTGGWWGGG",
  "GGGGGGGGGGTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTGGWWGGG",
];

export const MAP_DATA: TileType[][] = MAP_STR.map(row => {
  const tiles: TileType[] = [];
  for (let i = 0; i < MAP_COLS; i++) {
    const ch = row[i] || "G";
    tiles.push(legend[ch] ?? TileType.GRASS);
  }
  return tiles;
});

// Named locations — agents move between these
// Buildings are drawn as overlays by the canvas (not as tiles)
export const LOCATIONS: Location[] = [
  {
    id: "tavern",
    name: "Tavern",
    type: "tavern",
    x: 13, y: 4,
    buildingType: "tavern",
    buildingSize: { w: 3, h: 2 },
    spawnOffsets: [
      { dx: -4, dy: 20 }, { dx: 6, dy: 20 }, { dx: 16, dy: 20 }, { dx: -8, dy: 26 },
    ],
  },
  {
    id: "church",
    name: "Church",
    type: "church",
    x: 24, y: 2,
    buildingType: "church",
    buildingSize: { w: 3, h: 3 },
    spawnOffsets: [
      { dx: -4, dy: 28 }, { dx: 6, dy: 28 }, { dx: 16, dy: 28 }, { dx: 24, dy: 22 },
    ],
  },
  {
    id: "house_1",
    name: "Cottage",
    type: "house",
    x: 8, y: 2,
    buildingType: "house",
    buildingSize: { w: 2, h: 2 },
    spawnOffsets: [
      { dx: -2, dy: 18 }, { dx: 8, dy: 18 }, { dx: 4, dy: 24 },
    ],
  },
  {
    id: "house_2",
    name: "Homestead",
    type: "house",
    x: 18, y: 2,
    buildingType: "house",
    buildingSize: { w: 2, h: 2 },
    spawnOffsets: [
      { dx: -2, dy: 18 }, { dx: 8, dy: 18 }, { dx: 4, dy: 24 },
    ],
  },
  {
    id: "house_3",
    name: "Dwelling",
    type: "house",
    x: 8, y: 15,
    buildingType: "house",
    buildingSize: { w: 2, h: 2 },
    spawnOffsets: [
      { dx: -2, dy: 18 }, { dx: 8, dy: 18 }, { dx: 4, dy: 24 },
    ],
  },
  {
    id: "house_4",
    name: "Lodge",
    type: "house",
    x: 28, y: 7,
    buildingType: "house",
    buildingSize: { w: 2, h: 2 },
    spawnOffsets: [
      { dx: -2, dy: 18 }, { dx: 8, dy: 18 }, { dx: 4, dy: 24 },
    ],
  },
  {
    id: "house_5",
    name: "Cabin",
    type: "house",
    x: 14, y: 15,
    buildingType: "house",
    buildingSize: { w: 2, h: 2 },
    spawnOffsets: [
      { dx: -2, dy: 18 }, { dx: 8, dy: 18 }, { dx: 4, dy: 24 },
    ],
  },
  {
    id: "village_square",
    name: "Village Square",
    type: "village_square",
    x: 20, y: 10,
    spawnOffsets: [
      { dx: -6, dy: -4 }, { dx: 6, dy: -4 }, { dx: -6, dy: 6 },
      { dx: 6, dy: 6 }, { dx: 0, dy: 0 }, { dx: -10, dy: 2 },
      { dx: 12, dy: 2 }, { dx: 0, dy: -8 },
    ],
  },
  {
    id: "blacksmith",
    name: "Blacksmith",
    type: "blacksmith",
    x: 30, y: 9,
    buildingType: "blacksmith",
    buildingSize: { w: 2, h: 2 },
    spawnOffsets: [
      { dx: -2, dy: 18 }, { dx: 8, dy: 18 }, { dx: 4, dy: 24 },
    ],
  },
  {
    id: "market",
    name: "Market",
    type: "market",
    x: 18, y: 8,
    buildingType: "market",
    buildingSize: { w: 3, h: 2 },
    spawnOffsets: [
      { dx: -4, dy: 18 }, { dx: 6, dy: 18 }, { dx: 16, dy: 18 }, { dx: 24, dy: 14 },
    ],
  },
  {
    id: "farm",
    name: "Farm",
    type: "farm",
    x: 2, y: 15,
    buildingType: "farm_building",
    buildingSize: { w: 2, h: 2 },
    spawnOffsets: [
      { dx: -2, dy: 18 }, { dx: 8, dy: 18 }, { dx: 4, dy: 24 }, { dx: 16, dy: 12 },
    ],
  },
  {
    id: "forest",
    name: "Forest",
    type: "forest",
    x: 22, y: 24,
    spawnOffsets: [
      { dx: -6, dy: -4 }, { dx: 6, dy: -4 }, { dx: 0, dy: 6 }, { dx: -8, dy: 6 },
      { dx: 8, dy: 4 }, { dx: -4, dy: 8 },
    ],
  },
  {
    id: "river",
    name: "River",
    type: "river",
    x: 36, y: 16,
    spawnOffsets: [
      { dx: -4, dy: -4 }, { dx: 4, dy: -4 }, { dx: -4, dy: 4 }, { dx: 4, dy: 4 },
    ],
  },
  {
    id: "mine",
    name: "Mine",
    type: "mine",
    x: 6, y: 24,
    buildingType: "mine_entrance",
    buildingSize: { w: 2, h: 2 },
    spawnOffsets: [
      { dx: -2, dy: 18 }, { dx: 8, dy: 18 }, { dx: 4, dy: 24 },
    ],
  },
];

// Houses available for assignment to agents
export const HOUSE_IDS = ["house_1", "house_2", "house_3", "house_4", "house_5"];

// Work locations by occupation
export const WORK_LOCATIONS: Record<string, string[]> = {
  farmer: ["farm"],
  blacksmith: ["blacksmith"],
  merchant: ["market"],
  priest: ["church"],
  bard: ["tavern", "village_square"],
  hunter: ["forest"],
  miner: ["mine"],
};

// Item prices (base market values for buying)
export const ITEM_PRICES: Record<string, number> = {
  bread: 3,
  wheat: 2,
  meat: 4,
  fish: 4,
  ore: 6,
  tools: 12,
  sword: 20,
  medicine: 8,
  ale: 2,
  wood: 3,
  flowers: 5,
};

// Location names for display
export function getLocationName(locationId: string): string {
  const loc = LOCATIONS.find(l => l.id === locationId);
  return loc?.name ?? locationId;
}
