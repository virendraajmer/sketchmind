
# SketchMind
# Volume 14 – Shape Graph & Constraint Grammar

**Version:** 1.0
**Audience:** AI Coding Agents

---

# Purpose

Define the Shape Graph and Constraint Grammar used by SketchMind to represent technical objects before layout generation.

The Shape Graph is the semantic bridge between the Visual Intent Language (VIL) and the Diagram AST.

---

# Design Goals

- Semantic representation
- No geometry
- Reusable structures
- Domain independent
- Deterministic
- Extensible

---

# Pipeline

Visual Intent Language (VIL)

↓

Shape Graph

↓

Constraint Grammar

↓

Diagram AST

↓

Constraint Engine

---

# Shape Graph

A Shape Graph represents a technical object as a network of semantic nodes.

Nodes describe objects.

Edges describe relationships.

The graph never stores coordinates.

---

# Graph Components

Node

Represents:

- Object
- Component
- Label
- Connector
- Annotation

Edge

Represents:

- ConnectedTo
- AttachedTo
- Wraps
- Supports
- Contains
- Above
- Below
- LeftOf
- RightOf

---

# Node Definition

Every node contains:

- id
- type
- category
- role
- metadata
- behaviors
- anchors
- constraints

No rendering information.

---

# Constraint Grammar

Constraint Grammar defines spatial intent.

Supported constraints:

- Above
- Below
- LeftOf
- RightOf
- Inside
- Outside
- ConnectedTo
- AttachedTo
- WrapAround
- ParallelTo
- PerpendicularTo
- CenteredOn
- AlignedWith
- EqualSpacing
- MirrorOf

Plugins may register new constraint types.

---

# Composite Shapes

Complex objects are built by composition.

Example:

House

Components

- Roof
- Walls
- Door
- Window

Relationships

- Roof Above Walls
- Door Inside Walls
- Window Inside Walls

No coordinates.

---

# Repeating Structures

Support repeated elements.

Examples:

- Gear Teeth
- DNA Base Pairs
- Chain Links
- Fence Posts
- Tree Branches

Repeat rules belong to the Shape Graph, not the renderer.

---

# Symmetry Rules

Support:

- Horizontal symmetry
- Vertical symmetry
- Radial symmetry
- Rotational symmetry

The layout engine resolves final placement.

---

# Parametric Shapes

Allow parameters.

Examples:

Gear

- Teeth Count
- Radius

Battery

- Terminal Count
- Orientation

Tree

- Height
- Branch Density

Parameters influence semantics, not rendering.

---

# Inheritance

Shape definitions may inherit from existing shapes.

Example:

Mechanical Pulley

inherits

Pulley

adds

- Bearings
- Housing

---

# Validation

Validate:

- Connected graph
- Valid constraints
- No cycles where prohibited
- Required nodes
- Required anchors
- Schema compatibility

---

# Extensibility

Allow plugins to register:

- New node types
- New constraint types
- New composite builders
- New symmetry rules
- New parameter definitions

---

# Deliverables for AI Coding Agent

Design:

1. Shape Graph schema
2. Constraint Grammar schema
3. Graph builder
4. Graph validator
5. Composite shape framework
6. Parametric shape framework
7. Inheritance model
8. Plugin interfaces
9. Test strategy

Do not generate geometry from this layer.

---

# Final Principle

The Shape Graph describes **what a technical object is made of**.

The Constraint Grammar describes **how those parts relate**.

Only the Layout Engine converts those relationships into geometry.
