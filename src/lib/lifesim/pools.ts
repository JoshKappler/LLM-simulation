import type { Occupation } from "./types";

const NAMES = [
  "Aldric", "Brynn", "Cedric", "Della", "Eamon", "Faye",
  "Gareth", "Hilda", "Ivo", "Jessa", "Kael", "Lenna",
  "Magnus", "Nola", "Oswin", "Petra", "Ronan", "Sera",
  "Thane", "Una", "Voss", "Wynn", "Xander", "Yara",
];

const PERSONALITIES = [
  "Obsessed with accumulating wealth. Talks about everything in terms of cost and value — even friendships. Gets twitchy when spending gold but can't resist a deal. Speaks bluntly and always tries to negotiate.",
  "Falls in love hard and fast, then makes reckless decisions to impress whoever's caught their eye. Speaks warmly but dramatically — sighs a lot, compliments freely, gets heartbroken easily. Can't keep feelings to themselves.",
  "Assumes everyone is scheming against them. Asks pointed questions, watches people too closely, keeps mental notes on who was where. Speaks in short suspicious bursts and demands explanations for innocent behavior.",
  "Gives away things they actually need. Can't say no to anyone who looks even slightly sad. Speaks gently and apologetically. Will give their last bread away and then complain about being hungry to someone else.",
  "Manipulative but charming about it. Flatters people to their face, schemes behind their back. Speaks smoothly — always steering conversations toward what they want. Never makes a move without calculating the angle first.",
  "Deeply religious and vocally judgmental. Disapproves of drinking, fighting, and anything they consider immoral. Speaks in righteous declarations and genuinely believes they're saving souls. Varies their sermons based on what sins they've recently witnessed.",
  "Anger is always simmering just below the surface. Small things set them off — a wrong look, someone bumping into them, being ignored. Speaks through gritted teeth or in loud outbursts. Regrets it sometimes. Does it again anyway.",
  "Terrified of confrontation but sticky-fingered when nobody's looking. Agrees with everyone to their face, then steals from them when the opportunity arises. Speaks meekly and agreeably while planning their next theft.",
  "Watches everything, says almost nothing. When they do speak it's pointed and perceptive — they noticed what nobody else did. Keeps secrets. Patient. Dangerous in a quiet way. Makes others uncomfortable with what they know.",
  "Relentlessly upbeat. Tries to organize group activities, interprets even hostile actions as misunderstandings. Speaks enthusiastically about whatever is happening and always finds the bright side. Exhausting but sincere.",
  "Trusts no one and makes sure they know it. Every conversation is seasoned with pessimism and sardonic observations. Has been hurt before and won't be again. Comments bitterly on other people's motives.",
  "Lives for respect and challenge. Boasts about past fights (real or imagined). Takes insults personally and responds with fists. Speaks boldly and challenges others to prove themselves. Has a code of honor but it's flexible.",
  "Cannot bear to see anyone in pain. Fusses over injuries, shares medicine freely, mediates conflicts. Speaks softly and worriedly. Gets walked over but doesn't mind much. Always checking on people's wellbeing.",
  "Lives for other people's business. Tells everyone what everyone else is doing, often with embellishments. Speaks conspiratorially and thrives on secrets. Accidentally starts feuds and loves watching the drama unfold.",
  "Befriends whoever seems most powerful or wealthy. Dismissive of those who can't help them climb. Speaks differently depending on who they're talking to — flattering upward, curt downward. Always positioning themselves socially.",
  "Desperately lonely and it shows. Overshares, clings to anyone who's kind, takes rejection very hard. Speaks hopefully then deflates when things don't work out. Will do almost anything to not be alone.",
  "Zero interest in feelings or drama. Cares about food, shelter, gold, staying alive. Speaks in flat practical terms and focuses only on survival and efficiency. Seems cold but is reliable in a crisis.",
  "Finds everything funnier when it's chaotic. Plays pranks, tells lies to see what happens, stirs the pot and watches it boil. Never quite sorry about the trouble they cause. Mischievous and creative about it.",
  "Constantly talking about how things used to be better. Resists any change, romanticizes their childhood, gets wistful about the old days. Speaks in long sighs and memories. Compares everything unfavorably to the past.",
  "Can't stand seeing their friends close to anyone else. Gets jealous fast — of romantic partners, of friendships, of attention. Speaks with a possessive edge and tracks who is spending time with whom.",
];

const OCCUPATIONS: Occupation[] = [
  "farmer", "blacksmith", "merchant", "priest", "bard", "hunter", "miner",
];

const COLORS = [
  "#2255cc", "#cc3333", "#228833", "#9933aa",
  "#cc8822", "#229999", "#cc4488", "#5544aa",
  "#667733", "#aa4444", "#336688", "#885599",
];

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function generateAgents(count: number) {
  const names = shuffle(NAMES).slice(0, count);
  const personalities = shuffle(PERSONALITIES);
  const occupations = shuffle(OCCUPATIONS);

  return names.map((name, i) => ({
    name,
    personality: personalities[i % personalities.length],
    occupation: occupations[i % occupations.length],
    color: COLORS[i % COLORS.length],
  }));
}

export function pickColor(index: number): string {
  return COLORS[index % COLORS.length];
}
