/**
 * Live sessions, and the events they have emitted.
 *
 * Two things here are not obvious from the route handlers.
 *
 * **Events are buffered, not just fanned out.** Starting a session and opening
 * its stream are two separate HTTP requests, and the agent begins working
 * immediately. A client that connects a beat later would otherwise miss
 * `SessionStarted` and possibly the first few steps -- reliably, on a fast
 * machine, which is the worst kind of bug. So every event is retained and
 * replayed to each new subscriber.
 *
 * **One AbortController per session is the whole cancellation story.** It is
 * handed to `runAgent` (which threads it into the provider call and every
 * `ToolContext`) and checked by the playback loop. `cancel()` therefore stops an
 * in-flight model turn and an in-progress drawing with one call, and there is no
 * second flag that can disagree with it.
 */
import type { ToolRegistry } from "@sketchmind/agent-core";
import type { Message } from "@sketchmind/llm-provider";
import type { RuntimeEvent } from "@sketchmind/session-protocol";
import type { CritiqueFinding, DiagramAST, StrokeAST } from "@sketchmind/shared-types";

export type SessionListener = (event: RuntimeEvent) => void;

export interface SessionRecord {
  readonly sessionId: string;
  readonly controller: AbortController;
  /** Every event so far, replayed to each new subscriber. */
  readonly events: RuntimeEvent[];
  readonly listeners: Set<SessionListener>;
  /**
   * Set once a terminal event has been emitted: the session's own *run* is
   * over. It does not mean no further events -- a repair turn started from
   * `POST /findings` emits after it -- only that the run will not be cancelled
   * or completed a second time.
   */
  finished: boolean;
  /** The user's original words, needed to judge the image against the ask. */
  request: string;
  /** Ids and counts for the critique prompt. Never coordinates. */
  layoutSummary: string;
  /** Critique rounds spent. Capped by `config.vision.maxRounds`. */
  visionRounds: number;
  /** Repair turns spent. Capped by `config.repair.maxRounds`. */
  repairRounds: number;
  /** Last round's findings, so an unchanged verdict does not re-trigger repair. */
  lastFindings: CritiqueFinding[];
  /** Set once the run's registry exists, so a later repair turn can reuse it. */
  registry?: ToolRegistry;
  /**
   * Paired with `registry`, set at the same time: how a repair turn reads the
   * live AST and stroke plan, whether it was triggered automatically or from
   * `POST /findings` long after `runSession` itself has returned.
   */
  getAst?: () => DiagramAST | undefined;
  getStrokes?: () => StrokeAST | undefined;
  /**
   * The conversation so far. A repair turn passes this as `history` so it is a
   * follow-up on the same run instead of a stranger with no memory of the
   * original request or of what it already tried.
   */
  history: Message[];
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();

  create(sessionId: string, request = ""): SessionRecord {
    const record: SessionRecord = {
      sessionId,
      controller: new AbortController(),
      events: [],
      listeners: new Set(),
      finished: false,
      request,
      layoutSummary: "",
      visionRounds: 0,
      repairRounds: 0,
      lastFindings: [],
      history: [],
    };
    this.sessions.set(sessionId, record);
    return record;
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  emit(sessionId: string, event: RuntimeEvent): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;

    record.events.push(event);
    if (TERMINAL.has(event.type)) record.finished = true;

    for (const listener of record.listeners) {
      // One subscriber whose socket died must not stop the others being told.
      try {
        listener(event);
      } catch {
        record.listeners.delete(listener);
      }
    }
  }

  /**
   * Replays what has already happened, then follows. Returns an unsubscribe.
   *
   * A finished session is subscribed to like any other. `finished` used to short
   * out here, on the reasoning that a terminal event meant no more events could
   * follow -- which stopped being true when `POST /api/sessions/:id/findings`
   * made a repair turn startable long after `runSession` returned. Its events
   * (`VisionCritique`, `AgentStep`, `DiagramASTReady`) are emitted through this
   * same fan-out, so a subscriber that skipped the live listener would see the
   * replay and then silence.
   */
  subscribe(sessionId: string, listener: SessionListener): () => void {
    const record = this.sessions.get(sessionId);
    if (!record) return () => {};

    for (const event of record.events) listener(event);

    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  cancel(sessionId: string, _reason?: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record || record.finished) return false;
    record.controller.abort();
    return true;
  }

  /**
   * Drop a finished session's retained events.
   *
   * Not called on a timer. A session ends when the browser closes its stream,
   * and Phase 9 has no session store to reconcile against -- so this exists for
   * tests and for the shutdown path, and a long-lived deployment gets a real
   * eviction policy when `ai-orchestrator` takes over session lifecycle.
   */
  delete(sessionId: string): void {
    this.sessions.get(sessionId)?.listeners.clear();
    this.sessions.delete(sessionId);
  }

  /** Aborts every live run. The server's shutdown hook calls this. */
  cancelAll(): void {
    for (const record of this.sessions.values()) {
      if (!record.finished) record.controller.abort();
    }
  }
}

const TERMINAL = new Set<RuntimeEvent["type"]>([
  "SessionCompleted",
  "SessionFailed",
  "SessionCancelled",
]);
