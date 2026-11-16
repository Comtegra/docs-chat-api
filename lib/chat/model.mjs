// Single source of truth for the chat / classifier model. Override per
// environment with the CHAT_MODEL env var; docs chat may further override it
// with DOCS_CHAT_MODEL (see lib/docsChat/llm.mjs).
export const CHAT_MODEL = process.env.CHAT_MODEL || "gemma-4-26b-a4b";
