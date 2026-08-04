import type { Junjo } from "@junjo.io/sdk";
import { createContext } from "react";

export const JunjoContext = createContext<Junjo | null>(null);
