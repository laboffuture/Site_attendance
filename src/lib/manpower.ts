import { CounterModel } from "../models/Counter";

/** Mint the next sequential code like MPA-000123 / OUT-0007 (atomic via Counter). */
export async function nextCode(prefix: string, key: string, pad = 6): Promise<string> {
  const c = await CounterModel.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `${prefix}-${String(c!.seq).padStart(pad, "0")}`;
}

interface StatusInput {
  status?: string;
  lines: { designationId: unknown; qty: number }[];
  allocations: { lineDesignationId: unknown }[];
}

/** Derive a request's status from its lines vs allocations. `cancelled` is sticky. */
export function computeStatus(req: StatusInput): "open" | "partial" | "fulfilled" | "cancelled" {
  if (req.status === "cancelled") return "cancelled";
  if (req.allocations.length === 0) return "open";
  const allFilled = req.lines.every(
    (l) => req.allocations.filter((a) => String(a.lineDesignationId) === String(l.designationId)).length >= l.qty,
  );
  return allFilled ? "fulfilled" : "partial";
}
