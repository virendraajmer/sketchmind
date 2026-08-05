#!/usr/bin/env node
/**
 * Verifies declared Azure capabilities against the live deployment (D-5, Task
 * 10). Run after `pnpm build` so `dist/` reflects the current adapter.
 *
 *   pnpm --filter @sketchmind/llm-provider-azure-openai run probe
 *   # or, from the repo root:
 *   pnpm probe:azure
 *
 * Reads the same env vars as the adapter itself (see .env.example). Prints the
 * measured capabilities and the exact env assignments that would pin them, so
 * the result of one real deployment call becomes committed configuration
 * rather than something guessed from a model name every time the process starts.
 */
import { createAzureOpenAIProvider } from "../dist/index.js";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

let provider;
try {
  provider = createAzureOpenAIProvider(process.env);
} catch (error) {
  fail(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
}

process.stdout.write(`Probing deployment "${provider.model}" at ${new Date().toISOString()}...\n`);

if (typeof provider.probeCapabilities !== "function") {
  fail("This provider build does not expose probeCapabilities().");
}

const measured = await provider.probeCapabilities();

process.stdout.write("\nMeasured capabilities:\n");
process.stdout.write(`  structuredOutput : ${measured.structuredOutput}\n`);
process.stdout.write(`  toolCalling       : ${measured.toolCalling}\n`);

process.stdout.write("\nTo pin these instead of re-probing on every start, set:\n");
process.stdout.write(`  AZURE_OPENAI_STRUCTURED_OUTPUT=${measured.structuredOutput}\n`);
process.stdout.write(`  AZURE_OPENAI_TOOL_CALLING=${measured.toolCalling}\n`);

if (!measured.structuredOutput) {
  process.stdout.write(
    "\nNote: native structured output is unavailable. completeStructured() still returns " +
      "schema-valid values -- it falls back to prompt-injected schema + repair (D-3), " +
      "with mechanism: \"prompt-repair\" in the result.\n",
  );
}
