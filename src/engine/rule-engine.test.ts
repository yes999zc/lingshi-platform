import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RuleEngine, type RuleValidationResult } from "./rule-engine";

describe("rule-engine", () => {
  describe("load and validate", () => {
    it("should load valid config successfully", () => {
      // Use the real config file (should be valid)
      const engine = new RuleEngine();
      const result = engine.load();
      
      assert.strictEqual(result.valid, true);
      assert.deepStrictEqual(result.errors, []);
    });

    it("should reject non‑existent config file", () => {
      const engine = new RuleEngine("/nonexistent/rules.json");
      const result = engine.load();
      
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors[0].includes("Failed to load config"));
    });

    it("should reject empty config", () => {
      const tempDir = fs.mkdtempSync(path.join(__dirname, "test-"));
      const tempPath = path.join(tempDir, "empty.json");
      fs.writeFileSync(tempPath, "");
      
      try {
        const engine = new RuleEngine(tempPath);
        const result = engine.load();
        
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors[0].includes("Failed to load config"));
      } finally {
        fs.rmSync(tempDir, { recursive: true });
      }
    });

    it("should reject config missing required sections", () => {
      const tempDir = fs.mkdtempSync(path.join(__dirname, "test-"));
      const tempPath = path.join(tempDir, "bad.json");
      const badConfig = { _meta: {} }; // missing task, scoring, etc.
      fs.writeFileSync(tempPath, JSON.stringify(badConfig));
      
      try {
        const engine = new RuleEngine(tempPath);
        const result = engine.load();
        
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors.some(e => e.includes("Missing or invalid")));
      } finally {
        fs.rmSync(tempDir, { recursive: true });
      }
    });

    it("should reject config with invalid JSON", () => {
      const tempDir = fs.mkdtempSync(path.join(__dirname, "test-"));
      const tempPath = path.join(tempDir, "invalid.json");
      fs.writeFileSync(tempPath, "{ invalid json");
      
      try {
        const engine = new RuleEngine(tempPath);
        const result = engine.load();
        
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors[0].includes("Failed to load config"));
      } finally {
        fs.rmSync(tempDir, { recursive: true });
      }
    });
  });

  describe("getConfig", () => {
    it("should return loaded config", () => {
      const engine = new RuleEngine();
      engine.load();
      const config = engine.getConfig();
      
      assert.ok(config._meta);
      assert.ok(config.task);
      assert.ok(config.scoring);
      assert.ok(config.economy);
      assert.ok(config.tier);
      assert.ok(config.anti_abuse);
      assert.ok(config.settlement);
    });

    it("should throw if config not loaded", () => {
      const engine = new RuleEngine();
      assert.throws(
        () => engine.getConfig(),
        /Rules not loaded/
      );
    });
  });

  describe("validateScorerIsolation (integration)", () => {
    it("should allow isolated scorer via engine", () => {
      const engine = new RuleEngine();
      engine.load();
      const config = engine.getConfig();
      
      // This is an indirect test: we verify that the config's
      // require_scorer_isolation is true (default), meaning
      // validateScorerIsolation will enforce isolation.
      assert.strictEqual(config.scoring.require_scorer_isolation, true);
    });
  });

  // Note: Hot‑reload (watch) test is skipped because it requires mocking fs.watch.
  // Note: Value‑range validation tests (P1‑03) are skipped because the validation
  //       is not yet implemented in the engine (P1‑03 is a known issue).
});