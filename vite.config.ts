import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { existsSync, readFileSync } from 'node:fs';

export default defineConfig(({ mode }) => {
  const trustedCertificate = existsSync('certs/dev.pem') && existsSync('certs/dev-key.pem');
  return {
    base: process.env.VITE_BASE_PATH || '/',
    plugins: [react(), ...(mode === 'https' && !trustedCertificate ? [basicSsl()] : [])],
    server: {
      port: 5188,
      strictPort: true,
      ...(mode === 'https' && trustedCertificate ? {
        https: { cert: readFileSync('certs/dev.pem'), key: readFileSync('certs/dev-key.pem') },
      } : {}),
    },
  };
});
