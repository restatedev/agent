import type {Metadata} from "next";
import type {ReactNode} from "react";
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
