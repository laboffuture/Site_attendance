/* Probe: how many faces does each bundled sample image contain?
   Used to pick a single-face image for the enrollment e2e test. */
import fs from "fs";
import path from "path";

import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import type * as FaceApi from "@vladmandic/face-api";
import * as jpeg from "jpeg-js";

const faceapi: typeof FaceApi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
const PKG = path.join(process.cwd(), "node_modules/@vladmandic/face-api");
const MODEL_DIR = path.join(process.cwd(), "models/face");

async function main(): Promise<void> {
  setWasmPaths(path.join(process.cwd(), "node_modules/@tensorflow/tfjs-backend-wasm/dist/").replace(/\\/g, "/"));
  await tf.setBackend("wasm");
  await tf.ready();
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_DIR);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_DIR);

  for (const name of ["sample1.jpg", "sample2.jpg", "sample3.jpg", "sample4.jpg", "sample5.jpg", "sample6.jpg"]) {
    const p = path.join(PKG, "demo", name);
    if (!fs.existsSync(p)) { console.log(name, "missing"); continue; }
    const img = jpeg.decode(fs.readFileSync(p), { useTArray: true, maxMemoryUsageInMB: 1024 });
    const rgb = new Uint8Array(img.width * img.height * 3);
    for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) {
      rgb[j] = img.data[i]; rgb[j + 1] = img.data[i + 1]; rgb[j + 2] = img.data[i + 2];
    }
    const t = tf.tensor3d(rgb, [img.height, img.width, 3], "int32");
    const faces = await faceapi.detectAllFaces(t as never).withFaceLandmarks().withFaceDescriptors();
    t.dispose();
    console.log(name, "faces:", faces.length);
  }
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
