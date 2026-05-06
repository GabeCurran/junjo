// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { type ReactNode, createContext, useContext, useEffect, useState } from "react";

interface CurrentGameContextValue {
  name: string | null;
  setName: (name: string | null) => void;
}

const CurrentGameContext = createContext<CurrentGameContextValue>({
  name: null,
  setName: () => {},
});

export function CurrentGameProvider({ children }: { children: ReactNode }) {
  const [name, setName] = useState<string | null>(null);
  return (
    <CurrentGameContext.Provider value={{ name, setName }}>{children}</CurrentGameContext.Provider>
  );
}

export function useCurrentGameName(): string | null {
  return useContext(CurrentGameContext).name;
}

// Mounted under [gameId]/layout.tsx after a successful fetchAdminGame.
// Writes the resolved name into the context so the parent layout's
// SidebarNav can render the section header. Clears on unmount so a 404
// (handled via notFound() in the layout, which prevents this writer from
// mounting at all) leaves the context null and the sidebar section hides.
export function CurrentGameWriter({ gameName }: { gameName: string }) {
  const { setName } = useContext(CurrentGameContext);
  useEffect(() => {
    setName(gameName);
    return () => {
      setName(null);
    };
  }, [gameName, setName]);
  return null;
}
