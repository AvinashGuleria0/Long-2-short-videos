import { describe, it, expect } from "bun:test";
import { queryLLM } from "../src/llm.js";

describe("LLM Provider Integration Tests", () => {
  it("should query the configured LLM provider (Groq or Ollama) successfully", async () => {
    const response = await queryLLM({
      prompt: "Hello! Answer with READY.",
      temperature: 0.1,
      maxTokens: 100,
    });
    expect(response).toBeDefined();
    expect(response.length).toBeGreaterThan(0);
  }, 20000);
});
