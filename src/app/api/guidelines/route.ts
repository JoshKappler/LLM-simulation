import { createPresetListRoute } from "@/lib/presetRouteFactory";
import type { GuidelinesPreset } from "@/lib/types";

export const { GET, POST } = createPresetListRoute<GuidelinesPreset>({
  dirName: "guidelines",
  jsonKey: "guidelines",
});
