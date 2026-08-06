/**
 * The composition root's one look at the environment.
 *
 * Everything below this file takes its configuration as a constructor argument
 * and never asks where it came from -- that is what makes the packages
 * independently testable, and it is why `configs/` says no package reads
 * `process.env`. An app is not a package: something has to read the environment
 * once, and doing it here means the reading is visible in one place rather than
 * scattered through route handlers.
 *
 * The `AZURE_OPENAI_*` variables are conspicuously absent. Those belong to
 * `llm-provider-azure-openai`, which receives the whole env bag through the
 * provider registry and is the only code allowed to interpret them.
 */
export type VisionMode = "off" | "auto" | "on";

/**
 * `off` never runs the image tier. `auto` runs it exactly when a vision-capable
 * provider resolves -- which is the answer to "later we may find a model that
 * can do this": point a role at it and the tier turns itself on. `on` requires
 * it, so a deployment that depends on critique fails loudly at boot instead of
 * degrading in silence.
 */
export interface VisionConfig {
  readonly geometric: boolean;
  readonly mode: VisionMode;
  readonly maxRounds: number;
  readonly maxImageBytes: number;
}

export interface RepairConfig {
  readonly maxRounds: number;
  readonly maxSteps: number;
}

export interface ApiConfig {
  readonly port: number;
  /**
   * Where learned primitives persist between sessions (AD-7). A path rather
   * than a store so tests can point it at a temp directory.
   */
  readonly memoryPath: string;
  /** Origin allowed to open an SSE stream. The Next.js dev server, locally. */
  readonly webOrigin: string;
  readonly agentBudget: {
    readonly maxSteps: number;
    readonly maxTokens: number;
    readonly timeoutMs: number;
  };
  /**
   * How often playback advances, in milliseconds. Each tick is one SSE frame,
   * so this is a bandwidth/smoothness trade, not a drawing-speed control --
   * stroke durations live in the Stroke AST.
   */
  readonly tickMs: number;
  readonly vision: VisionConfig;
  readonly repair: RepairConfig;
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return fallback;
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

function visionMode(value: string | undefined): VisionMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === "on" || normalized === "auto" ? normalized : "off";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: int(env["PORT"], 3001),
    memoryPath: env["SKETCHMIND_MEMORY_PATH"] ?? ".data/memory.json",
    webOrigin: env["SKETCHMIND_WEB_ORIGIN"] ?? "http://localhost:3000",
    agentBudget: {
      maxSteps: int(env["SKETCHMIND_AGENT_MAX_STEPS"], 40),
      maxTokens: int(env["SKETCHMIND_AGENT_MAX_TOKENS"], 200_000),
      timeoutMs: int(env["SKETCHMIND_AGENT_TIMEOUT_MS"], 180_000),
    },
    tickMs: int(env["SKETCHMIND_TICK_MS"], 50),
    vision: {
      geometric: bool(env["SKETCHMIND_GEOMETRIC_CRITIQUE"], true),
      mode: visionMode(env["SKETCHMIND_VISION_MODE"]),
      maxRounds: int(env["SKETCHMIND_VISION_MAX_ROUNDS"], 2),
      maxImageBytes: int(env["SKETCHMIND_VISION_MAX_IMAGE_BYTES"], 4_000_000),
    },
    repair: {
      maxRounds: int(env["SKETCHMIND_REPAIR_MAX_ROUNDS"], 2),
      maxSteps: int(env["SKETCHMIND_REPAIR_MAX_STEPS"], 12),
    },
  };
}
