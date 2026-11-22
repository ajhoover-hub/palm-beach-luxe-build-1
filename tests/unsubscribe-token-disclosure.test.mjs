import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TOKEN = "UNSUBSCRIBE_TOKEN_PLACEHOLDER";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeCandidates = [
  process.env.CHROME_PATH,
  "/usr/local/bin/google-chrome",
  "/usr/bin/google-chrome",
  "google-chrome",
].filter(Boolean);

function containsToken(value) {
  if (value == null) return false;
  const text = String(value);
  if (text.includes(TOKEN)) return true;
  try {
    return decodeURIComponent(text).includes(TOKEN);
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startVite(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes("Local:") || output.includes(`127.0.0.1:${port}`)) resolve(child);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code) reject(new Error(`vite exited ${code}: ${output}`));
    });
  });
}

function startChrome(userDataDir) {
  return new Promise((resolve, reject) => {
    let child;
    let started = false;
    const tryNext = (index) => {
      if (index >= chromeCandidates.length) {
        reject(new Error("chrome executable not found"));
        return;
      }
      child = spawn(
        chromeCandidates[index],
        [
          "--headless=new",
          "--disable-gpu",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--remote-debugging-port=0",
          `--user-data-dir=${userDataDir}`,
          "--no-first-run",
          "about:blank",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let buffer = "";
      child.on("error", () => tryNext(index + 1));
      const watch = (chunk) => {
        buffer += chunk.toString();
        const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match && !started) {
          started = true;
          resolve({ child, browserWs: match[1] });
        }
      };
      child.stdout.on("data", watch);
      child.stderr.on("data", watch);
      child.on("exit", () => {
        if (!started) tryNext(index + 1);
      });
    };
    tryNext(0);
  });
}

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let next = 1;
  const pending = new Map();
  const listeners = [];
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error(`cdp connection failed for ${wsUrl}`)));
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message || "cdp error"}`));
      else resolve(message.result || {});
      return;
    }
    if (message.method) {
      for (const listener of listeners) listener(message);
    }
  });
  return {
    ready,
    send(method, params = {}) {
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(listener) {
      listeners.push(listener);
    },
    close() {
      ws.close();
    },
  };
}

test("unsubscribe visit does not send the query token to measurement or the data layer", { timeout: 60000 }, async () => {
  const port = await freePort();
  const vite = await startVite(port);
  const userDataDir = await mkdtemp(path.join(tmpdir(), "unsubscribe-disclosure-"));
  let chrome;
  let pageCdp;
  let failure;
  try {
    await fetch(`http://127.0.0.1:${port}/unsubscribe`, { redirect: "manual" });
    chrome = await startChrome(userDataDir);
    const browserPort = new URL(chrome.browserWs).port;
    const target = await fetch(
      `http://127.0.0.1:${browserPort}/json/new?${encodeURIComponent("about:blank")}`,
      { method: "PUT" },
    ).then(async (response) => {
      if (response.ok) return response.json();
      const fallback = await fetch(
        `http://127.0.0.1:${browserPort}/json/new?${encodeURIComponent("about:blank")}`,
      );
      if (!fallback.ok) throw new Error(`unable to open a chrome target (${fallback.status})`);
      return fallback.json();
    });
    pageCdp = connectCdp(target.webSocketDebuggerUrl);
    await pageCdp.ready;

    const appHost = `127.0.0.1:${port}`;
    const continuedTypes = new Set(["Document", "Script", "Stylesheet", "Font", "WebSocket", "Manifest"]);
    const thirdParty = [];
    let documentHadToken = false;

    pageCdp.on((message) => {
      if (message.method !== "Fetch.requestPaused") return;
      const request = message.params.request;
      const resourceType = message.params.resourceType;
      let host = "";
      try {
        host = new URL(request.url).host;
      } catch {
        host = "";
      }
      const tokenInRequest = containsToken(request.url) || containsToken(request.postData);
      if (host === appHost && resourceType === "Document" && tokenInRequest) documentHadToken = true;
      if (host !== appHost) {
        thirdParty.push({
          url: request.url,
          resourceType,
          hasToken: tokenInRequest,
        });
      }
      const continueRequest = host === appHost || continuedTypes.has(resourceType);
      const method = continueRequest ? "Fetch.continueRequest" : "Fetch.failRequest";
      const params = continueRequest
        ? { requestId: message.params.requestId }
        : { requestId: message.params.requestId, errorReason: "BlockedByClient" };
      pageCdp.send(method, params).catch(() => {});
    });

    await pageCdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await pageCdp.send("Page.enable");
    const loaded = new Promise((resolve) => {
      pageCdp.on((message) => {
        if (message.method === "Page.loadEventFired") resolve();
      });
    });
    await pageCdp.send("Page.navigate", {
      url: `http://127.0.0.1:${port}/unsubscribe?token=${encodeURIComponent(TOKEN)}`,
    });
    await Promise.race([
      loaded,
      new Promise((_, reject) => setTimeout(() => reject(new Error("page load timed out")), 20000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const dataLayer = await pageCdp.send("Runtime.evaluate", {
      expression: `JSON.stringify((window.dataLayer || []).map((entry) => {
        if (entry && typeof entry === "object" && typeof entry.length === "number") {
          return Array.from(entry).map((item) => item instanceof Date ? item.toISOString() : item);
        }
        return entry;
      }))`,
      returnByValue: true,
    });
    const dataLayerText = dataLayer.result?.value || "";
    const leaked = thirdParty.filter((request) => request.hasToken);
    const measurement = thirdParty.filter((request) => !continuedTypes.has(request.resourceType));
    const problems = [];
    if (!documentHadToken) problems.push("the visit did not open the preferences page with the token");
    if (leaked.length > 0) {
      const hosts = [...new Set(leaked.map((request) => new URL(request.url).host))];
      problems.push(`measurement hosts received the unsubscribe token: ${hosts.join(", ")}`);
    }
    if (containsToken(dataLayerText)) problems.push("the data layer contains the unsubscribe token");
    if (measurement.length === 0) {
      problems.push("the ads tag did not emit a measurement request, so the page URL was not observed");
    }
    assert.deepEqual(problems, []);
  } catch (error) {
    failure = error;
  } finally {
    pageCdp?.close();
    if (chrome?.child && chrome.child.exitCode === null && chrome.child.signalCode === null) {
      await new Promise((resolve) => {
        chrome.child.once("exit", resolve);
        chrome.child.kill("SIGKILL");
      });
    }
    if (vite.exitCode === null && vite.signalCode === null) {
      await new Promise((resolve) => {
        vite.once("exit", resolve);
        vite.kill("SIGKILL");
      });
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
  if (failure) throw failure;
});
