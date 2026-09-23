import type {Metadata} from "next";
import type {ReactNode} from "react";

import "@fontsource-variable/source-sans-3/wght.css";
import "@fontsource-variable/source-sans-3/wght-italic.css";
import "../src/styles.css";

export const metadata: Metadata = {
  title: "Restate Agent",
  description:
    "A demonstration interface for the Restate durable agent reference implementation.",
};

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
