/* Full pure-JS face pipeline check on this machine (no native deps):
   load CPU backend -> load nets from bundled weights -> decode a real sample
   JPEG with jpeg-js -> detect face -> extract a 128-d descriptor.
   This is the go/no-go proof before building enrollment. */

import fs from "fs";
import path from "path";

// The default entry needs @tensorflow/tfjs-node (native, won't load on Node 22).
// Use face-api's node-wasm build with the pure-JS WASM backend instead.
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import type * as FaceApi from "@vladmandic/face-api";
import * as jpeg from "jpeg-js";

const faceapi: typeof FaceApi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");

const WASM_DIR =
  path.join(process.cwd(), "node_modules/@tensorflow/tfjs-backend-wasm/dist/").replace(/\\/g, "/");

const PKG = path.join(process.cwd(), "node_modules/@vladmandic/face-api");
const MODEL_DIR = path.join(PKG, "model");
const SAMPLE = path.join(PKG, "demo/sample1.jpg");

function decodeJpegToTensor(buf: Buffer) {
  const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
  const { width, height, data } = img; // data = RGBA
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return faceapi.tf.tensor3d(rgb, [height, width, 3], "int32");
}

async function main(): Promise<void> {
  const tf = faceapi.tf;
  setWasmPaths(WASM_DIR);
  await tf.setBackend("wasm");
  await tf.ready();
  console.log("backend:", tf.getBackend(), "| tfjs:", tf.version.tfjs);

  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_DIR);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_DIR);
  console.log(
    "nets loaded:",
    faceapi.nets.ssdMobilenetv1.isLoaded,
    faceapi.nets.faceLandmark68Net.isLoaded,
    faceapi.nets.faceRecognitionNet.isLoaded,
  );

  const t0 = Date.now();
  const tensor = decodeJpegToTensor(fs.readFileSync(SAMPLE));
  const result = await faceapi
    .detectSingleFace(tensor as never)
    .withFaceLandmarks()
    .withFaceDescriptor();
  tensor.dispose();

  const len = result?.descriptor?.length ?? 0;
  console.log(`face detected: ${!!result} | descriptor dims: ${len} | ${Date.now() - t0}ms`);

  if (len !== 128) {
    console.error("\nFACE CHECK FAILED: expected a 128-d descriptor.");
    process.exit(1);
  }
  console.log("\nFACE CHECK (pure JS) PASSED");
}

main().catch((e) => {
  console.error("\nFACE CHECK FAILED:", e?.message ?? e);
  process.exit(1);
});
