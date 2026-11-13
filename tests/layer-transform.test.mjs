import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanvas,Image,ImageData} from '@napi-rs/canvas';
import {Editor} from '../public/editor.js';
globalThis.Image=Image;globalThis.ImageData=ImageData;
globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};
function canvas(width=1,height=1){const c=createCanvas(width,height);c.style={};c.addEventListener=()=>{};c.removeEventListener=()=>{};c.getBoundingClientRect=()=>({left:0,top:0,width:c.width,height:c.height});return c;}
globalThis.document={createElement:()=>canvas()};
const bytes=c=>Buffer.from(c.getContext('2d').getImageData(0,0,c.width,c.height).data);
const point=(x,y,extra={})=>({pointerId:1,button:0,clientX:x,clientY:y,preventDefault(){},...extra});
function scene(){const ed=new Editor(canvas());ed.newDocument(80,60,'#ffffff');ed.addLayer('Picture');const ctx=ed.active.canvas.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(20,20,20,10);ed._commit('Picture');return ed;}

test('exact layer resize changes only selected pixels and preserves document, background and center',()=>{
 const ed=scene(),bg=ed.layers[0],before=bytes(bg.canvas),old=ed.activeId,count=ed.history.length;
 ed.resizeActiveLayer(10,6,'nearest');
 assert.deepEqual([ed.width,ed.height],[80,60]);assert.equal(ed.layers[0],bg);assert.deepEqual(bytes(bg.canvas),before);assert.equal(ed.activeId,old);
 assert.deepEqual(ed.getActiveLayerBounds(),{x:25,y:22,width:10,height:6});assert.equal(ed.history.length,count+1);
 ed.undo();assert.deepEqual(ed.getActiveLayerBounds(),{x:20,y:20,width:20,height:10});ed.redo();assert.equal(ed.getActiveLayerBounds().width,10);ed.destroy();
});

test('transform is a cancellable preview with one history entry for several drags',()=>{
 const ed=scene(),original=bytes(ed.active.canvas),count=ed.history.length;
 ed.beginTransform();ed.transformPointerDown(point(40,30),'se');ed.transformPointerMove(point(60,40));ed.transformPointerUp(point(60,40));
 assert.deepEqual(ed.transformState.bounds,{x:20,y:20,width:40,height:20});assert.deepEqual(bytes(ed.active.canvas),original);assert.equal(ed.history.length,count);
 assert.throws(()=>ed.serialize(),/примените/);ed.cancelTransform();assert.deepEqual(bytes(ed.active.canvas),original);assert.equal(ed.history.length,count);
 ed.beginTransform();ed.previewTransform({x:10,y:10,width:30,height:15});ed.previewTransform({x:12,y:12,width:40,height:20});ed.applyTransform();
 assert.deepEqual(ed.getActiveLayerBounds(),{x:12,y:12,width:40,height:20});assert.equal(ed.history.length,count+1);ed.undo();assert.deepEqual(bytes(ed.active.canvas),original);ed.destroy();
});

test('corner anchor and Shift unlock work; cancelled pointer restores its preceding bounds',()=>{
 const ed=scene();ed.beginTransform();ed.transformPointerDown(point(20,20),'nw');ed.transformPointerMove(point(10,15));
 assert.deepEqual(ed.transformState.bounds,{x:10,y:15,width:30,height:15});ed.transformPointerUp(point(10,15),true);
 assert.deepEqual(ed.transformState.bounds,{x:20,y:20,width:20,height:10});
 ed.transformPointerDown(point(40,30),'se');ed.transformPointerUp(point(50,50,{shiftKey:true}));assert.deepEqual(ed.transformState.bounds,{x:20,y:20,width:30,height:30});ed.cancelTransform();ed.destroy();
});

test('empty layers and invalid sizes fail without altering pixels or history',()=>{
 const ed=scene(),before=bytes(ed.active.canvas),count=ed.history.length;
 assert.throws(()=>ed.resizeActiveLayer(0,8));assert.throws(()=>ed.resizeActiveLayer(4096,4096));assert.deepEqual(bytes(ed.active.canvas),before);assert.equal(ed.history.length,count);
 ed.resizeActiveLayer(20,10);assert.equal(ed.history.length,count);ed.addLayer();assert.throws(()=>ed.beginTransform(),/пуст/);assert.equal(ed.transformState,null);ed.destroy();
});

test('document rotation then click and move does not reuse a rotated drawing context',()=>{
 const ed=scene();ed.rotateCanvas();const before=bytes(ed.active.canvas),m=ed.active.canvas.getContext('2d').getTransform();
 assert.deepEqual([m.a,m.b,m.c,m.d,m.e,m.f],[1,0,0,1,0,0]);ed.setTool('move');ed._pointerDown(point(25,25));ed._pointerUp(point(25,25));assert.deepEqual(bytes(ed.active.canvas),before);
 const bounds=ed.getActiveLayerBounds();ed._pointerDown(point(25,25));ed._pointerUp(point(28,27));assert.deepEqual(ed.getActiveLayerBounds(),{...bounds,x:bounds.x+3,y:bounds.y+2});ed.destroy();
});

test('selected rotation and reflection keep background and canvas fixed; subsequent clicks are safe',()=>{
 const ed=scene(),background=bytes(ed.layers[0].canvas);ed.rotateActiveLayer();assert.deepEqual([ed.width,ed.height],[80,60]);assert.deepEqual(bytes(ed.layers[0].canvas),background);assert.deepEqual(ed.getActiveLayerBounds(),{x:25,y:15,width:10,height:20});
 ed.flipHorizontal();assert.deepEqual(ed.getActiveLayerBounds(),{x:25,y:15,width:10,height:20});const before=bytes(ed.active.canvas);ed.setTool('move');ed._pointerDown(point(30,25));ed._pointerUp(point(30,25));assert.deepEqual(bytes(ed.active.canvas),before);ed.destroy();
});

test('GIF resize affects every frame via its matrix; static layers, delays and project reload survive',async()=>{
 const ed=scene(),bg=bytes(ed.layers[0].canvas),f1=canvas(2,4),f2=canvas(2,4);f1.getContext('2d').fillRect(0,0,2,4);f2.getContext('2d').fillRect(0,0,2,4);
 ed.active.animation={frames:[{canvas:f1,delay:100},{canvas:f2,delay:200}],matrix:[1,0,0,1,20,20]};ed._refreshAnimationPreview(ed.active);ed._commit('GIF');
 ed.resizeActiveLayer(4,8);assert.deepEqual(ed.active.animation.matrix,[2,0,0,2,19,18]);assert.equal(ed.active.animation.frames[0].canvas,f1);assert.deepEqual(ed.active.animation.frames.map(f=>f.delay),[100,200]);assert.deepEqual(bytes(ed.layers[0].canvas),bg);
 const data=ed.serialize(),reopened=new Editor(canvas());await reopened.loadProject(data);assert.deepEqual(reopened.getActiveLayerBounds(),{x:19,y:18,width:4,height:8});assert.deepEqual(reopened.active.animation.frames.map(f=>f.delay),[100,200]);ed.undo();assert.deepEqual(ed.active.animation.matrix,[1,0,0,1,20,20]);ed.destroy();reopened.destroy();
});

test('fill tolerance covers textured shades and stops at a distinct boundary',()=>{
 const ed=new Editor(canvas());ed.newDocument(5,2,'transparent');const ctx=ed.active.canvas.getContext('2d'),image=ctx.getImageData(0,0,5,2);
 const row=[[200,100,20,255],[212,110,28,255],[0,0,0,255],[200,100,20,255],[200,100,20,255]];
 for(let y=0;y<2;y++)row.forEach((rgba,x)=>image.data.set(rgba,(y*5+x)*4));ctx.putImageData(image,0,0);
 ed.fillTolerance=32;ed.color='#ffffff';assert.equal(ed._floodFill({x:0,y:0}),true);
 const data=ctx.getImageData(0,0,5,2).data;assert.deepEqual(Array.from(data.slice(4,8)),[255,255,255,255]);assert.deepEqual(Array.from(data.slice(12,16)),row[3]);
 ed.fillContiguous=false;ed.color='#00ff00';ed._floodFill({x:3,y:0});assert.deepEqual(Array.from(ctx.getImageData(4,1,1,1).data),[0,255,0,255]);ed.destroy();
});

test('fill handles near-identical replacement and opacity without revisiting pixels or creating holes',()=>{
 const ed=new Editor(canvas());ed.newDocument(30,20,'#202020');ed.fillTolerance=32;ed.color='#212121';ed.opacity=.5;
 assert.equal(ed._floodFill({x:0,y:0}),true);const data=ed.active.canvas.getContext('2d').getImageData(0,0,30,20).data;
 for(let i=0;i<data.length;i+=4)assert.deepEqual(Array.from(data.slice(i,i+4)),[33,33,33,255]);
 ed.opacity=0;const before=bytes(ed.active.canvas);assert.equal(ed._floodFill({x:0,y:0}),false);assert.deepEqual(bytes(ed.active.canvas),before);ed.destroy();
});

test('zero tolerance leaves different shades intact and transparent fill ignores hidden RGB',()=>{
 const ed=new Editor(canvas());ed.newDocument(3,1,'transparent');const ctx=ed.active.canvas.getContext('2d');ctx.fillStyle='#202020';ctx.fillRect(0,0,1,1);ctx.fillStyle='#212121';ctx.fillRect(1,0,1,1);ed.fillTolerance=0;ed.color='#ffffff';ed._floodFill({x:0,y:0});assert.deepEqual(Array.from(ctx.getImageData(1,0,1,1).data),[33,33,33,255]);assert.equal(ctx.getImageData(2,0,1,1).data[3],0);ed.destroy();
});
