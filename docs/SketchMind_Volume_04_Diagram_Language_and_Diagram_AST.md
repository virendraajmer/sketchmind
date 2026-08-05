
# SketchMind
# Volume 04 – Diagram Language & Diagram AST

**Version:** 1.0
**Audience:** AI Coding Agents

---

# Purpose

Define the canonical diagram representation used throughout SketchMind.

Every AI agent, compiler, layout engine and renderer communicates through the Diagram AST.

The Diagram AST is the single source of truth.

---

# Design Goals

- Renderer independent
- Human readable
- Machine friendly
- Deterministic
- Extensible
- Versioned

---

# Pipeline

Natural Language

↓

Diagram AST

↓

Constraint Model

↓

Layout Model

↓

Stroke AST

↓

Renderer

---

# Diagram AST Responsibilities

The AST describes:

- What objects exist
- How they relate
- Labels
- Anchors
- Metadata
- Style hints

The AST never contains:

- Coordinates
- SVG
- Canvas commands
- Konva commands
- Drawing instructions

---

# Root Structure

Every diagram contains:

- id
- version
- subject
- title
- objects
- relationships
- groups
- annotations
- metadata

---

# Object Model

Every object should define:

- id
- type
- name
- category
- properties
- anchors
- behaviors
- labels
- children

Objects should be semantic.

Examples:

- Pulley
- Rope
- Gear
- House
- Tree
- Battery
- Neuron
- Atom

---

# Relationships

Supported relationships include:

- connectedTo
- inside
- above
- below
- leftOf
- rightOf
- wraps
- attachedTo
- intersects
- parallelTo
- centeredOn
- alignedWith

Relationships describe intent, not geometry.

---

# Anchors

Objects expose named anchors.

Examples

Pulley

- center
- axle
- rim

House

- roof
- door
- window

Cell

- nucleus
- membrane
- mitochondria

Anchors enable highlighting, labeling and interaction.

---

# Behaviors

Objects may expose behaviors.

Examples:

Pulley

- rotate
- highlight

Door

- open
- close

Circuit

- energize

Tree

- grow

Behaviors are semantic operations.

---

# Metadata

Metadata may include:

- subject
- grade
- difficulty
- source
- tags
- accessibility
- language

---

# Versioning

Diagram AST must support:

- backward compatibility
- schema evolution
- feature detection

---

# Validation Rules

Every AST must be validated.

Checks:

- unique ids
- valid object types
- valid relationships
- no orphan objects
- schema version
- required fields

Invalid ASTs must never enter the rendering pipeline.

---

# Extensibility

Allow plugins to register:

- new object types
- new relationships
- new behaviors
- new metadata
- custom validators

Core engine should remain unchanged.

---

# Deliverables for AI Coding Agent

Design:

1. AST schema
2. Validation layer
3. Serialization
4. Parser
5. Builder API
6. Plugin registration
7. Version manager
8. Test strategy

Do not mix geometry into the Diagram AST.

---

# Final Principle

The Diagram AST describes **what exists**.

It never describes **how it is drawn**.
