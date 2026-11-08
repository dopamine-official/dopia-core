import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import { LoginHost } from "@/components/ui";
import { defaultLocale } from "@/i18n";
import "./globals.css";
export const metadata: Metadata = {
  title: "Character Chat",
  description: "A local character chat preview.",
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={defaultLocale} suppressHydrationWarning>
      <body>
        <Providers>
          {children}
          <LoginHost />
        </Providers>
      </body>
    </html>
  );
}
