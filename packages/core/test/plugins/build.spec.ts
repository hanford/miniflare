import { existsSync, promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { BindingsPlugin, BuildError, BuildPlugin } from "@miniflare/core";
import { LogLevel } from "@miniflare/shared";
import {
  NoOpLog,
  TestLog,
  logPluginOptions,
  parsePluginArgv,
  parsePluginWranglerConfig,
  useMiniflare,
  useTmp,
} from "@miniflare/shared-test";
import test from "ava";
import rimraf from "rimraf";
import which from "which";

const rimrafPromise = promisify(rimraf);

test("BuildPlugin: parses options from argv", (t) => {
  let options = parsePluginArgv(BuildPlugin, [
    "--build-command",
    "npm run build",
    "--build-base-path",
    "cwd",
    "--build-watch-path",
    "src1",
    "--build-watch-path",
    "src2",
  ]);
  t.deepEqual(options, {
    buildCommand: "npm run build",
    buildBasePath: "cwd",
    buildWatchPaths: ["src1", "src2"],
  });
  options = parsePluginArgv(BuildPlugin, [
    "-B",
    "yarn build",
    "--build-watch-path",
    "source",
  ]);
  t.deepEqual(options, {
    buildCommand: "yarn build",
    buildWatchPaths: ["source"],
  });
});
test("BuildPlugin: parses options from wrangler config", (t) => {
  let options = parsePluginWranglerConfig(BuildPlugin, {
    build: {
      command: "npm run build",
      cwd: "cwd",
      watch_dir: "source",
    },
  });
  t.deepEqual(options, {
    buildCommand: "npm run build",
    buildBasePath: "cwd",
    buildWatchPaths: ["source"],
  });
  // Check buildWatchPaths defaults to "src" if any command specified
  options = parsePluginWranglerConfig(BuildPlugin, {
    build: { command: "yarn build" },
  });
  t.deepEqual(options, {
    buildCommand: "yarn build",
    buildBasePath: undefined,
    buildWatchPaths: ["src"],
  });
  options = parsePluginWranglerConfig(BuildPlugin, { build: {} });
  t.deepEqual(options, {
    buildCommand: undefined,
    buildBasePath: undefined,
    buildWatchPaths: undefined,
  });
});
test("BuildPlugin: logs options", (t) => {
  const logs = logPluginOptions(BuildPlugin, {
    buildCommand: "npm run build",
    buildBasePath: "cwd",
    buildWatchPaths: ["src1", "src2"],
  });
  t.deepEqual(logs, [
    "Build Command: npm run build",
    "Build Base Path: cwd",
    "Build Watch Paths: src1, src2",
  ]);
});

test("BuildPlugin: beforeSetup: does nothing without build command", async (t) => {
  const log = new NoOpLog();
  const plugin = new BuildPlugin(log);
  t.deepEqual(await plugin.beforeSetup(), {});
});
test("BuildPlugin: beforeSetup: runs build successfully", async (t) => {
  const tmp = await useTmp(t);
  const log = new TestLog();
  const plugin = new BuildPlugin(log, {
    buildCommand: "echo test > test.txt",
    buildBasePath: tmp,
    buildWatchPaths: ["src1", "src2"],
  });
  const result = await plugin.beforeSetup();
  t.deepEqual(result, { watch: ["src1", "src2"] });
  t.deepEqual(log.logs, [[LogLevel.INFO, "Build succeeded"]]);
  const test = await fs.readFile(path.join(tmp, "test.txt"), "utf8");
  t.is(test.trim(), "test");
});
test("BuildPlugin: beforeSetup: throws with exit code if build fails", async (t) => {
  const log = new NoOpLog();
  const plugin = new BuildPlugin(log, {
    buildCommand: "exit 42",
  });
  await t.throwsAsync(Promise.resolve(plugin.beforeSetup()), {
    instanceOf: BuildError,
    message: "Build failed with exit code 42",
    code: 42,
  });
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesPath = path.join(__dirname, "..", "..", "..", "test", "fixtures");
const webpackPath = path.join(fixturesPath, "wrangler", "webpack");
const rustPath = path.join(fixturesPath, "wrangler", "rust");

// These tests require wrangler and rust to be installed, so skip them if not installed
const wranglerInstalled = which.sync("wrangler", { nothrow: true });
const rustInstalled = which.sync("rustc", { nothrow: true });

const webpackTest = wranglerInstalled ? test : test.skip;
webpackTest(
  'populateBuildConfig: builds type "webpack" projects',
  async (t) => {
    await rimrafPromise(path.join(webpackPath, "worker"));
    const mf = useMiniflare(
      { BuildPlugin },
      { wranglerConfigPath: path.join(webpackPath, "wrangler.toml") }
    );
    await mf.getPlugins(); // Resolves once worker has been built
    t.true(existsSync(path.join(webpackPath, "worker", "script.js")));

    const res = await mf.dispatchFetch("http://localhost:8787/");
    t.is(await res.text(), "webpack:http://localhost:8787/");
  }
);

const rustTest = wranglerInstalled && rustInstalled ? test : test.skip;
rustTest('populateBuildConfig: builds type "rust" projects', async (t) => {
  await rimrafPromise(path.join(rustPath, "worker", "generated"));
  const mf = useMiniflare(
    // BindingsPlugin required for wasm binding
    { BuildPlugin, BindingsPlugin },
    { wranglerConfigPath: path.join(rustPath, "wrangler.toml") }
  );
  await mf.getPlugins(); // Resolves once worker has been built
  t.true(existsSync(path.join(rustPath, "worker", "generated", "script.js")));
  t.true(existsSync(path.join(rustPath, "worker", "generated", "script.wasm")));

  const res = await mf.dispatchFetch("http://localhost:8787/");
  t.is(await res.text(), "rust:http://localhost:8787/");
});
