import {decodeGif, drawAnimation, animationDuration, animationPixels, encodeGif, MAX_ANIMATION_PIXELS} from './animation.js';
const MAX_DIMENSION = 4096;
const MAX_PIXELS = 8_388_608;
const MAX_LAYERS = 16;
const MAX_PROJECT_PIXELS = 16_777_216;
const HISTORY_BUDGET = 64 * 1024 * 1024;
const MAX_HISTORY = 50;
const TOOLS = new Set(['move', 'brush', 'eraser', 'rectangle', 'ellipse', 'text', 'eyedropper', 'fill', 'crop']);

export function validateDimensions(width, height) {
  const w = Number(width), h = Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_DIMENSION || h > MAX_DIMENSION || w * h > MAX_PIXELS) {
    throw new Error('Размер холста: от 1 до 4096 px, не более 8 мегапикселей.');
  }
  return [w, h];
}

function surface(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function copyCanvas(source) {
  const canvas = surface(source.width, source.height);
  canvas.getContext('2d').drawImage(source, 0, 0);
  return canvas;
}

function uid() { return crypto.randomUUID(); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function safeColor(value) { return /^#[\da-f]{6}$/i.test(value) ? value : '#a5a0ff'; }
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Не удалось прочитать изображение.'));
    image.src = src;
  });
}

// Check dimensions before handing compressed PNG data to the image decoder.
export function validatePngDimensions(dataUrl, width, height) {
  if (typeof dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new Error('В проекте обнаружено неверное изображение слоя.');
  let header;
  try { header = Uint8Array.from(atob(dataUrl.slice(22, 66)), char => char.charCodeAt(0)); }
  catch { throw new Error('Не удалось прочитать PNG слоя.'); }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (header.length < 24 || !signature.every((value, index) => header[index] === value) || String.fromCharCode(...header.slice(12, 16)) !== 'IHDR') throw new Error('В проекте обнаружен повреждённый PNG.');
  const view = new DataView(header.buffer);
  if (view.getUint32(16) !== width || view.getUint32(20) !== height) throw new Error('Размер слоя не совпадает с размером проекта.');
}

/** Layered raster editor. Layers and snapshots are stored bottom to top. */
export class Editor {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {(editor: Editor) => void} onChange
   */
  constructor(canvas, onChange = () => {}) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.onChange = onChange;
    this.width = 1200;
    this.height = 900;
    this.layers = [];
    this.activeId = null;
    this.history = [];
    this.historyIndex = -1;
    this.historyBytes = 0;
    this.tool = 'move';
    this.color = '#aaa0ff';
    this.size = 24;
    this.opacity = 1;
    this.textValue = 'Ваш текст';
    this.fontSize = 80;
    this.shapeFilled = true;
    this.selection = null;
    this.busy = false;
    this.drag = null;
    this.playheadMs = 0;
    this.playing = false;
    this.onNotice = message => { void message; };
    this.canvas.style.touchAction = 'none';
    this.handlers = {
      pointerdown: event => this._pointerDown(event),
      pointermove: event => this._pointerMove(event),
      pointerup: event => this._pointerUp(event),
      pointercancel: event => this._cancelDrag(event),
      lostpointercapture: event => this._cancelDrag(event),
    };
    Object.entries(this.handlers).forEach(([name, handler]) => canvas.addEventListener(name, handler));
  }

  get active() { return this.layers.find(layer => layer.id === this.activeId) || null; }
  get canUndo() { return this.historyIndex > 0; }
  get canRedo() { return this.historyIndex < this.history.length - 1; }
  get hasAnimation() { return this.layers.some(layer => layer.animation); }
  get durationMs() { return Math.max(0, ...this.layers.filter(layer => layer.animation).map(layer => animationDuration(layer.animation))); }
  pause() { this.playing = false; if (this.animationFrame) cancelAnimationFrame(this.animationFrame); this.animationFrame = null; }
  seek(time) { this.pause(); this.playheadMs = Math.max(0, Math.min(this.durationMs, Number(time) || 0)); this.render(); }
  play() {
    this.pause(); if (!this.hasAnimation) return;
    this.playing = true;
    const start = performance.now() - this.playheadMs;
    const tick = () => {
      if (!this.playing) return;
      this.playheadMs = (performance.now() - start) % (this.durationMs || 1);
      if (!this.busy) this.render();
      this.animationFrame = requestAnimationFrame(tick);
    };
    this.animationFrame = requestAnimationFrame(tick);
  }
  _refreshAnimationPreview(layer) {
    if (!layer.animation) return;
    const ctx = layer.canvas.getContext('2d'); ctx.clearRect(0, 0, this.width, this.height);
    drawAnimation(ctx, layer.animation, 0);
  }
  async importGif(file) {
    this._assertReady();
    if (this.layers.length >= MAX_LAYERS) throw new Error('В одном проекте может быть до 16 слоёв.');
    this._checkLayerBudget(this.layers.length + 1);
    const existingPixels = (this.layers.length + 1) * this.width * this.height + this.layers.reduce((sum, layer) => sum + (layer.animation ? animationPixels(layer.animation) : 0), 0);
    this.busy = true;
    try {
      const animation = await decodeGif(file, MAX_ANIMATION_PIXELS - existingPixels);
      const frame = animation.frames[0].canvas;
      const scale = Math.min(1, this.width / frame.width, this.height / frame.height);
      animation.matrix = [scale, 0, 0, scale, (this.width - frame.width * scale) / 2, (this.height - frame.height * scale) / 2];
      const layer = this._layer((file.name || 'Анимация').replace(/\.gif$/i, ''));
      layer.animation = animation; this._refreshAnimationPreview(layer);
      this.layers.push(layer); this.activeId = layer.id;
      this._commit('Добавлена GIF-анимация'); this.play();
    } finally { this.busy = false; this._notify(); }
  }
  async exportGif(progress) { this._assertReady(); this.busy = true; try { return await encodeGif(this, progress); } finally { this.busy = false; } }

  _layer(name = 'Новый слой') {
    return { id: uid(), name: String(name).slice(0, 100), visible: true, opacity: 1, canvas: surface(this.width, this.height) };
  }

  _assertReady() {
    if (this.busy) throw new Error('Дождитесь загрузки проекта.');
    if (this.drag) this._cancelDrag();
  }

  _checkLayerBudget(count = this.layers.length, width = this.width, height = this.height) {
    const animationSize = this.layers.reduce((sum, layer) => sum + (layer.animation ? animationPixels(layer.animation) : 0), 0);
    if (count * width * height + animationSize > MAX_PROJECT_PIXELS) throw new Error('Для этого размера слишком много слоёв или кадров GIF. Уменьшите изображение или удалите ненужные слои (лимит: 16 млн пикселей).');
  }

  _notify() { this.onChange(this); }

  _snapshot(label) {
    return {
      label, width: this.width, height: this.height, activeId: this.activeId,
      layers: this.layers.map(layer => ({ ...layer, canvas: copyCanvas(layer.canvas) })),
      bytes: (this.width * this.height * this.layers.length + this.layers.reduce((sum, layer) => sum + (layer.animation ? animationPixels(layer.animation) : 0), 0)) * 4,
    };
  }

  _commit(label) {
    if (!this.hasAnimation) { this.pause(); this.playheadMs = 0; }
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(this._snapshot(label));
    this.historyBytes = this.history.reduce((total, item) => total + item.bytes, 0);
    while (this.history.length > 1 && (this.historyBytes > HISTORY_BUDGET || this.history.length > MAX_HISTORY)) {
      this.historyBytes -= this.history.shift().bytes;
    }
    this.historyIndex = this.history.length - 1;
    this.render();
    this._notify();
  }

  _resetHistory(label) {
    this.history = [];
    this.historyIndex = -1;
    this._commit(label);
  }

  newDocument(width, height, background = 'transparent') {
    this._assertReady();
    this.pause(); this.playheadMs = 0;
    [this.width, this.height] = validateDimensions(width, height);
    const layer = this._layer(background === 'transparent' ? 'Слой 1' : 'Фон');
    if (background !== 'transparent') {
      const ctx = layer.canvas.getContext('2d');
      ctx.fillStyle = background === 'white' ? '#ffffff' : safeColor(background);
      ctx.fillRect(0, 0, this.width, this.height);
    }
    this.layers = [layer];
    this.activeId = layer.id;
    this.selection = null;
    this._resetHistory('Новый документ');
  }

  createDemo() {
    this._assertReady();
    this.width = 1200;
    this.height = 900;
    const background = this._layer('01 · Тёплая бумага');
    let ctx = background.canvas.getContext('2d');
    ctx.fillStyle = '#f3efdf'; ctx.fillRect(0, 0, 1200, 900);
    ctx.strokeStyle = '#dedacb'; ctx.lineWidth = 1;
    ctx.strokeRect(32, 32, 1136, 836);
    const orbit = this._layer('02 · Солнце и пространство');
    ctx = orbit.canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(640, 140, 1030, 665);
    gradient.addColorStop(0, '#ffad69'); gradient.addColorStop(.5, '#f88053'); gradient.addColorStop(1, '#e94c40');
    ctx.fillStyle = gradient;
    ctx.beginPath(); ctx.arc(859, 409, 276, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#242d55';
    ctx.beginPath(); ctx.moveTo(780, 590); ctx.bezierCurveTo(890, 300, 1170, 395, 1200, 565); ctx.lineTo(1200, 900); ctx.lineTo(505, 900); ctx.bezierCurveTo(470, 700, 680, 830, 780, 590); ctx.fill();
    ctx.strokeStyle = '#f3efdf'; ctx.lineWidth = 2;
    for (let offset = 0; offset < 6; offset++) {
      ctx.beginPath(); ctx.moveTo(710 + offset * 20, 900);
      ctx.bezierCurveTo(610 + offset * 26, 710, 1070 + offset * 18, 600, 1200, 711 + offset * 22); ctx.stroke();
    }
    ctx.strokeStyle = '#242d55'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(853, 405, 333, 88, -.56, Math.PI * 1.03, Math.PI * 2.03); ctx.stroke();
    ctx.fillStyle = '#242d55'; ctx.beginPath(); ctx.arc(616, 189, 11, 0, Math.PI * 2); ctx.fill();
    const title = this._layer('03 · Типографика');
    ctx = title.canvas.getContext('2d'); ctx.fillStyle = '#242d55';
    ctx.font = '600 19px Arial, sans-serif'; ctx.fillText('PIXEL STUDIO  /  CREATIVE PLAYGROUND', 65, 75);
    ctx.font = '900 148px Arial, sans-serif';
    ctx.fillText('MAKE', 59, 330); ctx.fillText('SOME', 59, 475); ctx.fillText('SPACE.', 59, 620);
    ctx.font = '400 21px Arial, sans-serif'; ctx.fillText('Место для ваших идей.', 66, 770);
    ctx.font = '400 16px Arial, sans-serif'; ctx.fillText('ДВИГАЙТЕ СЛОИ. МЕНЯЙТЕ ЦВЕТ. СОЗДАВАЙТЕ.', 66, 803);
    ctx.fillStyle = '#f3efdf'; ctx.font = '600 19px Arial, sans-serif'; ctx.fillText('01 — ∞', 1035, 805);
    this.layers = [background, orbit, title];
    this.activeId = title.id;
    this.selection = null;
    this._resetHistory('Демо-проект');
  }

  addLayer(name) {
    this._assertReady();
    if (this.layers.length >= MAX_LAYERS) throw new Error('В одном проекте может быть до 16 слоёв.');
    this._checkLayerBudget(this.layers.length + 1);
    const layer = this._layer(name || `Слой ${this.layers.length + 1}`);
    const index = this.layers.findIndex(item => item.id === this.activeId);
    this.layers.splice(index + 1, 0, layer);
    this.activeId = layer.id;
    this._commit('Добавлен слой');
    return layer;
  }

  selectLayer(id) {
    this._assertReady();
    if (this.layers.some(layer => layer.id === id)) this.activeId = id;
    this.render(); this._notify();
  }

  deleteLayer() {
    this._assertReady();
    if (this.layers.length <= 1) throw new Error('В проекте должен остаться хотя бы один слой.');
    const index = this.layers.findIndex(layer => layer.id === this.activeId);
    if (index < 0) return;
    this.layers.splice(index, 1);
    this.activeId = this.layers[Math.min(index, this.layers.length - 1)].id;
    this._commit('Удалён слой');
  }

  duplicateLayer() {
    this._assertReady();
    if (!this.active) return;
    if (this.layers.length >= MAX_LAYERS) throw new Error('В одном проекте может быть до 16 слоёв.');
    this._checkLayerBudget(this.layers.length + 1);
    if (this.active.animation) {
      const pixels = (this.layers.length + 1) * this.width * this.height + this.layers.reduce((sum, layer) => sum + (layer.animation ? animationPixels(layer.animation) : 0), animationPixels(this.active.animation));
      if (pixels > MAX_PROJECT_PIXELS) throw new Error('Недостаточно памяти для дублирования GIF-слоя.');
    }
    const layer = { ...this.active, id: uid(), name: `${this.active.name} — копия`.slice(0, 100), canvas: copyCanvas(this.active.canvas) };
    const index = this.layers.findIndex(item => item.id === this.activeId);
    this.layers.splice(index + 1, 0, layer);
    this.activeId = layer.id;
    this._commit('Дубликат слоя');
    return layer;
  }

  toggleLayer(id) {
    this._assertReady();
    const layer = this.layers.find(item => item.id === id);
    if (!layer) return;
    layer.visible = !layer.visible;
    this._commit(layer.visible ? 'Слой показан' : 'Слой скрыт');
  }

  setLayerOpacity(value) {
    this._assertReady();
    if (!this.active) return;
    const opacity = clamp(value, 0, 1);
    if (this.active.opacity === opacity) return;
    this.active.opacity = opacity;
    this._commit('Прозрачность слоя');
  }

  renameLayer(id, name) {
    this._assertReady();
    const layer = this.layers.find(item => item.id === id);
    if (!layer || !String(name).trim()) return;
    const nextName = String(name).trim().slice(0, 100);
    if (layer.name === nextName) return;
    layer.name = nextName;
    this._commit('Слой переименован');
  }

  moveLayer(delta) {
    this._assertReady();
    if (!Number.isFinite(delta) || delta === 0) return;
    const index = this.layers.findIndex(layer => layer.id === this.activeId);
    const destination = index + Math.sign(delta);
    if (index < 0 || destination < 0 || destination >= this.layers.length) return;
    [this.layers[index], this.layers[destination]] = [this.layers[destination], this.layers[index]];
    this._commit('Порядок слоёв');
  }

  _restore(snapshot) {
    this.width = snapshot.width; this.height = snapshot.height;
    this.layers = snapshot.layers.map(layer => ({ ...layer, canvas: copyCanvas(layer.canvas) }));
    this.activeId = snapshot.activeId;
    this.selection = null;
    if (!this.hasAnimation) { this.pause(); this.playheadMs = 0; }
    this.render(); this._notify();
  }

  undo() {
    this._assertReady();
    if (this.canUndo) this._restore(this.history[--this.historyIndex]);
  }

  redo() {
    this._assertReady();
    if (this.canRedo) this._restore(this.history[++this.historyIndex]);
  }

  setTool(tool) {
    this._assertReady();
    if (!TOOLS.has(tool)) return;
    this.tool = tool;
    if (tool !== 'crop') this.selection = null;
    this.canvas.style.cursor = tool === 'move' ? 'move' : tool === 'text' ? 'text' : 'crosshair';
    this.render(); this._notify();
  }

  async importImage(file) {
    this._assertReady();
    if (file.type === 'image/gif' || /\.gif$/i.test(file.name || '')) return this.importGif(file);
    if (this.layers.length >= MAX_LAYERS) throw new Error('В одном проекте может быть до 16 слоёв.');
    this._checkLayerBudget(this.layers.length + 1);
    if (!(file instanceof Blob) || file.size > 25 * 1024 * 1024) throw new Error('Выберите изображение размером до 25 МБ.');
    if (file.type && !/^image\/(png|jpeg|webp|gif|avif|bmp)$/i.test(file.type)) throw new Error('Поддерживаются PNG, JPG, WebP, GIF, AVIF и BMP.');
    const url = URL.createObjectURL(file);
    this.busy = true;
    try {
      const image = await loadImage(url);
      if (image.width * image.height > 64_000_000) throw new Error('Изображение слишком большое: максимум 64 мегапикселя.');
      const layer = this._layer((file.name || 'Изображение').replace(/\.[^.]+$/, ''));
      const scale = Math.min(1, this.width / image.width, this.height / image.height);
      const w = Math.round(image.width * scale), h = Math.round(image.height * scale);
      layer.canvas.getContext('2d').drawImage(image, Math.round((this.width - w) / 2), Math.round((this.height - h) / 2), w, h);
      this.layers.push(layer);
      this.activeId = layer.id;
      this._commit('Импорт изображения');
      return layer;
    } finally { URL.revokeObjectURL(url); this.busy = false; this._notify(); }
  }

  serialize() {
    this._assertReady();
    return {
      version: this.hasAnimation ? 2 : 1, width: this.width, height: this.height, activeId: this.activeId,
      layers: this.layers.map(({ id, name, visible, opacity, canvas, animation }) => ({ id, name, visible, opacity, image: canvas.toDataURL('image/png'), ...(animation ? {animation: {matrix: animation.matrix, width: animation.frames[0].canvas.width, height: animation.frames[0].canvas.height, frames: animation.frames.map(frame => ({image: frame.canvas.toDataURL('image/png'), delay: frame.delay}))}} : {}) })),
    };
  }

  async loadProject(project) {
    this._assertReady();
    if (!project || ![1, 2].includes(project.version) || !Array.isArray(project.layers) || project.layers.length < 1 || project.layers.length > MAX_LAYERS) throw new Error('Неверный формат проекта Pixel Studio.');
    const [width, height] = validateDimensions(project.width, project.height);
    if (project.layers.length * width * height > MAX_PROJECT_PIXELS) throw new Error('Слишком много крупных слоёв.');
    const ids = new Set();
    let sourceBytes = 0, projectPixels = project.layers.length * width * height;
    for (const layer of project.layers) {
      if (!layer || typeof layer.image !== 'string') throw new Error('В проекте обнаружено неверное изображение слоя.');
      sourceBytes += layer.image.length;
      if (sourceBytes > 64 * 1024 * 1024) throw new Error('Файл проекта превышает 64 МБ.');
      validatePngDimensions(layer.image, width, height);
      if (layer.animation) {
        const a = layer.animation;
        validateDimensions(a.width, a.height);
        if (!Array.isArray(a.matrix) || a.matrix.length !== 6 || a.matrix.some(value => !Number.isFinite(value) || Math.abs(value) > 65536) || !Array.isArray(a.frames) || !a.frames.length || a.frames.length > 120) throw new Error('Повреждён GIF-слой.');
        projectPixels += a.width * a.height * a.frames.length;
        if (projectPixels > MAX_PROJECT_PIXELS) throw new Error('Слишком много пикселей в GIF-слоях.');
        let duration = 0;
        for (const frame of a.frames) {
          if (!Number.isInteger(frame.delay) || frame.delay < 10 || frame.delay > 60000) throw new Error('Неверная задержка кадра GIF.');
          duration += frame.delay; sourceBytes += frame.image?.length || 0;
          if (sourceBytes > 64 * 1024 * 1024 || duration > 60000) throw new Error('GIF-проект превышает допустимый размер или длительность.');
          validatePngDimensions(frame.image, a.width, a.height);
        }
      }
    }
    this.busy = true;
    try {
      const layers = [];
      for (const source of project.layers) {
        const image = await loadImage(source.image);
        if (image.width !== width || image.height !== height) throw new Error('Размер слоя не совпадает с размером проекта.');
        const id = typeof source.id === 'string' && source.id.length <= 100 && !ids.has(source.id) ? source.id : uid();
        ids.add(id);
        const canvas = surface(width, height);
        canvas.getContext('2d').drawImage(image, 0, 0);
        const layer = { id, name: String(source.name || 'Слой').slice(0, 100), visible: source.visible !== false, opacity: source.opacity == null ? 1 : clamp(source.opacity, 0, 1), canvas };
        if (source.animation) {
          const frames = [];
          for (const frame of source.animation.frames) {
            const image = await loadImage(frame.image), output = surface(source.animation.width, source.animation.height);
            output.getContext('2d').drawImage(image, 0, 0); frames.push({canvas: output, delay: frame.delay});
          }
          layer.animation = {frames, matrix: [...source.animation.matrix]};
        }
        layers.push(layer);
      }
      this.pause(); this.playheadMs = 0;
      this.width = width; this.height = height;
      this.layers = layers;
      this.activeId = ids.has(project.activeId) ? project.activeId : layers[layers.length - 1].id;
      this.selection = null;
      this._resetHistory('Проект открыт');
    } finally { this.busy = false; this._notify(); }
  }

  _composite(target, includePreview = false, time = this.playheadMs) {
    const ctx = target.getContext('2d');
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.save();
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      ctx.globalAlpha = layer.opacity;
      if (layer.animation) {
        drawAnimation(ctx, includePreview && this.drag?.layerId === layer.id && this.drag.previewAnimation ? this.drag.previewAnimation : layer.animation, time);
        continue;
      }
      const source = includePreview && this.drag?.layerId === layer.id && this.drag.preview ? this.drag.preview : layer.canvas;
      ctx.drawImage(source, 0, 0);
    }
    ctx.restore();
  }

  render() {
    if (this.canvas.width !== this.width) this.canvas.width = this.width;
    if (this.canvas.height !== this.height) this.canvas.height = this.height;
    this._composite(this.canvas, true);
    if (this.selection && this.tool === 'crop') {
      const { x, y, width, height } = this.selection;
      const ctx = this.context;
      const rect = this.canvas.getBoundingClientRect();
      const unit = rect.width ? this.width / rect.width : 1;
      ctx.save();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2 * unit;
      ctx.setLineDash([6 * unit, 5 * unit]); ctx.strokeRect(x, y, width, height);
      ctx.strokeStyle = '#24232e'; ctx.lineDashOffset = 6 * unit; ctx.strokeRect(x, y, width, height);
      ctx.restore();
    }
  }

  exportImage(type = 'image/png') {
    this._assertReady();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) type = 'image/png';
    const output = surface(this.width, this.height);
    this._composite(output);
    if (type === 'image/jpeg') {
      const ctx = output.getContext('2d');
      ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, this.width, this.height);
    }
    return output.toDataURL(type, .94);
  }

  _position(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * this.width / rect.width, y: (event.clientY - rect.top) * this.height / rect.height };
  }

  _pointerDown(event) {
    if (this.busy || this.drag || event.button !== 0 || !this.active) return;
    event.preventDefault();
    const point = this._position(event);
    if (this.tool === 'eyedropper') {
      const output = surface(this.width, this.height); this._composite(output);
      const rgba = output.getContext('2d').getImageData(clamp(Math.floor(point.x), 0, this.width - 1), clamp(Math.floor(point.y), 0, this.height - 1), 1, 1).data;
      this.color = `#${Array.from(rgba.slice(0, 3)).map(value => value.toString(16).padStart(2, '0')).join('')}`;
      this._notify(); return;
    }
    if (this.tool !== 'crop' && !this.active.visible) return;
    if (this.active.animation && !['move', 'crop', 'eyedropper'].includes(this.tool)) {
      if (this.tool === 'eraser') { this.onNotice('Для ластика выберите обычный слой. GIF сохраняет все кадры.'); return; }
      this.addLayer(this.tool === 'text' ? 'Текст над GIF' : 'Рисунок над GIF');
      this.onNotice('Создан обычный слой поверх GIF — анимация сохранена.');
    }
    if (this.tool === 'text') {
      const value = String(this.textValue || '').slice(0, 5000);
      if (!value.trim()) return;
      const ctx = this.active.canvas.getContext('2d'); ctx.save();
      ctx.globalAlpha = clamp(this.opacity, 0, 1); ctx.fillStyle = safeColor(this.color);
      const size = clamp(this.fontSize, 8, 1024);
      ctx.font = `600 ${size}px Arial, sans-serif`; ctx.textBaseline = 'top';
      value.split('\n').forEach((line, index) => ctx.fillText(line, point.x, point.y + index * size * 1.2));
      ctx.restore(); this._commit('Добавлен текст'); return;
    }
    if (this.tool === 'fill') { if (this._floodFill(point)) this._commit('Заливка'); return; }
    const source = this.tool === 'crop' ? null : copyCanvas(this.active.canvas);
    this.drag = { pointerId: event.pointerId, tool: this.tool, layerId: this.activeId, start: point, last: point, source, sourceAnimation: this.active.animation, preview: null, moved: false, previousSelection: this.selection };
    try { this.canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic events may not have an active pointer. */ }
    if (this.tool === 'brush' || this.tool === 'eraser') this._paint(point, point);
    if (this.tool === 'crop') this.selection = { x: Math.floor(point.x), y: Math.floor(point.y), width: 0, height: 0 };
    this.render();
  }

  _paint(from, to) {
    const layer = this.layers.find(item => item.id === this.drag.layerId);
    const ctx = layer.canvas.getContext('2d'); ctx.save();
    ctx.globalAlpha = clamp(this.opacity, 0, 1);
    ctx.globalCompositeOperation = this.drag.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = safeColor(this.color); ctx.fillStyle = safeColor(this.color);
    ctx.lineWidth = clamp(this.size, 1, 512); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (from.x === to.x && from.y === to.y) { ctx.beginPath(); ctx.arc(to.x, to.y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); }
    else { ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); }
    ctx.restore();
  }

  _pointerMove(event) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const point = this._position(event);
    drag.moved ||= Math.abs(point.x - drag.start.x) + Math.abs(point.y - drag.start.y) > 1;
    if (drag.tool === 'move' && drag.sourceAnimation) {
      const matrix = [...drag.sourceAnimation.matrix]; matrix[4] += Math.round(point.x - drag.start.x); matrix[5] += Math.round(point.y - drag.start.y);
      drag.previewAnimation = {...drag.sourceAnimation, matrix}; drag.last = point; this.render(); return;
    }
    if (drag.tool === 'brush' || drag.tool === 'eraser') {
      const events = event.getCoalescedEvents?.() || [];
      for (const item of events.length ? events : [event]) {
        const next = this._position(item);
        if (next.x !== drag.last.x || next.y !== drag.last.y) this._paint(drag.last, next);
        drag.last = next;
      }
    } else if (drag.tool === 'crop') {
      const x1 = clamp(Math.round(drag.start.x), 0, this.width), x2 = clamp(Math.round(point.x), 0, this.width);
      const y1 = clamp(Math.round(drag.start.y), 0, this.height), y2 = clamp(Math.round(point.y), 0, this.height);
      this.selection = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    } else {
      if (!drag.preview) drag.preview = surface(this.width, this.height);
      const ctx = drag.preview.getContext('2d'); ctx.clearRect(0, 0, this.width, this.height);
      if (drag.tool === 'move') {
        ctx.drawImage(drag.source, Math.round(point.x - drag.start.x), Math.round(point.y - drag.start.y));
      } else {
        ctx.drawImage(drag.source, 0, 0); ctx.save();
        ctx.fillStyle = safeColor(this.color); ctx.strokeStyle = safeColor(this.color);
        ctx.globalAlpha = clamp(this.opacity, 0, 1); ctx.lineWidth = clamp(this.size, 1, 512);
        let w = point.x - drag.start.x, h = point.y - drag.start.y;
        if (event.shiftKey) { const size = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * size; h = Math.sign(h || 1) * size; }
        ctx.beginPath();
        if (drag.tool === 'ellipse') ctx.ellipse(drag.start.x + w / 2, drag.start.y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
        else ctx.rect(drag.start.x, drag.start.y, w, h);
        if (this.shapeFilled) ctx.fill(); else ctx.stroke();
        ctx.restore();
      }
    }
    drag.last = point;
    this.render();
  }

  _pointerUp(event) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // Include the final pointer position even when the browser coalesces the last move.
    this._pointerMove(event);
    if (drag.previewAnimation) {
      const layer = this.layers.find(item => item.id === drag.layerId);
      layer.animation = drag.previewAnimation; this._refreshAnimationPreview(layer);
    }
    if (drag.preview) {
      const layer = this.layers.find(item => item.id === drag.layerId);
      const ctx = layer.canvas.getContext('2d'); ctx.clearRect(0, 0, this.width, this.height); ctx.drawImage(drag.preview, 0, 0);
    }
    this.drag = null;
    try { if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId); } catch { /* Already released. */ }
    if (drag.tool === 'crop') { this.render(); this._notify(); return; }
    const labels = { brush: 'Кисть', eraser: 'Ластик', move: 'Перемещение слоя', rectangle: 'Прямоугольник', ellipse: 'Эллипс' };
    if (drag.moved || drag.tool === 'brush' || drag.tool === 'eraser') this._commit(labels[drag.tool] || 'Изменение');
    else this.render();
  }

  _cancelDrag(event) {
    const drag = this.drag;
    if (!drag || (event && drag.pointerId !== event.pointerId)) return;
    if (drag.source) {
      const layer = this.layers.find(item => item.id === drag.layerId);
      if (layer) { const ctx = layer.canvas.getContext('2d'); ctx.clearRect(0, 0, this.width, this.height); ctx.drawImage(drag.source, 0, 0); }
    }
    if (drag.tool === 'crop') this.selection = drag.previousSelection;
    this.drag = null;
    try { if (this.canvas.hasPointerCapture(drag.pointerId)) this.canvas.releasePointerCapture(drag.pointerId); } catch { /* Already released. */ }
    this.render();
  }

  _floodFill(point) {
    const ctx = this.active.canvas.getContext('2d');
    const image = ctx.getImageData(0, 0, this.width, this.height), data = image.data;
    const startX = clamp(Math.floor(point.x), 0, this.width - 1), startY = clamp(Math.floor(point.y), 0, this.height - 1);
    const start = (startY * this.width + startX) * 4;
    const target = Array.from(data.slice(start, start + 4));
    const color = safeColor(this.color);
    const replacement = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16), Math.round(clamp(this.opacity, 0, 1) * 255)];
    if (target.every((value, index) => value === replacement[index])) return false;
    const match = (x, y) => { const i = (y * this.width + x) * 4; return data[i] === target[0] && data[i + 1] === target[1] && data[i + 2] === target[2] && data[i + 3] === target[3]; };
    // Scan-line fill avoids recursion and keeps the work list small on large canvases.
    const stack = [[startX, startY]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (!match(x, y)) continue;
      let left = x, right = x;
      while (left > 0 && match(left - 1, y)) left--;
      while (right < this.width - 1 && match(right + 1, y)) right++;
      let up = false, down = false;
      for (let px = left; px <= right; px++) {
        const i = (y * this.width + px) * 4;
        data.set(replacement, i);
        if (y > 0 && match(px, y - 1)) { if (!up) stack.push([px, y - 1]); up = true; } else up = false;
        if (y < this.height - 1 && match(px, y + 1)) { if (!down) stack.push([px, y + 1]); down = true; } else down = false;
      }
    }
    ctx.putImageData(image, 0, 0);
    return true;
  }

  applyFilter(name) {
    this._assertReady();
    if (!this.active) return;
    const filters = { grayscale: 'grayscale(1)', sepia: 'sepia(1)', invert: 'invert(1)', brightness: 'brightness(1.15)', darken: 'brightness(.85)', contrast: 'contrast(1.2)', saturate: 'saturate(1.35)', blur: 'blur(3px)' };
    if (!filters[name]) throw new Error('Этот фильтр не поддерживается.');
    if (this.active.animation) {
      const frames = this.active.animation.frames.map(frame => {
        const output = surface(frame.canvas.width, frame.canvas.height), ctx = output.getContext('2d');
        ctx.filter = filters[name]; ctx.drawImage(frame.canvas, 0, 0); return {...frame, canvas: output};
      });
      this.active.animation = {...this.active.animation, frames}; this._refreshAnimationPreview(this.active);
      this._commit('Фильтр GIF: ' + name); return;
    }
    const source = copyCanvas(this.active.canvas), ctx = this.active.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.width, this.height); ctx.save(); ctx.filter = filters[name]; ctx.drawImage(source, 0, 0); ctx.restore();
    this._commit('Фильтр: ' + ({ grayscale: 'чёрно-белый', sepia: 'сепия', invert: 'инверсия', brightness: 'светлее', darken: 'темнее', contrast: 'контраст', saturate: 'насыщенность', blur: 'размытие' }[name]));
  }

  rotateCanvas() {
    this._assertReady();
    const oldWidth = this.width, oldHeight = this.height;
    for (const layer of this.layers) {
      const output = surface(oldHeight, oldWidth), ctx = output.getContext('2d');
      ctx.translate(oldHeight, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(layer.canvas, 0, 0); layer.canvas = output;
      if (layer.animation) { const [a,b,c,d,e,f] = layer.animation.matrix; layer.animation = {...layer.animation, matrix: [-b,a,-d,c,oldHeight-f,e]}; }
    }
    this.width = oldHeight; this.height = oldWidth; this.selection = null;
    this._commit('Поворот на 90°');
  }

  flipHorizontal() {
    this._assertReady();
    if (!this.active) return;
    if (this.active.animation) {
      const [a,b,c,d,e,f] = this.active.animation.matrix;
      this.active.animation = {...this.active.animation, matrix: [-a,b,-c,d,this.width-e,f]};
      this._refreshAnimationPreview(this.active); this._commit('Отражение GIF-слоя'); return;
    }
    const source = copyCanvas(this.active.canvas), ctx = this.active.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.width, this.height); ctx.save(); ctx.translate(this.width, 0); ctx.scale(-1, 1); ctx.drawImage(source, 0, 0); ctx.restore();
    this._commit('Отражение слоя');
  }

  resizeCanvas(width, height, method = 'smooth') {
    this._assertReady();
    [width, height] = validateDimensions(width, height);
    this._checkLayerBudget(this.layers.length, width, height);
    if (!['smooth', 'nearest'].includes(method)) throw new Error('Неизвестный способ масштабирования.');
    if (width === this.width && height === this.height) return;
    // Prepare every layer before changing the document, so a failed allocation
    // cannot leave layers at different dimensions. Halve large reductions in
    // stages to retain thin details instead of sampling them away in one pass.
    const resized = this.layers.map(layer => {
      let source = layer.canvas;
      if (method === 'smooth') {
        while (source.width >= width * 2 || source.height >= height * 2) {
          const next = surface(Math.max(width, Math.floor(source.width / 2)), Math.max(height, Math.floor(source.height / 2)));
          const ctx = next.getContext('2d');
          ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(source, 0, 0, next.width, next.height);
          if (source !== layer.canvas) { source.width = 1; source.height = 1; }
          source = next;
        }
      }
      const output = surface(width, height), ctx = output.getContext('2d');
      ctx.imageSmoothingEnabled = method !== 'nearest'; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, width, height);
      if (source !== layer.canvas) { source.width = 1; source.height = 1; }
      return output;
    });
    this.layers.forEach((layer, index) => {
      layer.canvas = resized[index];
      if (layer.animation) { const [a,b,c,d,e,f] = layer.animation.matrix, sx = width / this.width, sy = height / this.height; layer.animation = {...layer.animation, matrix: [a*sx,b*sy,c*sx,d*sy,e*sx,f*sy]}; }
    });
    this.width = width; this.height = height; this.selection = null;
    this.layers.forEach(layer => this._refreshAnimationPreview(layer));
    this._commit('Изменён размер изображения');
  }

  cropToSelection() {
    this._assertReady();
    if (!this.selection || this.selection.width < 1 || this.selection.height < 1) throw new Error('Выделите область кадрирования на холсте.');
    const { x, y, width, height } = this.selection;
    for (const layer of this.layers) {
      const output = surface(width, height);
      output.getContext('2d').drawImage(layer.canvas, x, y, width, height, 0, 0, width, height); layer.canvas = output;
      if (layer.animation) { const matrix = [...layer.animation.matrix]; matrix[4] -= x; matrix[5] -= y; layer.animation = {...layer.animation, matrix}; }
    }
    this.width = width; this.height = height; this.selection = null;
    this._commit('Кадрирование');
  }

  destroy() {
    this.pause();
    this._cancelDrag();
    Object.entries(this.handlers).forEach(([name, handler]) => this.canvas.removeEventListener(name, handler));
    this.history = []; this.layers = [];
  }
}
