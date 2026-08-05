import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Page from "../app/page";

describe("web home page", () => {
  it("renders the app title", () => {
    render(<Page />);
    expect(screen.getByText("SketchMind")).toBeTruthy();
  });
});
