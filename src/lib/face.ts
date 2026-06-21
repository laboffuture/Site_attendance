/* Face recognition engine (server-side, pure JS — no native deps).
 *
 * Uses face-api.js's node-wasm build with the TensorFlow.js WASM backend.
 * (The default face-api entry needs @tensorflow/tfjs-node, whose native
 *  binding does not load on Node 22 — the WASM backend avoids that entirely.)
 *
 * Public surface is deliberately small so the engine can be swapped later
 * (e.g. for a Python micro-service) without touching callers:
 *   initFace(), encodeFace(buf), descriptorDistance(a,b), bestMatch(...)
 */
import path from "path";

import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import type * as FaceApi from "@vladmandic/face-api";
import * as jpeg from "jpeg-js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const faceapi: typeof FaceApi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");

const MODEL_DIR = path.join(__dirname, "..", "..", "models", "face");
const WASM_DIR = path
  .join(process.cwd(), "node_modules/@tensorflow/tfjs-backend-wasm/dist/")
  .replace(/\\/g, "/");

/** Max Euclidean distance between descriptors to count as the same person.
 *  Lower = stricter. 0.5 is conservative for the FaceNet-style 128-d space. */
const MATCH_THRESHOLD = 0.5;

let ready: Promise<void> | null = null;

/** Loads the WASM backend + face models once; subsequent calls reuse it. */
export function initFace(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      setWasmPaths(WASM_DIR);
      await tf.setBackend("wasm");
      await tf.ready();
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_DIR);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_DIR);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_DIR);
      console.log("Face models loaded (tfjs wasm backend).");
    })();
  }
  return ready;
}

function decodeJpegToTensor(jpegBuffer: Buffer) {
  const img = jpeg.decode(jpegBuffer, { useTArray: true, maxMemoryUsageInMB: 1024 });
  const { width, height, data } = img; // data = RGBA
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return tf.tensor3d(rgb, [height, width, 3], "int32");
}

/**
 * Returns a 128-d face descriptor for the image, or null. Enrollment requires
 * exactly one clearly-detected face — zero or multiple faces return null so
 * the caller can ask for a better photo.
 */
export async function encodeFace(jpegBuffer: Buffer): Promise<number[] | null> {
  await initFace();
  const tensor = decodeJpegToTensor(jpegBuffer);
  try {
    const results = await faceapi
      .detectAllFaces(tensor as never)
      .withFaceLandmarks()
      .withFaceDescriptors();
    if (results.length !== 1) return null;
    return Array.from(results[0].descriptor);
  } finally {
    tensor.dispose();
  }
}

/** Euclidean distance between two descriptors of equal length. */
function descriptorDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Closest candidate within `threshold`, or null if none match. */
export function bestMatch(
  probe: number[],
  candidates: { id: string; descriptor: number[] }[],
  threshold = MATCH_THRESHOLD,
): { id: string; distance: number } | null {
  let best: { id: string; distance: number } | null = null;
  for (const c of candidates) {
    if (!c.descriptor || c.descriptor.length !== probe.length) continue;
    const distance = descriptorDistance(probe, c.descriptor);
    if (best === null || distance < best.distance) best = { id: c.id, distance };
  }
  return best && best.distance <= threshold ? best : null;
}
