import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanvas, ImageData, Image} from '@napi-rs/canvas';
import gifenc from 'gifenc';
import {parseGIF, decompressFrames} from 'gifuct-js';
import {decodeGif, frameIndexAt, exportSchedule} from '../public/animation.js';
import {Editor} from '../public/editor.js';
globalThis.ImageData = ImageData; globalThis.Image = Image;
globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
function surface(width=1,height=1) {
  const canvas=createCanvas(width,height); canvas.style={}; canvas.addEventListener=()=>{}; canvas.removeEventListener=()=>{};
  canvas.getBoundingClientRect=()=>({left:0,top:0,width:canvas.width,height:canvas.height}); return canvas;
}
globalThis.document={createElement:()=>surface()};
function fixture(dispose=3) {
  const gif=gifenc.GIFEncoder(), palette=[[0,0,0],[255,0,0],[0,0,255],[0,255,0]];
  for (const [pixels,delay,disposal] of [[new Uint8Array([1,1,1,1]),100,1],[new Uint8Array([2,0,0,0]),200,dispose],[new Uint8Array([0,0,0,3]),100,1]]) gif.writeFrame(pixels,2,2,{palette,delay,dispose:disposal,transparent:true,transparentIndex:0});
  gif.finish(); return new File([gif.bytes()],'fixture.gif',{type:'image/gif'});
}
const pixel=(canvas,x,y)=>Array.from(canvas.getContext('2d').getImageData(x,y,1,1).data);
test('GIF decoding composites transparent patches and restores disposal 3/2 correctly',async()=>{
  const animation=await decodeGif(fixture());
  assert.deepEqual(animation.frames.map(f=>f.delay),[100,200,100]);
  assert.deepEqual(pixel(animation.frames[1].canvas,0,0),[0,0,255,255]);
  assert.deepEqual(pixel(animation.frames[2].canvas,0,0),[255,0,0,255]);
  assert.deepEqual(pixel(animation.frames[2].canvas,1,1),[0,255,0,255]);
  const cleared=await decodeGif(fixture(2)); assert.equal(pixel(cleared.frames[2].canvas,0,0)[3],0);
  assert.equal(frameIndexAt(animation,100),1); assert.equal(frameIndexAt(animation,400),0);
});
test('GIF and static overlays survive resize, undo, project reload and animated export',async()=>{
  const editor=new Editor(surface()); editor.newDocument(2,2,'transparent'); await editor.importGif(fixture()); editor.pause();
  editor.addLayer('Static overlay'); const ctx=editor.active.canvas.getContext('2d'); ctx.fillStyle='#ffff00'; ctx.fillRect(1,0,1,1); editor._commit('Overlay painted');
  editor.resizeCanvas(4,4); assert.equal(editor.layers[1].animation.frames[0].canvas.width,2);
  assert.deepEqual(editor.layers[1].animation.matrix,[2,0,0,2,0,0]);
  editor.undo(); assert.deepEqual(editor.layers[1].animation.matrix,[1,0,0,1,0,0]);
  const document=editor.serialize(); assert.equal(document.version,2);
  const reopened=new Editor(surface()); await reopened.loadProject(document);
  const output=await reopened.exportGif(); const frames=decompressFrames(parseGIF(await output.arrayBuffer()),true);
  assert.equal(frames.length,3); assert.deepEqual(frames.map(f=>f.delay),[100,200,100]);
  for(const frame of frames) assert.deepEqual(Array.from(frame.patch.slice(4,8)),[255,255,0,255]);
  editor.destroy(); reopened.destroy();
});
test('mixed GIF schedules retain all frame boundaries and reject excessive decoded size',async()=>{
  const schedule=exportSchedule([{frames:[{delay:100},{delay:200}]},{frames:[{delay:150},{delay:150}]}]);
  assert.deepEqual(schedule,[{time:0,delay:100},{time:100,delay:50},{time:150,delay:150}]);
  await assert.rejects(decodeGif(fixture(),4),/слишком большая/);
});
