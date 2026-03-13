import { createPresetListRoute } from "@/lib/presetRouteFactory";
import type { SituationPreset } from "@/lib/types";
import { BUILT_IN_SITUATIONS } from "@/lib/presets";

export const { GET, POST } = createPresetListRoute<SituationPreset>({
  dirName: "situations",
  jsonKey: "situations",
  builtIns: BUILT_IN_SITUATIONS,
});
