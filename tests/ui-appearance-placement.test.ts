import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("native appearance menu placement", () => {
  it("mounts Appearance in product and live headers instead of a fixed global overlay", () => {
    const main = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/main.tsx"),
      "utf8"
    );
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );
    const frame = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/ProductFrame.tsx"),
      "utf8"
    );
    const css = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/AppearanceDock.css"),
      "utf8"
    );

    expect(main).not.toContain("<AppearanceDock");
    expect(app).toContain("<AppearanceDock compact");
    expect(frame).toContain("<AppearanceDock />");
    expect(css).toContain("position: relative");
    expect(css).not.toContain("position: fixed");
  });
});
