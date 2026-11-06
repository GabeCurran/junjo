// @license All Rights Reserved (see apps/dashboard/LICENSE)

const dateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

// How long a ban or sanction lasts, as a phrase.
export function until(expiresAt: string | null): string {
  return expiresAt ? `until ${dateTime.format(new Date(expiresAt))}` : "with no end";
}
