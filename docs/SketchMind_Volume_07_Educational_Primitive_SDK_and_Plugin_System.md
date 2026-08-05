
# SketchMind
# Volume 07 – Educational Primitive SDK & Plugin System

**Version:** 1.0
**Audience:** AI Coding Agents

---

# Purpose

Define how SketchMind represents reusable educational objects and how third-party developers can extend the platform without modifying the core engine.

The Primitive SDK is the extensibility foundation of SketchMind.

---

# Design Goals

- Reusable primitives
- Domain independent
- Plugin based
- Versioned
- Renderer independent
- AI discoverable

---

# Primitive Lifecycle

Author

↓

Primitive Package

↓

Validation

↓

Registration

↓

Primitive Registry

↓

Runtime Loading

↓

Diagram Generation

---

# Primitive Definition

A primitive represents a semantic educational object.

Examples:

- House
- Tree
- Pulley
- Gear
- Atom
- DNA
- Animal Cell
- Battery
- Binary Tree

Primitives describe concepts, not pixels.

---

# Primitive Package

Each package should contain:

- manifest
- metadata
- schema
- anchors
- behaviors
- constraints
- stroke templates
- examples
- documentation

---

# Manifest

Every primitive manifest should define:

- id
- name
- version
- category
- author
- license
- dependencies
- supported renderers
- supported behaviors

---

# Anchors

Named interaction points.

Examples:

Pulley

- center
- axle
- ropeEntry
- ropeExit

House

- roof
- wall
- door
- window

Anchors enable:

- highlight
- label
- connect
- animate

---

# Behaviors

Examples:

Pulley

- rotate
- attachRope

Door

- open
- close

Battery

- energize

Tree

- grow

Behaviors are semantic operations.

---

# Constraints

Primitives expose layout constraints.

Examples:

Roof above Wall

Door inside Wall

Rope wraps Pulley

AI never defines geometry.

---

# Stroke Templates

Optional reusable drawing strategy.

Contains:

- preferred stroke order
- grouping
- animation hints

Runtime may override if required.

---

# Primitive Registry

Responsibilities:

- Register primitives
- Resolve versions
- Discover capabilities
- Validate dependencies
- Load packages

---

# Plugin System

Support plugins for:

- Subject packs
- Primitive packs
- Renderers
- Layout strategies
- Stroke generators
- Exporters

Plugins should communicate only through public interfaces.

---

# Subject Packs

Examples:

- Mathematics
- Physics
- Chemistry
- Biology
- Engineering
- Geography
- Computer Science

Each subject provides additional primitives.

---

# Versioning

Support:

- semantic versioning
- backward compatibility
- deprecation
- migration

---

# Validation

Validate:

- manifest
- schema
- anchors
- behaviors
- constraints
- examples

Invalid primitives must not load.

---

# Runtime Loading

Support:

- lazy loading
- caching
- hot reload
- dependency resolution

---

# Deliverables for AI Coding Agent

Design:

1. Primitive SDK
2. Package specification
3. Manifest schema
4. Registry architecture
5. Plugin interfaces
6. Validation pipeline
7. Runtime loader
8. Version manager
9. Example primitive package

Do not couple plugins to renderer implementations.

---

# Final Principle

The core engine should know **how to execute primitives**.

Plugins define **what new educational primitives exist**.
