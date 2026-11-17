import { Fragment, type ReactNode } from "react";

/** Renders the initials so "AJ" cannot be restyled into "Aj". */
export function AjName() {
  return <span className="aj-name">AJ</span>;
}

/** Split a plain string on the initials and protect each one. */
export function formatInitials(text: string): ReactNode {
  const parts = text.split("AJ");
  if (parts.length === 1) return text;
  return parts.map((part, index) => (
    <Fragment key={index}>
      {index > 0 ? <AjName /> : null}
      {part}
    </Fragment>
  ));
}
