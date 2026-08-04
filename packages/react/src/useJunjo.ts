import type { Junjo } from "@junjo.io/sdk";
import { useContext } from "react";
import { JunjoContext } from "./context.js";

export function useJunjo(): Junjo {
  const client = useContext(JunjoContext);
  if (client === null) {
    throw new Error("useJunjo must be used inside a <JunjoProvider>");
  }
  return client;
}
