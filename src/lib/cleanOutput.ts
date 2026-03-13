/**
 * Strips think/reasoning blocks emitted by various models.
 * Pass `partial: true` during streaming to replace unclosed blocks with "…".
 */
export function stripThinkBlocks(text: string, partial = false): string {
  let out = text;
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, "");
  out = out.replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, "");
  out = out.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  // Unclosed blocks: replace with ellipsis during streaming, strip entirely when done
  const tail = partial ? "…" : "";
  out = out.replace(/<think>[\s\S]*/i, tail);
  out = out.replace(/<\|thinking\|>[\s\S]*/i, tail);
  out = out.replace(/<reasoning>[\s\S]*/i, tail);
  return out;
}

/**
 * Cleans raw model output before storing or displaying.
 * Extracted from page.tsx so server-side code can share this logic.
 */
export function cleanOutput(
  raw: string,
  speakerName: string,
  allNames: string[],
): string {
  let text = stripThinkBlocks(raw);

  // Strip own-name prefix: "Alex: I can't believe..." → "I can't believe..."
  const nameEscaped = speakerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  text = text.replace(new RegExp(`^\\s*${nameEscaped}\\s*:\\s*`, "i"), "");

  // Strip wrapping quotation marks
  text = text.trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("\u201c") && text.endsWith("\u201d"))
  ) {
    text = text.slice(1, -1);
  }

  // Strip asterisk stage directions: *slams fist*, *sighs*, etc.
  text = text.replace(/\*[^*]+\*/g, "");

  // Remove lines spoken as other characters
  for (const name of allNames) {
    if (name === speakerName) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`^\\s*${escaped}\\s*:.*$`, "gmi"), "");
  }

  // Strip common role markers from killer output
  text = text.replace(/^\s*(Intercom|Announcer|Voice|Speaker)\s*:\s*/i, "");

  // Strip all remaining quotes, asterisks, and brackets
  text = text.replace(/["\u201c\u201d*[\]]/g, "");

  // Collapse multiple newlines and trim
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return text;
}
