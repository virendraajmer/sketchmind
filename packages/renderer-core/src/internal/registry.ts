/**
 * The renderer registry (Volume 08 §Renderer Registry): register backends,
 * discover capabilities, select one, resolve compatibility.
 *
 * The point of the registry is that `apps/web` asks for *a renderer that can do
 * X* rather than importing `renderer-konva`. Selecting by capability is what makes
 * Phase 12's plugin backends a registration rather than a code change, and it is
 * the same discipline the LLM provider abstraction applies one layer down.
 */
import { fail, ok, type ValidationResult } from "@sketchmind/shared-types";
import type { RendererCapabilities, RendererFactory } from "./adapter.js";
import { renderError } from "./errors.js";

/** What a caller needs; every stated field must be satisfied. */
export type RendererRequirements = Partial<Omit<RendererCapabilities, "id" | "exportFormats">> & {
  readonly id?: string;
  readonly exportFormats?: readonly RendererCapabilities["exportFormats"][number][];
};

export class RendererRegistry {
  readonly #factories = new Map<string, RendererFactory>();

  register(factory: RendererFactory): ValidationResult<void> {
    const id = factory.capabilities.id;
    if (this.#factories.has(id)) {
      return fail([
        renderError("RENDER_DUPLICATE_ADAPTER", `A renderer with id "${id}" is already registered.`, {
          details: { id },
        }),
      ]);
    }
    this.#factories.set(id, factory);
    return ok(undefined);
  }

  /** Replace an existing registration. Separate from `register` so a typo cannot silently win. */
  replace(factory: RendererFactory): void {
    this.#factories.set(factory.capabilities.id, factory);
  }

  unregister(id: string): boolean {
    return this.#factories.delete(id);
  }

  list(): readonly RendererCapabilities[] {
    return [...this.#factories.values()].map((factory) => factory.capabilities);
  }

  get(id: string): ValidationResult<RendererFactory> {
    const factory = this.#factories.get(id);
    if (!factory) {
      return fail([
        renderError("RENDER_ADAPTER_NOT_REGISTERED", `No renderer registered as "${id}".`, {
          details: { requested: id, registered: [...this.#factories.keys()] },
        }),
      ]);
    }
    return ok(factory);
  }

  /**
   * First registered backend meeting every stated requirement.
   *
   * Registration order is the preference order -- explicit, and cheaper to reason
   * about than a scoring function whose winner nobody can predict.
   */
  select(requirements: RendererRequirements = {}): ValidationResult<RendererFactory> {
    for (const factory of this.#factories.values()) {
      if (satisfies(factory.capabilities, requirements)) return ok(factory);
    }
    return fail([
      renderError(
        "RENDER_NO_COMPATIBLE_RENDERER",
        "No registered renderer satisfies the requested capabilities.",
        { details: { requirements, registered: this.list() } },
      ),
    ]);
  }
}

function satisfies(
  capabilities: RendererCapabilities,
  requirements: RendererRequirements,
): boolean {
  if (requirements.id !== undefined && capabilities.id !== requirements.id) return false;
  for (const flag of ["raster", "vector", "interactive", "captureImage"] as const) {
    if (requirements[flag] === true && !capabilities[flag]) return false;
  }
  for (const format of requirements.exportFormats ?? []) {
    if (!capabilities.exportFormats.includes(format)) return false;
  }
  return true;
}

/**
 * The process-wide registry. A module-level singleton is right here for the same
 * reason it is wrong for configuration: registration is a fact about which code
 * is loaded, not about which request is being served.
 */
export const rendererRegistry = new RendererRegistry();
