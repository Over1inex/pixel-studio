import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';

// Use the same vector logo in Windows Explorer, the taskbar and the editor.
const svg = await readFile(new URL('../desktop-ui/favicon.svg', import.meta.url));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(size => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer()));
const directory = Buffer.alloc(6 + images.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(images.length, 4);
let offset = directory.length;
images.forEach((image, index) => {
  const entry = 6 + index * 16;
  directory[entry] = sizes[index] === 256 ? 0 : sizes[index];
  directory[entry + 1] = directory[entry];
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(image.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += image.length;
});
await writeFile(new URL('./pixel-studio.ico', import.meta.url), Buffer.concat([directory, ...images]));
