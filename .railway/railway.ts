import { defineRailway, project, service } from "railway/iac";
// Settings moved here from railway.toml for the junjo-prod project. All three services build this repo's Dockerfile.
// The junjo services inside the reibu and PokeDnD projects are set from those projects' own files.
// The Postgres services are left out on purpose, so this file cannot delete them.
export const partial = "junjo";
export default defineRailway(() => {
  const settings = {
    build: { builder: "DOCKERFILE" as const, dockerfilePath: "Dockerfile" },
    healthcheck: "/healthz",
    healthcheckTimeout: 300,
    // Restarts on failure, Railway's default policy, so only the retry cap is set.
    deploy: { restartPolicyMaxRetries: 5 },
  };
  const junjoServer = service("junjo-server", settings);
  const junjoDashboard = service("junjo-dashboard", settings);
  const junjoDocs = service("junjo-docs", settings);

  return project("junjo-prod", {
    variables: { managed: false },
    resources: [junjoServer, junjoDashboard, junjoDocs],
  });
});
