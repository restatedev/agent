import type {ComponentProps} from "react";

type BubbleVariant = "tinted" | "outline";

function classes(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function Bubble({
  variant,
  align = "start",
  className,
  ...props
}: ComponentProps<"div"> & {
  variant?: BubbleVariant;
  align?: "start" | "end";
}) {
  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={align}
      className={classes("bubble", className)}
      {...props}
    />
  );
}

export function BubbleContent({className, ...props}: ComponentProps<"div">) {
  return (
    <div
      data-slot="bubble-content"
      className={classes("bubble-content", className)}
      {...props}
    />
  );
}
