// Healthcheck endpoint for Railway / orchestrator probes. Liveness only;
// docs is a static-rendered Nextra site with no upstream dependencies.

import type { NextApiRequest, NextApiResponse } from "next";

export default function healthz(_req: NextApiRequest, res: NextApiResponse): void {
  res.status(200).json({ status: "ok" });
}
