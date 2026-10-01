import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import { optimizerApiPlugin } from './src/server/optimizerApiPlugin.ts'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), optimizerApiPlugin({
      supabaseUrl: env.SUPABASE_URL ?? env.VITE_SUPABASE_URL,
      publishableKey: env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY,
    })],
    test: {
      globals: true,
      environment: 'node',
    },
  }
})
