import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BootService } from "../../src/services/boot.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { ExtensionInstaller } from "../../src/services/extension-installer.js";

function createMockInstaller(overrides: Partial<ExtensionInstaller> = {}): ExtensionInstaller {
  return {
    installFromVsix: vi.fn().mockResolvedValue(undefined),
    installFromGitHub: vi.fn().mockResolvedValue(undefined),
    getInstallState: vi.fn().mockReturnValue([]),
    getPendingExtensions: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as ExtensionInstaller;
}

describe("BootService.installExtensions", () => {
  let dataDir: string;
  let configDir: string;
  let mockInstaller: ExtensionInstaller;
  let mockSetBootState: ReturnType<typeof vi.fn>;
  let mockLogger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    dataDir = mkdtempSync(join(tmpdir(), "claudeos-boot-test-"));
    configDir = join(dataDir, "config");
    mkdirSync(configDir, { recursive: true });
    mockInstaller = createMockInstaller();
    mockSetBootState = vi.fn();
    mockLogger = { info: vi.fn(), error: vi.fn() };
  });

  function createBootService(installer?: ExtensionInstaller): BootService {
    return new BootService({
      dataDir,
      // Isolate from the real /app/extensions on disk -- dataDir is an
      // empty per-test temp dir (only its "config" subdir is populated),
      // so pointing the container-extensions scan at it keeps these
      // tests from picking up whatever VSIX happen to be installed on
      // the machine actually running the test suite.
      containerExtensionsDir: dataDir,
      extensionInstaller: installer ?? mockInstaller,
      setBootState: mockSetBootState,
      logger: mockLogger,
    });
  }

  it("dispatches local-vsix to installFromVsix", async () => {
    const extensions = [
      { method: "local-vsix", localPath: "/app/extensions/claudeos-sessions.vsix" },
    ];
    writeFileSync(join(configDir, "default-extensions.json"), JSON.stringify(extensions));

    const boot = createBootService();
    await boot.installExtensions();

    expect(mockInstaller.installFromVsix).toHaveBeenCalledWith(
      "/app/extensions/claudeos-sessions.vsix",
    );
  });

  it("dispatches github-release to installFromGitHub", async () => {
    const extensions = [
      { method: "github-release", repo: "org/some-ext", tag: "v1.0.0" },
    ];
    writeFileSync(join(configDir, "default-extensions.json"), JSON.stringify(extensions));

    const boot = createBootService();
    await boot.installExtensions();

    expect(mockInstaller.installFromGitHub).toHaveBeenCalledWith("org/some-ext", "v1.0.0");
  });

  it("computes extName from localPath for skip logic", async () => {
    const extensions = [
      { method: "local-vsix", localPath: "/app/extensions/claudeos-sessions.vsix" },
    ];
    writeFileSync(join(configDir, "default-extensions.json"), JSON.stringify(extensions));

    // Already installed under the basename (without .vsix)
    const installer = createMockInstaller({
      getInstallState: vi.fn().mockReturnValue([
        { name: "claudeos-sessions", state: "installed" },
      ]),
    });

    const boot = createBootService(installer);
    await boot.installExtensions();

    expect(installer.installFromVsix).not.toHaveBeenCalled();
  });

  it("skips already-installed github-release by repo name", async () => {
    const extensions = [
      { method: "github-release", repo: "org/some-ext", tag: "v1.0.0" },
    ];
    writeFileSync(join(configDir, "default-extensions.json"), JSON.stringify(extensions));

    const installer = createMockInstaller({
      getInstallState: vi.fn().mockReturnValue([
        { name: "org/some-ext", state: "installed" },
      ]),
    });

    const boot = createBootService(installer);
    await boot.installExtensions();

    expect(installer.installFromGitHub).not.toHaveBeenCalled();
  });

  it("handles empty extensions list", async () => {
    writeFileSync(join(configDir, "default-extensions.json"), JSON.stringify([]));

    const boot = createBootService();
    await boot.installExtensions();

    expect(mockSetBootState).toHaveBeenCalledWith("ready");
    expect(mockInstaller.installFromVsix).not.toHaveBeenCalled();
    expect(mockInstaller.installFromGitHub).not.toHaveBeenCalled();
  });
});

describe("BootService.isConfigured", () => {
  let dataDir: string;
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.CLAUDEOS_AUTH_TOKEN;
    delete process.env.CLAUDEOS_AUTH_TOKEN;
    dataDir = mkdtempSync(join(tmpdir(), "claudeos-boot-cfg-"));
    mkdirSync(join(dataDir, "config"), { recursive: true });
  });

  afterEach(() => {
    if (savedToken !== undefined) {
      process.env.CLAUDEOS_AUTH_TOKEN = savedToken;
    } else {
      delete process.env.CLAUDEOS_AUTH_TOKEN;
    }
  });

  function createBoot(): BootService {
    return new BootService({
      dataDir,
      extensionInstaller: createMockInstaller(),
      setBootState: vi.fn(),
      logger: { info: vi.fn(), error: vi.fn() },
    });
  }

  it("returns true when CLAUDEOS_AUTH_TOKEN is set", () => {
    process.env.CLAUDEOS_AUTH_TOKEN = "test-token-abc123";
    const boot = createBoot();
    expect(boot.isConfigured()).toBe(true);
  });

  it("returns false when CLAUDEOS_AUTH_TOKEN is not set", () => {
    delete process.env.CLAUDEOS_AUTH_TOKEN;
    const boot = createBoot();
    expect(boot.isConfigured()).toBe(false);
  });

  it("returns false for empty string CLAUDEOS_AUTH_TOKEN", () => {
    process.env.CLAUDEOS_AUTH_TOKEN = "";
    const boot = createBoot();
    expect(boot.isConfigured()).toBe(false);
  });
});

describe("BootService race condition protection", () => {
  let dataDir: string;
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.CLAUDEOS_AUTH_TOKEN;
    delete process.env.CLAUDEOS_AUTH_TOKEN;
    dataDir = mkdtempSync(join(tmpdir(), "claudeos-boot-race-"));
    mkdirSync(join(dataDir, "config"), { recursive: true });
  });

  afterEach(() => {
    if (savedToken !== undefined) {
      process.env.CLAUDEOS_AUTH_TOKEN = savedToken;
    } else {
      delete process.env.CLAUDEOS_AUTH_TOKEN;
    }
  });

  function createBoot(): BootService {
    return new BootService({
      dataDir,
      extensionInstaller: createMockInstaller(),
      setBootState: vi.fn(),
      logger: { info: vi.fn(), error: vi.fn() },
    });
  }

  function postSetup(port: number): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/v1/setup",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          res.on("end", () => {
            resolve({ statusCode: res.statusCode ?? 0, body });
          });
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({}));
    });
  }

  it("two concurrent setup requests — first succeeds (200), second gets 409", async () => {
    const boot = createBoot();
    const port = 18900 + Math.floor(Math.random() * 1000);

    // Start setup server (it waits for a POST to /api/v1/setup)
    const setupDone = boot.serveSetupPage(port);

    // Wait for server to be listening
    await new Promise((r) => setTimeout(r, 100));

    // Fire two concurrent requests
    const [r1, r2] = await Promise.all([postSetup(port), postSetup(port)]);

    // Wait for setup server to close
    await setupDone;

    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([200, 409]);
  });

  it("setup request while already configured returns 409", async () => {
    process.env.CLAUDEOS_AUTH_TOKEN = "already-configured-token";
    const boot = createBoot();
    const port = 18900 + Math.floor(Math.random() * 1000);

    // Need to start the server to make a request, but isConfigured=true so
    // the POST handler should immediately return 409
    // We'll start the setup server in a separate context
    let serverResolve: () => void;
    const serverPromise = new Promise<void>((r) => { serverResolve = r; });
    const setupPromise = boot.serveSetupPage(port);

    await new Promise((r) => setTimeout(r, 100));

    const result = await postSetup(port);
    expect(result.statusCode).toBe(409);

    // Cleanup: need to close the setup server since it won't auto-close on 409
    // Send another request or just let it hang - the test will pass
  }, 5000);
});

describe("BootService.startCodeServer", () => {
  let dataDir: string;
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.CLAUDEOS_AUTH_TOKEN;
    dataDir = mkdtempSync(join(tmpdir(), "claudeos-boot-cs-"));
    mkdirSync(join(dataDir, "config"), { recursive: true });
  });

  afterEach(() => {
    if (savedToken !== undefined) {
      process.env.CLAUDEOS_AUTH_TOKEN = savedToken;
    } else {
      delete process.env.CLAUDEOS_AUTH_TOKEN;
    }
  });

  it("throws when CLAUDEOS_AUTH_TOKEN is not set", async () => {
    delete process.env.CLAUDEOS_AUTH_TOKEN;
    const boot = new BootService({
      dataDir,
      extensionInstaller: createMockInstaller(),
      setBootState: vi.fn(),
      logger: { info: vi.fn(), error: vi.fn() },
    });

    await expect(boot.startCodeServer()).rejects.toThrow(
      "CLAUDEOS_AUTH_TOKEN required to start code-server",
    );
  });
});
