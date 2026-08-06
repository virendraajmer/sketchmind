/**
 * Tier 1: run every enabled check and return one sorted list.
 *
 * Sorting is not cosmetic. The round cap compares this round's findings against
 * the last round's, and an unordered list would make an unchanged diagram look
 * different every time -- which would defeat the one mechanism that stops the
 * repair loop oscillating.
 */
import type {
  CritiqueFinding,
  DiagramAST,
  LayoutModel,
  StrokeAST,
} from "@sketchmind/shared-types";
import { CHECKS, DEFAULT_OPTIONS, type GeometricCritiqueOptions } from "./checks.js";

export interface CritiqueGeometryInput {
  readonly ast: DiagramAST;
  readonly layout: LayoutModel;
  readonly strokes?: StrokeAST;
  readonly options?: GeometricCritiqueOptions;
}

export function critiqueGeometry(input: CritiqueGeometryInput): CritiqueFinding[] {
  const options = {
    ...DEFAULT_OPTIONS,
    ...input.options,
    checks: { ...DEFAULT_OPTIONS.checks, ...input.options?.checks },
  };

  const checkInput = {
    ast: input.ast,
    layout: input.layout,
    options,
    ...(input.strokes ? { strokes: input.strokes } : {}),
  };

  const findings = CHECKS.filter((check) => options.checks[check.name]).flatMap((check) =>
    check.run(checkInput),
  );

  return findings.sort((a, b) =>
    a.check === b.check ? a.id.localeCompare(b.id) : a.check.localeCompare(b.check),
  );
}
