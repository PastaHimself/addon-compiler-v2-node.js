import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@/app/globals.css";

export const metadata: Metadata = {
  title: "Add-On Compiler",
  description: "Compile Minecraft Bedrock add-ons, packs, and worlds in the browser with a Vercel-hosted Node.js backend.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
