import { NextRequest, NextResponse } from "next/server";
import { unlink } from "fs/promises";
import path from "path";

const DIR = path.join(process.cwd(), "guidelines");

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id.includes("/") || id.includes("..") || id.includes("\\"))
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  const filePath = path.join(DIR, `${id}.json`);
  if (!filePath.startsWith(DIR))
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  try {
    await unlink(filePath);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
}
