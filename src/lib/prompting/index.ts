/**
 * Prompting module — single import point for all prompt-shaping logic.
 *
 * Contents:
 *   assembly.ts  — buildSystemPrompt, buildChatMessages, block types & labels
 *   turnOrder.ts — shouldKillerSpeak, isLooping, threshold constants
 */

export * from "./assembly";
export * from "./turnOrder";
