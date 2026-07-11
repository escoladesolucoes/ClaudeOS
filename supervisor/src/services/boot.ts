// ============================================================
// ClaudeOS Supervisor - Boot Service
// ============================================================
// Boot sequence: first-boot detection, setup page serving,
// extension install, code-server launch.
//
// Boot states: initializing -> setup -> installing -> ready -> ok
// ============================================================

import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { join, resolve, extname } from "node:path";
import type { BootState } from "../types.js";
import type { ExtensionInstaller } from "./extension-installer.js";

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

type DefaultExtension =
  | { method: "github-release"; repo: string; tag: string }
  | { method: "local-vsix"; localPath: string };

interface BootServiceOptions {
  dataDir: string;
  extensionInstaller: ExtensionInstaller;
  setBootState: (state: BootState) => void;
  logger?: { info: (msg: string) => void; error: (msg: string) => void };
  /**
   * Directory holding the bundled VSIX files copied into the container by
   * the Dockerfile. Defaults to the real container path; overridable so
   * tests can point it at an isolated temp directory instead of the real
   * /app/extensions on disk.
   */
  containerExtensionsDir?: string;
}

export class BootService {
  private readonly dataDir: string;
  private readonly configDir: string;
  private readonly containerExtensionsDir: string;
  private readonly extensionInstaller: ExtensionInstaller;
  private readonly setBootState: (state: BootState) => void;
  private readonly logger: { info: (msg: string) => void; error: (msg: string) => void };
  private codeServerProcess: ChildProcess | null = null;
  private setupInProgress = false;
  private setupServerInstance: Server | null = null;

  constructor(options: BootServiceOptions) {
    this.dataDir = options.dataDir;
    this.configDir = join(options.dataDir, "config");
    this.containerExtensionsDir = options.containerExtensionsDir ?? "/app/extensions";
    this.extensionInstaller = options.extensionInstaller;
    this.setBootState = options.setBootState;
    this.logger = options.logger ?? {
      info: (msg: string) => console.log(`[boot] ${msg}`),
      error: (msg: string) => console.error(`[boot] ${msg}`),
    };

    // Ensure config directory exists
    mkdirSync(this.configDir, { recursive: true });
  }

  /**
   * Check if the system has been configured.
   * Requires both an auth token AND a completed wizard run.
   */
  isConfigured(): boolean {
    if (!process.env.CLAUDEOS_AUTH_TOKEN) return false;
    const wizardStatePath = join(this.configDir, "wizard-state.json");
    if (!existsSync(wizardStatePath)) return false;
    try {
      const raw = readFileSync(wizardStatePath, "utf-8");
      const state = JSON.parse(raw);
      return state.status === "completed";
    } catch {
      return false;
    }
  }

  /**
   * Resolve the wizard-dist directory containing the React build output.
   * Tries multiple locations to support both container and development environments.
   */
  private getWizardDistDir(): string | null {
    const candidates = [
      resolve(this.dataDir, '..', 'wizard-dist'),    // container: /app/wizard-dist
      resolve('wizard-dist'),                          // relative to CWD
      resolve('supervisor', 'wizard-dist'),            // development: project root
    ];

    for (const dir of candidates) {
      if (existsSync(join(dir, 'index.html'))) {
        return dir;
      }
    }
    return null;
  }

  /**
   * Proxy an incoming request to the Fastify server on localhost:3100.
   * Handles GET, POST, and SSE streaming.
   */
  private proxyToFastify(req: IncomingMessage, res: ServerResponse, fastifyPort = 3100): void {
    const isSSE = req.url === '/api/v1/wizard/events';

    const proxyReq = httpRequest(
      {
        hostname: 'localhost',
        port: fastifyPort,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: `localhost:${fastifyPort}`,
        },
      },
      (proxyRes) => {
        // For SSE, ensure no buffering
        if (isSSE) {
          res.writeHead(proxyRes.statusCode ?? 200, {
            ...proxyRes.headers,
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          proxyRes.on('data', (chunk: Buffer) => {
            res.write(chunk);
          });
          proxyRes.on('end', () => {
            res.end();
          });
        } else {
          res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
          proxyRes.pipe(res);
        }
      },
    );

    proxyReq.on('error', (err) => {
      this.logger.error(`Proxy error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Backend unavailable' }));
      }
    });

    // Pipe request body for POST/PUT/PATCH
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  }

  /**
   * Serve the first-boot wizard UI and proxy API requests to Fastify.
   * Returns a Promise that resolves when setup is complete.
   */
  async serveSetupPage(port: number): Promise<void> {
    this.setBootState("setup");

    const wizardDir = this.getWizardDistDir();
    if (wizardDir) {
      this.logger.info(`Serving wizard from ${wizardDir}`);
    } else {
      this.logger.info('Wizard dist not found, will use fallback HTML');
    }

    return new Promise<void>((resolvePromise, rejectPromise) => {
      const setupServer: Server = createServer(async (req, res) => {
        const url = req.url ?? '/';
        const method = req.method ?? 'GET';

        // ---- Health check for Railway/container orchestrators ----
        if (method === 'GET' && url === '/healthz') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'setup' }));
          return;
        }

        // ---- Direct handler: instance claim (controls setup server lifecycle) ----
        if (method === 'POST' && url === '/api/v1/setup') {
          // Mutex: reject if already configured or setup in progress
          if (this.isConfigured()) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Instance already claimed' }));
            return;
          }
          if (this.setupInProgress) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Setup already in progress' }));
            return;
          }
          this.setupInProgress = true;

          try {
            this.logger.info('Instance claimed, proceeding with setup');
            this.setBootState('installing');

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));

            // Close the setup server and resolve
            setupServer.close(() => {
              resolvePromise();
            });
          } catch (err) {
            this.setupInProgress = false;
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(`Setup error: ${message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
          return;
        }

        // ---- API proxy: forward all /api/v1/* to Fastify on port 3100 ----
        if (url.startsWith('/api/v1/')) {
          this.proxyToFastify(req, res);
          return;
        }

        // ---- Static file serving from wizard-dist ----
        if (wizardDir) {
          // SPA routes: serve index.html for / , /setup, and any non-asset path
          if (method === 'GET' && (url === '/' || url === '/setup' || !url.startsWith('/assets/'))) {
            // Check if it's a specific file in wizard-dist (not an SPA route)
            if (url !== '/' && url !== '/setup') {
              const specificPath = join(wizardDir, url);
              if (existsSync(specificPath)) {
                const ext = extname(url);
                const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
                try {
                  const content = readFileSync(specificPath);
                  res.writeHead(200, { 'Content-Type': mime });
                  res.end(content);
                  return;
                } catch {
                  // fall through to index.html
                }
              }
            }

            // Serve index.html (SPA fallback)
            try {
              const html = readFileSync(join(wizardDir, 'index.html'), 'utf-8');
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(html);
            } catch {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to load wizard' }));
            }
            return;
          }

          // Serve static assets from wizard-dist/assets/
          if (method === 'GET' && url.startsWith('/assets/')) {
            const filePath = join(wizardDir, url);
            if (existsSync(filePath)) {
              const ext = extname(url);
              const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
              try {
                const content = readFileSync(filePath);
                res.writeHead(200, { 'Content-Type': mime });
                res.end(content);
              } catch {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to read asset' }));
              }
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Asset not found' }));
            }
            return;
          }
        } else {
          // No wizard-dist: fallback HTML
          if (method === 'GET' && (url === '/' || url === '/setup')) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Setup page not found</h1><p>Wizard build output missing. Rebuild with: cd supervisor/wizard && npx vite build</p></body></html>');
            return;
          }
        }

        // 404 for everything else
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      });

      // Store reference for later access (port handoff during launch)
      this.setupServerInstance = setupServer;

      setupServer.listen(port, "0.0.0.0", () => {
        this.logger.info(`First-boot wizard available at http://localhost:${port}`);
      });

      setupServer.on("error", (err) => {
        rejectPromise(err);
      });
    });
  }

  /**
   * Install default extensions by scanning for .vsix files in the extensions directory.
   * Fail-fast: if any install fails, halt and throw.
   * On next boot, getPendingExtensions() finds failed ones, retries only those.
   */
  async installExtensions(): Promise<void> {
    // Scan for .vsix files in the extensions directory
    // Check container path first, then project path
    // NOTE: the container path is the literal /app/extensions/ that the
    // Dockerfile COPYs the built VSIX into (see Dockerfile lines 138-142).
    // join(this.configDir, "..", "extensions") previously resolved to
    // dataDir/extensions (e.g. /data/extensions) instead, so this scan
    // always came up empty and installExtensions() silently no-op'd on
    // every boot -- the bundled extensions were never actually installed.
    const extensionsDirs = [
      this.containerExtensionsDir,                // /app/extensions/ in container
      resolve("default-extensions"),              // project root default-extensions/
    ];

    let vsixFiles: string[] = [];
    for (const dir of extensionsDirs) {
      if (existsSync(dir)) {
        const files = readdirSync(dir).filter(f => f.endsWith(".vsix"));
        if (files.length > 0) {
          vsixFiles = files.map(f => join(dir, f));
          break;
        }
      }
    }

    // Convert to DefaultExtension format for existing install pipeline
    const extensions: DefaultExtension[] = vsixFiles.map(localPath => ({
      method: "local-vsix" as const,
      localPath,
    }));

    if (extensions.length === 0) {
      this.logger.info("No default extensions to install");
      this.setBootState("ready");
      return;
    }

    // Check for previously failed extensions to retry
    const pending = this.extensionInstaller.getPendingExtensions();
    const pendingNames = new Set(pending.map((p) => p.name));

    for (const ext of extensions) {
      // Compute extension name for skip/fail-fast logic
      const extName = ext.method === "local-vsix"
        ? ext.localPath.split("/").pop()?.replace(".vsix", "") ?? ext.localPath
        : ext.repo;

      // Skip already-installed extensions, retry failed ones
      const allState = this.extensionInstaller.getInstallState();
      const existing = allState.find((e) => e.name === extName);
      if (existing?.state === "installed" && !pendingNames.has(extName)) {
        this.logger.info(`Extension ${extName} already installed, skipping`);
        continue;
      }

      if (ext.method === "local-vsix") {
        this.logger.info(`Installing local extension: ${ext.localPath}`);
        await this.extensionInstaller.installFromVsix(ext.localPath);
      } else {
        this.logger.info(`Installing extension: ${ext.repo}@${ext.tag}`);
        await this.extensionInstaller.installFromGitHub(ext.repo, ext.tag);
      }

      // Check if install failed (fail-fast)
      const state = this.extensionInstaller.getInstallState();
      const record = state.find((e) => e.name === extName);
      if (record?.state === "failed") {
        throw new Error(
          `Extension install failed for ${extName}: ${record.error}`,
        );
      }
    }

    this.logger.info("All default extensions installed");
    this.setBootState("ready");
  }

  /**
   * Get the setup server instance for closing during port handoff.
   */
  getSetupServer(): Server | null {
    return this.setupServerInstance;
  }

  /**
   * Poll code-server until it responds to HTTP requests (healthy).
   * Returns true if code-server is healthy, false if all attempts exhausted.
   */
  async waitForCodeServer(
    port: number,
    maxAttempts = 30,
    intervalMs = 1000,
  ): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`http://localhost:${port}/healthz`);
        if (res.ok || res.status === 302) return true;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  }

  /**
   * Start code-server as a child process.
   * When auth is "none", skips PASSWORD env var (Railway auth cookie gates access).
   * Defaults to "password" auth with CLAUDEOS_AUTH_TOKEN for backward compatibility.
   */
  async startCodeServer(options?: {
    port?: number;
    auth?: "password" | "none";
    productJsonPath?: string;
    userDataDir?: string;
  }): Promise<void> {
    const port = options?.port ?? 8080;
    const authMode = options?.auth ?? "password";
    const password = process.env.CLAUDEOS_AUTH_TOKEN;

    if (authMode === "password" && !password) {
      throw new Error("CLAUDEOS_AUTH_TOKEN required to start code-server");
    }

    const args = [
      "--bind-addr",
      `0.0.0.0:${port}`,
      "--auth",
      authMode,
    ];

    // Product.json for ClaudeOS branding (SUP-01)
    if (options?.productJsonPath) {
      args.push("--config", options.productJsonPath);
    }

    // User data dir on persistent volume
    if (options?.userDataDir) {
      args.push("--user-data-dir", options.userDataDir);
    }

    const env: Record<string, string | undefined> = { ...process.env };
    if (authMode === "password" && password) {
      env.PASSWORD = password;
    }

    this.logger.info(`Starting code-server on port ${port} (auth: ${authMode})`);

    this.codeServerProcess = spawn("code-server", args, {
      env,
      stdio: "inherit",
    });

    this.codeServerProcess.on("error", (err) => {
      this.logger.error(`code-server error: ${err.message}`);
    });

    this.codeServerProcess.on("exit", (code, signal) => {
      this.logger.error(
        `code-server exited (code=${code}, signal=${signal}). Restarting...`,
      );
      // Auto-restart on crash
      if (code !== 0 && code !== null) {
        setTimeout(() => {
          void this.startCodeServer(options);
        }, 2000);
      }
    });

    this.setBootState("ok");
  }

  /**
   * Stop code-server process gracefully.
   */
  stopCodeServer(): void {
    if (this.codeServerProcess) {
      this.codeServerProcess.kill("SIGTERM");
      this.codeServerProcess = null;
    }
  }
}
