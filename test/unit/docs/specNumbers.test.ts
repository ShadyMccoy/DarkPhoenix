import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

/**
 * SPEC NUMBERS ARE UNIQUE, and every link to one resolves.
 *
 * Code cites specs by BARE NUMBER - `// spec 39 phase 4`, `(spec 46 phase A)` -
 * with no link. That is fine while a number names one document and silently
 * corrosive the moment it names two: every such comment becomes ambiguous at
 * once, and nothing fails.
 *
 * It had happened three times before this test existed (31, 46, and 45/47 from
 * a session that took two numbers already in use), and each collision was found
 * by a human reading a comment and noticing it pointed at the wrong spec. That
 * is not a detection mechanism.
 *
 * The convention this pins, when a collision does have to be resolved: the
 * document that CODE cites by bare number keeps the number, because those
 * citations are the fragile ones. Prose links carry an explicit filename and
 * disambiguate themselves, so they are the cheap side to move.
 */
const SPECS = path.join(__dirname, "..", "..", "..", "docs", "specs");
const DOCS = path.join(__dirname, "..", "..", "..", "docs");

function specFiles(): string[] {
  return fs.readdirSync(SPECS).filter(f => /^\d+-.*\.md$/.test(f));
}

describe("docs/specs: numbering", () => {
  it("no two specs share a number", () => {
    const byNumber = new Map<string, string[]>();
    for (const f of specFiles()) {
      const n = f.match(/^(\d+)-/)![1];
      byNumber.set(n, [...(byNumber.get(n) ?? []), f]);
    }
    const collisions = [...byNumber.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([n, files]) => `${n}: ${files.join(" + ")}`);
    expect(
      collisions,
      `two specs share a number, so every bare "spec N" citation in the code is now ambiguous:\n${collisions.join(
        "\n"
      )}`
    ).to.deep.equal([]);
  });

  it("every specs/NN-... link in docs/ resolves to a file that exists", () => {
    // A renumber that misses a link leaves a dead pointer, which reads as a
    // missing spec rather than a moved one.
    const broken: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
        } else if (entry.name.endsWith(".md")) {
          const body = fs.readFileSync(p, "utf8");
          const re = /\]\((?:specs\/)?(\d+-[a-z0-9-]+\.md)\)/gi;
          let m: RegExpExecArray | null;
          while ((m = re.exec(body)) !== null) {
            if (!fs.existsSync(path.join(SPECS, m[1]))) {
              broken.push(`${path.relative(DOCS, p)} -> ${m[1]}`);
            }
          }
        }
      }
    };
    walk(DOCS);
    expect(broken, `dead spec links:\n${broken.join("\n")}`).to.deep.equal([]);
  });

  it("finds the specs at all - the test is not vacuously green", () => {
    // Both assertions above pass trivially on an empty list; the roster is the
    // thing that makes them mean something.
    expect(specFiles().length).to.be.greaterThan(30);
  });
});
