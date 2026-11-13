import test from "node:test";
import assert from "node:assert/strict";
import { AppError, checkSameOrigin, MAX_BODY_BYTES, readPayload, validateProjectPayload, validProjectId } from "../lib/project-validation.mjs";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=";
function payload() {
  return { name: "  Мой проект  ", document: { version: 1, width: 1, height: 1, activeId: "layer-1", layers: [{ id: "layer-1", name: "Фон", visible: true, opacity: 1, image: PNG }] } };
}
function invalid(change, message) {
  const data = payload(); change(data);
  assert.throws(() => validateProjectPayload(data), message || AppError);
}

test("valid documents are normalized and unrecognized fields are stripped", () => {
  const input = payload(); input.ownerId = "someone-else"; input.document.layers[0].html = "<script>";
  const result = validateProjectPayload(input);
  assert.equal(result.name, "Мой проект");
  assert.equal(result.ownerId, undefined);
  assert.equal(result.document.layers[0].html, undefined);
});

test('animated projects retain frames and reject corrupt or oversized animation metadata', () => {
  const input = payload(); input.document.version = 2;
  input.document.layers[0].animation = {width: 1, height: 1, matrix: [1,0,0,1,0,0], frames: [{image: PNG, delay: 100},{image: PNG, delay: 200}]};
  assert.equal(validateProjectPayload(input).document.layers[0].animation.frames.length, 2);
  for (const change of [a => a.matrix[0] = Infinity, a => a.frames[0].delay = 0, a => a.frames[0].image = 'data:image/svg+xml;base64,PHN2Zz4=', a => a.width = 4096, a => a.frames = Array(121).fill(a.frames[0])]) {
    const damaged = structuredClone(input); change(damaged.document.layers[0].animation);
    assert.throws(() => validateProjectPayload(damaged), AppError);
  }
  input.document.version = 1; assert.throws(() => validateProjectPayload(input), AppError);
});

test("dimension and cumulative decoded image limits reject oversized projects", () => {
  invalid((p) => { p.document.width = 4097; });
  invalid((p) => { p.document.height = 0; });
  invalid((p) => { p.document.width = 1.5; });
  invalid((p) => { p.document.width = 4096; p.document.height = 4096; });
  invalid((p) => { p.document.width = 4096; p.document.height = 2048; p.document.layers = Array.from({length: 3}, (_, i) => ({...p.document.layers[0], id: `layer-${i}`})); }, /Слишком много/);
});

test("duplicate layers, missing selection, malformed opacity and names fail", () => {
  invalid((p) => p.document.layers.push({ ...p.document.layers[0] }));
  invalid((p) => { p.document.activeId = "unknown"; });
  invalid((p) => { p.document.layers[0].opacity = 2; });
  invalid((p) => { p.document.layers[0].opacity = NaN; });
  invalid((p) => { p.name = " "; });
  invalid((p) => { p.name = "x".repeat(121); });
});

test("HTML/SVG, forged PNG headers and mismatched dimensions fail", () => {
  invalid((p) => { p.document.layers[0].image = "data:image/svg+xml;base64,PHN2Zz4="; });
  invalid((p) => { p.document.layers[0].image = "data:image/png;base64," + btoa("<svg><script>alert(1)</script></svg>".repeat(2)); });
  invalid((p) => { p.document.width = 2; });
});

test("same-origin writes are required even when credentials are present", () => {
  assert.doesNotThrow(() => checkSameOrigin(new Request("https://studio.example/api/projects", { headers: { origin: "https://studio.example" } })));
  assert.throws(() => checkSameOrigin(new Request("https://studio.example/api/projects", { headers: { origin: "https://evil.example" } })), { status: 403 });
  assert.throws(() => checkSameOrigin(new Request("https://studio.example/api/projects")), { status: 403 });
  assert.throws(() => checkSameOrigin(new Request("https://studio.example/api/projects", { headers: { origin: "https://studio.example", "sec-fetch-site": "cross-site" } })), { status: 403 });
});

test("request bodies are parsed only as JSON", async () => {
  const good = new Request("https://studio.example", { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(payload()) });
  assert.equal((await readPayload(good)).name, "Мой проект");
  await assert.rejects(readPayload(new Request("https://studio.example", { method: "POST", body: "{}" })), { status: 415 });
  await assert.rejects(readPayload(new Request("https://studio.example", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })), { status: 400 });
});

test("stream limits apply when Content-Length is missing or misleading", async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_BODY_BYTES + 1)); controller.close(); } });
  const request = new Request("https://studio.example", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1" }, body: stream, duplex: "half" });
  await assert.rejects(readPayload(request), { status: 413 });
});

test("only opaque UUID project identifiers are accepted", () => {
  assert.equal(validProjectId("22a3cc44-1111-4333-a555-123456789abc"), true);
  for (const value of ["../../secret", "x OR 1=1", "", null, 42]) assert.equal(validProjectId(value), false);
});
