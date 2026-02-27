import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadServerConfig } from "../config.js";

const TEST_DIR = join(tmpdir(), "ao-api-server-config-test");
const TEST_CONFIG = join(TEST_DIR, "config.json");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadServerConfig", () => {
  it("returns defaults when config file does not exist", () => {
    const config = loadServerConfig(join(TEST_DIR, "nonexistent.json"));
    expect(config).toEqual({ host: "127.0.0.1", port: 3001 });
  });

  it("loads valid config with Tailscale IP", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ host: "100.64.0.1", port: 3001 }));
    const config = loadServerConfig(TEST_CONFIG);
    expect(config).toEqual({ host: "100.64.0.1", port: 3001 });
  });

  it("loads valid config with localhost", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ host: "127.0.0.1", port: 8080 }));
    const config = loadServerConfig(TEST_CONFIG);
    expect(config).toEqual({ host: "127.0.0.1", port: 8080 });
  });

  it("loads valid config with hostname", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ host: "my-server.tailnet", port: 3001 }));
    const config = loadServerConfig(TEST_CONFIG);
    expect(config).toEqual({ host: "my-server.tailnet", port: 3001 });
  });

  it("rejects 0.0.0.0 with security error", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ host: "0.0.0.0", port: 3001 }));
    expect(() => loadServerConfig(TEST_CONFIG)).toThrow(
      "Binding to 0.0.0.0 is not allowed for security",
    );
  });

  it("rejects empty host", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ host: "", port: 3001 }));
    expect(() => loadServerConfig(TEST_CONFIG)).toThrow("host must not be empty");
  });

  it("rejects invalid IP address (octet > 255)", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ host: "999.999.999.999", port: 3001 }));
    expect(() => loadServerConfig(TEST_CONFIG)).toThrow("host must be a valid IPv4 address");
  });

  it("rejects invalid hostname with spaces", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ host: "bad host", port: 3001 }));
    expect(() => loadServerConfig(TEST_CONFIG)).toThrow("host must be a valid IPv4 address");
  });

  it("rejects port out of range", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ host: "127.0.0.1", port: 70000 }));
    expect(() => loadServerConfig(TEST_CONFIG)).toThrow("Invalid config");
  });

  it("rejects port 0", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ host: "127.0.0.1", port: 0 }));
    expect(() => loadServerConfig(TEST_CONFIG)).toThrow("Invalid config");
  });

  it("rejects non-integer port", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ host: "127.0.0.1", port: 3.14 }));
    expect(() => loadServerConfig(TEST_CONFIG)).toThrow("Invalid config");
  });

  it("rejects invalid JSON", () => {
    writeFileSync(TEST_CONFIG, "not json{{{");
    expect(() => loadServerConfig(TEST_CONFIG)).toThrow("Invalid JSON");
  });

  it("rejects missing host field", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ port: 3001 }));
    expect(() => loadServerConfig(TEST_CONFIG)).toThrow("Invalid config");
  });

  it("rejects missing port field", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ host: "127.0.0.1" }));
    expect(() => loadServerConfig(TEST_CONFIG)).toThrow("Invalid config");
  });
});
