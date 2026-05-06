import type { DocsThemeConfig } from "nextra-theme-docs";

const config: DocsThemeConfig = {
  logo: <span style={{ fontWeight: 600 }}>Junjo</span>,
  project: {
    link: "https://github.com/GabeCurran/junjo",
  },
  docsRepositoryBase: "https://github.com/GabeCurran/junjo/tree/main/apps/docs",
  footer: {
    content: "Junjo",
  },
  // Collapse every sidebar section by default on first load. Users see
  // a clean top-level list (SDK, React, Roblox, API, Auth, etc.) and
  // click in to expand. defaultMenuCollapseLevel: 1 means only depth-1
  // top-level sections render expanded; everything below is collapsed
  // until clicked. autoCollapse re-collapses sibling sections when the
  // user navigates into a different one.
  sidebar: {
    defaultMenuCollapseLevel: 1,
    autoCollapse: true,
  },
};

export default config;
