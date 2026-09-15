//@ts-check

"use strict";

const path = require("path");
const fs = require("fs");
const { DefinePlugin, ProvidePlugin } = require("webpack");

// GITHUB_CLIENT_SECRET comes from the environment or a gitignored .env file next to this config.
function readEnv(name) {
  if (process.env[name]) {
    return process.env[name];
  }
  const envFile = path.join(__dirname, ".env");
  if (!fs.existsSync(envFile)) {
    return "";
  }
  const match = fs.readFileSync(envFile, "utf8").match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, "m"));
  return match ? match[1].replace(/^(['"])(.*)\1$/, "$2") : "";
}

/** @type {import('webpack').Configuration} */
const config = {
  target: "webworker",
  mode: "none",
  entry: {
    main: "./src/main.ts",
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
    libraryTarget: "commonjs2",
  },
  devtool: "nosources-source-map",
  externals: {
    vscode: "commonjs vscode",
  },
  plugins: [
    new ProvidePlugin({
      Buffer: ["buffer", "Buffer"],
    }),
    new DefinePlugin({
      __GITHUB_CLIENT_SECRET__: JSON.stringify(readEnv("GITHUB_CLIENT_SECRET")),
      "process.platform": JSON.stringify("web"),
      "process.env": JSON.stringify({}),
    }),
  ],
  resolve: {
    extensions: [".ts", ".js"],
    fallback: {
      path: require.resolve("path-browserify"),
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: "ts-loader", options: { transpileOnly: true } }],
      },
    ],
  },
  performance: {
    hints: false,
  },
};
module.exports = config;
