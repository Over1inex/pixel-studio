import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor, validateDimensions, validatePngDimensions } from '../public/editor.js';

// A tiny canvas test double exercises document/history transactions; raster output
// is intentionally left to browser QA rather than simulated pixel assertions.
class CanvasDouble {
  constructor() {
    this.width = 1; this.height = 1; this.content = ''; this.style = {};
    this.context = {
      save() {}, restore() {}, beginPath() {}, arc() {}, moveTo() {}, lineTo() {},
      setLineDash() {}, strokeRect() {},
      clearRect: () => { this.content = ''; },
      drawImage: source => { this.content += source.content; },
      fill: () => { this.content += 'paint;'; },
      stroke: () => { this.content += 'stroke;'; },
      fillRect: () => { this.content += 'background;'; },
    };
  }
  getContext() { return this.context; }
  addEventListener() {}
  removeEventListener() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; }
  setPointerCapture() {}
  hasPointerCapture() { return false; }
  releasePointerCapture() {}
}

globalThis.document = { createElement: () => new CanvasDouble() };

function createEditor(w = 100, h = 100) {
  const editor = new Editor(new CanvasDouble());
  editor.newDocument(w, h);
  return editor;
}

function pointer(x = 20, y = 20) {
  return { pointerId: 1, button: 0, clientX: x, clientY: y, preventDefault() {} };
}

function pngHeader(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

test('canvas dimensions reject oversized and fractional documents', () => {
  assert.deepEqual(validateDimensions(1200, 900), [1200, 900]);
  for (const dims of [[0, 20], [4097, 1], [4096, 4096], [1.5, 2], [NaN, 1]]) {
    assert.throws(() => validateDimensions(...dims));
  }
});

test('undo/redo restores independent layer snapshots and discards replaced future', () => {
  const editor = createEditor();
  const firstId = editor.activeId;
  editor.addLayer('Second');
  editor.renameLayer(editor.activeId, 'Renamed');
  editor.undo();
  assert.equal(editor.active.name, 'Second');
  editor.redo();
  assert.equal(editor.active.name, 'Renamed');
  editor.undo(); editor.undo();
  assert.equal(editor.layers.length, 1);
  assert.equal(editor.activeId, firstId);
  editor.addLayer('Branch');
  assert.equal(editor.canRedo, false);
  assert.equal(editor.active.name, 'Branch');
});

test('resizing keeps layers and metadata, supports undo, and rejects unsafe dimensions atomically', () => {
  const editor = createEditor(100, 80);
  editor.addLayer('Artwork'); editor.setLayerOpacity(.5);
  const ids = editor.layers.map(layer => layer.id);
  editor.resizeCanvas(25, 20);
  assert.deepEqual(editor.layers.map(layer => layer.id), ids);
  assert.equal(editor.active.opacity, .5);
  assert.ok(editor.layers.every(layer => layer.canvas.width === 25 && layer.canvas.height === 20));
  editor.undo(); assert.equal(editor.width, 100); assert.equal(editor.height, 80);
  editor.redo(); assert.equal(editor.width, 25);
  const historyLength = editor.history.length;
  editor.resizeCanvas(25, 20); assert.equal(editor.history.length, historyLength);
  assert.throws(() => editor.resizeCanvas(4096, 4096));
  assert.equal(editor.width, 25); assert.equal(editor.history.length, historyLength);
  editor.resizeCanvas(50, 40, 'nearest');
  assert.equal(editor.active.canvas.getContext('2d').imageSmoothingEnabled, false);
});

test('history is limited both by pixel memory and by entry count', () => {
  const large = createEditor(1024, 1024);
  for (let i = 0; i < 30; i++) large.renameLayer(large.activeId, `Layer ${i}`);
  assert.ok(large.historyBytes <= 64 * 1024 * 1024);
  assert.equal(large.history.length, 16);
  const tiny = createEditor(1, 1);
  for (let i = 0; i < 80; i++) tiny.renameLayer(tiny.activeId, `Layer ${i}`);
  assert.equal(tiny.history.length, 50);
  assert.equal(tiny.historyIndex, 49);
});

test('pointer cancellation restores the layer without adding an undo entry', () => {
  const editor = createEditor();
  editor.setTool('brush');
  editor._pointerDown(pointer());
  assert.equal(editor.active.canvas.content, 'paint;');
  editor._cancelDrag(pointer());
  assert.equal(editor.active.canvas.content, '');
  assert.equal(editor.history.length, 1);
  assert.equal(editor.drag, null);
});

test('stationary pointerup does not apply brush opacity a second time', () => {
  const editor = createEditor();
  editor.setTool('brush');
  editor._pointerDown(pointer());
  editor._pointerUp(pointer());
  assert.equal(editor.active.canvas.content, 'paint;');
  assert.equal(editor.history.length, 2);
  editor.undo();
  assert.equal(editor.active.canvas.content, '');
  editor.redo();
  assert.equal(editor.active.canvas.content, 'paint;');
});

test('cancelled crop restores the previous selection', () => {
  const editor = createEditor();
  editor.setTool('crop');
  editor.selection = { x: 2, y: 3, width: 40, height: 50 };
  editor._pointerDown(pointer(10, 10));
  editor._pointerMove(pointer(80, 90));
  editor._cancelDrag(pointer());
  assert.deepEqual(editor.selection, { x: 2, y: 3, width: 40, height: 50 });
});

test('PNG dimensions are checked before decoding, and rejected projects leave the document intact', async () => {
  assert.doesNotThrow(() => validatePngDimensions(pngHeader(100, 100), 100, 100));
  assert.throws(() => validatePngDimensions(pngHeader(50000, 50000), 100, 100));
  assert.throws(() => validatePngDimensions('data:image/png;base64,AAAA', 100, 100));
  const editor = createEditor();
  const oldId = editor.activeId;
  await assert.rejects(editor.loadProject({ version: 1, width: 100, height: 100, layers: [{ image: pngHeader(50000, 50000) }] }));
  assert.equal(editor.activeId, oldId);
  assert.equal(editor.busy, false);
  assert.equal(editor.history.length, 1);
});

test('a PNG decoder error releases the loading lock and preserves the prior project', async () => {
  globalThis.Image = class {
    set src(value) { queueMicrotask(() => this.onerror(new Error('decode failed'))); }
  };
  const editor = createEditor();
  const oldId = editor.activeId;
  await assert.rejects(editor.loadProject({ version: 1, width: 100, height: 100, layers: [{ image: pngHeader(100, 100) }] }));
  assert.equal(editor.activeId, oldId);
  assert.equal(editor.busy, false);
  editor.addLayer();
  assert.equal(editor.layers.length, 2);
});

test('memory limits and invalid layer moves cannot corrupt the layer stack', () => {
  const editor = createEditor(4096, 2048);
  editor.addLayer();
  assert.throws(() => editor.addLayer());
  const ids = editor.layers.map(layer => layer.id);
  editor.moveLayer(NaN);
  editor.moveLayer(0);
  assert.deepEqual(editor.layers.map(layer => layer.id), ids);
  assert.throws(() => editor.resizeCanvas(4096, 4096));
  assert.equal(editor.width, 4096);
  assert.equal(editor.height, 2048);
});
