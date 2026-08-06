"use client";

/**
 * The Diagram AST, as the agent composed it.
 *
 * Shown as a tree of what exists rather than raw JSON: the AST is the semantic
 * model, and "a pulley containing an axle, attached to a load" is what it is
 * supposed to say. There are no coordinates to show here, by construction --
 * this model is not allowed to carry any.
 */
import type { DiagramAST, DiagramObject } from "@sketchmind/shared-types";

function ObjectNode({ object }: { object: DiagramObject }): React.JSX.Element {
  return (
    <li>
      <span className="name">{object.name}</span> <span className="type">{object.type}</span>
      {object.labels.length > 0 ? (
        <span className="labels">“{object.labels.map((label) => label.text).join("”, “")}”</span>
      ) : null}
      {object.children.length > 0 ? (
        <ul>
          {object.children.map((child) => (
            <ObjectNode key={child.id} object={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function Inspector({ ast }: { ast?: DiagramAST }): React.JSX.Element {
  if (!ast) return <p className="empty">No diagram yet.</p>;

  return (
    <div className="inspector">
      <h3>{ast.title}</h3>
      <p className="subject">
        {ast.subject} · {ast.category}
      </p>

      <ul className="objects">
        {ast.objects.map((object) => (
          <ObjectNode key={object.id} object={object} />
        ))}
      </ul>

      {ast.relationships.length > 0 ? (
        <ul className="relationships">
          {ast.relationships.map((relationship) => (
            <li key={relationship.id}>
              {relationship.from} <em>{relationship.type}</em> {relationship.to}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
