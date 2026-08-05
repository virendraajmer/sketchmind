
# SketchMind
# Volume 05 – Constraint Engine & Layout Solver

**Version:** 1.0
**Audience:** AI Coding Agents

---

# Purpose

This document defines how SketchMind transforms semantic relationships into spatial layouts.

The Constraint Engine computes **where objects belong**.

The AI never generates coordinates.

---

# Design Goals

- Coordinate-free AI
- Deterministic layouts
- Relative positioning
- Automatic alignment
- Collision avoidance
- Extensible layout rules

---

# Pipeline

Diagram AST

↓

Constraint Graph

↓

Layout Solver

↓

Layout Model

↓

Stroke Planner

---

# Constraint Engine Responsibilities

Generate layout constraints from Diagram AST.

Examples:

- above
- below
- inside
- outside
- attachedTo
- connectedTo
- wrapsAround
- centeredOn
- alignedWith
- parallelTo
- perpendicularTo

No geometry is calculated here.

---

# Constraint Graph

The Constraint Graph is a graph of spatial relationships.

Nodes:
- Objects

Edges:
- Constraints

Example:

Ceiling

↓

attachedTo

↓

Pulley

↓

wrapsAround

↓

Rope

↓

connectedTo

↓

Load

---

# Constraint Types

Support at minimum:

- Position
- Alignment
- Containment
- Connectivity
- Distribution
- Rotation
- Orientation
- Spacing
- Scaling
- Visibility

Architecture must allow custom constraints.

---

# Layout Solver Responsibilities

Input:

Constraint Graph

Output:

Layout Model

The solver computes:

- Position
- Size
- Rotation
- Bounding box
- Connection points

---

# Layout Rules

Rules should include:

- Center objects automatically
- Prevent overlaps
- Maintain minimum spacing
- Preserve hierarchy
- Preserve reading order
- Optimize whitespace

---

# Layout Strategies

Support multiple strategies:

- Hierarchical
- Tree
- Radial
- Flow
- Circular
- Grid
- Force-directed
- Manual override

Strategy selected by diagram type.

---

# Object Positioning

Objects should never define coordinates.

Instead they define relationships.

Example:

Window

inside

Wall

Roof

above

Wall

Door

centeredOn

Wall

Solver computes positions.

---

# Connector Routing

Support automatic routing.

Examples:

- Straight
- Orthogonal
- Curved
- Smart avoidance

Connectors should avoid overlapping objects.

---

# Label Placement

Automatically position labels.

Rules:

- Avoid overlaps
- Stay near target object
- Maintain readability
- Support multiple languages

---

# Collision Detection

Detect:

- Object overlap
- Label overlap
- Connector overlap

Automatically resolve conflicts.

---

# Layout Model

The Layout Model contains:

- Coordinates
- Dimensions
- Rotation
- Bounding boxes
- Connector paths

Only this model contains geometry.

---

# Validation

Validate:

- No overlaps
- Valid bounds
- Connected graph
- Visible labels
- Stable layout

---

# Extensibility

Allow plugins to register:

- Custom constraints
- Custom layout algorithms
- Custom routing
- Custom placement rules

Core engine must remain unchanged.

---

# Deliverables for AI Coding Agent

Design:

1. Constraint model
2. Constraint graph
3. Layout interfaces
4. Solver architecture
5. Routing engine
6. Collision detection
7. Label engine
8. Plugin interfaces
9. Test strategy

Implementation should be deterministic.

---

# Final Principle

AI decides relationships.

The Constraint Engine decides placement.

The renderer only draws.
