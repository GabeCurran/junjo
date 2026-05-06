import type { Junjo } from "@junjo/sdk";
import { createContext } from "react";

export const JunjoContext = createContext<Junjo | null>(null);
