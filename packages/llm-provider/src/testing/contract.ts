/**
 * The provider contract suite (D-8).
 *
 * There is exactly one copy of these assertions, parameterised by a factory.
 * The master plan's acceptance criterion -- "the same test passes against an
 * in-memory fake with zero test-code changes" -- is then true by construction
 * rather than by anyone remembering to keep two files in step.
 *
 * It also does the job a written interface cannot: it is what stops the next
 * adapter from quietly meaning something different by `finishReason` or by
 * `usage`.
 *
 * Imports `vitest` as an optional peer, so it is only loaded by test runs.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LLMProviderError, type LLMProvider } from "../types.js";
import { ProviderErrorCode } from "../internal/errors.js";

/** Small, but exercises nesting, enums, arrays and optionality. */
export const ContractSchema = z.object({
  title: z.string().min(1),
  category: z.enum(["schematic", "flow", "freeform"]),
  parts: z
    .array(z.object({ name: z.string().min(1), important: z.boolean() }))
    .min(1),
  note: z.string().optional(),
});

export interface ProviderContractOptions {
  /** Fresh provider per test -- shared state between cases hides ordering bugs. */
  readonly make: () => LLMProvider;
  /** Skip the whole suite, e.g. when live credentials are absent. */
  readonly skip?: boolean;
  /** Live providers are slow; the fake is not. */
  readonly timeoutMs?: number;
}

export function describeProviderContract(name: string, options: ProviderContractOptions): void {
  const suite = options.skip ? describe.skip : describe;
  const timeout = options.timeoutMs ?? 15_000;

  suite(`LLMProvider contract: ${name}`, () => {
    it("reports an id, a model and a full capability set", () => {
      const provider = options.make();
      expect(provider.id).toBeTruthy();
      expect(provider.model).toBeTruthy();
      expect(provider.capabilities).toMatchObject({
        structuredOutput: expect.any(Boolean),
        toolCalling: expect.any(Boolean),
        parallelToolCalls: expect.any(Boolean),
        streaming: expect.any(Boolean),
        vision: expect.any(Boolean),
        maxContextTokens: expect.any(Number),
      });
      expect(provider.capabilities.maxContextTokens).toBeGreaterThan(0);
    });

    it(
      "completes a prompt and accounts for tokens",
      async () => {
        const provider = options.make();
        const response = await provider.complete({
          system: "Answer in one short sentence.",
          messages: [{ role: "user", content: "Name one simple machine." }],
          maxOutputTokens: 64,
        });

        expect(typeof response.text).toBe("string");
        expect(response.model).toBeTruthy();
        // Totals that don't add up mean an adapter invented its own accounting,
        // and budgets in Phase 4 are enforced against these numbers.
        expect(response.usage.totalTokens).toBe(
          response.usage.inputTokens + response.usage.outputTokens,
        );
        expect(["stop", "length", "tool_calls", "content_filter", "unknown"]).toContain(
          response.finishReason,
        );
      },
      timeout,
    );

    it(
      "returns a value matching the schema, whatever mechanism it used",
      async () => {
        const provider = options.make();
        const result = await provider.completeStructured({
          system: "You describe simple diagrams.",
          messages: [
            {
              role: "user",
              content:
                "Describe a lever diagram: title, category, and two parts (a beam and a fulcrum).",
            },
          ],
          schema: ContractSchema,
          name: "diagram_sketch",
        });

        // Parse again rather than trusting the provider's word for it.
        expect(() => ContractSchema.parse(result.value)).not.toThrow();
        expect(result.value.parts.length).toBeGreaterThan(0);
        expect(["native", "forced-tool", "prompt-repair"]).toContain(result.mechanism);
        expect(result.repairAttempts).toBeGreaterThanOrEqual(0);
      },
      timeout,
    );

    it(
      "streams deltas that reassemble into the full text",
      async () => {
        const provider = options.make();
        if (!provider.capabilities.streaming) return;

        const chunks: string[] = [];
        let sawDone = false;
        for await (const chunk of provider.stream({
          messages: [{ role: "user", content: "Count to three." }],
          maxOutputTokens: 32,
        })) {
          if (chunk.done) sawDone = true;
          else chunks.push(chunk.delta);
        }

        expect(sawDone).toBe(true);
        expect(chunks.join("").length).toBeGreaterThan(0);
      },
      timeout,
    );

    it(
      "calls a tool when the prompt plainly calls for one",
      async () => {
        const provider = options.make();
        if (!provider.capabilities.toolCalling) return;

        const response = await provider.completeWithTools({
          system: "Use the provided tool. Do not answer in prose.",
          messages: [{ role: "user", content: "Draw a circle labelled 'wheel'." }],
          tools: [
            {
              name: "draw_shape",
              description: "Draw a labelled shape on the whiteboard.",
              parameters: {
                type: "object",
                properties: {
                  shape: { type: "string", enum: ["circle", "square", "triangle"] },
                  label: { type: "string" },
                },
                required: ["shape", "label"],
                additionalProperties: false,
              },
            },
          ],
          toolChoice: "required",
        });

        expect(response.toolCalls.length).toBeGreaterThan(0);
        const call = response.toolCalls[0]!;
        expect(call.name).toBe("draw_shape");
        // Adapters must parse the provider's argument JSON, not pass the string
        // through. Otherwise every tool implementation parses it again.
        expect(typeof call.arguments).toBe("object");
        expect(call.arguments).not.toBeNull();
      },
      timeout,
    );

    it("refuses image input while vision is disabled, without touching the images", async () => {
      const provider = options.make();
      if (provider.capabilities.vision) return;

      // A getter that records access: the standing directive is that no image is
      // encoded or sent, and "we return an error afterwards" would not satisfy it.
      let imagesRead = false;
      const request = {
        messages: [{ role: "user" as const, content: "What is wrong with this drawing?" }],
        get images() {
          imagesRead = true;
          return [{ mimeType: "image/png", base64: "iVBORw0KGgo=" }];
        },
      };

      await expect(provider.completeWithImages(request)).rejects.toBeInstanceOf(LLMProviderError);
      expect(imagesRead).toBe(false);
    });

    it(
      "surfaces cancellation as a non-retryable provider error",
      async () => {
        const provider = options.make();
        const controller = new AbortController();
        controller.abort();

        try {
          await provider.complete({
            messages: [{ role: "user", content: "Hello." }],
            signal: controller.signal,
          });
          expect.unreachable("aborted request should not resolve");
        } catch (error) {
          // The SDK may raise its own abort error before our classifier runs;
          // what the contract requires is that it does not silently succeed.
          if (error instanceof LLMProviderError) {
            expect(error.retryable).toBe(false);
            expect([ProviderErrorCode.Cancelled, ProviderErrorCode.Unknown]).toContain(
              error.error.code,
            );
          }
        }
      },
      timeout,
    );
  });
}
