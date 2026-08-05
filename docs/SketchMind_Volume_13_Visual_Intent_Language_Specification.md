
# SketchMind
# Volume 13 – Visual Intent Language (VIL) Specification

**Version:** 1.0
**Audience:** AI Coding Agents

---

# Purpose

Define the Visual Intent Language (VIL), the structured language produced by AI before Diagram AST generation.

VIL describes **what should be visualized**, never **how it should be rendered**.

It is the contract between AI reasoning and the deterministic SketchMind engine.

---

# Design Goals

- Human readable
- Machine friendly
- Renderer independent
- Deterministic
- Extensible
- Versioned

---

# Pipeline

Natural Language

↓

Intent Model

↓

Visual Intent Language (VIL)

↓

Diagram AST

↓

Constraint Graph

↓

Layout

↓

Stroke AST

↓

Renderer

---

# Responsibilities

VIL must describe:

- Subject
- Teaching objective
- Diagram type
- Objects
- Relationships
- Labels
- Highlights
- Focus order
- Level of detail

VIL never contains:

- Coordinates
- Geometry
- SVG
- Canvas commands
- Rendering instructions

---

# Core Sections

Every VIL document should contain:

- version
- intent
- subject
- context
- objects
- relationships
- annotations
- emphasis
- metadata

---

# Object Definition

Each object defines:

- id
- type
- role
- importance
- labels
- behaviors

Example objects:

- Pulley
- Rope
- Atom
- Cell
- Gear
- Binary Tree

---

# Relationship Model

Relationships describe meaning.

Examples:

- connectedTo
- wraps
- inside
- above
- below
- attachedTo
- pointsTo
- contains

---

# Teaching Intent

VIL should capture instructional purpose.

Examples:

- explain
- compare
- classify
- label
- demonstrate
- animate
- highlight

This helps the Stroke Planner choose an appropriate drawing sequence.

---

# Visual Focus

Objects may define priority:

- primary
- secondary
- supporting

The engine should draw high-priority objects first.

---

# AI Output Rules

The AI must produce:

- Stable identifiers
- Semantic object names
- Explicit relationships
- Teaching intent

The AI must never produce:

- Geometry
- Coordinates
- SVG
- Drawing commands

---

# Validation

Validate:

- Required sections
- Unique ids
- Valid relationships
- Known object types
- Supported intent

Invalid VIL must never continue to Diagram AST generation.

---

# Extensibility

Support plugins for:

- New intent types
- New object categories
- Domain-specific metadata
- Educational annotations

---

# Deliverables for AI Coding Agent

Design:

1. VIL schema
2. Parser
3. Validator
4. Builder API
5. Version manager
6. Conversion pipeline (VIL → Diagram AST)
7. Plugin extension model
8. Test strategy

---

# Final Principle

Natural language is ambiguous.

Visual Intent Language converts ambiguity into a precise semantic specification that every downstream SketchMind component can understand consistently.
