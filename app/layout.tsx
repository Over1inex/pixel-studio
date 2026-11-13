import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Pixel Studio — пространство для идей', description: 'Создавайте изображения, рисуйте и собирайте композиции в браузере. Слои, личные проекты и экспорт.', icons: { icon: '/favicon.svg' } };
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) { return <html lang="ru"><body>{children}</body></html>; }
