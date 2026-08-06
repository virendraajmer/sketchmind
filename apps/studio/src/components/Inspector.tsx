import type { DiagramAST, DiagramObject } from "@sketchmind/shared-types";

function ObjectNode({ object }: { object: DiagramObject }): React.JSX.Element {
  return (
    <li>
      <span>{object.name}</span> <span className="text-muted font-mono text-xs">{object.type}</span>
      {object.labels.length > 0 ? (
        <span className="text-muted">“{object.labels.map((label) => label.text).join("”, “")}”</span>
      ) : null}
      {object.children.length > 0 ? (
        <ul className="m-0 pl-[18px]">
          {object.children.map((child) => (
            <ObjectNode key={child.id} object={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function Inspector({ ast }: { ast?: DiagramAST }): React.JSX.Element {
  if (!ast) return <p className="m-0 text-muted">No diagram yet.</p>;

  return (
    <div>
      <h3 className="m-0 text-[15px] font-bold">{ast.title}</h3>
      <p className="mt-[2px] mb-[10px] text-muted">
        {ast.subject} · {ast.category}
      </p>

      <ul className="m-0 pl-[18px]">
        {ast.objects.map((object) => (
          <ObjectNode key={object.id} object={object} />
        ))}
      </ul>

      {ast.relationships.length > 0 ? (
        <ul className="mt-[10px] mb-0 pl-[18px] text-muted">
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
