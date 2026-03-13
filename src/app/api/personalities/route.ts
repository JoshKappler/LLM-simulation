import { createPresetListRoute } from "@/lib/presetRouteFactory";
import type { PersonalityPreset } from "@/lib/types";
import { BUILT_IN_PERSONALITIES } from "@/lib/presets";

export const { GET, POST } = createPresetListRoute<PersonalityPreset>({
  dirName: "personalities",
  jsonKey: "personalities",
  builtIns: BUILT_IN_PERSONALITIES,
});
