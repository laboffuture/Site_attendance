import { Types } from "mongoose";

import type { CurrentUser } from "../auth/types";
import { WorkerModel, RemarkType } from "../models/Worker";

/** Append an audit remark to a hydrated worker doc (caller saves).
 *  Only `text` is required on the subdoc; `cleared`/`clearedBy`/`clearedAt`
 *  fall back to their schema defaults, so they're omitted here. */
export function pushRemark(
  worker: InstanceType<typeof WorkerModel>,
  user: CurrentUser,
  text: string,
  type: RemarkType,
): void {
  worker.remarks.push({
    text,
    type,
    authorId: new Types.ObjectId(user.id),
    authorName: user.name,
    at: new Date(),
  } as never);
}
