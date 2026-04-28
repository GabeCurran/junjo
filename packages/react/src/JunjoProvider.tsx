import type { Junjo } from "@junjo/sdk";
import type { ReactNode } from "react";
import { JunjoContext } from "./context.js";

export interface JunjoProviderProps {
  client: Junjo;
  children: ReactNode;
}

export function JunjoProvider({ client, children }: JunjoProviderProps) {
  return <JunjoContext.Provider value={client}>{children}</JunjoContext.Provider>;
}
