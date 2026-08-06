/**
 * The critique route: the only place an image reaches a model.
 *
 * It exists so the browser agent can *see* without the multimodal turn ever
 * entering its own message loop -- the client sends pixels, this returns JSON
 * findings, and `agent-core`, the `LLMProvider` interface and `/api/agent/llm`
 * all stay text-only.
 *
 * Validated rather than forwarded, on exactly the reasoning behind
 * `routes/llm.ts`: an endpoint that relayed whatever bytes it received to a paid
 * multimodal API would be an open relay wearing a SketchMind badge.
 *
 * A closed gate is a 503 with a reason, not a silent empty list. A tier that is
 * off should be legible from the outside; "no findings" and "critique never ran"
 * are different answers and must not look alike.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { critiqueImage } from "@sketchmind/agent-vision";
import type { SketchMindError } from "@sketchmind/shared-types";
import { LLMProviderError, ProviderErrorCode, type LLMProvider } from "@sketchmind/llm-provider";
import type { ApiConfig } from "../config.js";
import type { SessionManager } from "../session/manager.js";

const RequestSchema = z.object({
  sessionId: z.string().min(1),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  base64: z.string().min(1),
  width: z.number().int().positive().max(20_000),
  height: z.number().int().positive().max(20_000),
});

export interface VisionRouteOptions {
  /** The vision-role provider, or undefined when none resolved. */
  readonly provider: LLMProvider | undefined;
  readonly config: ApiConfig;
  readonly sessions: SessionManager;
}

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Every code `classifyFailure`/`providerError` can produce (see
 * `llm-provider/src/internal/errors.ts`) -- both start every provider taxonomy
 * entry at `PROVIDER_`. `critiqueImage` already catches `LLMProviderError`
 * around its own model call and folds it into a `fail([...])` alongside its
 * *own* parse/schema failures (`CRITIQUE_UNPARSEABLE`, `SCHEMA_INVALID`,
 * `CRITIQUE_VISION_UNAVAILABLE`), so by the time a `ValidationResult` reaches
 * this route the two failure kinds are indistinguishable except by this code
 * set -- a rate limit and a bad model reply otherwise both look like 422.
 */
const PROVIDER_ERROR_CODES = new Set<string>(Object.values(ProviderErrorCode));

function isTransportFailure(errors: readonly SketchMindError[]): boolean {
  return errors.some((error) => PROVIDER_ERROR_CODES.has(error.code));
}

export function registerVisionRoute(app: FastifyInstance, options: VisionRouteOptions): void {
  const { provider, config, sessions } = options;
  const enabled = config.vision.mode !== "off" && provider !== undefined;

  app.post("/api/agent/vision-critique", async (request, reply) => {
    if (!enabled) {
      return reply.code(503).send({
        reason:
          config.vision.mode === "off"
            ? "Visual critique is switched off (SKETCHMIND_VISION_MODE=off)."
            : "No vision-capable provider resolved for the vision role.",
      });
    }

    const parsed = RequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ errors: parsed.error.issues });

    // Base64 inflates by 4/3; comparing the encoded length is the cheap check
    // and it is deliberately done before decoding rather than after.
    if (parsed.data.base64.length > config.vision.maxImageBytes) {
      return reply.code(413).send({ reason: "The image is larger than the configured cap." });
    }

    const record = sessions.get(parsed.data.sessionId);
    if (!record) return reply.code(404).send({ reason: "No such session." });

    if (record.visionRounds >= config.vision.maxRounds) {
      return reply.code(429).send({ reason: "This session has used its critique rounds." });
    }
    record.visionRounds += 1;

    // Decoded separately from the critique call so a client's own bad input
    // (non-base64) answers 400, not 502 -- `atob` throws `DOMException` on
    // invalid characters, and that throw must not fall into the "the model
    // could not be reached" branch below. The round still counts: a malformed
    // request consuming a round is what stops a retry loop from being free.
    let data: Uint8Array;
    try {
      data = decode(parsed.data.base64);
    } catch {
      return reply.code(400).send({ reason: "The image data is not valid base64." });
    }

    try {
      const result = await critiqueImage({
        provider,
        image: {
          mimeType: parsed.data.mimeType,
          width: parsed.data.width,
          height: parsed.data.height,
          data,
        },
        request: record.request,
        layoutSummary: record.layoutSummary,
        signal: record.controller.signal,
      });

      if (!result.ok) {
        // A transport failure (rate limit, auth, timeout) and a parse failure
        // (the model answered but its JSON did not fit the schema) are
        // different problems for whoever is debugging this -- the first means
        // "check credentials/quota", the second means "check the prompt".
        // See `isTransportFailure` for why the error code is the seam.
        if (isTransportFailure(result.errors)) {
          return reply.code(502).send({ errors: result.errors });
        }
        return reply.code(422).send({ errors: result.errors });
      }
      return reply.send({ findings: result.value });
    } catch (cause) {
      // Reachable only for what `critiqueImage` does not itself convert to a
      // `ValidationResult` -- an abort, or a genuinely unexpected throw. The
      // provider's own message can name a deployment, and this response goes
      // to a browser.
      if (cause instanceof LLMProviderError) return reply.code(502).send({ errors: [cause.error] });
      app.log.error({ err: cause }, "vision critique failed");
      return reply.code(502).send({ reason: "The critique model could not be reached." });
    }
  });
}
