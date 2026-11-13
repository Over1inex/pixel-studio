// Run against the loopback Sites dev preview after applying local migrations.
// The owner isolation fixture is changed only in the local preview database.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const base = process.env.PIXEL_TEST_ORIGIN || "http://127.0.0.1:5173";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "Integration fixtures must stay local");
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=";
const document = { version: 1, width: 1, height: 1, activeId: "layer-1", layers: [{ id: "layer-1", name: "Фон", visible: true, opacity: 1, image }] };
let cookie = "";
let id;
let ownerChanged = false;
let checks = 0;

async function call(path, { method = "GET", body, auth = true, origin = base, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (auth && cookie) requestHeaders.Cookie = cookie;
  if (method !== "GET" && origin) requestHeaders.Origin = origin;
  if (body !== undefined) requestHeaders["Content-Type"] ||= "application/json";
  const response = await fetch(`${base}${path}`, { method, headers: requestHeaders, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { response, status: response.status, data };
}
function status(result, expected, label) {
  assert.equal(result.status, expected, `${label}: ${JSON.stringify(result.data)}`);
  checks++;
  console.log(`PASS ${label} (${expected})`);
}
async function setOwner(owner) {
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.match(owner, /^[a-z_]+$/);
  await exec(process.execPath, ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local", "--config", "dist/server/wrangler.json", "--persist-to", ".wrangler/state", "--command", `UPDATE projects SET owner_id = '${owner}' WHERE id = '${id}'`], { cwd: root });
}

try {
  const anonymous = await call("/api/me", { auth: false });
  status(anonymous, 200, "Anonymous identity");
  assert.equal(anonymous.data.user, null);
  status(await call("/api/projects", { auth: false }), 401, "Anonymous list denied");
  status(await call("/api/projects", { method: "POST", auth: false, body: { name: "Test", document } }), 401, "Anonymous write denied");
  status(await call("/api/projects", { auth: false, headers: { "oai-authenticated-user-id": "local_seedy", "oai-authenticated-user-email": "seedy@sites.test" } }), 401, "Forged identity denied");

  const login = await fetch(`${base}/signin-with-chatgpt?return_to=%2F`, { redirect: "manual" });
  assert.equal(login.status, 302);
  cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const identity = await call("/api/me");
  status(identity, 200, "Signed-in identity");
  assert.equal(identity.data.user.id, "local_seedy");

  status(await call("/api/projects", { method: "POST", origin: "https://evil.example", body: { name: "Test", document } }), 403, "Cross-origin save denied");
  status(await call("/api/projects", { method: "POST", origin: null, body: { name: "Test", document } }), 403, "Missing-origin save denied");
  status(await call("/api/projects", { method: "POST", body: "{" }), 400, "Malformed JSON denied");
  status(await call("/api/projects", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }), 415, "Non-JSON write denied");
  status(await call("/api/projects", { method: "POST", body: { name: "Test", document: { ...document, width: 2 } } }), 400, "Wrong PNG dimensions denied");
  status(await call("/api/projects", { method: "POST", body: { name: "Test", document: { ...document, layers: Array.from({ length: 17 }, (_, i) => ({ ...document.layers[0], id: `layer-${i}` })) } } }), 400, "Too many layers denied");

  const created = await call("/api/projects", { method: "POST", body: { name: "Проверка API — временный проект", document } });
  status(created, 201, "Create cloud project");
  id = created.data.id;
  assert.match(created.data.updatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  const listed = await call("/api/projects");
  status(listed, 200, "List cloud projects");
  const entry = listed.data.projects.find((project) => project.id === id);
  assert.equal(entry.updatedAt, created.data.updatedAt);
  assert.equal(entry.width, 1);
  const loaded = await call(`/api/projects/${id}`);
  status(loaded, 200, "Load cloud project");
  assert.deepEqual(loaded.data.document, document);
  assert.equal(loaded.data.updatedAt, created.data.updatedAt);
  assert.equal(loaded.response.headers.get("cache-control"), "no-store");

  const revised = { ...document, version: 2, layers: [{ ...document.layers[0], opacity: 0.5, animation: {width: 1, height: 1, matrix: [1,0,0,1,0,0], frames: [{image, delay: 100}, {image, delay: 200}]} }] };
  const updated = await call(`/api/projects/${id}`, { method: "PUT", body: { name: "Обновлённый тест", document: revised } });
  status(updated, 200, "Update cloud project");
  assert.ok(updated.data.updatedAt >= created.data.updatedAt);
  const reloaded = await call(`/api/projects/${id}`);
  status(reloaded, 200, "Reload updated project");
  assert.deepEqual(reloaded.data.document, revised);
  assert.equal(reloaded.data.name, "Обновлённый тест");
  assert.equal(reloaded.data.updatedAt, updated.data.updatedAt);

  await setOwner("api_integration_other_user");
  ownerChanged = true;
  status(await call(`/api/projects/${id}`), 404, "Other-owner read denied");
  status(await call(`/api/projects/${id}`, { method: "PUT", body: { name: "Intrusion", document } }), 404, "Other-owner update denied");
  status(await call(`/api/projects/${id}`, { method: "DELETE" }), 404, "Other-owner deletion denied");
  const isolatedList = await call("/api/projects");
  assert.ok(!isolatedList.data.projects.some((project) => project.id === id));
  checks++;
  console.log("PASS Other-owner listing excluded");
  await setOwner("local_seedy");
  ownerChanged = false;
  const restored = await call(`/api/projects/${id}`);
  status(restored, 200, "Unauthorized writes did not change file");
  assert.deepEqual(restored.data.document, revised);
  status(await call(`/api/projects/${id}`, { method: "DELETE", origin: "https://evil.example" }), 403, "Cross-origin deletion denied");
  status(await call(`/api/projects/${id}`, { method: "DELETE" }), 200, "Delete cloud project");
  status(await call(`/api/projects/${id}`), 404, "Deleted project no longer loads");
  id = undefined;
  console.log(`${checks} API integration checks passed.`);
} finally {
  if (id) {
    if (ownerChanged) await setOwner("local_seedy");
    const cleanup = await call(`/api/projects/${id}`, { method: "DELETE" });
    assert.equal(cleanup.status, 200, "Failed to remove local test fixture");
  }
}
