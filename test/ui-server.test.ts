/**
 * The localhost UI server.
 *
 * This process can read and write every file in the bundle and now answers
 * HTTP, so the tests that matter are the ones about who is allowed to reach
 * it. A regression here is not a broken feature, it is an open door.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Connections } from "../src/bun/connections";
import { startUiServer, type UiServer } from "../src/bun/ui-server";
import { Workspace } from "../src/bun/workspace";
import { removeTempDir } from "./helpers";

describe("serving the UI to a browser", () => {
  let root: string;
  let viewRoot: string;
  let workspace: Workspace;
  let connections: Connections;
  let server: UiServer;
  let token: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "okf-ui-"));
    workspace = new Workspace({ watch: false });
    await workspace.scaffold(root);
    await workspace.open(root);
    connections = new Connections();

    // A stand-in for the Vite build.
    viewRoot = join(root, "view");
    await mkdir(join(viewRoot, "assets"), { recursive: true });
    await writeFile(join(viewRoot, "index.html"), "<!doctype html><title>ok</title>", "utf8");
    await writeFile(join(viewRoot, "assets", "app.css"), "body{}", "utf8");

    server = startUiServer({ workspace, connections, viewRoot });
    token = new URL(server.url).searchParams.get("token")!;
  });

  afterEach(async () => {
    server.stop();
    await connections.closeAll();
    await workspace.close();
    await removeTempDir(root);
  });

  const base = () => `http://127.0.0.1:${server.port}`;

  test("binds to loopback only", () => {
    // Not 0.0.0.0 — otherwise the knowledge base is served to whatever
    // network the laptop is on.
    expect(server.url.startsWith("http://127.0.0.1:")).toBe(true);
  });

  test("the token is long enough to be worth having", () => {
    // A short token is a speed bump. 24 random bytes as hex.
    expect(token).toMatch(/^[a-f0-9]{48}$/);
  });

  test("a request with no token is refused", async () => {
    expect((await fetch(`${base()}/`)).status).toBe(403);
  });

  test("a request with the wrong token is refused", async () => {
    expect((await fetch(`${base()}/?token=deadbeef`)).status).toBe(403);
  });

  test("the document is served with the right token, and sets a cookie", async () => {
    const response = await fetch(`${base()}/?token=${token}`);
    expect(response.status).toBe(200);

    // Assets are fetched with no query string of their own, so the cookie is
    // what authorises them. HttpOnly keeps script from reading it back out;
    // Strict keeps it off requests started by any other origin.
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  test("an asset is served on the cookie alone", async () => {
    const response = await fetch(`${base()}/assets/app.css`, {
      headers: { cookie: `okf_token=${token}` },
    });
    expect(response.status).toBe(200);
  });

  test("an asset is refused with a forged cookie", async () => {
    const response = await fetch(`${base()}/assets/app.css`, {
      headers: { cookie: "okf_token=deadbeef" },
    });
    expect(response.status).toBe(403);
  });

  test("the RPC endpoint will not accept the cookie in place of the token", async () => {
    // Cookies ignore the port, so every local server on 127.0.0.1 shares a
    // jar with this one. The capability behind /rpc is the whole bundle, so
    // it demands the token itself.
    const response = await fetch(`${base()}/rpc`, {
      headers: { cookie: `okf_token=${token}` },
    });
    expect(response.status).toBe(403);
  });

  test("paths cannot escape the view directory", async () => {
    for (const attempt of [
      "/../package.json",
      "/..%2Fpackage.json",
      "/assets/../../package.json",
    ]) {
      const response = await fetch(`${base()}${attempt}?token=${token}`);
      expect(response.status).not.toBe(200);
    }
  });

  test("a missing file is a 404, not a crash", async () => {
    expect((await fetch(`${base()}/nope.js?token=${token}`)).status).toBe(404);
  });
});
