import { Schema, model, InferSchemaType } from "mongoose";

// Atomic sequence source. key='empRegNo' is incremented via findOneAndUpdate
// to mint unique employee registration numbers like 'TRGBI-0001'.
const counterSchema = new Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 },
});

export type Counter = InferSchemaType<typeof counterSchema>;
export const CounterModel = model("Counter", counterSchema, "counters");
