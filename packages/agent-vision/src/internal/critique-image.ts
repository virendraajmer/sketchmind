/**
 * Tier 2: one multimodal call, server-side, and the only place in SketchMind
 * that sends an image anywhere.
 *
 * `completeWithImages` returns prose, not tool calls -- so the contract with the
 * model is a JSON body we parse ourselves. That is also why this function exists
 * at all rather than the client agent seeing the image directly: keeping the
 * multimodal turn here means `agent-core`, the `LLMProvider` interface and the
 * browser's LLM proxy all stay text-only.
 *
 * A model that answers badly is an observation, not a crash (AD-2): every
 * failure below returns a `ValidationResult`. Only a transport failure throws,
 * and it throws `LLMProviderError` from the provider itself.
 */
import {
  LLMProviderError,
  type ImageInput,
  type LLMProvider,
} from "@sketchmind/llm-provider";
import type { CapturedImage } from "@sketchmind/renderer-core";
import {
  CritiqueFindingSchema,
  fail,
  makeError,
  ok,
  type CritiqueFinding,
  type ValidationResult,
} from "@sketchmind/shared-types";
import { z } from "zod";
import { CRITIQUE_SYSTEM_PROMPT, critiqueUserPrompt } from "./prompt.js";

const PACKAGE = "@sketchmind/agent-vision";

/** The model supplies everything but the tier and the id; we own both. */
const ModelFindingSchema = CritiqueFindingSchema.omit({ id: true, tier: true }).extend({
  objectIds: z.array(z.string().min(1)).default([]),
});

const ModelReplySchema = z.object({ findings: z.array(ModelFindingSchema) });

export interface CritiqueImageInput {
  readonly provider: LLMProvider;
  readonly image: CapturedImage;
  /** The user's original words. The image is judged against these. */
  readonly request: string;
  /** Ids and counts. Never coordinates -- the model must read the picture. */
  readonly layoutSummary: string;
  readonly signal?: AbortSignal;
}

function problem(code: string, message: string): ValidationResult<CritiqueFinding[]> {
  return fail([
    makeError({ code, message, package: PACKAGE, stage: "render", recoverable: true }),
  ]);
}

/** Models wrap JSON in prose and fences no matter how firmly asked not to. */
function extractJsonObject(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return undefined;
  return candidate.slice(start, end + 1);
}

function toBase64(data: Uint8Array): string {
  // Node and the browser disagree about how to do this, and this function runs
  // only on the server -- but Buffer is not in `agent-vision`'s type surface, so
  // the portable form is used deliberately.
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function critiqueImage(
  input: CritiqueImageInput,
): Promise<ValidationResult<CritiqueFinding[]>> {
  if (!input.provider.capabilities.vision) {
    return problem(
      "CRITIQUE_VISION_UNAVAILABLE",
      `Provider "${input.provider.id}" cannot accept images, so the visual critique tier ` +
        `cannot run. This is a configuration state, not a failure of the drawing.`,
    );
  }

  const images: ImageInput[] = [
    { mimeType: input.image.mimeType, base64: toBase64(input.image.data) },
  ];

  let text: string;
  try {
    const response = await input.provider.completeWithImages({
      system: CRITIQUE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: critiqueUserPrompt(input.request, input.layoutSummary) }],
      images,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    text = response.text;
  } catch (cause) {
    if (cause instanceof LLMProviderError) return fail([cause.error]);
    throw cause;
  }

  const json = extractJsonObject(text);
  if (!json) {
    return problem(
      "CRITIQUE_UNPARSEABLE",
      `The critique model replied without a JSON object. It said: ${text.slice(0, 200)}`,
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return problem("CRITIQUE_UNPARSEABLE", "The critique model's JSON did not parse.");
  }

  const reply = ModelReplySchema.safeParse(parsedJson);
  if (!reply.success) {
    return problem(
      "CRITIQUE_INVALID",
      `The critique model's findings did not match the expected shape: ` +
        reply.error.issues.map((i) => i.message).join("; "),
    );
  }

  return ok(
    reply.data.findings.map((f, index) => ({
      ...f,
      id: `visual:${index}:${f.check}`,
      tier: "visual" as const,
    })),
  );
}
