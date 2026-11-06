// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { PageSkeleton } from "../../../../components/dashboard/page-skeleton";

// Shown while a page inside one game loads; the game layout and the
// sidebar stay in place.
export default function GameLoading() {
  return <PageSkeleton />;
}
