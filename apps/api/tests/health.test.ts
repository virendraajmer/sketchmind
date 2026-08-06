import { describe, it, expect } from "vitest";
import { testServer } from "./support.js";

describe("api health endpoint", () => {
  it("returns ok", async () => {
    const { app } = await testServer();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
    await app.close();
  });
});
