
# SketchMind
# Volume 06 – Stroke Engine & Human Drawing Simulation

**Version:** 1.0
**Audience:** AI Coding Agents

---

# Purpose

Define how SketchMind converts a geometric layout into a natural, human-like drawing sequence.

The Stroke Engine is responsible for **how** a diagram is drawn, not **what** is drawn.

---

# Design Goals

- Draw like a teacher
- Deterministic output
- Stroke-by-stroke animation
- Replayable drawings
- Renderer independent
- Extensible stroke behaviors

---

# Pipeline

Layout Model

↓

Stroke Planner

↓

Stroke AST

↓

Stroke Optimizer

↓

Stroke Runtime

↓

Renderer

---

# Responsibilities

## Stroke Planner

Convert the Layout Model into a logical drawing sequence.

Examples:

House

1. Ground
2. Walls
3. Roof
4. Door
5. Windows
6. Labels

Pulley

1. Ceiling
2. Fixed Pulley
3. Movable Pulley
4. Rope
5. Load
6. Force Arrow

Never generate pixels.

---

## Stroke AST

The canonical representation of a drawing sequence.

Each stroke contains:

- id
- type
- target object
- order
- dependencies
- style
- timing
- metadata

No renderer-specific commands.

---

## Stroke Types

Support semantic stroke types:

- Line
- Curve
- Arc
- Circle
- Ellipse
- Rectangle
- Polygon
- Freehand
- Arrow
- Text
- Hatch
- Erase

Architecture must allow custom stroke types.

---

## Stroke Optimizer

Responsibilities:

- Merge compatible strokes
- Remove redundant strokes
- Preserve natural drawing order
- Improve playback performance

Must never change semantic meaning.

---

## Human Drawing Rules

The engine should imitate a teacher.

Guidelines:

- Draw large outlines first.
- Add details afterwards.
- Add labels last.
- Draw connected objects continuously.
- Avoid unnatural pen jumps.
- Keep stroke order predictable.

---

## Pen Simulation

Support configurable pen behavior:

- Stroke width
- Pressure profile
- Drawing speed
- Start/end taper
- Hand jitter
- Ink style

The renderer decides visual appearance.

---

## Stroke Timing

Each stroke supports:

- delay
- duration
- playback speed
- pause
- dependency

Supports accelerated and real-time playback.

---

## Stroke Runtime

Responsibilities:

- Play
- Pause
- Resume
- Seek
- Replay
- Undo
- Redo
- Cancel

Maintain execution state independently from rendering.

---

## Incremental Rendering

The runtime should support:

- Partial rendering
- Live drawing
- Progressive updates
- Streaming strokes

Useful for AI-generated diagrams.

---

## Editing

Support editing after playback.

Operations:

- Insert stroke
- Delete stroke
- Move stroke
- Replace stroke
- Reorder stroke

Updates should remain deterministic.

---

## Export

Support exporting:

- Stroke AST
- Replay timeline
- SVG
- Canvas snapshot
- PDF

Export should not modify the internal model.

---

## Extensibility

Allow plugins for:

- Custom pens
- Stroke generators
- Animation styles
- Playback strategies
- Exporters

---

# Deliverables for AI Coding Agent

Design:

1. Stroke AST schema
2. Stroke planner interfaces
3. Stroke optimizer
4. Playback runtime
5. Timeline model
6. Pen abstraction
7. Editing API
8. Export API
9. Test strategy

Implementation should remain renderer independent.

---

# Final Principle

The Layout Model decides **where** objects exist.

The Stroke Engine decides **how a human would draw them**.

The renderer only converts strokes into pixels.
