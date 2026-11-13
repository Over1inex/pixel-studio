import {parseGIF, decompressFrame} from 'gifuct-js';
import gifenc from 'gifenc';
const {GIFEncoder, quantize, applyPalette} = gifenc;

export const MAX_ANIMATION_PIXELS = 16_777_216;
export function frameIndexAt(animation, time) {
  const duration = animation.frames.reduce((sum, frame) => sum + frame.delay, 0);
  let position = ((time % duration) + duration) % duration;
  for (let i = 0; i < animation.frames.length; i++) {
    if (position < animation.frames[i].delay) return i;
    position -= animation.frames[i].delay;
  }
  return 0;
}
export function animationDuration(animation) { return animation.frames.reduce((sum, frame) => sum + frame.delay, 0); }
export function animationPixels(animation) { return animation.frames.reduce((sum, frame) => sum + frame.canvas.width * frame.canvas.height, 0); }
export function drawAnimation(ctx, animation, time) {
  ctx.save(); ctx.transform(...animation.matrix);
  ctx.drawImage(animation.frames[frameIndexAt(animation, time)].canvas, 0, 0); ctx.restore();
}
function canvas(width, height) { const value = document.createElement('canvas'); value.width = width; value.height = height; return value; }
export async function decodeGif(file, pixelBudget = MAX_ANIMATION_PIXELS) {
  if (file.size > 25 * 1024 * 1024) throw new Error('GIF должна быть меньше 25 МБ.');
  const bytes = await file.arrayBuffer();
  if (!/^GIF8[79]a$/.test(String.fromCharCode(...new Uint8Array(bytes, 0, Math.min(6, bytes.byteLength))))) throw new Error('Файл не является GIF.');
  const parsed = parseGIF(bytes), width = parsed.lsd.width, height = parsed.lsd.height;
  const sourceFrames = parsed.frames.filter(frame => frame.image);
  if (!width || !height || width > 4096 || height > 4096 || !sourceFrames.length || sourceFrames.length > 120 || width * height * sourceFrames.length > pixelBudget) {
    throw new Error('GIF слишком большая: до 120 кадров, 4096 px по стороне и 16 млн пикселей во всех кадрах и слоях проекта.');
  }
  for (const raw of sourceFrames) {
    const d = raw.image.descriptor;
    if (!d.width || !d.height || d.left + d.width > width || d.top + d.height > height) throw new Error('Повреждённые размеры кадра GIF.');
  }
  const composed = canvas(width, height), ctx = composed.getContext('2d'), frames = [];
  const background = parsed.gct?.[parsed.lsd.backgroundColorIndex];
  if (!sourceFrames[0].gce?.extras?.transparentColorGiven && background) { ctx.fillStyle = `rgb(${background.join(',')})`; ctx.fillRect(0, 0, width, height); }
  for (const raw of sourceFrames) {
    const frame = decompressFrame(raw, parsed.gct, true), {dims} = frame;
    const previous = frame.disposalType === 3 ? ctx.getImageData(0, 0, width, height) : null;
    const patch = canvas(dims.width, dims.height);
    patch.getContext('2d').putImageData(new ImageData(frame.patch, dims.width, dims.height), 0, 0);
    ctx.drawImage(patch, dims.left, dims.top); patch.width = patch.height = 1;
    const output = canvas(width, height); output.getContext('2d').drawImage(composed, 0, 0);
    frames.push({canvas: output, delay: Math.max(10, frame.delay || 100)});
    if (frame.disposalType === 2) {
      ctx.clearRect(dims.left, dims.top, dims.width, dims.height);
      if (frame.transparentIndex === undefined && background) { ctx.fillStyle = `rgb(${background.join(',')})`; ctx.fillRect(dims.left, dims.top, dims.width, dims.height); }
    } else if (previous) ctx.putImageData(previous, 0, 0);
    if (frames.length % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  const animation = {frames, matrix: [1, 0, 0, 1, 0, 0]};
  if (animationDuration(animation) > 60000) throw new Error('Длительность GIF должна быть не больше 60 секунд.');
  return animation;
}
export function exportSchedule(animations) {
  const duration = Math.max(...animations.map(animationDuration));
  const boundaries = new Set([0, duration]);
  for (const animation of animations) {
    const period = animationDuration(animation);
    for (let loop = 0; loop < duration; loop += period) {
      let time = loop;
      for (const frame of animation.frames) { if (time < duration) boundaries.add(time); time += frame.delay; }
      if (boundaries.size > 600) throw new Error('Слишком много кадров для экспорта: сократите GIF или используйте меньше анимированных слоёв.');
    }
  }
  const times = [...boundaries].sort((a, b) => a - b);
  return times.slice(0, -1).map((time, index) => ({time, delay: times[index + 1] - time}));
}
export async function encodeGif(editor, onProgress = () => {}) {
  const animations = editor.layers.filter(layer => layer.visible && layer.animation).map(layer => layer.animation);
  const schedule = animations.length ? exportSchedule(animations) : [{time: 0, delay: 100}];
  if (schedule.length * editor.width * editor.height > 150_000_000) throw new Error('Для экспорта GIF уменьшите размер изображения: максимум 150 млн пикселей по всем кадрам.');
  const output = canvas(editor.width, editor.height), ctx = output.getContext('2d'), gif = GIFEncoder();
  for (let i = 0; i < schedule.length; i++) {
    editor._composite(output, false, schedule[i].time);
    const {data} = ctx.getImageData(0, 0, editor.width, editor.height);
    const palette = quantize(data, 256, {format: 'rgba4444', oneBitAlpha: true, clearAlpha: true});
    const index = applyPalette(data, palette, 'rgba4444'), transparentIndex = palette.findIndex(color => color[3] === 0);
    gif.writeFrame(index, editor.width, editor.height, {palette, delay: schedule[i].delay, repeat: 0, transparent: transparentIndex >= 0, transparentIndex: Math.max(0, transparentIndex), dispose: 2});
    onProgress(Math.round((i + 1) / schedule.length * 100));
    if (i % 3 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  gif.finish(); return new Blob([gif.bytes()], {type: 'image/gif'});
}
