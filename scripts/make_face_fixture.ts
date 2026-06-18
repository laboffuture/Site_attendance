/* Generates a single-face test fixture by cropping one detected face (with
   margin) out of a bundled multi-face sample. Run once: tsx scripts/make_face_fixture.ts
   Output: test/fixtures/face_single.jpg (committed; used by e2e:workers). */
import fs from "fs";
import path from "path";

import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import type * as FaceApi from "@vladmandic/face-api";
import * as jpeg from "jpeg-js";

const faceapi: typeof FaceApi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
const SRC = path.join(process.cwd(), "node_modules/@vladmandic/face-api/demo/sample1.jpg");
const OUT_DIR = path.join(process.cwd(), "test/fixtures");
const OUT = path.join(OUT_DIR, "face_single.jpg");

async function main(): Promise<void> {
  setWasmPaths(path.join(process.cwd(), "node_modules/@tensorflow/tfjs-backend-wasm/dist/").replace(/\\/g, "/"));
  await tf.setBackend("wasm");
  await tf.ready();
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(path.join(process.cwd(), "models/face"));
  await faceapi.nets.faceLandmark68Net.loadFromDisk(path.join(process.cwd(), "models/face"));
  await faceapi.nets.faceRecognitionNet.loadFromDisk(path.join(process.cwd(), "models/face"));

  const img = jpeg.decode(fs.readFileSync(SRC), { useTArray: true, maxMemoryUsageInMB: 1024 });
  const { width: W, height: H, data } = img;
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2];
  }
  const t = tf.tensor3d(rgb, [H, W, 3], "int32");
  const faces = await faceapi.detectAllFaces(t as never);
  t.dispose();
  if (!faces.length) throw new Error("no faces found in source");

  const box = faces[0].box; // {x,y,width,height}
  const mx = box.width * 0.5, my = box.height * 0.5;
  const x0 = Math.max(0, Math.floor(box.x - mx));
  const y0 = Math.max(0, Math.floor(box.y - my));
  const x1 = Math.min(W, Math.ceil(box.x + box.width + mx));
  const y1 = Math.min(H, Math.ceil(box.y + box.height + my));
  const cw = x1 - x0, ch = y1 - y0;

  const crop = Buffer.alloc(cw * ch * 4);
  for (let yy = 0; yy < ch; yy++) {
    for (let xx = 0; xx < cw; xx++) {
      const si = ((y0 + yy) * W + (x0 + xx)) * 4;
      const di = (yy * cw + xx) * 4;
      crop[di] = data[si]; crop[di + 1] = data[si + 1]; crop[di + 2] = data[si + 2]; crop[di + 3] = 255;
    }
  }
  const encoded = jpeg.encode({ data: crop, width: cw, height: ch }, 92);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, encoded.data);

  // Verify the crop now contains exactly one face.
  const vt = tf.tensor3d(
    (() => { const r = new Uint8Array(cw * ch * 3); for (let i = 0, j = 0; i < crop.length; i += 4, j += 3) { r[j] = crop[i]; r[j + 1] = crop[i + 1]; r[j + 2] = crop[i + 2]; } return r; })(),
    [ch, cw, 3], "int32",
  );
  const check = await faceapi.detectAllFaces(vt as never).withFaceLandmarks().withFaceDescriptors();
  vt.dispose();
  console.log(`wrote ${OUT} (${cw}x${ch}) — faces in crop: ${check.length}`);
  if (check.length !== 1) process.exit(1);
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
