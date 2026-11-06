// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type { CSSProperties, HTMLAttributes } from "react";

import { cn } from "../../lib/utils";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

interface RoleChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, "color"> {
  name: string;
  // The role's stored color; anything that is not a 6-digit hex renders
  // the neutral chip.
  color?: string | null;
}

// A role in its own color: the tint and border come from the role, the
// text stays the page's ink so any stored color stays readable.
export function RoleChip({ name, color, className, style, ...props }: RoleChipProps) {
  const hex = color && HEX_COLOR.test(color) ? color : null;
  const tinted: CSSProperties | undefined = hex
    ? { backgroundColor: `${hex}29`, borderColor: `${hex}73` }
    : undefined;
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-sm border px-1.5 py-px text-xs font-medium leading-5",
        hex ? "text-foreground" : "border-border bg-muted text-muted-foreground",
        className,
      )}
      style={{ ...tinted, ...style }}
      {...props}
    >
      {hex ? (
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: hex }}
        />
      ) : null}
      <span className="truncate">{name}</span>
    </span>
  );
}
