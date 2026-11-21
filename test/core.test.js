import { describe, it, expect } from "bun:test";
import { chunkTranscript } from "../src/chunker.js";
import { scoreChunk } from "../src/scorer.js";
import { selectClips } from "../src/ranker.js";
import { generateSRT, generateASS } from "../src/subtitles.js";
import { getLLMConfig } from "../src/llm.js";
import { checkDependencies } from "../src/doctor.js";

describe("L2S Core Unit Tests", () => {
  it("should check system dependencies", async () => {
    const deps = await checkDependencies();
    expect(deps).toHaveProperty("ffmpeg");
    expect(deps).toHaveProperty("ytdlp");
    expect(deps).toHaveProperty("groq");
    expect(deps).toHaveProperty("ollama");
  }, 10000);

  it("should load LLM configuration properly", () => {
    const config = getLLMConfig();
    expect(["groq", "ollama"]).toContain(config.provider);
    expect(config).toHaveProperty("ollamaUrl");
  });

  it("should chunk transcript segments cleanly into chunks", () => {
    const mockTranscript = {
      language: "en",
      duration: 120,
      segments: [
        { start: 0, end: 15, text: "Hello everyone, welcome to this video.", words: [] },
        { start: 15, end: 40, text: "Today we are discussing something truly revolutionary.", words: [] },
        { start: 40, end: 70, text: "The secret to growing your audience is consistency and hooks.", words: [] },
        { start: 70, end: 100, text: "If you don't grab attention in the first three seconds, they will swipe away.", words: [] },
        { start: 100, end: 120, text: "Let's summarize everything we talked about today.", words: [] },
      ],
    };

    const chunks = chunkTranscript(mockTranscript);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const duration = chunk.end - chunk.start;
      expect(duration).toBeGreaterThan(0);
      expect(duration).toBeLessThanOrEqual(100);
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it("should heuristically score transcript chunks", () => {
    const sampleChunk = {
      start: 0,
      end: 25,
      text: "Stop scrolling right now! The biggest secret that nobody tells you is unbelievable.",
      words: [],
    };

    const scored = scoreChunk(sampleChunk);
    expect(scored).toHaveProperty("total");
    expect(scored.total).toBeGreaterThanOrEqual(0);
    expect(scored.total).toBeLessThanOrEqual(100);
    expect(scored).toHaveProperty("speakingRate");
    expect(scored).toHaveProperty("engagementHooks");
  });

  it("should select non-overlapping clips based on rank", () => {
    const scoredChunks = [
      {
        index: 0,
        chunk: { start: 0, end: 30, text: "Clip 1" },
        heuristic: { total: 80 },
      },
      {
        index: 1,
        chunk: { start: 20, end: 45, text: "Clip 2 (overlapping Clip 1)" },
        heuristic: { total: 70 },
      },
      {
        index: 2,
        chunk: { start: 50, end: 80, text: "Clip 3" },
        heuristic: { total: 85 },
      },
    ];

    const ranked = [
      { title: "Best Clip", score: 9, start: 50, end: 80 },
      { title: "Second Best Clip", score: 8, start: 0, end: 30 },
      { title: "Overlapping Clip", score: 7, start: 20, end: 45 },
    ];

    const selected = selectClips(ranked, scoredChunks, 2, 15, 60);
    expect(selected.length).toBe(2);
    // Overlapping clip should be excluded
    const starts = selected.map((s) => s.chunk.start);
    expect(starts).toContain(50);
    expect(starts).toContain(0);
    expect(starts).not.toContain(20);
  });

  it("should generate valid SRT and ASS subtitles", () => {
    const words = [
      { word: "Hello", start: 1.0, end: 1.5 },
      { word: "world", start: 1.5, end: 2.0 },
    ];

    const srt = generateSRT(words, "clean", 0);
    expect(srt).toContain("-->");
    expect(srt).toContain("Hello");

    const ass = generateASS(words, "tiktok", 0);
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("Dialogue:");
  });
});
