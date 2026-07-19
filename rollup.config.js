"use strict";

import clear from 'rollup-plugin-clear';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';
import screeps from 'rollup-plugin-screeps';

let cfg;
const dest = process.env.DEST;
if (!dest) {
  console.log("No destination specified - code will be compiled but not uploaded");
} else if ((cfg = require("./screeps.json")[dest]) == null) {
  throw new Error("Invalid upload destination");
}

export default {
  input: "src/main.ts",
  output: {
    file: "dist/main.js",
    format: "cjs",
    sourcemap: true
  },

  plugins: [
    clear({ targets: ["dist"] }),
    resolve({ rootDir: "src" }),
    commonjs(),
    // Plain globs, not rpt2's extglob defaults (*.ts+(|x)): some picomatch
    // builds reject extglobs with an empty alternative, silently excluding
    // every file and breaking the bundle at "Unexpected token: declare".
    typescript({
      tsconfig: "./tsconfig.json",
      include: ["*.ts", "**/*.ts", "*.tsx", "**/*.tsx"],
      exclude: ["*.d.ts", "**/*.d.ts"]
    }),
    screeps({config: cfg, dryRun: cfg == null})
  ]
}
