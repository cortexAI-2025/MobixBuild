import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MobixBuild — Build Mobile Apps. Instantly.',
  description: 'From repo to APK in one click. Android build service for developers.',
  icons: { icon: '/favicon.ico' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
