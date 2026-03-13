export const MESSAGE_WINDOW = 40;
export const VOTE_CONTEXT_WINDOW = 20;

// Banned phrases that LLMs overuse — appended to speech prompts
export const BANNED_PHRASES = [
  "classic wolf tactic",
  "classic wolf move",
  "classic wolf behavior",
  "classic wolf cover-up",
  "classic wolf lure",
  "concrete evidence",
  "concrete observation",
  "sow division",
  "sowing discord",
  "conveniently",
  "throwing shade",
  "awfully quiet",
  "deflecting suspicion",
  "playing it safe",
  "piggyback",
  "bandwagon",
  "under the bus",
  "speaks volumes",
  "food for thought",
  "interesting that",
  "just saying",
];

export const BANNED_PHRASES_LINE = `
SPEAKING RULES:
- Do NOT accuse anyone of "being vague," "lacking concrete evidence," or "not providing observations." Point to a SPECIFIC thing they said and explain why it's suspicious.
- Do NOT use canned phrases like "classic wolf move," "sowing discord," "throwing shade," "speaks volumes," or any similar stock expressions.
- Do NOT start your message by addressing someone by name (e.g. "Quinn, you..."). Vary your openers: an observation, a feeling, a question to the group, a reaction, a declaration. You can name people mid-sentence, just not as the opening word.
- NEVER quote another player's exact words back at them. Paraphrase or reference what they meant — don't parrot their phrasing.
- Make a NEW point each time you speak. If someone already made your argument, build on it with new reasoning or change the subject entirely.
- Every accusation must reference something specific someone actually said or did — paraphrase their words or describe their behavior.
- If you can't think of something specific, share your gut feeling about someone rather than criticizing how others argue.`;

export const DEFAULT_TEMPERATURE = 0.9;
export const MODEL_KEY = "mafia-model";
export const TEMP_KEY = "mafia-temperature";
