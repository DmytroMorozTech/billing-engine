import type { Metadata, Viewport } from 'next';

import '@sumup-oss/design-tokens/fonts.css';
import '@sumup-oss/design-tokens/light.css';
import '@sumup-oss/circuit-ui/styles.css';

import './globals.css';

export const metadata: Metadata = {
  title: {
    template: '%s | Billing engine',
    default: 'Billing engine',
  },
  description:
    'Subscriptions, usage-based commission and invoicing for a small-business payments platform.',
  // A local file, not a remote one. The template pointed these at its
  // vendor's CDN, which fetched third-party assets on every page load.
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fff' },
    { media: '(prefers-color-scheme: dark)', color: '#000' },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
