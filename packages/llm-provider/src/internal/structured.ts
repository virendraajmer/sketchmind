/**
 * Structured output without native support (D-3, mechanism 3).
 *
 * A provider that cannot constrain its own output still has to satisfy the same
 * `completeStructured` contract, because the whole point of the abstraction is
 * that callers never learn which mechanism ran. So: inject the schema into the
 * prompt, parse what comes back, and on failure hand the model its own
 * validation errors and ask again.
 *
 * The error feedback is the part that matters. Retrying an identical prompt is
 * hoping; showing the model exactly which field it got wrong is instruction.
 */
import { errorsFromZod, type SketchMindError } from "@sketchmind/shared-types";
import type { ZodType, z } from "zod";
import type { CompletionRequest, CompletionResponse, StructuredRequest } from "../types.js";
import { ProviderErrorCode, providerError } from "./errors.js";
import { decodeStrictOutput, toStrictJsonSchema } from "./json-schema.js";

export const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

/**
 * Pull JSON out of a text completion.
 *
 * Models wrap JSON in prose and code fences no matter how firmly the prompt
 * says not to, so scanning for the outermost balanced object is more reliable
 * than trusting the whole response to parse. String-aware, because a `}` inside
 * a label would otherwise end the object early.
 */
export function extractJson(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const haystack = fenced?.[1] ?? text;

  const start = haystack.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < haystack.length; i += 1) {
    const char = haystack[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }
  return undefined;
}

function schemaInstruction(name: string, schema: unknown, description?: string): string {
  return [
    `Respond with a single JSON object named "${name}"${description ? ` -- ${description}` : ""}.`,
    "It must validate against this JSON Schema:",
    JSON.stringify(schema),
    "Output only the JSON object. No prose, no code fence, no explanation.",
  ].join("\n");
}

function repairInstruction(previous: string, errors: readonly SketchMindError[]): string {
  const listed = errors
    .slice(0, 20)
    .map((e) => `  - ${e.path || "<root>"}: ${e.message}`)
    .join("\n");
  return [
    "Your previous response did not validate:",
    previous,
    "",
    "Problems:",
    listed,
    "",
    "Return the corrected JSON object. Fix every problem listed, change nothing else.",
  ].join("\n");
}

/** Result of a prompt-and-repair round trip, including how many tries it took. */
export interface PromptStructuredResult<T> {
  readonly value: T;
  readonly response: CompletionResponse;
  readonly repairAttempts: number;
}

/**
 * Run schema-constrained output over a plain text completion.
 *
 * Used by any provider whose `capabilities.structuredOutput` is false, and
 * available to the others as a fallback when a native call comes back
 * unparseable.
 */
export async function completeStructuredViaPrompt<S extends ZodType>(
  req: StructuredRequest<S>,
  complete: (request: CompletionRequest) => Promise<CompletionResponse>,
  providerPackage: string,
): Promise<PromptStructuredResult<z.infer<S>>> {
  const strict = toStrictJsonSchema(req.schema, req.name);
  if (!strict.ok) {
    throw providerError(
      ProviderErrorCode.Misconfigured,
      `Schema "${req.name}" cannot be expressed for structured output.`,
      providerPackage,
      { details: { problems: strict.errors.map((e) => `${e.path || "<root>"}: ${e.message}`) } },
    );
  }

  const maxAttempts = (req.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS) + 1;
  const system = [req.system, schemaInstruction(req.name, strict.value.schema, req.description)]
    .filter(Boolean)
    .join("\n\n");

  const messages = [...req.messages];
  let lastErrors: readonly SketchMindError[] = [];
  let lastResponse: CompletionResponse | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await complete({ ...req, system, messages });
    lastResponse = response;

    const json = extractJson(response.text);
    if (json === undefined) {
      lastErrors = [
        {
          code: ProviderErrorCode.InvalidOutput,
          message: "Response contained no JSON object.",
          package: providerPackage,
          stage: "agent",
          recoverable: true,
        },
      ];
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (cause) {
        parsed = undefined;
        lastErrors = [
          {
            code: ProviderErrorCode.InvalidOutput,
            message: `Response was not valid JSON: ${(cause as Error).message}`,
            package: providerPackage,
            stage: "agent",
            recoverable: true,
          },
        ];
      }

      if (parsed !== undefined) {
        const result = req.schema.safeParse(decodeStrictOutput(parsed));
        if (result.success) {
          return { value: result.data, response, repairAttempts: attempt };
        }
        lastErrors = errorsFromZod(result.error, {
          package: providerPackage,
          stage: "agent",
        });
      }
    }

    if (attempt === maxAttempts - 1) break;
    messages.push({ role: "assistant", content: response.text });
    messages.push({ role: "user", content: repairInstruction(response.text, lastErrors) });
  }

  throw providerError(
    ProviderErrorCode.InvalidOutput,
    `Model did not produce output matching "${req.name}" after ${maxAttempts} attempt(s).`,
    providerPackage,
    {
      // The agent CAN act on this -- rephrase, simplify, or split the request --
      // so it is an observation, not a dead end (AD-2).
      recoverable: true,
      details: {
        attempts: maxAttempts,
        lastErrors: lastErrors.map((e) => `${e.path || "<root>"}: ${e.message}`),
        finishReason: lastResponse?.finishReason,
      },
    },
  );
}
