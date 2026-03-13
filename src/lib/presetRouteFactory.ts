/**
 * Generic CRUD route handlers for preset types (personalities, situations, guidelines).
 * Eliminates copy-paste across nearly identical API route files.
 */
import { NextRequest, NextResponse } from "next/server";
import { readdir, readFile, writeFile, mkdir, unlink } from "fs/promises";
import path from "path";

interface PresetRouteOptions<T> {
  /** Directory name relative to project root (e.g. "personalities") */
  dirName: string;
  /** JSON response key (e.g. "personalities") */
  jsonKey: string;
  /** Built-in presets to merge into GET responses */
  builtIns?: T[];
}

function resolveDir(dirName: string) {
  return path.join(process.cwd(), dirName);
}

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

function sanitizeId(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .trim()
    .slice(0, 60)
    .toLowerCase()
    .replace(/\s+/g, "-");
}

/**
 * Creates GET and POST handlers for a preset collection route.
 */
export function createPresetListRoute<T extends { name: string }>(
  opts: PresetRouteOptions<T>,
) {
  const dir = resolveDir(opts.dirName);
  const builtIns = opts.builtIns ?? [];

  async function GET() {
    await ensureDir(dir);
    try {
      const files = await readdir(dir);
      const userPresets: T[] = [];
      for (const file of files.filter((f) => f.endsWith(".json"))) {
        try {
          const raw = await readFile(path.join(dir, file), "utf-8");
          userPresets.push(JSON.parse(raw) as T);
        } catch { /* skip malformed */ }
      }
      return NextResponse.json({ [opts.jsonKey]: [...builtIns, ...userPresets] });
    } catch {
      return NextResponse.json({ [opts.jsonKey]: builtIns });
    }
  }

  async function POST(req: NextRequest) {
    await ensureDir(dir);
    const preset = (await req.json()) as T;
    const safeId = sanitizeId(preset.name);
    if (!safeId) return NextResponse.json({ error: "Invalid name." }, { status: 400 });
    const filePath = path.join(dir, `${safeId}.json`);
    await writeFile(filePath, JSON.stringify({ ...preset, id: safeId, isBuiltIn: false }, null, 2));
    return NextResponse.json({ success: true, id: safeId }, { status: 201 });
  }

  return { GET, POST };
}

/**
 * Creates a DELETE handler for a preset [id] route.
 */
export function createPresetItemRoute(dirName: string) {
  const dir = resolveDir(dirName);

  async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) {
    const { id } = await params;
    if (!id || id.includes("/") || id.includes("..") || id.includes("\\"))
      return NextResponse.json({ error: "Invalid id." }, { status: 400 });
    const filePath = path.join(dir, `${id}.json`);
    if (!filePath.startsWith(dir))
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    try {
      await unlink(filePath);
      return NextResponse.json({ success: true });
    } catch {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
  }

  return { DELETE };
}
