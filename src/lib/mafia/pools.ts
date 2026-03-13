import type { MafiaPreset } from "./types";

export const NAMES = [
  "Alex", "Sam", "Jordan", "Morgan", "Casey", "Riley", "Quinn", "Avery",
  "Blake", "Drew", "Sage", "Rowan", "Finley", "Harper", "Reese", "Parker",
  "Skyler", "Taylor", "Jamie", "Lennox", "Oakley", "Emery", "Devon", "Ellis",
  "Frankie", "Hayden", "Kit", "Luca", "Nico", "Wren", "Kendall", "Remy",
  "Harlow", "Phoenix", "Dakota", "Shiloh", "Marley", "River", "Tatum", "Peyton",
  "Indigo", "Sterling", "Vesper", "Calloway",
];

export const PRESET_PERSONALITIES: MafiaPreset[] = [
  { name: "The Interrogator", personality: "Asks pointed questions and watches how people change their story under pressure. Believes contradictions reveal everything." },
  { name: "The Peacemaker", personality: "Tries to calm tensions and build consensus. Gets genuinely distressed when people fight." },
  { name: "The Paranoid", personality: "Trusts nobody, reads too much into every word. Convinced there's a pattern others are missing." },
  { name: "The Comedian", personality: "Deflects everything with dark humor. Uses jokes to probe without seeming threatening." },
  { name: "The Bully", personality: "Dominates through intimidation. Targets the quietest person and pressures them to talk." },
  { name: "The Analyst", personality: "Tracks who voted for whom and builds elaborate theories. Speaks in probabilities." },
  { name: "The Loyalist", personality: "Picks someone to trust early and defends them fiercely. Will go down with the ship." },
  { name: "The Snake", personality: "Agrees with everyone to their face, then shifts blame the moment they leave." },
  { name: "The Hothead", personality: "Takes everything personally and escalates fast. Quick to accuse but also quick to forgive." },
  { name: "The Ghost", personality: "Barely speaks unless spoken to. When they do talk, it's unsettling and specific." },
  { name: "The Preacher", personality: "Makes emotional appeals about unity and fairness. Wraps every argument in morality." },
  { name: "The Gambler", personality: "Loves risk. Throws out wild accusations to see what sticks. Thrives in chaos." },
  { name: "The Detective", personality: "Methodical and persistent. Asks the same question five different ways looking for inconsistencies." },
  { name: "The Diplomat", personality: "Never directly accuses anyone. Frames everything as gentle suggestions and hypotheticals." },
  { name: "The Opportunist", personality: "Has no real allegiance. Sides with whoever seems to be winning at any given moment." },
  { name: "The Martyr", personality: "Constantly offers to be voted out to prove their innocence. Guilt-trips everyone." },
  { name: "The Gossip", personality: "Remembers every detail of what everyone said and loves pointing out contradictions." },
  { name: "The Philosopher", personality: "Overthinks everything and gets lost in abstract reasoning about trust and betrayal." },
  { name: "The Hustler", personality: "Fast-talking and persuasive. Can convince people of almost anything in the moment." },
  { name: "The Contrarian", personality: "Disagrees with the majority on principle. If everyone thinks someone is guilty, they must be innocent." },
  { name: "The Protector", personality: "Shields quieter players from bullying and redirects aggression. Gets louder when someone is being ganged up on." },
  { name: "The Statistician", personality: "Obsessed with vote patterns and elimination order. Treats the game like a math problem and gets frustrated when others don't follow the logic." },
  { name: "The Flatterer", personality: "Compliments everyone constantly and builds alliances through charm. Hard to read because they never seem rattled." },
  { name: "The Cynic", personality: "Assumes the worst about everyone's motives. Interprets kindness as manipulation and silence as guilt." },
  { name: "The Storyteller", personality: "Frames everything as narrative — who's the villain, who's the hero. Gets emotionally invested in their own theories." },
  { name: "The Wallflower", personality: "Observes quietly and speaks only when they've noticed something important. Their rare contributions carry weight." },
  { name: "The Provocateur", personality: "Deliberately stirs conflict between others to see how they react. Enjoys watching people crack under pressure." },
  { name: "The Empath", personality: "Reads emotional states and trusts gut feelings over logic. Gets uneasy when someone is lying and calls it out directly." },
  { name: "The Dealmaker", personality: "Constantly proposes trades and alliances. Thinks every situation can be resolved through negotiation." },
  { name: "The Fatalist", personality: "Accepts whatever happens with eerie calm. Makes dark predictions and seems unbothered by the prospect of elimination." },
];

const COLORS = [
  "#000099", "#cc0000", "#006600", "#880088",
  "#886600", "#008888", "#884400", "#444444",
  "#4400aa", "#aa0044", "#226622", "#664488",
  "#0066aa", "#bb4400", "#338833", "#993399",
  "#aa6600", "#006666", "#773311", "#222266",
];

export function pickColor(index: number): string {
  return COLORS[index % COLORS.length];
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function pickRandomNames(count: number): string[] {
  return shuffle(NAMES).slice(0, count);
}

export function pickRandomPersonalities(count: number): string[] {
  return shuffle(PRESET_PERSONALITIES).slice(0, count).map((p) => p.personality);
}
