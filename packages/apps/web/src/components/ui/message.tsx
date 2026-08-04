import type {ComponentProps} from "react";

function classes(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function Message({
  className,
  align = "start",
  ...props
}: ComponentProps<"article"> & {align?: "start" | "end"}) {
  return (
    <article
      data-slot="message"
      data-align={align}
      className={classes("message", className)}
      {...props}
    />
  );
}

export function MessageAvatar({className, ...props}: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-avatar"
      className={classes("message-avatar", className)}
      {...props}
    />
  );
}

export function MessageContent({className, ...props}: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-content"
      className={classes("message-content", className)}
      {...props}
    />
  );
}

export function MessageHeader({className, ...props}: ComponentProps<"header">) {
  return (
    <header
      data-slot="message-header"
      className={classes("message-header", className)}
      {...props}
    />
  );
}

export function MessageFooter({className, ...props}: ComponentProps<"footer">) {
  return (
    <footer
      data-slot="message-footer"
      className={classes("message-footer", className)}
      {...props}
    />
  );
}
