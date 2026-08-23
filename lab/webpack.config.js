// The graph lab's bundle: the REAL engine modules (src/engine, src/corps,
// src/sizing, src/primitives) compiled for the browser with a thin GUI on
// top. No server, no framework — a static page (REBOOT.md lab tech ruling).
const path = require("path");

module.exports = {
  context: path.resolve(__dirname, ".."),
  entry: "./lab/src/main.ts",
  output: {
    filename: "lab.js",
    path: path.resolve(__dirname, "dist")
  },
  resolve: {
    extensions: [".ts", ".js"]
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: "ts-loader",
          options: {
            transpileOnly: true,
            configFile: path.resolve(__dirname, "tsconfig.json")
          }
        },
        exclude: /node_modules/
      }
    ]
  },
  devtool: "source-map",
  mode: "development"
};
