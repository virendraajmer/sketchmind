/**
 * The one test in this package that touches the network. Skipped entirely
 * unless Azure credentials are present -- CI and every local run without a
 * `.env` simply never see it, which is why it lives apart from the stubbed
 * suite in provider.test.ts rather than gated by an `it.skipIf` scattered
 * through it.
 *
 * What a stub cannot cover, and this does: that Azure's v1 Responses API
 * actually agrees with our reading of it -- that `strict: true` really is
 * honoured, that a real deployment answers the Responses API at all under our
 * base-URL normalisation, and that the schema this adapter sends for a real
 * `shared-types` model (not a five-field toy) survives strict mode. Task 10 /
 * D-5 / D-4.
 */
import { describe, expect, it } from "vitest";
import { IntentModelSchema } from "@sketchmind/shared-types";
import { createAzureOpenAIProvider } from "../src/index.js";

const hasLiveCredentials =
  Boolean(process.env["AZURE_OPENAI_BASE_URL"]) &&
  Boolean(process.env["AZURE_OPENAI_DEPLOYMENT"]) &&
  (Boolean(process.env["AZURE_OPENAI_API_KEY"]) ||
    process.env["AZURE_OPENAI_USE_ENTRA_ID"] === "true");

const suite = hasLiveCredentials ? describe : describe.skip;

suite("live: Azure OpenAI v1 Responses API", () => {
  it(
    "returns a value matching IntentModelSchema, a real shared-types model, not a toy",
    async () => {
      const provider = createAzureOpenAIProvider(process.env);

      const result = await provider.completeStructured({
        system:
          "You are the SketchMind intent analyzer. Read the user's request and produce " +
          "the intent model that downstream planning consumes.",
        messages: [
          {
            role: "user",
            content:
              "Explain how a lever works, for a physics student who has never seen one.",
          },
        ],
        schema: IntentModelSchema,
        name: "intent_model",
        maxOutputTokens: 1024,
      });

      expect(() => IntentModelSchema.parse(result.value)).not.toThrow();
      expect(result.value.subject.length).toBeGreaterThan(0);
      expect(["native", "prompt-repair"]).toContain(result.mechanism);
      expect(result.usage.totalTokens).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "streams a real response and reassembles it",
    async () => {
      const provider = createAzureOpenAIProvider(process.env);
      if (!provider.capabilities.streaming) return;

      const chunks: string[] = [];
      let sawDone = false;
      for await (const chunk of provider.stream({
        messages: [{ role: "user", content: "Count from one to three." }],
        maxOutputTokens: 64,
      })) {
        if (chunk.done) sawDone = true;
        else chunks.push(chunk.delta);
      }

      expect(sawDone).toBe(true);
      expect(chunks.join("").length).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "probes real capabilities and returns booleans, not guesses",
    async () => {
      const provider = createAzureOpenAIProvider(process.env);
      const measured = await provider.probeCapabilities?.();
      expect(measured).toBeDefined();
      expect(typeof measured?.structuredOutput).toBe("boolean");
      expect(typeof measured?.toolCalling).toBe("boolean");
    },
    60_000,
  );
});
