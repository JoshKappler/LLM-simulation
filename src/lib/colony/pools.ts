const NAMES = [
  "Alex", "Sam", "Jordan", "Morgan", "Casey", "Riley", "Quinn", "Avery",
  "Blake", "Drew", "Sage", "Rowan", "Finley", "Harper", "Reese", "Parker",
  "Skyler", "Taylor", "Jamie", "Lennox", "Oakley", "Emery", "Devon", "Ellis",
  "Frankie", "Hayden", "Kit", "Luca", "Nico", "Wren",
];

const TRAITS = [
  "paranoid and always suspects others of scheming",
  "cheerful optimist who sees the best in everyone",
  "quiet observer who only speaks when they have something cutting to say",
  "compulsive storyteller who derails every conversation",
  "brutally honest to the point of cruelty",
  "desperate people-pleaser who agrees with whoever spoke last",
  "conspiracy theorist who connects everything to a grand plot",
  "dry comedian who treats everything like a bit",
  "petty grudge-holder who never lets anything go",
  "self-appointed leader who tries to control every conversation",
  "nervous wreck who catastrophizes everything",
  "smug know-it-all who corrects everyone",
  "chaotic wildcard who says whatever pops into their head",
  "empathetic mediator who tries to keep the peace",
  "bitter cynic who thinks everything is pointless",
  "shameless gossip who stirs up drama",
  "deadpan contrarian who disagrees with everything on principle",
  "overly enthusiastic about incredibly boring topics",
  "passive-aggressive and speaks almost entirely in subtext",
  "blunt survivalist who only cares about practical outcomes",
  "melodramatic and treats every minor event like a tragedy",
  "quietly menacing and makes unsettling observations",
  "nostalgic daydreamer who keeps comparing everything to the past",
  "relentless flatterer with unclear motives",
  "deeply suspicious of anyone who seems too friendly",
  "anxious rule-follower who panics when norms are broken",
  "cryptic and speaks in half-finished thoughts",
  "aggressively competitive about everything, even casual conversation",
  "weirdly calm about everything, even chaos",
  "impulsive hothead who escalates every disagreement",
];

const COLORS = [
  "#000099", "#990000", "#006600", "#880088",
  "#886600", "#008888", "#884400", "#444444",
  "#4400aa", "#aa0044", "#226622", "#664488",
];

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function pickUniqueName(exclude: string[]): string {
  const available = NAMES.filter((n) => !exclude.includes(n));
  if (available.length === 0) {
    // All names used — append a number to a random name
    const base = NAMES[Math.floor(Math.random() * NAMES.length)];
    return `${base}${Math.floor(Math.random() * 90) + 10}`;
  }
  return available[Math.floor(Math.random() * available.length)];
}

export function pickTrait(): string {
  return TRAITS[Math.floor(Math.random() * TRAITS.length)];
}

export function pickColor(index: number): string {
  return COLORS[index % COLORS.length];
}

export function generateInitialAgents(count: number): { name: string; trait: string }[] {
  const names = shuffle(NAMES).slice(0, count);
  return names.map((name) => ({ name, trait: pickTrait() }));
}
