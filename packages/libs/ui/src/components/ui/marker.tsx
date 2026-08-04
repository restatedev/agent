import type {ComponentProps} from "react";

function classes(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function Marker({
  className,
  variant = "default",
  ...props
}: ComponentProps<"div"> & {
  variant?: "default" | "separator" | "border";
}) {
  return (
    <div
      data-slot="marker"
      data-variant={variant}
      className={classes("marker", className)}
      {...props}
    />
  );
}

export function MarkerIcon({className, ...props}: ComponentProps<"span">) {
  return (
    <span
      data-slot="marker-icon"
      aria-hidden="true"
      className={classes("marker-icon", className)}
      {...props}
    />
  );
}

export function MarkerContent({className, ...props}: ComponentProps<"span">) {
  return (
    <span
      data-slot="marker-content"
      className={classes("marker-content", className)}
      {...props}
    />
  );
}
