import { NextRequest, NextResponse } from "next/server";
import { unlink } from "fs/promises";
import path from "path";

const PROMPTS_DIR = path.join(process.cwd(), "prompts");

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  if (!name || name.includes("/") || name.includes("..") || name.includes("\\")) {
    return NextResponse.json({ error: "Invalid name." }, { status: 400 });
  }

  const filePath = path.join(PROMPTS_DIR, `${name}.json`);

  if (!filePath.startsWith(PROMPTS_DIR)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  try {
    await unlink(filePath);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Config not found." }, { status: 404 });
  }
}
