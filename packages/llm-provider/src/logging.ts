/**
 * Provider logging (D-7).
 *
 * Prompts contain what the user asked us to draw, and structured outputs
 * contain the diagram itself. Neither is ours to write to a log aggregator. So
 * providers log request *shape* -- counts, sizes, model, latency, status -- and
 * the payload never appears at any level, not just not at info.
 *
 * `describeRequest` is the only thing adapters are meant to log about a call.
 * A test asserts a canary string present in a prompt appears in no log call.
 */
export interface LogFields {
  readonly [key: string]: string | number | boolean | undefined;
}

export interface ProviderLogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const noopLogger: ProviderLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface DescribableRequest {
  readonly system?: string;
  readonly messages: readonly { readonly content: string }[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

/** Shape only. If you find yourself wanting to add the text here, don't. */
export function describeRequest(req: DescribableRequest): LogFields {
  const promptChars =
    (req.system?.length ?? 0) + req.messages.reduce((sum, m) => sum + m.content.length, 0);
  return {
    messageCount: req.messages.length,
    hasSystemPrompt: req.system !== undefined && req.system.length > 0,
    promptChars,
    maxOutputTokens: req.maxOutputTokens,
    temperature: req.temperature,
  };
}
