import type { Metadata } from "next";
import "./globals.css";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "Pips Storage",
  description: "Accounts, apps, API keys, database, and file storage.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <a className="brand" href="/">Pips Storage</a>
          <Nav />
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
